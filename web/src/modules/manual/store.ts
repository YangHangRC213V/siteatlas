/**
 * 手动采集模块状态（Zustand）：WS 连接、画面帧、输入回传、待确认队列、事件日志
 *
 * 设计要点：
 *   · 画面帧不放进 store（每帧几十 KB，进 store 会触发全树重渲染）—— 由 canvas 组件直接订阅回调；
 *   · store 只存「状态 + 日志 + 待确认队列」这些低频数据；
 *   · 输入事件以「视口坐标」为单位上行，坐标换算在 canvas 组件里完成（见 RemoteBrowserView）。
 */
import { create } from 'zustand';
import { ManualApiError, manualApi, type ManualUpstreamMessage } from './api.ts';
import type { ManualLogLine, ManualSessionState, PendingConfirm } from './types.ts';

export type SocketState = 'idle' | 'connecting' | 'open' | 'closed';

export interface ManualStoreState {
  siteId: string | null;
  sessionId: string | null;
  state: ManualSessionState | null;
  socketState: SocketState;
  viewport: { width: number; height: number };
  logs: ManualLogLine[];
  pending: PendingConfirm[];
  error: string | null;
  actionError: string | null;
  busy: boolean;

  socket: WebSocket | null;
  /** 帧订阅者（canvas 注册；避免把帧塞进 store） */
  frameSink: ((frame: { data: string; width: number; height: number; at: number }) => void) | null;
  lastFrameAt: number | null;
  frameCount: number;

  setFrameSink: (sink: ((frame: { data: string; width: number; height: number; at: number }) => void) | null) => void;
  bind: (siteId: string) => Promise<void>;
  unbind: () => void;
  start: (options?: { url?: string; mode?: 'record-only' | 'record-and-expand' }) => Promise<void>;
  stop: () => Promise<void>;
  send: (message: ManualUpstreamMessage) => boolean;
  clearErrors: () => void;
}

const MAX_LOGS = 200;

export const useManualStore = create<ManualStoreState>((set, get) => ({
  siteId: null,
  sessionId: null,
  state: null,
  socketState: 'idle',
  viewport: { width: 1280, height: 800 },
  logs: [],
  pending: [],
  error: null,
  actionError: null,
  busy: false,
  socket: null,
  frameSink: null,
  lastFrameAt: null,
  frameCount: 0,

  setFrameSink(sink) {
    set({ frameSink: sink });
  },

  async bind(siteId) {
    if (get().siteId === siteId) return;
    get().unbind();
    set({ siteId });
    try {
      const { state } = await manualApi.status(siteId);
      if (state !== null) {
        set({ sessionId: state.sessionId, state });
        connect(state.sessionId);
      }
    } catch (err) {
      set({ error: err instanceof ManualApiError ? err.message : String(err) });
    }
  },

  unbind() {
    const socket = get().socket;
    if (socket !== null) socket.close();
    set({
      siteId: null,
      sessionId: null,
      state: null,
      socket: null,
      socketState: 'idle',
      logs: [],
      pending: [],
      frameSink: null,
      error: null,
      actionError: null,
    });
  },

  async start(options = {}) {
    const siteId = get().siteId;
    if (siteId === null) return;
    set({ busy: true, actionError: null, error: null, logs: [], pending: [] });
    try {
      const { state } = await manualApi.start(siteId, {
        ...(options.url !== undefined ? { url: options.url } : {}),
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
      });
      set({ busy: false, sessionId: state.sessionId, state });
      connect(state.sessionId);
    } catch (err) {
      set({
        busy: false,
        actionError:
          err instanceof ManualApiError
            ? `${err.message}${err.status === 0 ? '' : `（${err.code}）`}`
            : String(err),
      });
    }
  },

  async stop() {
    const sessionId = get().sessionId;
    if (sessionId === null) return;
    set({ busy: true });
    try {
      const { state } = await manualApi.stop(sessionId);
      const socket = get().socket;
      if (socket !== null) socket.close();
      set({ busy: false, state, socket: null, socketState: 'idle', sessionId: null });
    } catch (err) {
      set({
        busy: false,
        actionError: err instanceof ManualApiError ? err.message : String(err),
      });
    }
  },

  send(message) {
    const socket = get().socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  },

  clearErrors() {
    set({ error: null, actionError: null });
  },
}));

/** 建立 WS 连接并接线（放在 store 外部，避免把 WebSocket 细节塞进状态定义） */
function connect(sessionId: string): void {
  const set = useManualStore.setState;
  const get = useManualStore.getState;

  const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/manual/${encodeURIComponent(sessionId)}`;
  set({ socketState: 'connecting', socket: null, lastFrameAt: null, frameCount: 0 });

  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch {
    set({ socketState: 'closed' });
    return;
  }
  set({ socket });

  socket.addEventListener('message', (event) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message['type']) {
      case 'hello': {
        const viewport = message['viewport'] as { width: number; height: number } | undefined;
        if (viewport !== undefined) set({ viewport });
        break;
      }
      case 'frame': {
        const frame = {
          data: String(message['data'] ?? ''),
          width: Number(message['width'] ?? 0),
          height: Number(message['height'] ?? 0),
          at: Number(message['at'] ?? Date.now()),
        };
        get().frameSink?.(frame);
        set({ lastFrameAt: frame.at, frameCount: get().frameCount + 1 });
        break;
      }
      case 'state': {
        set({ state: message['state'] as ManualSessionState });
        break;
      }
      case 'pending': {
        const item = message['item'] as PendingConfirm;
        set({ pending: [...get().pending.filter((p) => p.id !== item.id), item] });
        break;
      }
      // 服务端在队列增删后推整份队列：直接替换，避免「本地残留已丢弃项」
      case 'pending-list': {
        set({ pending: (message['items'] as PendingConfirm[] | undefined) ?? [] });
        break;
      }
      case 'identity': {
        const state = get().state;
        if (state !== null) {
          set({ state: { ...state, current: message['identity'] as ManualSessionState['current'] } });
        }
        break;
      }
      case 'event': {
        const event = message['event'] as ManualLogLine;
        const logs = [...get().logs, event];
        set({ logs: logs.slice(-MAX_LOGS) });
        break;
      }
      case 'error': {
        const logs = [
          ...get().logs,
          { at: Date.now(), level: 'error' as const, message: `${String(message['code'])}：${String(message['message'])}` },
        ];
        set({ logs: logs.slice(-MAX_LOGS), actionError: String(message['message']) });
        break;
      }
      default:
        break;
    }
  });

  socket.addEventListener('open', () => set({ socketState: 'open' }));
  socket.addEventListener('close', () => set({ socketState: 'closed', socket: null }));
  socket.addEventListener('error', () => set({ socketState: 'closed' }));
}

export function connectManualSocket(sessionId: string): void {
  connect(sessionId);
}

export function pushManualLog(level: ManualLogLine['level'], message: string): void {
  const logs = [...useManualStore.getState().logs, { at: Date.now(), level, message }];
  useManualStore.setState({ logs: logs.slice(-MAX_LOGS) });
}
