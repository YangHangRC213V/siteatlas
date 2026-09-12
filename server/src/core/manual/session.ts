/**
 * manual/session.ts —— 手动（引导式）采集会话（dev-spec §6.5）
 *
 * 状态机：
 *   用户在画面里点击 → 页面内注入脚本上报被点元素 → 进入「待配对队列」
 *   → 若紧随其后发生导航：建边（source='manual'）+ 按 identityKey 判定节点身份
 *        · 未知 URL → 新建节点（父 = 点击时所在页节点，深度 = 父深度 + 1）
 *        · 已知 URL（含自环/横链）→ 复用已有节点，只补一条边，不新建、不改父
 *   → 若窗口内没有导航：进「待确认队列」，不污染树（页内锚点/JS 行为/新标签）
 *
 * 身份与深度：
 *   会话维护「当前页面节点」= currentPage；回根/回到已知节点由 identityKey 自动识别，
 *   识别失败时提供「置为根 / 置为父节点」的人工指定兜底（并打 manual_overrides 标记）。
 *
 * 持久化：建节点/建边直接写库（与自动采集同一套表）；凡是人工**指定**父节点或根的操作
 * 记一条 `manual_overrides`（可撤销、可追溯），自动识别到已知节点则只打标记不改父。
 */
import type { NodeRecord, SiteScope, TreeNodeRow } from '@siteatlas/shared';
import type { DatabaseSync } from 'node:sqlite';
import { deriveDisplayLabel } from '../extract/content.ts';
import type { PageSession, MouseInput, KeyInput } from '../fetch/session.ts';
import { normalizeUrl } from '../url/normalize.ts';
import { identityKeyOf } from '../url/identity.ts';
import { EdgesRepo } from '../store/repos/edges.ts';
import { NodesRepo } from '../store/repos/nodes.ts';
import { SitesRepo } from '../store/repos/sites.ts';
import { nowSec, ulid } from '../store/ids.ts';
import { PendingClickQueue, parseCapture, type ClickCapturePayload, type PendingClick } from './capture.ts';
import { ScreencastPump, type ScreencastStats } from './screencast.ts';

export type ManualSessionStatus = 'idle' | 'running' | 'paused' | 'ended';

export type ProgressMode = 'record-only' | 'record-and-expand';

export interface PendingConfirm {
  id: string;
  /** 未配对的点击（页内锚点 / JS 行为 / 新标签 / 未触发导航） */
  payload: ClickCapturePayload;
  fromNodeId: string;
  fromUrl: string;
  /** 可能的目标（href 的规范化身份），供人工确认时参考 */
  candidateUrl: string | null;
  reason: string;
  at: number;
}

export interface ManualEvent {
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface ManualIdentity {
  nodeId: string;
  url: string;
  identityKey: string;
  /** 该节点在树中的有效父节点 */
  parentId: string | null;
  depth: number;
  displayLabel: string | null;
  /** 是否为本次会话新建 */
  fresh: boolean;
}

export interface ManualSessionState {
  sessionId: string;
  siteId: string;
  status: ManualSessionStatus;
  guideEnabled: boolean;
  progressMode: ProgressMode;
  /** 当前页面身份 */
  current: ManualIdentity | null;
  /** 会话起始根（可被「以当前页为根」改写） */
  rootNodeId: string;
  rootUrl: string;
  /** 统计 */
  clicks: { total: number; paired: number; unpaired: number; skippedDuplicate: number };
  nodesCreated: number;
  edgesCreated: number;
  pendingConfirmCount: number;
  screencast: ScreencastStats;
  lastNavigatedUrl: string | null;
  lastError: string | null;
}

export interface SetIdentityResult {
  ok: boolean;
  message: string;
  identity: ManualIdentity | null;
  /** 在 manual_overrides 里记录的标记（人工指定） */
  marker: 'set-root' | 'set-parent' | null;
}

/** 超出该深度的候选节点不再视为「展开一层」的目标 */
const MAX_MANUAL_DEPTH = 50;

export interface ManualSessionDeps {
  db: DatabaseSync;
  siteId: string;
  nodes: NodesRepo;
  edges: EdgesRepo;
  sites: SitesRepo;
  /** 站点根 URL（用于范围判定/展示） */
  siteRootUrl: string;
  siteScope: SiteScope;
  /** 会话起始节点（通常是站点根节点） */
  startNodeId: string;
  sessionId?: string;
  pairingWindowMs?: number;
  maxFps?: number;
  now?: () => number;
  randomId?: () => string;
  /** 帧投递：由 WS 层提供（返回是否真的发出） */
  deliverFrame?: (frame: { data: string; width: number; height: number }) => void;
  onEvent?: (event: ManualEvent) => void;
  onPendingConfirm?: (item: PendingConfirm) => void;
  /** 待确认队列「内容变化」回调（增/删都触发）：WS 层据此把整份队列推给前端 */
  onPendingChanged?: (items: PendingConfirm[]) => void;
  onIdentity?: (identity: ManualIdentity) => void;
}

export class ManualSession {
  readonly id: string;
  private readonly deps: ManualSessionDeps;
  private readonly nodes: NodesRepo;
  private readonly edges: EdgesRepo;
  private readonly sites: SitesRepo;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly queue: PendingClickQueue;
  private readonly pump: ScreencastPump;

