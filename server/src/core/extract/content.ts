/**
 * 展示标签推导（dev-spec §6.4）
 *
 * 优先级：用户别名 > 页面标题 > 路径末段。URL 不在行内显示。
 * M0 只用到「路径末段」这一档（新节点尚无 title）；M1 抓到标题后复用同一函数。
 */
import { normalizeUrl } from '../url/normalize.ts';

export interface DisplayLabelInput {
  alias?: string | null;
  title?: string | null;
  url: string;
}

/** 路径末段：`/a/b/` → `b`；`/` → host */
export function pathTail(url: string): string {
  let normalized: string;
  try {
    normalized = normalizeUrl(url).pathname;
  } catch {
    return url;
  }
  if (normalized === '/') {
    try {
      return normalizeUrl(url).normalizedHost;
    } catch {
      return url;
    }
  }
  const segments = normalized.split('/').filter((s) => s.length > 0);
  return decodeURIComponent(segments[segments.length - 1] ?? normalized);
}

export function deriveDisplayLabel(input: DisplayLabelInput): string {
  const alias = input.alias?.trim();
  if (alias) return alias;
  const title = input.title?.trim();
  if (title) return title;
  return pathTail(input.url);
}
