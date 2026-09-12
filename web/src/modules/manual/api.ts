/**
 * 手动采集模块 API 客户端 + WS 消息契约
 */
import type { ManualSessionState, PendingConfirm } from './types.ts';

export class ManualApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ManualApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new ManualApiError(0, 'NETWORK_ERROR', `无法连接服务端：${(err as Error).message}`);
  }
  const text = await res.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ManualApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const manualApi = {
  start(siteId: string, input: { url?: string; mode?: 'record-only' | 'record-and-expand'; viewport?: { width: number; height: number } }): Promise<{ state: ManualSessionState }> {
    return request(`/api/sites/${encodeURIComponent(siteId)}/manual`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  status(siteId: string): Promise<{ state: ManualSessionState | null }> {
    return request(`/api/sites/${encodeURIComponent(siteId)}/manual`);
  },
  detail(sessionId: string): Promise<{ state: ManualSessionState; events: Array<{ at: number; level: string; message: string }>; pendingConfirm: PendingConfirm[] }> {
    return request(`/api/manual/${encodeURIComponent(sessionId)}`);
  },
  stop(sessionId: string): Promise<{ state: ManualSessionState }> {
    return request(`/api/manual/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' });
  },
  /** 建一个「当前页」节点（供置为父/确认时选择目标） */
  node(nodeId: string): Promise<{ node: { id: string; url: string; display_label: string | null } }> {
    return request(`/api/nodes/${encodeURIComponent(nodeId)}`);
  },
};

/* ---------------- WS 消息（与服务端 ws-manual.ts 对齐） ---------------- */

export interface MouseInputMessage {
  type: 'mouse';
  mouse: {
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
    x: number;
    y: number;
    button?: 'none' | 'left' | 'middle' | 'right';
    clickCount?: number;
    deltaX?: number;
    deltaY?: number;
    modifiersBitmask?: number;
  };
}

export interface KeyInputMessage {
  type: 'key';
  key: {
    type: 'keyDown' | 'keyUp' | 'char';
    key: string;
    code?: string;
    text?: string;
    windowsVirtualKeyCode?: number;
    modifiersBitmask?: number;
  };
}

export type ManualUpstreamMessage =
  | MouseInputMessage
  | KeyInputMessage
  | { type: 'navigate'; url: string }
  | { type: 'back-root' }
  | { type: 'back-parent' }
  | { type: 'expand' }
  | { type: 'set-root' }
  | { type: 'set-parent'; nodeId: string }
  | { type: 'mode'; mode: 'record-only' | 'record-and-expand' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'confirm-click'; confirmId: string; nodeId: string }
  | { type: 'discard-click'; confirmId: string };

export type ManualDownstreamMessage =
  | { type: 'hello'; sessionId: string; schemaVersion: string; viewport: { width: number; height: number } }
  | { type: 'frame'; data: string; width: number; height: number; at: number }
  | { type: 'state'; state: ManualSessionState }
  | { type: 'pending'; item: PendingConfirm }
  | { type: 'pending-list'; items: PendingConfirm[] }
  | { type: 'event'; event: { at: number; level: string; message: string } }
  | { type: 'identity'; identity: ManualSessionState['current'] }
  | { type: 'error'; code: string; message: string };