  private pageSession: PageSession | null = null;
  private status: ManualSessionStatus = 'idle';
  private progressMode: ProgressMode = 'record-only';
  private rootNodeId: string;
  private rootUrl: string;
  private current: ManualIdentity | null = null;
  private pendingConfirm: PendingConfirm[] = [];
  private events: ManualEvent[] = [];
  private lastNavigatedUrl: string | null = null;
  private lastError: string | null = null;
  private counters = { total: 0, paired: 0, unpaired: 0, skippedDuplicate: 0 };
  private nodesCreated = 0;
  private edgesCreated = 0;
  private closed = false;

  constructor(deps: ManualSessionDeps) {
    this.deps = deps;
    this.nodes = deps.nodes;
    this.edges = deps.edges;
    this.sites = deps.sites;
    this.now = deps.now ?? (() => Date.now());
    this.randomId = deps.randomId ?? (() => ulid());
    this.id = deps.sessionId ?? this.randomId();
    this.queue = new PendingClickQueue({ pairingWindowMs: deps.pairingWindowMs ?? 4000, now: this.now });
    this.pump = new ScreencastPump({ maxFps: deps.maxFps ?? 12, now: this.now });

    const startNode = this.nodes.get(deps.startNodeId);
    if (startNode === null) throw new Error(`会话起始节点不存在：${deps.startNodeId}`);
    this.rootNodeId = startNode.id;
    this.rootUrl = startNode.url;
    this.current = this.identityOf(startNode, false);
  }

  /* ---------------- 生命周期 ---------------- */

  attachPage(pageSession: PageSession): void {
    this.pageSession = pageSession;
  }

  /**
   * 页面 → 会话的回调装配（唯一真源）。
   * 页面必须带着这组 handler 创建，否则点击/导航事件根本不会进到会话
   * （踩过的坑：测试里手工 new FakePageSession() 不带 handler，表现为「点击毫无反应」）。
   */
  pageHandlers(): {
    onFrame: (frame: { data: string; width: number; height: number; sessionId?: number }) => void;
    onNavigated: (url: string) => void;
    onCapture: (payload: unknown) => void;
    onClosed: (reason: string) => void;
  } {
    return {
      onFrame: (frame) => this.handleFrame({ data: frame.data, width: frame.width, height: frame.height }),
      onNavigated: (url) => this.handleNavigated(url),
      onCapture: (payload) => this.handleCapture(payload),
      onClosed: (reason) => {
        this.emit('warn', `页面已关闭：${reason}`);
      },
    };
  }

  /** 开始引导：可带起点 URL（默认当前节点 URL） */
  async start(url?: string): Promise<void> {
    this.status = 'running';
    this.emit('info', '会话已开始');
    if (url !== undefined && url.length > 0) await this.navigate(url);
  }

  pause(): void {
    if (this.status !== 'running') return;
    this.status = 'paused';
    this.emit('info', '已暂停：画面仍可查看，但不再记录点击');
  }

