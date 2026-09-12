/**
 * core/crawl/service.ts —— 采集任务用例层（dev-spec §5.1 /api/sites/:id/crawl*）
 *
 * 一个站点同时只允许一个活动任务（running/paused）；启动时把根节点入队，
 * 任务状态与队列全部落库，支持暂停/继续/停止与重启续跑（§6.6）。
 */
import {
  DEFAULT_CRAWL_PRESET,
  RENDER_MODES,
  SITE_SCOPES,
  type CrawlPreset,
  type CrawlProgress,
  type CrawlStats,
  type CrawlTaskRecord,
  type SiteScope,
} from '@siteatlas/shared';
import type { DatabaseSync } from 'node:sqlite';
import type { BrowserPool } from '../fetch/pool.ts';
import type { MaterialsArchiver } from '../materials/archive.ts';
import { CrawlRepo } from '../store/repos/crawl.ts';
import { EdgesRepo } from '../store/repos/edges.ts';
import { NodesRepo } from '../store/repos/nodes.ts';
import { SitesRepo } from '../store/repos/sites.ts';
import { CrawlControl } from './control.ts';
import { Scheduler, type CrawlListener, type CrawlResult } from './scheduler.ts';

export class CrawlError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'CrawlError';
    this.code = code;
    this.status = status;
  }
}

export interface CrawlServiceDeps {
  db: DatabaseSync;
  sites: SitesRepo;
  nodes: NodesRepo;
  edges: EdgesRepo;
  crawl: CrawlRepo;
  pool: BrowserPool;
  /**
   * 素材归档器（§6.7 三档数据）：抓到 HTML 后写 raw/ 原件与 parsed/ 解析结果。
   * 未注入时采集照常，只是不留素材档（单元测试多数不需要）。
   */
  archiver?: MaterialsArchiver;
  /**
   * 默认抓取预设的来源（全局设置）。调用方没显式传值时就落在这里，
   * 这样「设置里改了默认限速/并发」对下一次采集立即生效（§4.7）。
   */
  defaultPreset?: () => CrawlPreset;
  /** 是否归档解析结果（设置项 archiveMaterials，默认开） */
  archiveMaterials?: () => boolean;
}

interface ActiveRun {
  taskId: string;
  siteId: string;
  control: CrawlControl;
  scheduler: Scheduler;
  promise: Promise<CrawlResult>;
  lastProgress: CrawlProgress;
}

/** 校验并合并 preset（越界值一律夹到合法区间，避免把站点压垮） */
export function resolvePreset(input: Partial<CrawlPreset> | undefined, siteScope: SiteScope, fallback: CrawlPreset = DEFAULT_CRAWL_PRESET): CrawlPreset {
  // 站点自身的 scope 是默认值：未显式传 preset.scope 时跟随站点设置
  const merged: CrawlPreset = { ...fallback, scope: siteScope, ...(input ?? {}) };
  const clamp = (value: number, min: number, max: number, dflt: number): number =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : dflt;
  merged.concurrency = clamp(merged.concurrency, 1, 32, fallback.concurrency);
  merged.maxDepth = clamp(merged.maxDepth, 0, 20, fallback.maxDepth);
  merged.maxPages = clamp(merged.maxPages, 1, 1_000_000, fallback.maxPages);
  merged.minDelayMs = clamp(merged.minDelayMs, 0, 60000, fallback.minDelayMs);
  merged.jitterMs = clamp(merged.jitterMs, 0, 10000, fallback.jitterMs);
  merged.timeoutMs = clamp(merged.timeoutMs, 1000, 120000, fallback.timeoutMs);
  merged.maxRetries = clamp(merged.maxRetries, 0, 10, fallback.maxRetries);
  merged.retryBackoffMs = clamp(merged.retryBackoffMs, 0, 60000, fallback.retryBackoffMs);
  merged.retryBackoffMaxMs = clamp(merged.retryBackoffMaxMs, 0, 600000, fallback.retryBackoffMaxMs);
  merged.perHostConcurrency = clamp(merged.perHostConcurrency, 1, 16, fallback.perHostConcurrency);
  merged.visitLimit = clamp(merged.visitLimit, 1, 100, fallback.visitLimit);
  merged.prefixPruneThreshold = clamp(merged.prefixPruneThreshold, 1, 10000, fallback.prefixPruneThreshold);
  merged.paginationPageLimit = clamp(merged.paginationPageLimit, 1, 10000, fallback.paginationPageLimit);
  merged.scope = (SITE_SCOPES as readonly string[]).includes(merged.scope) ? merged.scope : siteScope;
  merged.renderMode = (RENDER_MODES as readonly string[]).includes(merged.renderMode) ? merged.renderMode : 'auto';
  merged.allowlist = Array.isArray(merged.allowlist) ? merged.allowlist.filter((s) => typeof s === 'string') : [];
  if (typeof merged.userAgent !== 'string' || merged.userAgent.trim().length === 0) {
    merged.userAgent = fallback.userAgent;
  }
  return merged;
}

