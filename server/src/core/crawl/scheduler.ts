/**
 * core/crawl/scheduler.ts —— 采集调度器（dev-spec §3 / §6.3 护栏 / §6.6 断点续爬）
 *
 * 流程（每个队列项一次）：
 *   守卫（已抓/暂停/页数上限/访问次数/前缀剪枝/分页上限/范围）
 *   → robots 检查 → 静态抓取（undici）→ 链接数为 0 或疑似 SPA 时回落 Playwright
 *   → 解析链接与正文 → 内容指纹去重 → 建节点（幂等）→ 建边 → 入队新节点 → 写 fetch_logs
 *
 * 去重三层：identityKey（UNIQUE 约束）→ content_hash（内容指纹）→ 已抓节点直连复用。
 * core/ 不依赖 api/：进度通过 CrawlListener 回调向外广播（由 api/ws.ts 接线）。
 */
import { DEFAULT_CRAWL_PRESET, type CrawlPreset, type CrawlProgress, type NodeStatus } from '@siteatlas/shared';
import { fetchRendered } from '../fetch/browser-fetcher.ts';
import { decideRender } from '../fetch/browser-fetcher.ts';
import { fetchStatic, looksAssetContentType, looksHtmlContentType } from '../fetch/http-fetcher.ts';
import type { BrowserPool } from '../fetch/pool.ts';
import { isAllowedByRobots, loadRobots } from '../fetch/robots.ts';
import { contentFingerprint, deriveDisplayLabel, extractContent } from '../extract/content.ts';
import { extractLinks, type ExtractLinksResult } from '../extract/links.ts';
import { normalizeUrl } from '../url/normalize.ts';
import { identityKeyOf } from '../url/identity.ts';
import { isInScope } from '../url/scope.ts';
import type { CrawlRepo, QueueItem } from '../store/repos/crawl.ts';
import { EdgesRepo } from '../store/repos/edges.ts';
import { NodesRepo } from '../store/repos/nodes.ts';
import { nowSec } from '../store/ids.ts';
import { CrawlControl, STOPPED_ERROR } from './control.ts';
import { Frontier } from './frontier.ts';
import { PaginationLimiter } from './pagination.ts';
import { Politeness, hostOf } from './politeness.ts';
import { PrefixTrie } from './prefix.ts';
import { decideRetry } from './retry.ts';

export interface CrawlListener {
  onProgress?(progress: CrawlProgress): void;
  onNodeFound?(node: { id: string; url: string; depth: number; status: NodeStatus; display_label: string | null }): void;
  onTaskEnd?(status: 'done' | 'failed' | 'stopped' | 'paused', reason: string | null): void;
}

export interface SchedulerOptions {
  taskId: string;
  siteId: string;
  rootUrl: string;
  preset: CrawlPreset;
  crawl: CrawlRepo;
  nodes: NodesRepo;
  edges: EdgesRepo;
  pool: BrowserPool;
  control?: CrawlControl;
  listener?: CrawlListener;
  /** 测试注入：静态抓取实现 */
  fetchStaticImpl?: typeof fetchStatic;
  /** 测试注入：渲染实现 */
  fetchRenderedImpl?: typeof fetchRendered;
}

export interface CrawlResult {
  status: 'done' | 'failed' | 'stopped';
  fetched: number;
  ok: number;
  failed: number;
  skipped: number;
  discovered: number;
  reason: string | null;
  prunedPrefixes: string[];
  durationMs: number;
}

interface SchedulerState {
  taskId: string;
  siteId: string;
  frontier: Frontier;
  control: CrawlControl;
  politeness: Politeness;
  prefix: PrefixTrie;
  pagination: PaginationLimiter;
  pagesFetched: number;
  discovered: number;
  ok: number;
  failed: number;
  skipped: number;
  /** 内容指纹 → 首个节点 id（§6.3 二层去重） */
  contentHashes: Map<string, string>;
  lastEvent: string | null;
  startedAt: number;
  finishedAt: number | null;
  stopped: boolean;
  lastBroadcastAt: number;
}

const ASSET_EXT_RE =
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif|pdf|zip|gz|tgz|bz2|7z|rar|mp3|wav|ogg|m4a|mp4|m4v|mov|avi|webm|woff2?|ttf|eot|otf|docx?|xlsx?|pptx?|epub|csv|json|xml|rss|atom)$/i;

