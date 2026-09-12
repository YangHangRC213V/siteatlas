/**
 * core/crawl/politeness.ts —— 限速与按域并发（requirements §4.7 默认限速 ≥1s/请求、并发 5）
 *
 * 两个约束同时生效：
 *   1. 全局并发上限（preset.concurrency，1–32）
 *   2. 单域并发上限（preset.perHostConcurrency）+ 单域最小间隔（preset.minDelayMs + 抖动）
 * 这样跨域可以放宽并发，而不会把同一个站压垮。
 */
export interface PolitenessOptions {
  minDelayMs: number;
  jitterMs: number;
  perHostConcurrency: number;
}

interface HostState {
  active: number;
  /** 下次允许发请求的时间戳（ms） */
  nextAllowedAt: number;
}

export class Politeness {
  private readonly options: PolitenessOptions;
  private readonly hosts = new Map<string, HostState>();

  constructor(options: PolitenessOptions) {
    this.options = options;
  }

  private hostState(host: string): HostState {
    const existing = this.hosts.get(host);
    if (existing !== undefined) return existing;
    const created: HostState = { active: 0, nextAllowedAt: 0 };
    this.hosts.set(host, created);
    return created;
  }

  /** 是否有该域的空位（无空位则调度器应换别的域） */
  canHit(host: string): boolean {
    const state = this.hostState(host);
    return state.active < Math.max(1, this.options.perHostConcurrency);
  }

  /** 等待到该域允许发请求的时刻，并占位 */
  async acquire(host: string): Promise<void> {
    const state = this.hostState(host);
    for (;;) {
      const now = Date.now();
      const waitMs = state.nextAllowedAt - now;
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 1000)));
        continue;
      }
      if (state.active >= Math.max(1, this.options.perHostConcurrency)) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      break;
    }
    const jitter = this.options.jitterMs > 0 ? Math.random() * this.options.jitterMs : 0;
    state.nextAllowedAt = Date.now() + this.options.minDelayMs + jitter;
    state.active += 1;
  }

  /** 释放占位 */
  release(host: string): void {
    const state = this.hostState(host);
    state.active = Math.max(0, state.active - 1);
  }

  /** 包一层：自动 acquire/release */
  async withHost<T>(host: string, task: () => Promise<T>): Promise<T> {
    await this.acquire(host);
    try {
      return await task();
    } finally {
      this.release(host);
    }
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return 'invalid';
  }
}

/** 按域并发信号量：perHostConcurrency 之外的补充（用于 future 的手动采集共用） */
export class Semaphore {
  private readonly limit: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      next?.();
    }
  }
}
