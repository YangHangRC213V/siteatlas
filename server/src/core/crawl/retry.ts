/**
 * core/crawl/retry.ts —— 重试与退避（requirements §4.4「重试与退避」）
 */

export interface RetryOptions {
  maxRetries: number;
  backoffMs: number;
  backoffMaxMs: number;
}

/** 指数退避：attempt=1 → backoff，attempt=2 → 2×backoff …，封顶 backoffMaxMs */
export function backoffDelay(attempt: number, options: RetryOptions): number {
  const base = Math.max(0, options.backoffMs);
  const raw = base * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(raw, Math.max(base, options.backoffMaxMs));
  // 抖动 ±10%，避免重试队列同时爆发
  const jitter = capped * 0.1 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

/** 是否值得重试：网络类失败才重试，4xx（除 408/429）不重试 */
export function isRetryableHttp(status: number | null): boolean {
  if (status === null) return true; // 网络层失败
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}

/** 由状态与尝试次数决定下一步 */
export function decideRetry(
  attempt: number,
  status: number | null,
  options: RetryOptions,
): { retry: boolean; delayMs: number } {
  if (attempt > options.maxRetries) return { retry: false, delayMs: 0 };
  if (!isRetryableHttp(status)) return { retry: false, delayMs: 0 };
  return { retry: true, delayMs: backoffDelay(attempt, options) };
}