  resume(): void {
    if (this.status !== 'paused') return;
    this.status = 'running';
    this.emit('info', '已继续');
  }

  stop(): void {
    this.status = 'ended';
    this.emit('info', '会话已结束并保存');
  }

  isClosed(): boolean {
    return this.closed;
  }

  /* ---------------- 画面串流 ---------------- */

  handleFrame(frame: { data: string; width: number; height: number }): void {
    if (this.closed) return;
    const deliverable = this.pump.accept(frame);
    if (deliverable !== null) this.deps.deliverFrame?.(deliverable);
  }

  /** 节流窗口结束后把待投递的最新帧推出去（由 WS 层定时调用） */
  flushFrame(): void {
    if (this.closed) return;
    // 顺便把「过了配对窗口仍未发生导航」的点击落到待确认队列
    this.promoteExpiredClicks();
    if (!this.pump.hasPending) return;
    const frame = this.pump.takeLatest();
    if (frame !== null) this.deps.deliverFrame?.(frame);
  }

  /**
   * 配对窗口内没有导航的点击 → 待确认队列（dev-spec §6.5「未触发导航的点击单独标记，确认后再入树」）。
   * 没有这一步，带 href 但被 JS 拦截 / 只改 hash 的点击会安静消失，
   * 界面上的「待确认」永远是 0（踩过的坑，见 DECISIONS.md M3）。
   */
  private promoteExpiredClicks(): void {
    if (this.status !== 'running') return;
    const expired = this.queue.takeExpired();
    for (const click of expired) {
      const href = click.payload.href;
      this.pushPendingConfirm({
        id: this.randomId(),
        payload: click.payload,
        fromNodeId: click.fromNodeId,
        fromUrl: click.fromUrl,
        candidateUrl: href === null ? null : (this.safeNormalize(href)?.url ?? null),
        reason: href === null ? '点击未触发导航' : '点击未触发导航（可能是页内锚点或 JS 行为）',
        at: this.now(),
      });
    }
  }

  /* ---------------- 导航与身份 ---------------- */

  /** 无状态直接导航（§6.2）；导航后重新注入点击捕获脚本 */
  async navigate(url: string, options: { timeoutMs?: number } = {}): Promise<{ ok: boolean; url: string; error: string | null }> {
    if (this.pageSession === null) {
      this.lastError = '会话未绑定浏览器页面';
      this.emit('error', this.lastError);
      return { ok: false, url, error: this.lastError };
    }
    const normalized = this.safeNormalize(url);
    if (normalized === null) {
      this.lastError = `URL 不合法：${url}`;
      this.emit('error', this.lastError);
      return { ok: false, url, error: this.lastError };
    }
    if (!this.inScope(normalized)) {
      this.lastError = `超出站点范围（${this.deps.siteScope}）：${normalized.host}`;
      this.emit('warn', this.lastError);
      return { ok: false, url, error: this.lastError };
    }
    const result = await this.pageSession.navigate(normalized.url, options);
    if (!result.ok) {
      this.lastError = result.error;
      this.emit('error', `导航失败：${result.error ?? '未知错误'}`);
      return { ok: false, url: normalized.url, error: result.error };
    }
    this.lastNavigatedUrl = result.url;
    this.emit('info', `已导航：${result.url}`);
    // 导航完成后立刻按 identityKey 识别当前页面（回根/回到已知节点都在这里发生）
    this.resolveCurrent(result.url, { reason: 'navigate' });
    return { ok: true, url: result.url, error: null };
  }

  /** 页面导航事件（来自 CDP/Playwright）：与待配对点击配对并识别新页面身份 */
  handleNavigated(url: string): void {
    if (this.closed) return;
    this.lastNavigatedUrl = url;
    const paired = this.queue.takeForNavigation();

    if (paired !== null) {
      this.counters.paired += 1;
      this.recordEdgeAndNode(paired, url);
    } else {
      this.emit('warn', `检测到导航但没有可配对的点击：${url}（可能是脚本跳转或地址栏行为）`);
    }
    this.resolveCurrent(url, { reason: 'navigation' });
  }

