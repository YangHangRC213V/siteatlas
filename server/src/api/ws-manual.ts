/**
 * api/ws-manual.ts —— 手动采集的双向通道（dev-spec §5.2 `/ws/manual/:sessionId`）
 *
 * 下行：JPEG 画面帧（base64）+ 会话状态 + 待确认项 + 事件日志
 * 上行：鼠标/键盘事件折成 CDP Input.*，加上控制指令（导航/回根/回父/置为根/置为父/暂停/继续/结束）
 *
 * 这样「整个工具就是一个网页」：前端只负责画 canvas 与把事件折成消息。
 */
import type { FastifyInstance } from 'fastify';
import { SCHEMA_VERSION } from '@siteatlas/shared';
import type { ManualService } from '../core/manual/service.ts';
import type { ManualEvent, ManualIdentity, ManualSessionState, PendingConfirm } from '../core/manual/session.ts';
import type { KeyInput, MouseInput } from '../core/fetch/session.ts';

interface SocketLike {
  readyState: number;
  send(data: string): void;
  on(event: 'close' | 'error' | 'message', handler: (...args: unknown[]) => void): void;
}

const OPEN = 1;

/** 下行消息 */
export type ManualDownstream =
  | { type: 'hello'; sessionId: string; schemaVersion: string; viewport: { width: number; height: number } }
  | { type: 'frame'; data: string; width: number; height: number; at: number }
  | { type: 'state'; state: ManualSessionState }
  | { type: 'pending'; item: PendingConfirm }
  | { type: 'pending-list'; items: PendingConfirm[] }
  | { type: 'event'; event: ManualEvent }
  | { type: 'identity'; identity: ManualIdentity }
  | { type: 'error'; code: string; message: string };

/** 上行消息 */
export interface ManualUpstream {
  type:
    | 'mouse'
    | 'key'
    | 'navigate'
    | 'back-root'
    | 'back-parent'
    | 'set-root'
    | 'set-parent'
    | 'expand'
    | 'mode'
    | 'pause'
    | 'resume'
    | 'stop'
    | 'confirm-click'
    | 'discard-click';
  mouse?: MouseInput;
  key?: KeyInput;
  url?: string;
  nodeId?: string;
  mode?: 'record-only' | 'record-and-expand';
  confirmId?: string;
}

export async function registerManualWsRoutes(app: FastifyInstance, service: ManualService): Promise<void> {
  app.get('/ws/manual/:sessionId', { websocket: true }, (socket, request) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const s = socket as unknown as SocketLike;

    const send = (message: ManualDownstream): void => {
      if (s.readyState !== OPEN) return;
      try {
        s.send(JSON.stringify(message));
      } catch {
        /* 通道已断开，忽略 */
      }
    };

    let entry;
    try {
      entry = service.require(sessionId);
    } catch (err) {
      send({ type: 'error', code: 'SESSION_NOT_FOUND', message: (err as Error).message });
      return;
    }
    const session = entry.session;

    // 订阅画面帧
    service.setFrameSink(sessionId, (frame) => {
      send({ type: 'frame', data: frame.data, width: frame.width, height: frame.height, at: Date.now() });
    });

    // 订阅待确认队列：队列变化必须主动推 —— 否则「页面里的点击」只写进服务端队列，
    // 界面上的待确认列表与计数一直停在 0（踩过的坑，见 DECISIONS.md M3）
    service.setPendingListener(sessionId, (items) => {
      send({ type: 'pending-list', items });
      send({ type: 'state', state: session.state() });
    });

    send({
      type: 'hello',
      sessionId,
      schemaVersion: SCHEMA_VERSION,
      viewport: session.pageViewport(),
    });
    send({ type: 'state', state: session.state() });
    send({ type: 'pending-list', items: session.listPendingConfirm() });

    s.on('message', (raw: unknown) => {
      void (async (): Promise<void> => {
        let message: ManualUpstream;
        try {
          message = JSON.parse(String(raw)) as ManualUpstream;
        } catch {
          send({ type: 'error', code: 'BAD_MESSAGE', message: '消息不是合法 JSON' });
          return;
        }
        try {
          switch (message.type) {
            case 'mouse':
              if (message.mouse !== undefined) await session.dispatchMouse(message.mouse);
              break;
            case 'key':
              if (message.key !== undefined) await session.dispatchKey(message.key);
              break;
            case 'navigate':
              if (message.url !== undefined) await session.navigate(message.url);
              break;
            case 'back-root':
              await session.backToRoot();
              break;
            case 'back-parent':
              await session.backToParent();
              break;
            case 'expand': {
              const outcome = await session.expandOneLevel();
              if (!outcome.ok) send({ type: 'error', code: 'EXPAND_FAILED', message: outcome.message });
              break;
            }
            case 'set-root':
              session.setCurrentAsRoot();
              break;
            case 'set-parent':
              if (message.nodeId !== undefined) session.setCurrentAsParentOf(message.nodeId);
              break;
            case 'mode':
              if (message.mode !== undefined) session.setProgressMode(message.mode);
              break;
            case 'pause':
              session.pause();
              break;
            case 'resume':
              session.resume();
              break;
            case 'stop':
              await service.stop(sessionId, '前端请求结束');
              send({ type: 'state', state: { ...session.state(), status: 'ended' } });
              return;
            case 'confirm-click':
              if (message.confirmId !== undefined && message.nodeId !== undefined) {
                const result = session.confirmPending(message.confirmId, message.nodeId);
                if (!result.ok) send({ type: 'error', code: 'CONFIRM_FAILED', message: result.message });
              }
              break;
            case 'discard-click':
              if (message.confirmId !== undefined) session.discardPending(message.confirmId);
              break;
            default:
              send({ type: 'error', code: 'UNKNOWN_TYPE', message: `未知消息类型：${String(message.type)}` });
          }
          send({ type: 'state', state: session.state() });
        } catch (err) {
          send({ type: 'error', code: 'HANDLER_FAILED', message: (err as Error).message });
        }
      })();
    });

    const detach = (): void => {
      service.setFrameSink(sessionId, null);
      service.setPendingListener(sessionId, null);
    };
    s.on('close', detach);
    s.on('error', detach);
  });
}
