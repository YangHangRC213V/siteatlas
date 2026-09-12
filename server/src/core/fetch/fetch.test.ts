/**
 * core/fetch + core/extract 单元测试：robots.txt 解析与遵守、链接抽取、内容指纹、渲染回落判定
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedByRobots, parseRobotsTxt } from '../fetch/robots.ts';
import { looksAssetContentType, looksHtmlContentType } from '../fetch/http-fetcher.ts';
import { decideRender } from '../fetch/browser-fetcher.ts';
import { extractLinks } from '../extract/links.ts';
import { contentFingerprint, deriveDisplayLabel, pathTail } from '../extract/content.ts';

const UA = 'SiteAtlas/0.1 (+local crawling tool)';

test('robots.txt：用户代理分组与最长匹配优先', () => {
  const text = `
# 注释行
User-agent: *
Disallow: /private/
Allow: /private/readme

User-agent: SiteAtlas
Disallow: /nogo/
Crawl-delay: 2

Sitemap: https://x.com/sitemap.xml
`;
  const rules = parseRobotsTxt(text, UA, 'https://x.com');
  assert.equal(rules.fetched, true);
  assert.equal(rules.crawlDelayMs, 2000);
  assert.deepEqual(rules.sitemaps, ['https://x.com/sitemap.xml']);
  // 精确分组命中：/nogo/ 被禁
  assert.equal(isAllowedByRobots(rules, 'https://x.com/nogo/a'), false);
  assert.equal(isAllowedByRobots(rules, 'https://x.com/ok'), true);
  // 命中的是 SiteAtlas 分组（不含 /private/ 规则）
  assert.equal(isAllowedByRobots(rules, 'https://x.com/private/x'), true);
});

test('robots.txt：Allow 与 Disallow 等长时 Allow 胜；通配与 $ 锚定', () => {
  const rules = parseRobotsTxt(
    `User-agent: *
Disallow: /*.pdf$
Disallow: /tmp
Allow: /tmp/keep`,
    UA,
    'https://x.com',
  );
  assert.equal(isAllowedByRobots(rules, 'https://x.com/a/b.pdf'), false);
  assert.equal(isAllowedByRobots(rules, 'https://x.com/a/b.pdf?x=1'), true);
  assert.equal(isAllowedByRobots(rules, 'https://x.com/tmp/a'), false);
  assert.equal(isAllowedByRobots(rules, 'https://x.com/tmp/keep/a'), true);
});

test('robots.txt：无匹配分组或无规则 → 全部允许', () => {
  const rules = parseRobotsTxt('User-agent: Googlebot\nDisallow: /', UA, 'https://x.com');
  assert.equal(rules.allowAll, true);
  assert.equal(rules.rules.length, 0);
  assert.equal(isAllowedByRobots(rules, 'https://x.com/anything'), true);
});

test('content-type 判定：HTML / 素材 / 缺省', () => {
  assert.equal(looksHtmlContentType('text/html; charset=utf-8'), true);
  assert.equal(looksHtmlContentType('application/xhtml+xml'), true);
  assert.equal(looksHtmlContentType(null), true);
  assert.equal(looksHtmlContentType('application/pdf'), false);
  assert.equal(looksAssetContentType('image/png'), true);
  assert.equal(looksAssetContentType('application/pdf'), true);
  assert.equal(looksAssetContentType('text/html'), false);
  assert.equal(looksAssetContentType(null), false);
});

test('渲染回落判定：链接数为 0 → 回落；http 模式不回落；browser 模式强制', () => {
  const base = { staticOk: true, linkCount: 5, htmlLength: 1000, spaSuspected: false, textLength: 500 };
  assert.equal(decideRender({ ...base, mode: 'auto' }), 'static-enough');
  assert.equal(decideRender({ ...base, mode: 'auto', linkCount: 0 }), 'no-links-fallback');
  assert.equal(decideRender({ ...base, mode: 'auto', spaSuspected: true, textLength: 50 }), 'spa-fallback');
  assert.equal(decideRender({ ...base, mode: 'auto', spaSuspected: true, textLength: 800 }), 'static-enough');
  assert.equal(decideRender({ ...base, mode: 'http', linkCount: 0 }), 'static-enough');
  assert.equal(decideRender({ ...base, mode: 'browser' }), 'forced-browser');
  assert.equal(decideRender({ ...base, mode: 'auto', staticOk: false }), 'static-error');
});

test('链接抽取：绝对化、跳过 mailto/#/javascript、保留 selector 与 fragment', () => {
  const html = `
<html><head><base href="https://example.com/base/"></head>
<body>
  <nav id="main">
    <a href="/a">A 页</a>
    <a href="b/c">相对 B</a>
    <a href="https://other.com/x" rel="nofollow" target="_blank">外链</a>
    <a href="mailto:x@example.com">邮件</a>
    <a href="#sec">页内锚点</a>
    <a href="javascript:void(0)">JS</a>
    <a href="/d?utm_source=nl&amp;b=2&amp;a=1#frag">带参数</a>
  </nav>
</body></html>`;
  const result = extractLinks(html, 'https://example.com/page');
  const urls = result.links.map((l) => l.url);
  // base href 生效
  assert.ok(urls.includes('https://example.com/a'));
  assert.ok(urls.includes('https://example.com/base/b/c'));
  assert.ok(urls.includes('https://other.com/x'));
  assert.ok(urls.includes('https://example.com/d?utm_source=nl&b=2&a=1#frag'));
  assert.equal(urls.some((u) => u.startsWith('mailto:')), false);
  assert.equal(urls.some((u) => u.includes('javascript:')), false);
  assert.equal(urls.some((u) => u.endsWith('#sec')), false);

  const external = result.links.find((l) => l.url === 'https://other.com/x');
  assert.equal(external?.isNofollow, true);
  assert.equal(external?.target, '_blank');
  assert.equal(external?.anchorText, '外链');

  const frag = result.links.find((l) => l.url.includes('#frag'));
  assert.equal(frag?.fragment, 'frag');

  const first = result.links[0];
  assert.ok(first !== undefined);
  assert.match(first.selector, /a/);
  assert.equal(first.domPath.includes('/'), true);
  assert.deepEqual(
    result.links.map((l) => l.orderInPage),
    result.links.map((_, i) => i),
  );
});

test('内容指纹：短正文返回 null，长正文同内容同指纹、异内容异指纹', () => {
  assert.equal(contentFingerprint('太短'), null);
  const long = '这是一段足够长的正文内容，用于内容去重指纹的判定。'.repeat(5);
  const a = contentFingerprint(long);
  const b = contentFingerprint(long.replace(/\s+/g, ' '));
  const c = contentFingerprint(`${long}另外一段完全不同的结尾内容补充。`);
  assert.ok(a !== null && b !== null && c !== null);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('display_label：别名 > 标题 > 路径末段；根 URL 落到域名', () => {
  assert.equal(deriveDisplayLabel({ alias: '别名', title: '标题', url: 'https://x.com/a/b' }), '别名');
  assert.equal(deriveDisplayLabel({ alias: null, title: '标题', url: 'https://x.com/a/b' }), '标题');
  assert.equal(deriveDisplayLabel({ url: 'https://x.com/a/b/' }), 'b');
  assert.equal(deriveDisplayLabel({ url: 'https://www.x.com/' }), 'x.com');
  assert.equal(pathTail('https://x.com/%E4%B8%AD%E6%96%87/'), '中文');
});