  /** 识别当前页面身份：已存在则复用（并打「回根/回到已知节点」标记），否则按配对来源新建 */
  private resolveCurrent(url: string, options: { reason: string }): ManualIdentity | null {
    const normalized = this.safeNormalize(url);
    if (normalized === null) {
      this.lastError = `URL 不合法：${url}`;
      return null;
    }
    const existing = this.nodes.findByUrlForSite(this.deps.siteId, normalized.url, normalized.identityKey);
    if (existing !== null) {
      const identity = this.identityOf(existing, false);
      const isRoot = existing.id === this.rootNodeId;
      this.emit(
        'info',
        isRoot
          ? `识别为已回到根节点：${existing.url}`
          : `识别为已知节点：${existing.display_label ?? existing.url}（不新建节点）`,
      );
      this.current = identity;
      this.deps.onIdentity?.(identity);
      return identity;
    }
    // 未配对的导航：页面不在库里，按「当前页面」的子节点兜底挂载（避免节点凭空消失）
    const parent = this.current;
    const created = this.upsertNode({
      url: normalized.url,
      identityKey: normalized.identityKey,
      parentId: parent?.nodeId ?? this.rootNodeId,
      depth: (parent?.depth ?? 0) + 1,
      displayLabel: deriveDisplayLabel({ url: normalized.url }),
      reason: options.reason,
    });
    if (parent !== null) {
      this.linkEdge({
        fromNodeId: parent.nodeId,
        toNodeId: created.id,
        payload: null,
        href: normalized.url,
      });
    }
    const identity = this.identityOf(created, created.__fresh);
    this.current = identity;
    this.deps.onIdentity?.(identity);
    return identity;
  }

  /* ---------------- 点击捕获 ---------------- */

  handleCapture(raw: unknown): void {
    if (this.closed) return;
    if (this.status !== 'running') {
      this.emit('warn', '会话未在记录状态（暂停/已结束），该次点击已忽略');
      return;
    }
    const payload = parseCapture(raw);
    if (payload === null) {
      this.emit('warn', '收到无法解析的页面上报，已忽略');
      return;
    }
    this.counters.total += 1;
    const current = this.current;
    if (current === null) {
      this.emit('warn', '当前页面身份未知，点击已忽略');
      return;
    }

    // 由内到外的「回父/回根」：点击后若命中已知节点，配对逻辑会把它识别为已知节点
    if (payload.href === null) {
      this.pushPendingConfirm({
        id: this.randomId(),
        payload,
        fromNodeId: current.nodeId,
        fromUrl: current.url,
        candidateUrl: null,
        reason: payload.tag === 'a' ? '链接缺少 href' : '被点元素不是链接',
        at: this.now(),
      });
      return;
    }

    this.queue.push({
      payload,
      fromNodeId: current.nodeId,
      fromUrl: current.url,
      fromDepth: current.depth,
    });
    this.emit('info', `记录点击：${payload.anchorText.slice(0, 40) || payload.tag} → ${payload.href}`);
    // 若该 href 的规范化身份已经存在，立即按「回到已知节点」处理，不必等导航事件
    const known = this.findByHref(payload.href);
    if (known !== null) {
      this.counters.skippedDuplicate += 1;
      this.emit('info', `该链接指向已知节点，等导航确认后只补边：${known.display_label ?? known.url}`);
    }
  }

  /** 点击与导航配对的落地：建边（必要时建节点） */
  private recordEdgeAndNode(paired: PendingClick, navigatedUrl: string): void {
    const normalized = this.safeNormalize(navigatedUrl);
    if (normalized === null) {
      this.lastError = `导航目标 URL 不合法：${navigatedUrl}`;
      this.emit('error', this.lastError);
      return;
    }
    const from = this.nodes.get(paired.fromNodeId);
    if (from === null) {
      this.emit('warn', '点击来源节点已不存在，忽略该次配对');
      return;
    }
    const existing = this.nodes.findByUrlForSite(this.deps.siteId, normalized.url, normalized.identityKey);
    const toNode =
      existing ??
      this.upsertNode({
        url: normalized.url,
        identityKey: normalized.identityKey,
        parentId: from.id,
        depth: Math.min(MAX_MANUAL_DEPTH, paired.fromDepth + 1),
        displayLabel: deriveDisplayLabel({ url: normalized.url, title: null }),
        reason: 'click-pairing',
      });
    this.linkEdge({
      fromNodeId: from.id,
      toNodeId: toNode.id,
      payload: paired.payload,
      href: normalized.url,
    });
    if (this.progressMode === 'record-and-expand') {
      this.emit('info', `已记录并展开一层：${normalized.url}`);
    } else {
      this.emit('info', `已记录：${from.display_label ?? from.url} → ${toNode.display_label ?? toNode.url}`);
    }
  }