export class CrawlService {
  private readonly deps: CrawlServiceDeps;
  private readonly runs = new Map<string, ActiveRun>();

  constructor(deps: CrawlServiceDeps) {
    this.deps = deps;
  }

  /** 进程启动时复位上次遗留的 running 队列（§6.6） */
  recover(): number {
    return this.deps.crawl.recoverStaleQueue();
  }

  activeRun(siteId: string): ActiveRun | undefined {
    return this.runs.get(siteId);
  }

  progressOf(siteId: string): CrawlProgress | null {
    const run = this.runs.get(siteId);
    if (run !== undefined) return run.scheduler.progress();
    const task = this.deps.crawl.latestTask(siteId);
    if (task === null) return null;
    const stats = this.deps.crawl.taskSummary(task.id);
    const counts = this.deps.crawl.queueCounts(task.id);
    return {
      siteId,
      taskId: task.id,
      status: task.status,
      pagesFetched: stats.fetched,
      discovered: this.deps.nodes.count(siteId),
      queueLength: (counts['pending'] ?? 0) + (counts['running'] ?? 0),
      ok: stats.ok,
      failed: stats.failed,
      skipped: counts['skipped'] ?? 0,
      lastEvent: task.status === 'running' ? null : `任务已结束（${task.status}）`,
      startedAt: task.started_at,
      finishedAt: task.finished_at,
      now: Math.floor(Date.now() / 1000),
    };
  }

  statusOf(siteId: string): { task: CrawlTaskRecord | null; progress: CrawlProgress | null; stats: CrawlStats | null } {
    const task = this.deps.crawl.latestTask(siteId);
    const progress = this.progressOf(siteId);
    if (task === null) return { task: null, progress, stats: null };
    const dist = this.deps.crawl.siteDistribution(siteId, task.id);
    const counts = this.deps.crawl.queueCounts(task.id);
    const summary = this.deps.crawl.taskSummary(task.id);
    const stats: CrawlStats = {
      fetched: summary.fetched,
      ok: summary.ok,
      failed: summary.failed,
      skipped: counts['skipped'] ?? 0,
      queued: (counts['pending'] ?? 0) + (counts['running'] ?? 0),
      retrying: counts['pending'] ?? 0,
      depthDistribution: dist.depthDistribution,
      statusCounts: dist.statusCounts,
    };
    return { task, progress, stats };
  }

