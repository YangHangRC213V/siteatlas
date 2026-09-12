/**
 * core/crawl 单元测试：前缀剪枝 Trie、分页探测、重试退避
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrefixTrie } from './prefix.ts';
import { PaginationLimiter, detectPagination } from './pagination.ts';
import { backoffDelay, decideRetry, isRetryableHttp } from './retry.ts';
import { resolvePreset } from './service.ts';

test('PrefixTrie：同一前缀连续命中超阈值即剪枝该前缀', () => {
  const trie = new PrefixTrie(3);
  const results = [
    trie.recordHit('https://x.com/a/1'),
    trie.recordHit('https://x.com/a/2'),
    trie.recordHit('https://x.com/a/3'),
    trie.recordHit('https://x.com/a/4'),
  ];
  // 阈值 3：第 4 次命中时 hits=4 > 3 → 剪枝 /a
  assert.deepEqual(
    results.map((r) => r.pruned),
    [false, false, false, true],
  );
  assert.equal(trie.isPruned('https://x.com/a/99'), '/a');
  assert.equal(trie.isPruned('https://x.com/b/1'), null);
  assert.deepEqual(trie.prunedPrefixes, ['/a']);
});

test('PrefixTrie：按路径段而非字符匹配（/ab 不影响 /a）', () => {
  const trie = new PrefixTrie(1);
  trie.recordHit('https://x.com/ab');
  trie.recordHit('https://x.com/ab');
  assert.equal(trie.isPruned('https://x.com/ab'), '/ab');
  assert.equal(trie.isPruned('https://x.com/a'), null);
  assert.equal(trie.isPruned('https://x.com/abc'), null);
});

test('detectPagination：识别 ?page=n / /page/n / ?offset=n', () => {
  assert.deepEqual(detectPagination('https://x.com/list?page=3').pageNumber, 3);
  assert.equal(detectPagination('https://x.com/list?page=3').isPaged, true);
  assert.equal(detectPagination('https://x.com/list/page/12/').pageNumber, 12);
  assert.equal(detectPagination('https://x.com/list?offset=40').pageNumber, 40);
  assert.equal(detectPagination('https://x.com/list?q=abc').isPaged, false);
  // 非数字页号不算分页
  assert.equal(detectPagination('https://x.com/list?page=all').isPaged, false);
});

test('PaginationLimiter：同一序列超过上限后拒绝入队', () => {
  const limiter = new PaginationLimiter(3);
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((n) => limiter.allow(`https://x.com/list?page=${n}`)),
    [true, true, true, false, false],
  );
  // 另一个序列不受影响
  assert.equal(limiter.allow('https://x.com/other?page=1'), true);
  assert.equal(limiter.allow('https://x.com/plain'), true);
  assert.deepEqual(limiter.series.map((s) => s.pages), [3, 1]);
});

test('retry：退避指数增长并封顶，4xx 不重试', () => {
  const options = { maxRetries: 5, backoffMs: 100, backoffMaxMs: 400 };
  for (const attempt of [1, 2, 3]) {
    const delay = backoffDelay(attempt, options);
    const expected = Math.min(100 * 2 ** (attempt - 1), 400);
    assert.ok(Math.abs(delay - expected) <= expected * 0.11, `attempt=${attempt} delay=${delay}`);
  }
  assert.ok(backoffDelay(9, options) <= 440);
  assert.equal(isRetryableHttp(500), true);
  assert.equal(isRetryableHttp(429), true);
  assert.equal(isRetryableHttp(404), false);
  assert.equal(isRetryableHttp(null), true);
  assert.equal(decideRetry(3, 404, options).retry, false);
  assert.equal(decideRetry(6, 500, options).retry, false);
});

test('resolvePreset：越界参数被夹到合法区间，缺省字段取默认值', () => {
  const preset = resolvePreset({ concurrency: 99, maxDepth: -5, minDelayMs: -1, visitLimit: 999 }, 'same_site');
  assert.equal(preset.concurrency, 32);
  assert.equal(preset.maxDepth, 0);
  assert.equal(preset.minDelayMs, 0);
  assert.equal(preset.visitLimit, 100);
  assert.equal(preset.maxPages, 100000);
  assert.equal(preset.scope, 'same_site');
  assert.equal(preset.renderMode, 'auto');
  assert.equal(resolvePreset(undefined, 'same_domain').scope, 'same_domain');
});
