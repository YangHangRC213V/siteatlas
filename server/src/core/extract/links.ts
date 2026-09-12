/**
 * core/extract/links.ts —— 链接抽取（dev-spec §3 / requirements §4.3 点击捕获所需的 selector/dom_path）
 *
 * 抽取每条 `<a href>` 的：
 *   绝对 URL（§6.2 内部一律存绝对值）、anchorText、css selector、dom_path、
 *   rel / target / nofollow / fragment、orderInPage。
 * 相对地址用当前页 URL 解析（等价于浏览器语义）；`<base href>` 也一并遵守。
 */
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

/** cheerio 1.x 不再导出 Element，实际节点类型来自 domhandler.AnyNode */
type Element = AnyNode;

export interface ExtractedLink {
  /** 绝对 URL（含 fragment 原文，规范化交给 core/url） */
  url: string;
  anchorText: string;
  selector: string;
  domPath: string;
  rel: string | null;
  target: string | null;
  isNofollow: boolean;
  fragment: string | null;
  orderInPage: number;
}

export interface ExtractLinksResult {
  links: ExtractedLink[];
  /** 是否疑似 SPA（脚本多、正文薄、且有空的挂载容器） */
  spaSuspected: boolean;
  /** 正文文本（用于内容指纹与 SPA 判定） */
  text: string;
  title: string | null;
}

const SKIP_SCHEMES = ['mailto:', 'tel:', 'javascript:', 'data:', 'blob:', 'file:', 'ftp:'];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** 生成 CSS 选择器：优先 id，其次稳定类名，最后带 nth-of-type 的后缀 */
function cssSelector($: cheerio.CheerioAPI, el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node !== null && node.type === 'tag') {
    const tag = node.name;
    const attribs = node.attribs ?? {};
    const id = attribs['id'];
    if (id !== undefined && id.length > 0) {
      parts.unshift(`${tag}#${id}`);
      break;
    }
    let part = tag;
    const classAttr = attribs['class'];
    if (classAttr !== undefined) {
      const stable = classAttr
        .split(/\s+/)
        .filter((c: string) => c.length > 0 && c.length < 24 && !/\d{3,}/.test(c))
        .slice(0, 2);
      if (stable.length > 0) part += `.${stable.join('.')}`;
    }
    const parentNode: Element | undefined = $(node).parent().get(0);
    if (parentNode !== undefined && parentNode.type === 'tag') {
      const sameTag = $(parentNode)
        .children(tag)
        .toArray();
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parentNode !== undefined && parentNode.type === 'tag' ? parentNode : null;
  }
  return parts.join(' > ');
}

/** 结构化 DOM 路径（带同级序号，便于重放定位） */
function domPath($: cheerio.CheerioAPI, el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node !== null && node.type === 'tag') {
    const parentNode: Element | undefined = $(node).parent().get(0);
    let index = 1;
    if (parentNode !== undefined && parentNode.type === 'tag') {
      const siblings = $(parentNode)
        .children(node.name)
        .toArray();
      index = siblings.indexOf(node) + 1;
    }
    parts.unshift(`${node.name}[${index}]`);
    node = parentNode !== undefined && parentNode.type === 'tag' ? parentNode : null;
  }
  return parts.join('/');
}

/** 抽取页面全部链接与正文文本 */
export function extractLinks(html: string, pageUrl: string): ExtractLinksResult {
  const $ = cheerio.load(html);
  const scriptCount = $('script').length;
  $('script, style, noscript, template').remove();

  const baseHref = $('base[href]').first().attr('href');
  let base: string;
  try {
    base = baseHref !== undefined ? new URL(baseHref, pageUrl).toString() : pageUrl;
  } catch {
    base = pageUrl;
  }

  const links: ExtractedLink[] = [];
  let order = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href === undefined) return;
    const trimmed = href.trim();
    if (trimmed.length === 0) return;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('#') || SKIP_SCHEMES.some((s) => lower.startsWith(s))) return;

    let absolute: URL;
    try {
      absolute = new URL(trimmed, base);
    } catch {
      return;
    }
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return;

    const rel = $(el).attr('rel') ?? null;
    links.push({
      url: absolute.toString(),
      anchorText: normalizeWhitespace($(el).text()).slice(0, 300),
      selector: cssSelector($, el),
      domPath: domPath($, el),
      rel,
      target: $(el).attr('target') ?? null,
      isNofollow: rel !== null && rel.toLowerCase().split(/\s+/).includes('nofollow'),
      fragment: absolute.hash.length > 1 ? absolute.hash.slice(1) : null,
      orderInPage: order++,
    });
  });

  const text = normalizeWhitespace($('body').text());
  const mountRoots = ['#root', '#app', '#__next', '[data-reactroot]'];
  const spaSuspected = scriptCount >= 3 && mountRoots.some((sel) => $(sel).length > 0);
  const title = $('title').first().text();

  return {
    links,
    spaSuspected,
    text,
    title: title !== undefined && normalizeWhitespace(title).length > 0 ? normalizeWhitespace(title) : null,
  };
}
