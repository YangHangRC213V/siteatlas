/**
 * core/url 范围判定单元测试（dev-spec §0 抓取范围决策 / §4 sites.scope）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInScope, matchAllowlist } from './scope.ts';

test('same_site：同域与子域在范围内，跨域不在', () => {
  const rule = { scope: 'same_site' as const, rootUrl: 'https://www.example.com/' };
  assert.equal(isInScope('https://example.com/a', rule), true);
  assert.equal(isInScope('https://blog.example.com/a', rule), true);
  assert.equal(isInScope('https://other.com/a', rule), false);
  // 后缀相似但不是子域
  assert.equal(isInScope('https://notexample.com/a', rule), false);
});

test('same_domain：子域不在范围内', () => {
  const rule = { scope: 'same_domain' as const, rootUrl: 'https://www.example.com/' };
  assert.equal(isInScope('https://example.com/a', rule), true);
  assert.equal(isInScope('https://blog.example.com/a', rule), false);
});

test('allowlist：通配子域与精确匹配', () => {
  const rule = { scope: 'allowlist' as const, rootUrl: 'https://example.com/', allowlist: ['*.cdn.net', 'partner.org'] };
  assert.equal(isInScope('https://a.cdn.net/x', rule), true);
  assert.equal(isInScope('https://cdn.net/x', rule), false);
  assert.equal(isInScope('https://partner.org/x', rule), true);
  assert.equal(isInScope('https://evil.org/x', rule), false);
});

test('all：不限制', () => {
  assert.equal(isInScope('https://anything.io/x', { scope: 'all', rootUrl: 'https://example.com/' }), true);
});

test('非法候选 URL 不算在范围内', () => {
  assert.equal(isInScope('ftp://example.com/a', { scope: 'all', rootUrl: 'https://example.com/' }), false);
  assert.equal(isInScope('ftp://example.com/a', { scope: 'same_site', rootUrl: 'https://example.com/' }), false);
  assert.equal(isInScope('mailto:a@b.com', { scope: 'same_site', rootUrl: 'https://example.com/' }), false);
});

test('matchAllowlist 大小写与前导点容错', () => {
  assert.equal(matchAllowlist('Example.com', 'example.com'), true);
  assert.equal(matchAllowlist('.example.com', 'example.com'), true);
  assert.equal(matchAllowlist('*.Example.com', 'sub.example.com'), true);
  assert.equal(matchAllowlist('', 'example.com'), false);
});
