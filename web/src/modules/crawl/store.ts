/**
 * 采集模块状态（Zustand）：preset 表单 + 任务进度 + WS 实时推送
 *
 * 进度优先级：WS 推送 > 轮询兜底。WS 断开时退化为 1.5s 轮询，
 * 保证「实时进度」在 ws 被中间层掐断时依然可信（dev-spec §8 风险对策）。
 */
import { create } from 'zustand';
import { DEFAULT_CRAWL_PRESET, type CrawlPreset, type CrawlProgress, type CrawlStats, type CrawlTaskRecord, type CrawlSocketMessage } from '@siteatlas/shared';
import { CrawlApiError, crawlApi, type CrawlStatusResponse } from './api.ts';

export type CrawlFormState = Pick<
  CrawlPreset,
  | 'maxDepth'
  | 'maxPages'
  | 'scope'
  | 'allowlist'
  | 'concurrency'
  | 'minDelayMs'
  | 'jitterMs'
  | 'timeoutMs'
  | 'maxRetries'
  | 'renderMode'
  | 'respectRobots'
  | 'perHostConcurrency'
  | 'userAgent'
  | 'visitLimit'
  | 'paginationPageLimit'
>;

export type SocketState = 'idle' | 'connecting' | 'open' | 'closed';

export interface CrawlStoreState {
  siteId: string | null;
  form: CrawlFormState;
  task: CrawlTaskRecord | null;
  progress: CrawlProgress | null;
  stats: CrawlStats | null;
  logs: CrawlStatusResponse['recentLogs'];
  wsSubscribers: number;
  socketState: SocketState;
  loading: boolean;
  error: string | null;
  actionError: string | null;

  socket: WebSocket | null;
  pollTimer: ReturnType<typeof setInterval> | null;

  bind: (siteId: string, siteScope?: CrawlPreset['scope'], siteAllowlist?: string[]) => Promise<void>;
  unbind: () => void;
  setForm: <K extends keyof CrawlFormState>(key: K, value: CrawlFormState[K]) => void;
  resetForm: () => void;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  refresh: () => Promise<void>;
  connectSocket: () => void;
  disconnectSocket: () => void;
}

const defaultForm = (): CrawlFormState => ({
  maxDepth: DEFAULT_CRAWL_PRESET.maxDepth,
  maxPages: 1000,
  scope: DEFAULT_CRAWL_PRESET.scope,
  allowlist: [],
  concurrency: DEFAULT_CRAWL_PRESET.concurrency,
  minDelayMs: DEFAULT_CRAWL_PRESET.minDelayMs,
  jitterMs: DEFAULT_CRAWL_PRESET.jitterMs,
  timeoutMs: DEFAULT_CRAWL_PRESET.timeoutMs,
  maxRetries: DEFAULT_CRAWL_PRESET.maxRetries,
  renderMode: DEFAULT_CRAWL_PRESET.renderMode,
  respectRobots: DEFAULT_CRAWL_PRESET.respectRobots,
  perHostConcurrency: DEFAULT_CRAWL_PRESET.perHostConcurrency,
  userAgent: DEFAULT_CRAWL_PRESET.userAgent,
  visitLimit: DEFAULT_CRAWL_PRESET.visitLimit,
  paginationPageLimit: DEFAULT_CRAWL_PRESET.paginationPageLimit,
});

