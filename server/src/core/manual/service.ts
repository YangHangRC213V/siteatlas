/**
 * manual/service.ts —— 手动采集会话管理（dev-spec §6.5 / §5.2）
 *
 * 一个站点同时只允许一个手动会话；会话持有浏览器页面 + CDP 连接，
 * 生命周期由 API 控制（POST 开始 / POST 停止 / WS 断开不自动结束）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { BrowserPool } from '../fetch/pool.ts';
import { openChromiumSession, type PageSession } from '../fetch/session.ts';
import { EdgesRepo } from '../store/repos/edges.ts';
import { NodesRepo } from '../store/repos/nodes.ts';
import { SitesRepo } from '../store/repos/sites.ts';
import { ManualSession, type ManualEvent, type ManualSessionState, type PendingConfirm } from './session.ts';

export class ManualError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ManualError';
    this.code = code;
    this.status = status;
  }
}

/** 会话关闭回调：正常情况下是「页面自己关了 → 结束会话」，主动关闭时被替换成空实现防重入 */
export interface PageSessionLike {
  onClose(handler: (reason: string) => void): void;
}

export interface ManualServiceDeps {
  db: DatabaseSync;
  sites: SitesRepo;
  nodes: NodesRepo;
  edges: EdgesRepo;
  pool: BrowserPool;
  /** 测试注入：会话工厂（默认走真实 Playwright + CDP） */
  createPageSession?: (options: {
    id: string;
    pool: BrowserPool;
    viewport: { width: number; height: number };
    handlers: Parameters<typeof openChromiumSession>[0]['handlers'];
  }) => Promise<PageSession>;
  /** 帧投递回调注册：WS 层订阅后由会话把帧推出去 */
  onFrameSubscriber?: (sessionId: string, deliver: (frame: { data: string; width: number; height: number }) => void) => void;
}

export interface StartedManualSession {
  session: ManualSession;
  state: ManualSessionState;
}

interface ActiveManual {
  session: ManualSession;
  page: PageSession | null;
  deliverFrame: ((frame: { data: string; width: number; height: number }) => void) | null;
  frameTimer: ReturnType<typeof setInterval> | null;
}

export interface StartManualOptions {
  siteId: string;
  startNodeId?: string;
  url?: string;
  viewport?: { width: number; height: number };
  progressMode?: 'record-only' | 'record-and-expand';
  onEvent?: (event: ManualEvent) => void;
  onPendingConfirm?: (item: PendingConfirm) => void;
  onIdentity?: (identity: NonNullable<ManualSessionState['current']>) => void;
}

export class ManualService {
  private readonly deps: ManualServiceDeps;
  private readonly sessions = new Map<string, ActiveManual>();

  constructor(deps: ManualServiceDeps) {
    this.deps = deps;
  }

  get(sessionId: string): ActiveManual | undefined {
    return this.sessions.get(sessionId);
  }

  list(): ManualSessionState[] {
    return [...this.sessions.values()].map((entry) => entry.session.state());
  }

  /** 某站点当前是否有手动会话 */
  activeForSite(siteId: string): ManualSessionState | null {
    for (const entry of this.sessions.values()) {
      const state = entry.session.state();
      if (state.siteId === siteId && state.status !== 'ended') return state;
    }
    return null;
  }