  private linkEdge(input: {
    fromNodeId: string;
    toNodeId: string;
    payload: ClickCapturePayload | null;
    href: string | null;
  }): boolean {
    const fragment = this.fragmentOf(input.href);
    if (this.edges.exists(input.fromNodeId, input.toNodeId, fragment)) {
      this.counters.skippedDuplicate += 1;
      return false;
    }
    this.edges.insert({
      siteId: this.deps.siteId,
      fromId: input.fromNodeId,
      toId: input.toNodeId,
      anchorText: input.payload?.anchorText !== undefined && input.payload.anchorText.length > 0 ? input.payload.anchorText : null,
      selector: input.payload?.selector !== undefined && input.payload.selector.length > 0 ? input.payload.selector : null,
      domPath: input.payload?.domPath !== undefined && input.payload.domPath.length > 0 ? input.payload.domPath : null,
      rel: input.payload?.rel ?? null,
      target: input.payload?.target ?? null,
      isNofollow: (input.payload?.rel ?? '').toLowerCase().split(/\s+/).includes('nofollow'),
      fragment,
      source: 'manual',
      // 手动采集没有稳定的页内序号，退化为「该页已记录的手动边数」
      orderInPage: this.edges.outgoing(input.fromNodeId, 1000).length,
    });
    this.nodes.refreshInLinkCount(input.toNodeId);
    this.edgesCreated += 1;
    return true;
  }

  private upsertNode(input: {
    url: string;
    identityKey: string;
    parentId: string;
    depth: number;
    displayLabel: string;
    reason: string;
  }): NodeRecord & { __fresh: boolean } {
    const { created, node } = this.nodes.upsert({
      siteId: this.deps.siteId,
      url: input.url,
      identityKey: input.identityKey,
      parentId: input.parentId,
      depth: input.depth,
      displayLabel: input.displayLabel,
      status: 'queued',
    });
    if (created) {
      this.nodesCreated += 1;
      this.emit('info', `新建节点：${input.displayLabel}（父=${this.nodes.get(input.parentId)?.display_label ?? input.parentId}，来源 ${input.reason}）`);
    }
    return { ...node, __fresh: created };
  }

  /** 取本会话所属站点里某个节点的 URL（树视图「查看原始网页」用；跨站返回 null） */
  nodeUrl(nodeId: string): { id: string; url: string; displayLabel: string | null } | null {
    const node = this.nodes.get(nodeId);
    if (node === null || node.site_id !== this.deps.siteId) return null;
    return { id: node.id, url: node.url, displayLabel: node.display_label };
  }

  /* ---------------- 展开一层（§4.3 手动工具条 / §6.5 记录并展开） ---------------- */

