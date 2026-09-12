/**
 * core/fetch/browser-fetcher.ts —— JS 渲染回落（dev-spec §2「判定为 SPA 时回落 Playwright」）
 */
import type { RenderMode } from '@siteatlas/shared';
import type { BrowserPool } from './pool.ts';

export type RenderDecision = 'static-enough' | 'no-links-fallback' | 'spa-fallback' | 'forced-browser' | 'static-error';

export interface RenderPlanInput {
  mode: RenderMode;
  /** 静态抓取是否成功 */
  staticOk: boolean;
  /** 静态 HTML 中的链接数 */
  linkCount: number;
  /** 静态 HTML 文本长度 */
  htmlLength: number;
  /** 命中 SPA 特征（空根容器 + 大量脚本） */
  spaSuspected: boolean;
  /** 静态正文长度 */
  textLength: number;
}

/** 是否需要 Playwright 回落：链接数为 0 即回落（dev-spec §8 风险对策），疑似 SPA 也回落 */
export function decideRender(input: RenderPlanInput): RenderDecision {
  if (input.mode === 'browser') return 'forced-browser';
  if (input.mode === 'http') return input.staticOk ? 'static-enough' : 'static-error';
  if (!input.staticOk) return 'static-error';
  if (input.linkCount === 0) return 'no-links-fallback';
  if (input.spaSuspected && input.textLength < 200) return 'spa-fallback';
  return 'static-enough';
}

export interface BrowserFetchResult {
  ok: boolean;
  finalUrl: string;
  html: string | null;
  durationMs: number;
  renderMode: 'browser';
  error: string | null;
}

/** 用 Playwright 渲染页面；浏览器不可用时返回 ok:false（调用方降级为静态结果） */
export async function fetchRendered(
  url: string,
  pool: BrowserPool,
  options: { timeoutMs: number },
): Promise<BrowserFetchResult> {
  const startedAt = Date.now();
  const rendered = await pool.render(url, options.timeoutMs);
  if ('error' in rendered) {
    return {
      ok: false,
      finalUrl: url,
      html: null,
      durationMs: Date.now() - startedAt,
      renderMode: 'browser',
      error: rendered.error,
    };
  }
  return {
    ok: true,
    finalUrl: rendered.finalUrl,
    html: rendered.html,
    durationMs: Date.now() - startedAt,
    renderMode: 'browser',
    error: null,
  };
}
