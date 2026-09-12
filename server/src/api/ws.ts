/**
 * api/ws.ts —— 实时进度通道（dev-spec §5.2 `/ws/sites/:id` 服务端→前端）
 *
 * core/ 不依赖 api/：调度器通过 CrawlListener 回调把进度交出来，这里负责广播给订阅者。
 * 只推增量事件（进度快照 + 新节点），前端按消息类型更新视图。
 */
import type { FastifyInstance } from 'fastify';
import { SCHEMA_VERSION, type CrawlSocketMessage } from '@siteatlas/shared';
import type { CrawlListener } from '../core/crawl/scheduler.ts';

interface SocketLike {
  readyState: number;
  send(data: string): void;
  on(event: 'close' | 'error', handler: () => void): void;
  close?(): void;
}

const OPEN = 1;

export class CrawlBroadcaster {
  private readonly subscribers = new Map<string, Set<SocketLike>>();

  subscribe(siteId: string, socket: SocketLike): void {
    let set = this.subscribers.get(siteId);
    if (set === undefined) {
      set = new Set();
      this.subscribers.set(siteId, set);
    }
    set.add(socket);
    socket.on('close', () => this.unsubscribe(siteId, socket));
    socket.on('error', () => this.unsubscribe(siteId, socket));
  }

  unsubscribe(siteId: string, socket: SocketLike): void {
    const set = this.subscribers.get(siteId);
    if (set === undefined) return;
    set.delete(socket);
    if (set.size === 0) this.subscribers.delete(siteId);
  }

  count(siteId: string): number {
    return this.subscribers.get(siteId)?.size ?? 0;
  }

  broadcast(siteId: string, message: CrawlSocketMessage): void {
    const set = this.subscribers.get(siteId);
    if (set === undefined) return;
    const payload = JSON.stringify(message);
    for (const socket of set) {
      if (socket.readyState !== OPEN) continue;
      try {
        socket.send(payload);
      } catch {
        this.unsubscribe(siteId, socket);
      }
    }
  }

  /** 生成给调度器用的监听器：进度 + 新节点 + 任务结束 */
  listenerFor(siteId: string): CrawlListener {
    return {
      onProgress: (progress) => this.broadcast(siteId, { type: 'progress', progress }),
      onNodeFound: (node) => this.broadcast(siteId, { type: 'node', node }),
      onTaskEnd: (status, _reason) =>
        this.broadcast(siteId, { type: 'task', status: status === 'failed' ? 'failed' : status, taskId: '' }),
    };
  }
}

export async function registerWsRoutes(app: FastifyInstance, broadcaster: CrawlBroadcaster): Promise<void> {
  app.get('/ws/sites/:id', { websocket: true }, (socket, request) => {
    const siteId = (request.params as { id: string }).id;
    const s = socket as unknown as SocketLike;
    broadcaster.subscribe(siteId, s);
    const hello: CrawlSocketMessage = { type: 'hello', siteId, schemaVersion: SCHEMA_VERSION };
    if (s.readyState === OPEN) s.send(JSON.stringify(hello));
  });
}