export const useCrawlStore = create<CrawlStoreState>((set, get) => ({
  siteId: null,
  form: defaultForm(),
  task: null,
  progress: null,
  stats: null,
  logs: [],
  wsSubscribers: 0,
  socketState: 'idle',
  loading: false,
  error: null,
  actionError: null,
  socket: null,
  pollTimer: null,

  async bind(siteId, siteScope, siteAllowlist) {
    const previous = get().siteId;
    if (previous !== null && previous !== siteId) {
      get().unbind();
      set({ form: defaultForm() });
    }
    if (siteScope !== undefined) set({ form: { ...get().form, scope: siteScope } });
    if (siteAllowlist !== undefined && siteAllowlist.length > 0) {
      set({ form: { ...get().form, allowlist: siteAllowlist } });
    }
    set({ siteId });
    await get().refresh();
    get().connectSocket();
  },

  unbind() {
    get().disconnectSocket();
    const timer = get().pollTimer;
    if (timer !== null) clearInterval(timer);
    set({ siteId: null, task: null, progress: null, stats: null, logs: [], pollTimer: null, socketState: 'idle' });
  },

  setForm(key, value) {
    set({ form: { ...get().form, [key]: value } });
  },

  resetForm() {
    set({ form: defaultForm() });
  },

  async start() {
    const siteId = get().siteId;
    if (siteId === null) return;
    set({ actionError: null, error: null });
    try {
      const { task } = await crawlApi.start(siteId, get().form);
      set({ task });
      await get().refresh();
    } catch (err) {
      set({ actionError: err instanceof CrawlApiError ? `${err.message}（${err.code}）` : String(err) });
    }
  },

  async pause() {
    const siteId = get().siteId;
    if (siteId === null) return;
    try {
      const { task } = await crawlApi.control(siteId, 'pause');
      set({ task, actionError: null });
      await get().refresh();
    } catch (err) {
      set({ actionError: err instanceof CrawlApiError ? `${err.message}（${err.code}）` : String(err) });
    }
  },

  async resume() {
    const siteId = get().siteId;
    if (siteId === null) return;
    try {
      const { task } = await crawlApi.control(siteId, 'resume');
      set({ task, actionError: null });
      await get().refresh();
    } catch (err) {
      set({ actionError: err instanceof CrawlApiError ? `${err.message}（${err.code}）` : String(err) });
    }
  },

  async stop() {
    const siteId = get().siteId;
    if (siteId === null) return;
    try {
      const { task } = await crawlApi.control(siteId, 'stop');
      set({ task, actionError: null });
      await get().refresh();
    } catch (err) {
      set({ actionError: err instanceof CrawlApiError ? `${err.message}（${err.code}）` : String(err) });
    }
  },

  async refresh() {
    const siteId = get().siteId;
    if (siteId === null) return;
    set({ loading: true });
    try {
      const status = await crawlApi.status(siteId);
      set({
        task: status.task,
        progress: status.progress,
        stats: status.stats,
        logs: status.recentLogs,
        wsSubscribers: status.wsSubscribers,
        loading: false,
        error: null,
      });
    } catch (err) {
      set({ loading: false, error: err instanceof CrawlApiError ? err.message : String(err) });
    }
  },

  connectSocket() {
    const siteId = get().siteId;
    if (siteId === null) return;
    if (get().socket !== null) return;

    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/sites/${encodeURIComponent(siteId)}`;
    let socket: WebSocket;
    set({ socketState: 'connecting' });
    try {
      socket = new WebSocket(url);
    } catch {
      set({ socketState: 'closed' });
      return;
    }
    set({ socket });

    socket.addEventListener('message', (event) => {
      let message: CrawlSocketMessage;
      try {
        message = JSON.parse(String(event.data)) as CrawlSocketMessage;
      } catch {
        return;
      }
      const state = get();
      if (message.type === 'progress') {
        set({ progress: message.progress, task: state.task === null ? state.task : { ...state.task, status: message.progress.status } });
      } else if (message.type === 'task') {
        set({ task: state.task === null ? state.task : { ...state.task, status: message.status } });
        void get().refresh();
      } else if (message.type === 'node') {
        set({ progress: state.progress === null ? state.progress : { ...state.progress, discovered: state.progress.discovered + 1 } });
      }
    });

    socket.addEventListener('open', () => {
      set({ socketState: 'open' });
      // WS 可用则停掉轮询兜底
      const timer = get().pollTimer;
      if (timer !== null) {
        clearInterval(timer);
        set({ pollTimer: null });
      }
    });

    socket.addEventListener('close', () => {
      set({ socketState: 'closed', socket: null });
      // 兜底轮询：WS 断开也能看到进度
      if (get().pollTimer === null && get().siteId !== null) {
        const timer = setInterval(() => void get().refresh(), 1500);
        set({ pollTimer: timer });
      }
    });

    socket.addEventListener('error', () => {
      set({ socketState: 'closed' });
    });
  },

  disconnectSocket() {
    const socket = get().socket;
    if (socket !== null) {
      socket.close();
    }
    set({ socket: null, socketState: 'idle' });
  },
}));