/** 明显是素材/非 HTML 的扩展名：只登记节点，不发请求（§4.4「记录但不递归」） */
export function looksLikeAssetUrl(url: string): boolean {
  try {
    return ASSET_EXT_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export class Scheduler {
  private readonly options: SchedulerOptions;
  private readonly preset: CrawlPreset;
  private state: SchedulerState;
  private readonly fetchStaticImpl: typeof fetchStatic;
  private readonly fetchRenderedImpl: typeof fetchRendered;

  constructor(options: SchedulerOptions) {
    this.options = options;
    this.preset = { ...DEFAULT_CRAWL_PRESET, ...options.preset };
    this.fetchStaticImpl = options.fetchStaticImpl ?? fetchStatic;
    this.fetchRenderedImpl = options.fetchRenderedImpl ?? fetchRendered;
    this.state = {
      taskId: options.taskId,
      siteId: options.siteId,
      frontier: new Frontier(options.crawl, options.taskId),
      control: options.control ?? new CrawlControl(),
      politeness: new Politeness({
        minDelayMs: this.preset.minDelayMs,
        jitterMs: this.preset.jitterMs,
        perHostConcurrency: this.preset.perHostConcurrency,
      }),
      prefix: new PrefixTrie(this.preset.prefixPruneThreshold),
      pagination: new PaginationLimiter(this.preset.paginationPageLimit),
      pagesFetched: 0,
      discovered: 0,
      ok: 0,
      failed: 0,
      skipped: 0,
      contentHashes: new Map(),
      lastEvent: null,
      startedAt: Date.now(),
      finishedAt: null,
      stopped: false,
      lastBroadcastAt: 0,
    };
  }

  get control(): CrawlControl {
    return this.state.control;
  }

  /** 主循环：并发 workers 直到队列空/停止/上限 */
  async start(): Promise<CrawlResult> {
    const state = this.state;
    let reason: string | null = null;

    const workers = Array.from({ length: Math.max(1, Math.min(32, this.preset.concurrency)) }, () =>
      this.worker().catch((err: Error) => {
        if (err.message !== STOPPED_ERROR) throw err;
      }),
    );

    try {
      await Promise.all(workers);
    } catch (err) {
      reason = (err as Error).message;
    }

    state.finishedAt = Date.now();
    const status: CrawlResult['status'] =
      state.control.current === 'stopped' ? 'stopped' : reason !== null ? 'failed' : 'done';

    const result: CrawlResult = {
      status,
      fetched: state.pagesFetched,
      ok: state.ok,
      failed: state.failed,
      skipped: state.skipped,
      discovered: state.discovered,
      reason,
      prunedPrefixes: state.prefix.prunedPrefixes,
      durationMs: state.finishedAt - state.startedAt - state.control.pausedMs,
    };

    this.options.crawl.setTaskStatus(this.options.taskId, status, this.stats());
    this.broadcast(true);
    this.options.listener?.onTaskEnd?.(status === 'failed' ? 'failed' : status, reason);
    return result;
  }

  private async worker(): Promise<void> {
    const state = this.state;
    for (;;) {
      await state.control.checkpoint();
      if (state.stopped) return;

      const items = await state.frontier.take(
        Math.max(1, this.preset.concurrency),
        (host) => state.politeness.canHit(host),
        (nodeId) => this.options.nodes.get(nodeId)?.url ?? null,
      );
      if (items.length === 0) {
        // 没有可取的项：要么队列空了，要么都被同域并发挡住 → 稍等再试
        if (!state.frontier.hasWork()) return;
        await new Promise((r) => setTimeout(r, 200));
        await state.control.checkpoint();
        continue;
      }

      for (const item of items) {
        try {
          await this.step(item);
        } catch (err) {
          if ((err as Error).message === STOPPED_ERROR) return;
          state.failed += 1;
          state.frontier.failed(item);
          this.options.nodes.setStatus(item.node_id, 'error');
          state.lastEvent = `内部错误：${(err as Error).message}`;
          this.broadcast();
        }
      }
    }
  }

  /** 单个队列项的处理 */
  private async step(item: QueueItem): Promise<void> {
    const state = this.state;
    const nodes = this.options.nodes;

    if (state.pagesFetched >= this.preset.maxPages) {
      state.skipped += 1;
      state.stopped = true;
      state.lastEvent = `已达最大页数上限 ${this.preset.maxPages}，停止采集`;
      state.frontier.skipped(item);
      nodes.setStatus(item.node_id, 'skipped');
      this.broadcast(true);
      return;
    }

    const node = nodes.get(item.node_id);
    if (node === null) {
      state.frontier.skipped(item);
      return;
    }

    // 三层去重的第三层：已抓节点直连复用，不重复请求
    if (nodes.isCrawled(node.id)) {
      state.frontier.done(item);
      return;
    }

    await state.control.checkpoint();

    const outcome = await this.fetchNode(node.id, node.url, item.depth);
    state.pagesFetched += outcome.counted ? 1 : 0;
    if (outcome.status === 'ok') state.ok += 1;
    else if (outcome.status === 'skipped' || outcome.status === 'blocked') state.skipped += 1;
    else state.failed += 1;
    state.lastEvent = outcome.event;

    if (outcome.status === 'error' && outcome.retryable && item.attempts < this.preset.maxRetries) {
      const delay = decideRetry(item.attempts + 1, outcome.httpStatus, {
        maxRetries: this.preset.maxRetries,
        backoffMs: this.preset.retryBackoffMs,
        backoffMaxMs: this.preset.retryBackoffMaxMs,
      }).delayMs;
      state.frontier.retryLater(item, Date.now() + delay);
      state.lastEvent = `${outcome.event}；${Math.round(delay / 1000)}s 后重试（第 ${item.attempts + 1} 次）`;
    } else if (outcome.status === 'error') {
      state.frontier.failed(item);
    } else {
      state.frontier.done(item);
    }

    this.broadcast();
  }

  private async fetchNode(
    nodeId: string,
    url: string,
    depth: number,
  ): Promise<{
    status: NodeStatus;
    httpStatus: number | null;
    retryable: boolean;
    counted: boolean;
    event: string;
  }> {
    const state = this.state;
    const nodes = this.options.nodes;
    const host = hostOf(url);

    // 护栏 2：同一 URL 访问上限
    const visits = this.options.crawl.countVisit(state.siteId, identityKeyOf(url));
    if (visits > this.preset.visitLimit) {
      nodes.setStatus(nodeId, 'skipped');
      return { status: 'skipped', httpStatus: null, retryable: false, counted: false, event: `访问次数超限（${visits}）跳过` };
    }

    // 明显素材：只登记不发请求
    if (looksLikeAssetUrl(url)) {
      nodes.applyFetchResult({
        id: nodeId,
        status: 'skipped',
        httpStatus: null,
        contentType: null,
        title: null,
        displayLabel: null,
        contentHash: null,
      });
      return { status: 'skipped', httpStatus: null, retryable: false, counted: false, event: '非 HTML 素材，仅登记不递归' };
    }

    // robots.txt（§4.7 默认遵守）
    if (this.preset.respectRobots) {
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        origin = '';
      }
      if (origin.length > 0) {
        const rules = await loadRobots(origin, { userAgent: this.preset.userAgent, timeoutMs: this.preset.timeoutMs });
        if (!isAllowedByRobots(rules, url)) {
          nodes.setStatus(nodeId, 'blocked');
          this.options.crawl.logFetch({
            taskId: state.taskId,
            nodeId,
            url,
            httpStatus: null,
            durationMs: 0,
            error: 'robots.txt 禁止',
            redirectChain: [url],
          });
          return { status: 'blocked', httpStatus: null, retryable: false, counted: false, event: 'robots.txt 禁止，标记 blocked' };
        }
      }
    }

    nodes.setStatus(nodeId, 'crawling');

    // 静态抓取（快路径）
    let got = await state.politeness.withHost(host, () =>
      this.fetchStaticImpl(url, {
        userAgent: this.preset.userAgent,
        timeoutMs: this.preset.timeoutMs,
        signal: state.control.signal,
      }),
    );

    let html = got.html;
    let contentType = got.contentType;
    let httpStatus = got.status;
    let finalUrl = got.finalUrl;
    let renderMode: 'http' | 'browser' = got.usedRenderMode;
    let lastError = got.error;
    let linkData: ExtractLinksResult | null = html !== null ? extractLinks(html, finalUrl) : null;

    const decision = decideRender({
      mode: this.preset.renderMode,
      staticOk: got.ok,
      linkCount: linkData?.links.length ?? 0,
      htmlLength: html?.length ?? 0,
      spaSuspected: linkData?.spaSuspected ?? false,
      textLength: linkData?.text.length ?? 0,
    });

    if (decision === 'no-links-fallback' || decision === 'spa-fallback' || decision === 'forced-browser') {
      const rendered = await state.politeness.withHost(host, () =>
        this.fetchRenderedImpl(url, this.options.pool, { timeoutMs: this.preset.timeoutMs }),
      );
      if (rendered.ok && rendered.html !== null) {
        html = rendered.html;
        finalUrl = rendered.finalUrl;
        contentType = contentType ?? 'text/html';
        renderMode = 'browser';
        lastError = null;
        got = { ...got, ok: true, status: httpStatus ?? 200 };
        linkData = extractLinks(html, finalUrl);
        state.lastEvent = `静态链接不足，已回落 Playwright 渲染（${decision}）`;
      } else if (decision === 'forced-browser' && !got.ok) {
        lastError = rendered.error ?? lastError;
      } else if (decision !== 'forced-browser') {
        state.lastEvent = `渲染回落不可用（${rendered.error ?? '未知'}），沿用静态结果`;
      }
    }

    this.options.crawl.logFetch({
      taskId: state.taskId,
      nodeId,
      url,
      httpStatus,
      durationMs: got.durationMs,
      error: got.ok && looksHtmlContentType(contentType) ? null : lastError,
      redirectChain: got.redirectChain,
    });

    // 重定向：最终 URL 落到同一节点（§6.2）
    if (got.redirectChain.length > 1 && finalUrl !== url) {
      try {
        const normalizedFinal = normalizeUrl(finalUrl);
        this.options.nodes.applyRedirect(nodeId, state.siteId, normalizedFinal.url, normalizedFinal.identityKey);
      } catch {
        /* 最终 URL 不可解析则保留原样 */
      }
    }

    if (looksAssetContentType(contentType) || (html === null && got.ok)) {
      nodes.applyFetchResult({
        id: nodeId,
        status: 'skipped',
        httpStatus,
        contentType,
        title: null,
        displayLabel: null,
        contentHash: null,
      });
      return { status: 'skipped', httpStatus, retryable: false, counted: true, event: '非 HTML 资源，仅登记不递归' };
    }

    if (!got.ok || html === null) {
      nodes.applyFetchResult({
        id: nodeId,
        status: 'error',
        httpStatus,
        contentType,
        title: null,
        displayLabel: null,
        contentHash: null,
      });
      return {
        status: 'error',
        httpStatus,
        retryable: true,
        counted: true,
        event: `抓取失败：${lastError ?? '未知错误'}`,
      };
    }

    const content = extractContent(html);
    const fingerprint = contentFingerprint(content.text || linkData?.text || '');

    // 二层去重：内容指纹重复 → 不递归（保留节点与边，供树视图看到入链）
    if (fingerprint !== null) {
      const first = state.contentHashes.get(fingerprint);
      if (first !== undefined && first !== nodeId) {
        nodes.applyFetchResult({
          id: nodeId,
          status: 'skipped',
          httpStatus,
          contentType,
          title: content.title,
          displayLabel: deriveDisplayLabel({ url: finalUrl, title: content.title }),
          contentHash: fingerprint,
        });
        this.broadcast();
        return {
          status: 'skipped',
          httpStatus,
          retryable: false,
          counted: true,
          event: `内容与节点 ${first.slice(-6)} 重复，不递归`,
        };
      }
      state.contentHashes.set(fingerprint, nodeId);
    }

    const links = linkData?.links ?? [];
    const discovered = this.expandLinks(nodeId, finalUrl, depth, links);

    nodes.applyFetchResult({
      id: nodeId,
      status: 'ok',
      httpStatus,
      contentType,
      title: content.title,
      displayLabel: deriveDisplayLabel({ url: finalUrl, title: content.title }),
      contentHash: fingerprint,
    });
    nodes.setOutLinkCount(nodeId, links.length);

    // 护栏 3：前缀 Trie 剪枝
    const hit = state.prefix.recordHit(finalUrl);
    if (hit.pruned) {
      state.lastEvent = `前缀 ${hit.prefix} 连续命中超阈值，已剪枝`;
    }

    state.discovered += discovered;
    this.broadcast();
    return {
      status: 'ok',
      httpStatus,
      retryable: false,
      counted: true,
      event: `HTTP ${httpStatus ?? '—'} · ${renderMode} · 链接 ${links.length} · 新增 ${discovered}`,
    };
  }

  /** 建边 + 建节点 + 入队；返回新增节点数 */
  private expandLinks(fromNodeId: string, fromUrl: string, depth: number, links: ExtractLinksResult['links']): number {
    const state = this.state;
    const nodes = this.options.nodes;
    const edges = this.options.edges;
    let created = 0;

    for (const link of links) {
      let normalized;
      try {
        normalized = normalizeUrl(link.url);
      } catch {
        continue;
      }
      if (normalized.scope !== 'http' && normalized.scope !== 'https') continue;

      // 范围判定（dev-spec §0：同域 + 子域 + 跨域白名单）
      const inScope = isInScope(normalized.identityKey, {
        scope: this.preset.scope,
        rootUrl: this.options.rootUrl,
        allowlist: this.preset.allowlist,
      });
      if (!inScope) continue;

      // 护栏：深度、分页、已剪枝前缀
      const childDepth = depth + 1;
      if (childDepth > this.preset.maxDepth) continue;
      if (state.prefix.isPruned(normalized.identityKey) !== null) continue;
      if (!state.pagination.allow(normalized.identityKey)) continue;

      // 节点（identityKey 去重）
      const { created: isNew, node } = nodes.upsert({
        siteId: state.siteId,
        url: normalized.url,
        identityKey: normalized.identityKey,
        parentId: fromNodeId,
        depth: childDepth,
        displayLabel: deriveDisplayLabel({ url: normalized.url }),
      });
      if (isNew) {
        created += 1;
        this.options.listener?.onNodeFound?.({
          id: node.id,
          url: node.url,
          depth: node.depth,
          status: node.status,
          display_label: node.display_label,
        });
      }

      // 边（父节点由首次发现的链接决定，§4）；同一目标不同 fragment 各留一条
      if (!edges.exists(fromNodeId, node.id, link.fragment)) {
        edges.insert({
          siteId: state.siteId,
          fromId: fromNodeId,
          toId: node.id,
          anchorText: link.anchorText.length > 0 ? link.anchorText : null,
          selector: link.selector.length > 0 ? link.selector : null,
          domPath: link.domPath.length > 0 ? link.domPath : null,
          rel: link.rel,
          target: link.target,
          isNofollow: link.isNofollow,
          fragment: link.fragment,
          source: 'auto',
          orderInPage: link.orderInPage,
        });
        nodes.refreshInLinkCount(node.id);
      }

      // 入队（已抓过的节点仍会入队，由 step 里的直连复用判定跳过请求）
      if (isNew && node.status === 'queued') {
        state.frontier.push(state.siteId, node.id, childDepth);
      }
    }
    void fromUrl;
    return created;
  }

  /** 进度快照 */
  progress(): CrawlProgress {
    const state = this.state;
    const counts = state.frontier.stats();
    return {
      siteId: state.siteId,
      taskId: state.taskId,
      status: state.control.current === 'stopped' ? 'stopped' : state.control.current,
      pagesFetched: state.pagesFetched,
      discovered: state.discovered,
      queueLength: counts.pending + counts.running,
      ok: state.ok,
      failed: state.failed,
      skipped: state.skipped,
      lastEvent: state.lastEvent,
      startedAt: Math.floor(state.startedAt / 1000),
      finishedAt: state.finishedAt === null ? null : Math.floor(state.finishedAt / 1000),
      now: nowSec(),
    };
  }

  stats(): ReturnType<CrawlRepo['siteDistribution']> & {
    fetched: number;
    ok: number;
    failed: number;
    skipped: number;
    queued: number;
    retrying: number;
  } {
    const state = this.state;
    const dist = this.options.crawl.siteDistribution(state.siteId, state.taskId);
    const counts = state.frontier.stats();
    return {
      ...dist,
      fetched: state.pagesFetched,
      ok: state.ok,
      failed: state.failed,
      skipped: state.skipped,
      queued: counts.pending + counts.running,
      retrying: counts.pending,
    };
  }

  /** 进度广播节流：默认 400ms，force=true 立即推 */
  private broadcast(force = false): void {
    const listener = this.options.listener;
    if (listener?.onProgress === undefined) return;
    const now = Date.now();
    if (!force && now - this.state.lastBroadcastAt < 400) return;
    this.state.lastBroadcastAt = now;
    listener.onProgress(this.progress());
  }
}