  /**
   * 展开一层：在当前页面下虚拟出一个「下一层」，导航过去并建边建节点。
   *
   * 为什么要有这个动作（而不是只靠用户点链接）：
   *   requirements §4.3 的手动模式工具条明确要求「开始-暂停-继续-回根-**展开一层**-结束并保存」。
   *   当页面上的链接被 JS 拦截、或用户想按自己的意图继续深入（例如页面还没做完），
   *   点链接走不通 —— 这时需要一个「我说了算」的推进动作。
   *
   * 地址怎么来：手动模式没有真实的目标地址可用（是用户意图，不是页面上存在的链接），
   * 因此按当前页地址派生一个**可预期的占位地址**：`<当前路径>/siteatlas-expand/<序号>`。
   *   · 只写本地图（节点 + 边），不改站点数据；
   *   · 目标页大概率不存在（404）——这是这个动作的固有语义，记在 node.status='need_human'
   *     并在事件里说清楚：占位节点的地址应当在「修改地址」里改成真实地址。
   *   · 若该占位地址已被占用（重复点），序号自增，保证每次都是新的一层。
   */
  async expandOneLevel(): Promise<{ ok: boolean; message: string; nodeId: string | null; url: string | null }> {
    if (this.status !== 'running') {
      return { ok: false, message: '会话未在记录状态（暂停/已结束），无法展开', nodeId: null, url: null };
    }
    const current = this.current;
    if (current === null) return { ok: false, message: '当前页面身份未知', nodeId: null, url: null };

    const base = this.safeNormalize(current.url);
    if (base === null) return { ok: false, message: `当前地址不合法：${current.url}`, nodeId: null, url: null };

    // 若当前页本身就是占位地址（连续展开），从它的基址继续，避免 /siteatlas-expand/1/siteatlas-expand/1 这种套娃
    const prefix = (base.url.replace(/\/+$/, '').replace(/\/siteatlas-expand\/\d+$/, '') || base.url.replace(/\/+$/, ''));
    let candidate: string | null = null;
    let normalized: ReturnType<typeof this.safeNormalize> = null;
    for (let seq = 1; seq <= 50; seq++) {
      normalized = this.safeNormalize(`${prefix}/siteatlas-expand/${seq}`);
      if (normalized === null) break;
      if (this.nodes.findByUrlForSite(this.deps.siteId, normalized.url, normalized.identityKey) === null) {
        candidate = normalized.url;
        break;
      }
    }
    if (candidate === null || normalized === null) {
      return { ok: false, message: '无法派生占位地址（当前地址形态不支持）', nodeId: null, url: null };
    }
    if (!this.inScope(normalized)) {
      return { ok: false, message: `超出站点范围（${this.deps.siteScope}）：${normalized.host}`, nodeId: null, url: null };
    }

    const node = this.upsertNode({
      url: normalized.url,
      identityKey: normalized.identityKey,
      parentId: current.nodeId,
      depth: Math.min(MAX_MANUAL_DEPTH, current.depth + 1),
      displayLabel: deriveDisplayLabel({ url: normalized.url, title: null }),
      reason: 'expand-one-level',
    });
    // 占位地址不是抓来的页面：标成 need_human，提示用户回来改地址
    this.nodes.setStatus(node.id, 'need_human');
    this.linkEdge({ fromNodeId: current.nodeId, toNodeId: node.id, payload: null, href: normalized.url });
    this.emit('warn', `已展开一层（占位地址 ${normalized.url}）——页面多半不存在，请在树视图里用「修改地址」改成真实地址`);

    // 等导航落地再返回：调用方（WS）随后立刻取 state，若不等就会拿到「展开前」的身份
    await this.navigate(normalized.url);
    return { ok: true, message: `已展开一层：${normalized.url}`, nodeId: node.id, url: normalized.url };
  }

  /* ---------------- 待确认队列与人工指定 ---------------- */

  private pushPendingConfirm(item: PendingConfirm): void {
    this.pendingConfirm.push(item);
    while (this.pendingConfirm.length > 100) this.pendingConfirm.shift();
    this.emit('warn', `待确认：${item.reason}（${item.payload.anchorText.slice(0, 30) || item.payload.tag}）`);
    this.deps.onPendingConfirm?.(item);
    this.deps.onPendingChanged?.(this.listPendingConfirm());
  }

  listPendingConfirm(): PendingConfirm[] {
    return [...this.pendingConfirm];
  }

  /** 人工确认某条待确认点击：把它记成到指定节点的边（不再新建节点） */
  confirmPending(id: string, targetNodeId: string): { ok: boolean; message: string } {
    const index = this.pendingConfirm.findIndex((item) => item.id === id);
    if (index < 0) return { ok: false, message: `待确认项不存在：${id}` };
    const item = this.pendingConfirm[index] as PendingConfirm;
    const target = this.nodes.get(targetNodeId);
    if (target === null) return { ok: false, message: `目标节点不存在：${targetNodeId}` };
    this.linkEdge({ fromNodeId: item.fromNodeId, toNodeId: target.id, payload: item.payload, href: target.url });
    this.pendingConfirm.splice(index, 1);
    this.emit('info', `人工确认：${item.payload.anchorText.slice(0, 30)} → ${target.display_label ?? target.url}`);
    this.deps.onPendingChanged?.(this.listPendingConfirm());
    return { ok: true, message: '已按人工确认记录边' };
  }

