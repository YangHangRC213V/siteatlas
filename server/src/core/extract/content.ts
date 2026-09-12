/**
 * core/extract/content.ts —— 标题/正文/展示标签（dev-spec §6.4 / §6.3 内容去重）
 * M0 已有 display_label 推导，M1 在此扩展正文抽取与指纹。
 */
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
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

/** §6.4 优先级：用户别名 > 页面标题 > 路径末段（URL 不在行内显示） */
export function deriveDisplayLabel(input: DisplayLabelInput): string {
  const alias = input.alias?.trim();
  if (alias) return alias;
  const title = input.title?.trim();
  if (title) return title;
  return pathTail(input.url);
}

export interface ExtractedContent {
  title: string | null;
  /** 正文文本（去导航/脚本样式后的 body 文本） */
  text: string;
  /** 正文长度（字符） */
  textLength: number;
  description: string | null;
}

/** 抽取页面标题与正文（M1 只存正文；原始 HTML/截图由 downloadAssets 开关控制） */
export function extractContent(html: string): ExtractedContent {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();
  const description = $('meta[name="description"]').first().attr('content')?.trim() ?? null;
  $('script, style, noscript, template, nav, footer, aside').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return {
    title: title.length > 0 ? title.slice(0, 300) : null,
    text,
    textLength: text.length,
    description: description !== null && description.length > 0 ? description.slice(0, 500) : null,
  };
}

/**
 * 正文指纹（dev-spec §6.3 三层去重之二）。
 * 归一化：仅保留字母数字与中日韩字符，小写；再对前 4KB 做 sha256。
 * 目的：同内容不同 URL（分页壳、打印页、参数变体）只留一个递归来源。
 */
export function contentFingerprint(text: string): string | null {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 4096);
  if (normalized.length < 64) return null; // 太短的正文不足以判定重复
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
