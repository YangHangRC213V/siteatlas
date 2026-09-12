/**
 * core/crawl/control.ts —— 任务控制（启动/暂停/继续/停止，requirements §4.4「收敛与可控」）
 */
export const PAUSED_ERROR = 'CRAWL_PAUSED';
export const STOPPED_ERROR = 'CRAWL_STOPPED';

export type ControlState = 'running' | 'paused' | 'stopped';

/** 控制层错误：api 层映射为 409（不依赖 service.ts，避免循环依赖） */
export class CrawlControlError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = 'CrawlControlError';
    this.code = code;
    this.status = status;
  }
}

export class CrawlControl {
  private state: ControlState = 'running';
  private readonly controller = new AbortController();
  private readonly waiters: Array<() => void> = [];
  private totalPausedMs = 0;
  private pausedAt: number | null = null;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get current(): ControlState {
    return this.state;
  }

  /** 已暂停的累计时长（不计入抓取耗时统计） */
  get pausedMs(): number {
    return this.totalPausedMs + (this.pausedAt !== null ? Date.now() - this.pausedAt : 0);
  }

  pause(): void {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.pausedAt = Date.now();
  }

  resume(): void {
    if (this.state === 'stopped') {
      throw new CrawlControlError('CRAWL_NOT_RUNNING', '任务已停止，无法继续');
    }
    if (this.state === 'paused') {
      if (this.pausedAt !== null) this.totalPausedMs += Date.now() - this.pausedAt;
      this.pausedAt = null;
    }
    this.state = 'running';
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  stop(): void {
    this.state = 'stopped';
    if (this.pausedAt !== null) {
      this.totalPausedMs += Date.now() - this.pausedAt;
      this.pausedAt = null;
    }
    this.controller.abort(new Error(STOPPED_ERROR));
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  /** 在每个工作单元前调用：暂停时挂起，停止时抛错 */
  async checkpoint(): Promise<void> {
    while (this.state === 'paused') {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.state === 'stopped') throw new Error(STOPPED_ERROR);
  }
}
