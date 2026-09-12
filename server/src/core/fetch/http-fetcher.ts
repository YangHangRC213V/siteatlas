/**
 * core/fetch/http-fetcher.ts —— 静态抓取快路径（dev-spec §2「undici + cheerio」）
 *
 * 只负责「拿到 HTML 文本 + 响应元数据」，解析交给 core/extract。
 * 逐跳重定向链按 §6.2 记录；UA/超时由调用方（crawl/scheduler）从 preset 传入。
 */
import type { RenderMode } from '@siteatlas/shared';

export interface FetchResult {
  ok: boolean;
  /** 最终 URL（重定向后） */
  finalUrl: string;
  status: number | null;
  contentType: string | null;
  /** 正文 HTML（仅当 content-type 为 HTML 且成功时） */
  html: string | null;
  redirectChain: string[];
  /** 耗时（ms） */
  durationMs: number;
  /** 实际使用的渲染方式 */
  usedRenderMode: Exclude<RenderMode, 'auto'>;
  error: string | null;
  /** 非 HTML 资源（图片/PDF/音视频） */
  isAsset: boolean;
}

export interface FetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  /** 需要正文时的最大字节数，防止超大页面吃内存 */
  maxBytes?: number;
}

const ASSET_CONTENT_TYPES = [
  'image/',
  'video/',
  'audio/',
  'application/pdf',
  'application/zip',
  'application/octet-stream',
  'font/',
];

export function looksHtmlContentType(contentType: string | null): boolean {
  if (contentType === null) return true; // 无 Content-Type 时按 HTML 处理（很多老站点不返回）
  const ct = contentType.toLowerCase();
  return ct.includes('text/html') || ct.includes('application/xhtml+xml') || ct.startsWith('text/plain');
}

export function looksAssetContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const ct = contentType.toLowerCase();
  return ASSET_CONTENT_TYPES.some((p) => ct.includes(p));
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function combineSignals(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs);
  const onAbort = (): void => controller.abort(outer?.reason);
  if (outer !== undefined) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

async function readBodyLimited(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (body === null) return await res.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= maxBytes) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= merged.length) break;
    const slice = chunk.subarray(0, merged.length - offset);
    merged.set(slice, offset);
    offset += slice.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

/** 静态抓取。网络层失败不抛异常，落成 `ok:false + error`。 */
export async function fetchStatic(url: string, options: FetchOptions): Promise<FetchResult> {
  const startedAt = Date.now();
  const maxRedirects = options.maxRedirects ?? 10;
  const maxBytes = options.maxBytes ?? 5_000_000;
  const redirectChain: string[] = [url];
  let current = url;
  const { signal, cancel } = combineSignals(options.timeoutMs, options.signal);

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': options.userAgent,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal,
      });

      if (isRedirect(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (location === null) {
          return {
            ok: false,
            finalUrl: current,
            status: res.status,
            contentType: null,
            html: null,
            redirectChain,
            durationMs: Date.now() - startedAt,
            usedRenderMode: 'http',
            error: `重定向响应缺少 Location（HTTP ${res.status}）`,
            isAsset: false,
          };
        }
        current = new URL(location, current).toString();
        redirectChain.push(current);
        continue;
      }

      const contentType = res.headers.get('content-type');
      const isAsset = looksAssetContentType(contentType);
      const html = isAsset ? null : await readBodyLimited(res, maxBytes);
      return {
        ok: res.status < 400,
        finalUrl: current,
        status: res.status,
        contentType,
        html,
        redirectChain,
        durationMs: Date.now() - startedAt,
        usedRenderMode: 'http',
        error: res.status >= 400 ? `HTTP ${res.status}` : null,
        isAsset,
      };
    }
    return {
      ok: false,
      finalUrl: current,
      status: null,
      contentType: null,
      html: null,
      redirectChain,
      durationMs: Date.now() - startedAt,
      usedRenderMode: 'http',
      error: `重定向次数超过上限（${maxRedirects}）`,
      isAsset: false,
    };
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    const message = cause instanceof Error ? cause.message : (err as Error).message;
    return {
      ok: false,
      finalUrl: current,
      status: null,
      contentType: null,
      html: null,
      redirectChain,
      durationMs: Date.now() - startedAt,
      usedRenderMode: 'http',
      error: signal.aborted ? `请求超时（${options.timeoutMs}ms）` : message,
      isAsset: false,
    };
  } finally {
    cancel();
  }
}