  listTasks(siteId: string): CrawlTaskRecord[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM crawl_tasks WHERE site_id = ? ORDER BY started_at DESC, id DESC LIMIT 20')
      .all(siteId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row['id']),
      site_id: String(row['site_id']),
      preset_json: String(row['preset_json']),
      status: row['status'] as CrawlTaskRecord['status'],
      stats_json: (row['stats_json'] as string | null) ?? null,
      started_at: row['started_at'] === null ? null : Number(row['started_at']),
      finished_at: row['finished_at'] === null ? null : Number(row['finished_at']),
    }));
  }

  recentLogs(siteId: string, limit = 20): ReturnType<CrawlRepo['recentLogs']> {
    const task = this.deps.crawl.latestTask(siteId);
    if (task === null) return [];
    return this.deps.crawl.recentLogs(task.id, limit);
  }

  /** 启动自动采集（dev-spec §5.1 POST /api/sites/:id/crawl） */
  start(siteId: string, presetInput?: Partial<CrawlPreset>, listener?: CrawlListener): { task: CrawlTaskRecord; preset: CrawlPreset } {
    const site = this.deps.sites.get(siteId);
    if (site === null) throw new CrawlError('SITE_NOT_FOUND', `站点不存在：${siteId}`, 404);
    if (site.archived === 1) throw new CrawlError('SITE_ARCHIVED', '站点已归档（软删），请先恢复再采集', 409);

    const existing = this.runs.get(siteId);
    if (existing !== undefined) {
      throw new CrawlError('CRAWL_ALREADY_RUNNING', `该站点已有进行中的任务（${existing.taskId}）`, 409);
    }

    const root = this.deps.nodes.root(siteId);
    if (root === null) throw new CrawlError('ROOT_NODE_MISSING', '站点缺少根节点，无法采集', 409);

    const preset = resolvePreset(presetInput, site.scope, this.deps.defaultPreset?.() ?? DEFAULT_CRAWL_PRESET);
    // 站点范围以站点记录为准（除非显式传入 preset.scope）
    if (presetInput?.scope === undefined) preset.scope = site.scope;
    if (preset.scope === 'allowlist' && preset.allowlist.length === 0) {
      const fromSite = JSON.parse(site.allowlist_json) as string[];
      preset.allowlist = fromSite;
    }

    const task = this.deps.crawl.createTask(siteId, preset);
    // 根节点先入队（若尚未抓取）
    this.deps.crawl.enqueue(task.id, siteId, root.id, 0, 0);

    const control = new CrawlControl();
    const scheduler = new Scheduler({
      taskId: task.id,
      siteId,
      rootUrl: site.root_url,
      preset,
      crawl: this.deps.crawl,
      nodes: this.deps.nodes,
      edges: this.deps.edges,
      pool: this.deps.pool,
      control,
      listener: this.withArchiver(listener),
    });

    const promise = scheduler.start().finally(() => {
      if (this.runs.get(siteId)?.taskId === task.id) this.runs.delete(siteId);
    });

    this.runs.set(siteId, {
      taskId: task.id,
      siteId,
      control,
      scheduler,
      promise,
      lastProgress: scheduler.progress(),
    });

    // 后台跑，接口立即返回任务 id（进度走 WS / 轮询）
    void promise.catch(() => undefined);
    return { task, preset };
  }

  pause(siteId: string): CrawlTaskRecord {
    const run = this.requireRun(siteId);
    run.control.pause();
    this.deps.crawl.setTaskStatus(run.taskId, 'paused');
    return this.requireTask(run.taskId);
  }

  resume(siteId: string): CrawlTaskRecord {
    const run = this.runs.get(siteId);
    if (run === undefined) {
      // 进程重启后的续跑：复用最近一个 paused 任务（§6.6）
      const task = this.deps.crawl.activeTask(siteId);
      if (task === null || task.status !== 'paused') {
        throw new CrawlError('CRAWL_NOT_RUNNING', '没有可继续的任务', 409);
      }
      const preset = JSON.parse(task.preset_json) as CrawlPreset;
      const site = this.deps.sites.get(siteId);
      if (site === null) throw new CrawlError('SITE_NOT_FOUND', `站点不存在：${siteId}`, 404);
      const control = new CrawlControl();
      const scheduler = new Scheduler({
        taskId: task.id,
        siteId,
        rootUrl: site.root_url,
        preset,
        crawl: this.deps.crawl,
        nodes: this.deps.nodes,
        edges: this.deps.edges,
        pool: this.deps.pool,
        control,
        listener: this.withArchiver(undefined),
      });
      this.deps.crawl.setTaskStatus(task.id, 'running');
      const promise = scheduler.start().finally(() => {
        if (this.runs.get(siteId)?.taskId === task.id) this.runs.delete(siteId);
      });
      this.runs.set(siteId, { taskId: task.id, siteId, control, scheduler, promise, lastProgress: scheduler.progress() });
      void promise.catch(() => undefined);
      return this.requireTask(task.id);
    }
    run.control.resume();
    this.deps.crawl.setTaskStatus(run.taskId, 'running');
    return this.requireTask(run.taskId);
  }

  /** 停止并等待收尾：接口返回时任务已终结、站点不再 busy */
  async stop(siteId: string): Promise<CrawlTaskRecord> {
    const run = this.requireRun(siteId);
    run.control.stop();
    this.deps.crawl.releaseRunning(run.taskId);
    this.deps.crawl.setTaskStatus(run.taskId, 'stopped');
    await run.promise.catch(() => undefined);
    if (this.runs.get(siteId)?.taskId === run.taskId) this.runs.delete(siteId);
    return this.requireTask(run.taskId);
  }

  /** 等待任务结束（测试与 CLI 用） */
  async wait(siteId: string): Promise<CrawlResult | null> {
    const run = this.runs.get(siteId);
    if (run === undefined) return null;
    return await run.promise;
  }

  /** 优雅关闭：停止所有活动任务并等待其收尾 */
  async stopAll(): Promise<void> {
    const runs = [...this.runs.values()];
    for (const run of runs) {
      run.control.stop();
      this.deps.crawl.releaseRunning(run.taskId);
      this.deps.crawl.setTaskStatus(run.taskId, 'stopped');
    }
    await Promise.allSettled(runs.map((run) => run.promise));
    this.runs.clear();
  }

  busy(siteId: string): boolean {
    return this.runs.has(siteId);
  }

  /**
   * 把「素材归档」和调用方传入的 listener 合成一个 listener。
   * 归档只在拿到 HTML 时触发（含渲染回落与内容重复页），写 raw/parsed 三档数据。
   */
  private withArchiver(listener: CrawlListener | undefined): CrawlListener {
    const archiver = this.deps.archiver;
    const passthrough: CrawlListener = { ...(listener ?? {}) };
    if (archiver === undefined) return passthrough;
    // 解析结果档案可以关（设置项 archiveMaterials）：关掉时不写 parsed/
    const archiveParsed = this.deps.archiveMaterials?.() ?? true;
    const original = listener?.onPageFetched;
    return {
      ...passthrough,
      onPageFetched: (page) => {
        if (!archiveParsed) return original?.(page);
        archiver.archivePage({
          siteId: page.siteId,
          nodeId: page.nodeId,
          url: page.url,
          html: page.html,
          rendered: page.rendered,
          httpStatus: page.httpStatus,
          contentType: page.contentType,
          // 原件开关跟随抓取预设的 downloadAssets（§4.4 / §6.7）
          storeRaw: page.storeRaw,
        });
        original?.(page);
      },
    };
  }

  private requireRun(siteId: string): ActiveRun {
    const run = this.runs.get(siteId);
    if (run === undefined) throw new CrawlError('CRAWL_NOT_RUNNING', '该站点当前没有进行中的任务', 409);
    return run;
  }

  private requireTask(taskId: string): CrawlTaskRecord {
    const task = this.deps.crawl.getTask(taskId);
    if (task === null) throw new CrawlError('TASK_NOT_FOUND', `任务不存在：${taskId}`, 404);
    return task;
  }
}
