/**
 * core/crawl/frontier.ts —— 待抓队列（dev-spec §4 crawl_queue / §6.6 断点续爬）
 *
 * 队列落在 SQLite（不是内存），因此进程重启后可 `recoverStaleQueue()` 复位 running → pending 续跑。
 * 内存里维护「本进程尚未分配的节点集合」以避免同一节点被两个 worker 同时取走：
 * 取件时直接把 state 置为 running（单进程内的临界区由 SQLite 串行化保证）。
 */
import type { CrawlRepo, QueueItem } from '../store/repos/crawl.ts';

export interface FrontierStats {
  pending: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
}

export class Frontier {
  private readonly repo: CrawlRepo;
  private readonly taskId: string;

  constructor(repo: CrawlRepo, taskId: string) {
    this.repo = repo;
    this.taskId = taskId;
  }

  /** 入队（已存在同 (task,node) 则忽略） */
  push(siteId: string, nodeId: string, depth: number): boolean {
    return this.repo.enqueue(this.taskId, siteId, nodeId, depth);
  }

  /** 取一批待抓并标记 running；priority 高者优先（=depth 小者优先） */
  async take(limit: number, isHostAvailable?: (hostOfUrl: string) => boolean, urlOf?: (nodeId: string) => string | null): Promise<QueueItem[]> {
    const picked = this.repo.pickPending(this.taskId, limit, Date.now());
    const out: QueueItem[] = [];
    for (const item of picked) {
      if (isHostAvailable !== undefined && urlOf !== undefined) {
        const url = urlOf(item.node_id);
        if (url !== null) {
          const host = safeHost(url);
          if (!isHostAvailable(host)) continue;
        }
      }
      this.repo.markRunning(item.id);
      out.push(item);
    }
    return out;
  }

  done(item: QueueItem): void {
    this.repo.markDone(item.id);
  }

  skipped(item: QueueItem): void {
    this.repo.markSkipped(item.id);
  }

  failed(item: QueueItem): void {
    this.repo.markFailed(item.id);
  }

  retryLater(item: QueueItem, nextRetryAtMs: number): void {
    this.repo.scheduleRetry(item.id, nextRetryAtMs);
  }

  stats(): FrontierStats {
    const counts = this.repo.queueCounts(this.taskId);
    return {
      pending: counts['pending'] ?? 0,
      running: counts['running'] ?? 0,
      done: counts['done'] ?? 0,
      failed: counts['failed'] ?? 0,
      skipped: counts['skipped'] ?? 0,
    };
  }

  /** 是否还有待处理（含待重试） */
  hasWork(): boolean {
    const s = this.stats();
    return s.pending > 0 || s.running > 0;
  }

  releaseRunning(): void {
    this.repo.releaseRunning(this.taskId);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return 'invalid';
  }
}