  /**
   * 启动手动采集会话。
   * 浏览器不可用时返回 503（前端提示先装 Chromium），而不是抛 500。
   */
  async start(options: StartManualOptions): Promise<StartedManualSession> {
    const site = this.deps.sites.get(options.siteId);
    if (site === null) throw new ManualError('SITE_NOT_FOUND', `站点不存在：${options.siteId}`, 404);

    const existing = this.activeForSite(options.siteId);
    if (existing !== null) {
      throw new ManualError('MANUAL_ALREADY_RUNNING', `该站点已有手动会话：${existing.sessionId}`, 409);
    }

    const startNodeId = options.startNodeId ?? this.deps.nodes.root(options.siteId)?.id;
    if (startNodeId === undefined || startNodeId === null) {
      throw new ManualError('ROOT_NODE_MISSING', '站点缺少根节点，无法开始手动采集', 409);
    }
    const startNode = this.deps.nodes.get(startNodeId);
    if (startNode === null) throw new ManualError('NODE_NOT_FOUND', `起始节点不存在：${startNodeId}`, 404);

    const viewport = options.viewport ?? { width: 1280, height: 800 };
    const session = new ManualSession({
      db: this.deps.db,
      siteId: options.siteId,
      nodes: this.deps.nodes,
      edges: this.deps.edges,
      sites: this.deps.sites,
      siteRootUrl: site.root_url,
      siteScope: site.scope,
      startNodeId,
      ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
      ...(options.onPendingConfirm !== undefined ? { onPendingConfirm: options.onPendingConfirm } : {}),
      ...(options.onIdentity !== undefined ? { onIdentity: options.onIdentity } : {}),
      deliverFrame: (frame) => this.sessions.get(session.id)?.deliverFrame?.(frame),
    });
    if (options.progressMode !== undefined) session.setProgressMode(options.progressMode);

    const entry: ActiveManual = { session, page: null, deliverFrame: null, frameTimer: null };
    this.sessions.set(session.id, entry);

    // 打开浏览器页面（不可用则回滚，不留半死会话）
    try {
      const factory = this.deps.createPageSession;
      const page =
        factory !== undefined
          ? await factory({
              id: session.id,
              pool: this.deps.pool,
              viewport,
              handlers: this.handlersFor(session),
            })
          : await this.openRealPageSession(session.id, viewport, this.handlersFor(session));
      entry.page = page;
      session.attachPage(page);
      await page.startScreencast({ quality: 60, maxWidth: viewport.width, maxHeight: viewport.height });
      // 帧节流：定期把待投递的最新帧推给 WS（无订阅者时自动跳过）
      entry.frameTimer = setInterval(() => session.flushFrame(), 80);
      if (typeof entry.frameTimer === 'object' && entry.frameTimer !== null && 'unref' in entry.frameTimer) {
        (entry.frameTimer as unknown as { unref(): void }).unref();
      }
    } catch (err) {
      this.sessions.delete(session.id);
      throw new ManualError(
        'BROWSER_UNAVAILABLE',
        `无法启动浏览器页面：${(err as Error).message}（Playwright 浏览器是否已安装？）`,
        503,
      );
    }

    await session.start(options.url);
    return { session, state: session.state() };
  }

  private handlersFor(session: ManualSession): Parameters<typeof openChromiumSession>[0]['handlers'] {
    const handlers = session.pageHandlers();
    return {
      ...handlers,
      onClosed: (reason) => {
        void this.stop(session.id, reason);
      },
    };
  }

  private async openRealPageSession(
    id: string,
    viewport: { width: number; height: number },
    handlers: Parameters<typeof openChromiumSession>[0]['handlers'],
  ): Promise<PageSession> {
    const browser = await this.deps.pool.acquire();
    if (browser === null) {
      throw new Error(this.deps.pool.lastLaunchError ?? '浏览器不可用');
    }
    return openChromiumSession({ id, browser, viewport, ...(handlers !== undefined ? { handlers } : {}) });
  }

  /** WS 订阅帧：注册投递回调 */
  setFrameSink(sessionId: string, deliver: ((frame: { data: string; width: number; height: number }) => void) | null): boolean {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return false;
    entry.deliverFrame = deliver;
    return true;
  }

  async stop(sessionId: string, reason = '用户结束会话'): Promise<ManualSessionState | null> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return null;
    // 先从表里摘掉：页面关闭会回调 onClosed，若不先摘掉会变成 stop → close → onClosed → stop 的无限递归
    this.sessions.delete(sessionId);
    if (entry.frameTimer !== null) clearInterval(entry.frameTimer);
    entry.session.stop();
    await entry.session.close();
    const state = entry.session.state();
    return { ...state, lastError: null };
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.stop(id, '服务关闭');
  }

  /** 会话未找到时的统一错误 */
  require(sessionId: string): ActiveManual {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) throw new ManualError('SESSION_NOT_FOUND', `手动会话不存在：${sessionId}`, 404);
    return entry;
  }
}
