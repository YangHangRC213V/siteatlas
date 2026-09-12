/**
 * 静态 HTTP 探测（dev-spec §7 M0「建站与 URL 校验」）
 *
 * M0 只需要「可达性 + 是否 HTML + 重定向链」三件事，因此用 undici.fetch 手写
 * 逐跳重定向（而不是 undici.request），以便按 §6.2 记录完整重定向链。
 * M1 的 http-fetcher 会在此基础上加 UA/限速/robots，本文件不承担抓取职责。
 */
import type { UrlProbeResult } from '@siteatlas/shared';

export interface ProbeOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  signal?: AbortSignal;
}

const DEFAULT_UA = 'SiteAtlas/0.1 (+local crawling tool)';

function looksHtml(contentType: string | null): boolean {
  if (contentType === null) return false;
  const ct = contentType.toLowerCase();
  return ct.includes('text/html') || ct.includes('application/xhtml+xml');
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function combineSignals(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`探测超时（${timeoutMs}ms）`)), timeoutMs);
  const onOuterAbort = (): void => controller.abort(outer?.reason);
  if (outer !== undefined) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    },
  };
}

/**
 * 探测 URL。任何网络层失败都落成 `reachable=false, error=...`，不抛异常
 * （调用方决定「拒绝建站」还是「建站并标 error」，见 core/sites/service.ts）。
 */
export async function probeUrl(url: string, options: ProbeOptions = {}): Promise<UrlProbeResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxRedirects = options.maxRedirects ?? 10;
  const userAgent = options.userAgent ?? DEFAULT_UA;

  const redirectChain: string[] = [url];
  let current = url;
  const { signal, cancel } = combineSignals(timeoutMs, options.signal);

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
        signal,
      });
      const status = res.status;
      if (isRedirect(status)) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (location === null) {
          return {
            reachable: true,
            isHtml: false,
            status,
            contentType: null,
            finalUrl: current,
            redirectChain,
            error: `重定向响应缺少 Location 头（HTTP ${status}）`,
          };
        }
        current = new URL(location, current).toString();
        redirectChain.push(current);
        continue;
      }
      const contentType = res.headers.get('content-type');
      await res.body?.cancel().catch(() => undefined);
      return {
        reachable: true,
        isHtml: looksHtml(contentType),
        status,
        contentType,
        finalUrl: current,
        redirectChain,
        error: status >= 400 ? `HTTP ${status}` : null,
      };
    }
    return {
      reachable: true,
      isHtml: false,
      status: null,
      contentType: null,
      finalUrl: current,
      redirectChain,
      error: `重定向次数超过上限（${maxRedirects}）`,
    };
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    const message = cause instanceof Error ? cause.message : (err as Error).message;
    return {
      reachable: false,
      isHtml: false,
      status: null,
      contentType: null,
      finalUrl: null,
      redirectChain,
      error: signal.aborted ? `探测超时（${timeoutMs}ms）` : message,
    };
  } finally {
    cancel();
  }
}
