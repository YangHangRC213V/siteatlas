/**
 * URL 规范化（dev-spec §6.1 / requirements §3）
 *
 * identityKey = 小写 host + 补默认端口 + 去 `www.`（可配）+ 去尾 `/` + query 排序
 *             + 剔除跟踪参数（`utm_*`/`sessionid`/`_ga`，黑名单可配）+ 去 fragment。
 * url 字段保留完整绝对地址（含 fragment）。
 */
import type { NormalizeOptions, NormalizedUrl } from '@siteatlas/shared';

/** 内置跟踪参数黑名单之外的前缀规则（dev-spec §6.1 的 `utm_*`） */
const TRACKING_PREFIXES = ['utm_'];
/** 内置跟踪参数黑名单（大小写不敏感，逐字取自 §6.1） */
const TRACKING_EXACT = ['sessionid', '_ga'];
/** 默认端口（§6.1「补默认端口」，等价于规范化时省略） */
const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

export const DEFAULT_NORMALIZE_OPTIONS: Required<NormalizeOptions> = {
  dropWww: true,
  forceHttps: false,
  trackingBlacklist: [],
};

export class InvalidUrlError extends Error {
  readonly input: string;
  constructor(input: string, message: string) {
    super(message);
    this.name = 'InvalidUrlError';
    this.input = input;
  }
}

function isTracking(name: string, blacklist: readonly string[]): boolean {
  const lower = name.toLowerCase();
  for (const prefix of TRACKING_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  if (TRACKING_EXACT.includes(lower)) return true;
  return blacklist.some((b) => b.toLowerCase() === lower);
}

/** 去尾 `/`：`/` 保持为 `/`，`/a/` → `/a`，`/a/b///` → `/a/b` */
function stripTrailingSlash(pathname: string): string {
  const stripped = pathname.replace(/\/+$/, '');
  return stripped.length === 0 ? '/' : stripped;
}

/** 小写 host 并去 `www.` 前缀（可配） */
function normalizeHost(hostname: string, dropWww: boolean): string {
  const lower = hostname.toLowerCase();
  if (!dropWww) return lower;
  if (lower.startsWith('www.')) return lower.slice(4);
  return lower;
}

/**
 * 规范化一个绝对 URL 字符串。
 * 输入可以是缺协议的形式（如 `example.com/a`），按 `https://` 补全；
 * 但显式给出非 http/https 协议（如 `ftp:`、`file:`、`javascript:`）一律报错。
 */
export function normalizeUrl(input: string, options: NormalizeOptions = {}): NormalizedUrl {
  const opts = { ...DEFAULT_NORMALIZE_OPTIONS, ...options };
  const raw = (input ?? '').trim();
  if (raw.length === 0) throw new InvalidUrlError(input, 'URL 不能为空');

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw);
  if (hasScheme && !/^https?:/i.test(raw)) {
    const scheme = raw.slice(0, raw.indexOf(':')).toLowerCase();
    throw new InvalidUrlError(input, `仅支持 http/https 协议，收到 "${scheme}:"`);
  }
  const candidate = hasScheme ? raw : `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new InvalidUrlError(input, `无法解析为合法 URL：${input}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidUrlError(input, `仅支持 http/https 协议，收到 "${parsed.protocol}"`);
  }
  if (parsed.hostname.length === 0) throw new InvalidUrlError(input, 'URL 缺少主机名');

  const originalHost = parsed.hostname.toLowerCase();
  const host = normalizeHost(originalHost, opts.dropWww);

  // 「补默认端口」= 规范化结果里省略默认端口；非默认端口显式保留
  let protocol = parsed.protocol;
  let port = parsed.port;
  if (opts.forceHttps && protocol === 'http:' && (port === '' || port === '80')) {
    protocol = 'https:';
    port = '';
  }
  const defaultPort = DEFAULT_PORTS[protocol];
  const explicitPort = port !== '' && port !== defaultPort ? port : null;

  const pathname = stripTrailingSlash(parsed.pathname || '/');

  // query 排序（键、值双排序，保证确定性）+ 剔除跟踪参数
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of parsed.searchParams.entries()) {
    if (isTracking(k, opts.trackingBlacklist)) continue;
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const search = new URLSearchParams(pairs).toString();

  const fragment = parsed.hash.length > 1 ? parsed.hash.slice(1) : null;
  const auth = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
    : '';

  const authority = `${host}${explicitPort !== null ? `:${explicitPort}` : ''}`;
  const identityKey = `${protocol}//${auth}${authority}${pathname}${search.length > 0 ? `?${search}` : ''}`;
  const url = `${identityKey}${fragment !== null ? `#${fragment}` : ''}`;

  return {
    url,
    identityKey,
    origin: `${protocol}//${authority}`,
    host: originalHost,
    normalizedHost: host,
    protocol,
    port: explicitPort,
    pathname,
    search,
    fragment,
    scope: protocol === 'https:' ? 'https' : 'http',
  };
}