  discardPending(id: string): { ok: boolean } {
    const index = this.pendingConfirm.findIndex((item) => item.id === id);
    if (index < 0) return { ok: false };
    this.pendingConfirm.splice(index, 1);
    this.emit('info', '已丢弃该待确认项');
    this.deps.onPendingChanged?.(this.listPendingConfirm());
    return { ok: true };
  }

  /** 「以当前页为根」：改会话根（不影响整站根节点），并打 manual_overrides 标记 */
  setCurrentAsRoot(): SetIdentityResult {
    const current = this.current;
    if (current === null) return { ok: false, message: '当前页面身份未知', identity: null, marker: null };
    this.rootNodeId = current.nodeId;
    this.rootUrl = current.url;
    this.recordManualMarker(current.nodeId, 'set-root', this.rootNodeId);
    this.emit('info', `已把当前页设为会话根：${current.url}`);
    return { ok: true, message: '已设为会话根', identity: current, marker: 'set-root' };
  }

  /** 「置为父节点」：把当前页人工指定为某节点的父（识别失败的兜底） */
  setCurrentAsParentOf(nodeId: string): SetIdentityResult {
    const current = this.current;
    if (current === null) return { ok: false, message: '当前页面身份未知', identity: null, marker: null };
    const child = this.nodes.get(nodeId);
    if (child === null) return { ok: false, message: `节点不存在：${nodeId}`, identity: null, marker: null };
    /*
     * 防环：把 X 的父设为当前页 P 时，只要求「X 是 P 的祖先」（祖先链包含自身），
     * 即环会变成 P→…→X→P。注意链包含 P 自身：
     * X = P 的子孙（P 是 X 的祖先）是允许的，人工指定父节点最常见的场景就是「把某个游离节点挂到当前页下」。
     */
    const seen = new Set<string>();
    let cursor: string | null = current.nodeId;
    while (cursor !== null && !seen.has(cursor)) {
      if (cursor === child.id) {
        return { ok: false, message: '目标节点是当前页的祖先，会形成环', identity: current, marker: null };
      }
      seen.add(cursor);
      cursor = this.nodes.get(cursor)?.auto_parent_id ?? null;
    }
    this.nodes.applyAutoParent(child.id, current.nodeId);
    this.recordManualMarker(child.id, 'set-parent', current.nodeId);
    this.emit('info', `已把 ${child.display_label ?? child.url} 的父节点人工指定为当前页`);
    return { ok: true, message: '已人工指定父节点', identity: current, marker: 'set-parent' };
  }

  /** 回根/回父：一次绝对 URL 导航（§6.2，不使用前进/后退） */
  async backToRoot(): Promise<{ ok: boolean; url: string }> {
    const root = this.nodes.get(this.rootNodeId);
    if (root === null) return { ok: false, url: this.rootUrl };
    const result = await this.navigate(root.url);
    return { ok: result.ok, url: result.url };
  }

  async backToParent(): Promise<{ ok: boolean; url: string }> {
    const parentId = this.current?.parentId ?? null;
    if (parentId === null) return this.backToRoot();
    const parent = this.nodes.get(parentId);
    if (parent === null) return this.backToRoot();
    const result = await this.navigate(parent.url);
    return { ok: result.ok, url: result.url };
  }

  setProgressMode(mode: ProgressMode): void {
    this.progressMode = mode;
    this.emit('info', mode === 'record-and-expand' ? '模式：记录并展开一层' : '模式：仅记录');
  }

  /* ---------------- 输入回传 ---------------- */

  async dispatchMouse(input: MouseInput): Promise<void> {
    if (this.pageSession === null) return;
    await this.pageSession.dispatchMouse(input);
  }

  async dispatchKey(input: KeyInput): Promise<void> {
    if (this.pageSession === null) return;
    await this.pageSession.dispatchKey(input);
  }

