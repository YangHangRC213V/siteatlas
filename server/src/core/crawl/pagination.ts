/**
 * core/crawl/pagination.ts —— 分页模式探测（dev-spec §6.3 护栏 4）
 *
 * 识别 `?page=n` / `?p=n` / `?pn=n` / `/page/n` / `?offset=n`，并给出自动页上限，
 * 防止 `?page=1..∞` 的无限翻页把队列撑爆。
 */

const QUERY_PAGE_KEYS = ['page', 'p', 'pn', 'pg', 'paged', 'offset', 'start'];
const PATH_PAGE_RE = /\/page\/(\d+)\/?$/i;

export interface PaginationInfo {
  isPaged: boolean;
  /** 当前页号（无法解析则 null） */
  pageNumber: number | null;
  /** 用于分组同一分页序列的键（不含页号部分） */
  seriesKey: string | null;
}

/** 解析 URL 的分页信息 */
export function detectPagination(url: string): PaginationInfo {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { isPaged: false, pageNumber: null, seriesKey: null };
  }

  const pathMatch = PATH_PAGE_RE.exec(parsed.pathname);
  if (pathMatch !== null) {
    const number = Number(pathMatch[1]);
    const basePath = parsed.pathname.replace(PATH_PAGE_RE, '');
    return {
      isPaged: true,
      pageNumber: Number.isFinite(number) ? number : null,
      seriesKey: `${parsed.origin}${basePath}|path`,
    };
  }

  for (const key of QUERY_PAGE_KEYS) {
    const value = parsed.searchParams.get(key);
    if (value === null) continue;
    if (!/^\d+$/.test(value.trim())) continue;
    const others = [...parsed.searchParams.entries()]
      .filter(([k]) => k !== key)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return {
      isPaged: true,
      pageNumber: Number(value),
      seriesKey: `${parsed.origin}${parsed.pathname}?${others}|query:${key}`,
    };
  }

  return { isPaged: false, pageNumber: null, seriesKey: null };
}

/**
 * 分页序列计数器：同一序列超过上限即不再入队。
 * 键 = seriesKey（页号归一化后的地址），值 = 已发现页数。
 */
export class PaginationLimiter {
  private readonly counts = new Map<string, number>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  /** 返回 true 表示允许继续（含未识别分页的普通 URL） */
  allow(url: string): boolean {
    const info = detectPagination(url);
    if (!info.isPaged || info.seriesKey === null) return true;
    const count = this.counts.get(info.seriesKey) ?? 0;
    if (count >= this.limit) return false;
    this.counts.set(info.seriesKey, count + 1);
    return true;
  }

  /** 已识别出的分页序列（用于状态汇报） */
  get series(): Array<{ key: string; pages: number }> {
    return [...this.counts.entries()].map(([key, pages]) => ({ key, pages }));
  }
}