  /** 读远端页面里某个元素的位置（用于自动化验收与「点这里」的坐标提示） */
  async elementBox(selector: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
    return (await this.pageSession?.elementBox(selector)) ?? null;
  }

  /* ---------------- 状态与收尾 ---------------- */

  /** 浏览器页面视口（画面串流的坐标系基准） */
  pageViewport(): { width: number; height: number } {
    return this.pageSession?.viewport ?? { width: 1280, height: 800 };
  }

  state(): ManualSessionState {
    return {
      sessionId: this.id,
      siteId: this.deps.siteId,
      status: this.status,
      guideEnabled: this.pageSession !== null,
      progressMode: this.progressMode,
      current: this.current,
      rootNodeId: this.rootNodeId,
      rootUrl: this.rootUrl,
      clicks: { ...this.counters },
      nodesCreated: this.nodesCreated,
      edgesCreated: this.edgesCreated,
      pendingConfirmCount: this.pendingConfirm.length,
      screencast: this.pump.stats(),
      lastNavigatedUrl: this.lastNavigatedUrl,
      lastError: this.lastError,
    };
  }

  recentEvents(limit = 50): ManualEvent[] {
    return this.events.slice(-limit);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.status = 'ended';
    await this.pageSession?.close().catch(() => undefined);
    this.pageSession = null;
  }

  /* ---------------- 内部工具 ---------------- */

  private emit(level: ManualEvent['level'], message: string): void {
    const event: ManualEvent = { at: this.now(), level, message };
    this.events.push(event);
    while (this.events.length > 400) this.events.shift();
    this.deps.onEvent?.(event);
  }

  private safeNormalize(url: string): ReturnType<typeof normalizeUrl> | null {
    try {
      return normalizeUrl(url);
    } catch {
      return null;
    }
  }

  private inScope(normalized: ReturnType<typeof normalizeUrl>): boolean {
    const rootHost = this.safeNormalize(this.deps.siteRootUrl)?.normalizedHost ?? normalized.normalizedHost;
    switch (this.deps.siteScope) {
      case 'all':
        return true;
      case 'same_domain':
        return normalized.normalizedHost === rootHost;
      case 'allowlist':
      case 'same_site':
      default:
        return (
          normalized.normalizedHost === rootHost || normalized.normalizedHost.endsWith(`.${rootHost}`)
        );
    }
  }

  private findByHref(href: string): (NodeRecord & TreeNodeRow) | null {
    const normalized = this.safeNormalize(href);
    if (normalized === null) return null;
    const node = this.nodes.findByUrlForSite(this.deps.siteId, normalized.url, normalized.identityKey);
    return node as (NodeRecord & TreeNodeRow) | null;
  }

  private fragmentOf(href: string | null): string | null {
    if (href === null) return null;
    try {
      const hash = new URL(href).hash;
      return hash.length > 1 ? hash.slice(1) : null;
    } catch {
      return null;
    }
  }

  private identityOf(node: NodeRecord, fresh: boolean): ManualIdentity {
    const parentRow = this.deps.db
      .prepare('SELECT effective_parent_id FROM v_nodes_effective WHERE id = ?')
      .get(node.id) as Record<string, unknown> | undefined;
    const parentId = parentRow === undefined ? null : ((parentRow['effective_parent_id'] as string | null) ?? null);
    return {
      nodeId: node.id,
      url: node.url,
      identityKey: node.identity_key,
      parentId,
      depth: node.depth,
      displayLabel: node.display_label,
      fresh,
    };
  }

  private recordManualMarker(nodeId: string, kind: 'set-root' | 'set-parent', value: string): void {
    this.deps.db
      .prepare(
        `INSERT INTO manual_overrides (id, site_id, session_id, node_id, kind, value, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      // id 用真 ULID：单调递增可排序（randomId 在测试里是随机的，不能拿来当排序键）
      .run(ulid(), this.deps.siteId, this.id, nodeId, kind, value, nowSec());
  }

  /** identityKey 工具（供状态展示） */
  static identityOfUrl(url: string): string | null {
    try {
      return identityKeyOf(url);
    } catch {
      return null;
    }
  }
}
