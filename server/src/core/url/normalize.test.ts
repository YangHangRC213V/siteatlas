/**
 * core/url 规范化单元测试（dev-spec §6.1）
 * 覆盖：小写 host / 默认端口 / www / 尾斜杠 / query 排序 / fragment / utm 参数
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidUrlError, normalizeUrl, DEFAULT_NORMALIZE_OPTIONS } from './normalize.ts';
import { identityKeyOf, isSameIdentity } from './identity.ts';

test('1. 小写 host：大写主机名归一', () => {
  assert.equal(normalizeUrl('HTTPS://Example.COM/Path').identityKey, 'https://example.com/Path');
});

test('2. 默认端口：http:80 / https:443 补默认端口后省略，非默认端口保留', () => {
  assert.equal(normalizeUrl('http://example.com:80/a').identityKey, 'http://example.com/a');
  assert.equal(normalizeUrl('https://example.com:443/a').identityKey, 'https://example.com/a');
  assert.equal(normalizeUrl('http://example.com:8080/a').identityKey, 'http://example.com:8080/a');
});

test('3. www：默认去除，可配保留', () => {
  assert.equal(normalizeUrl('https://www.example.com/a').identityKey, 'https://example.com/a');
  assert.equal(
    normalizeUrl('https://www.example.com/a', { dropWww: false }).identityKey,
    'https://www.example.com/a',
  );
  assert.equal(DEFAULT_NORMALIZE_OPTIONS.dropWww, true);
});

test('4. 尾斜杠：去尾部 /，根路径保持 /', () => {
  assert.equal(normalizeUrl('https://example.com/a/b/').identityKey, 'https://example.com/a/b');
  assert.equal(normalizeUrl('https://example.com/a/b///').identityKey, 'https://example.com/a/b');
  assert.equal(normalizeUrl('https://example.com/').identityKey, 'https://example.com/');
});

test('5. query 排序：键值确定性排序', () => {
  assert.equal(
    normalizeUrl('https://example.com/p?b=2&a=1&c=3').identityKey,
    'https://example.com/p?a=1&b=2&c=3',
  );
  assert.equal(normalizeUrl('https://example.com/p?b=1&a=1').identityKey, normalizeUrl('https://example.com/p?a=1&b=1').identityKey);
});

test('6. fragment：剔除在 identityKey 里、保留在 url 里', () => {
  const n = normalizeUrl('https://example.com/a#section-2');
  assert.equal(n.identityKey, 'https://example.com/a');
  assert.equal(n.url, 'https://example.com/a#section-2');
  assert.equal(n.fragment, 'section-2');
});

test('7. utm 参数：utm_* 全部剔除（大小写不敏感）', () => {
  assert.equal(
    normalizeUrl('https://example.com/a?utm_source=x&UTM_Campaign=y&utm_medium=z').identityKey,
    'https://example.com/a',
  );
  assert.equal(normalizeUrl('https://example.com/a?utm_source=x&keep=1').identityKey, 'https://example.com/a?keep=1');
});

test('8. sessionid / _ga：内置黑名单剔除', () => {
  assert.equal(normalizeUrl('https://example.com/a?sessionid=abc').identityKey, 'https://example.com/a');
  assert.equal(normalizeUrl('https://example.com/a?_ga=GA1.2.3').identityKey, 'https://example.com/a');
  assert.equal(normalizeUrl('https://example.com/a?keep=1&sessionid=abc&_ga=1').identityKey, 'https://example.com/a?keep=1');
});

test('9. 自定义黑名单：叠加在内置黑名单之上', () => {
  assert.equal(
    normalizeUrl('https://example.com/a?ref=twitter&keep=1', { trackingBlacklist: ['ref'] }).identityKey,
    'https://example.com/a?keep=1',
  );
});

test('10. 跟踪参数不影响身份：同资源不同跟踪参数 → 同一 identityKey', () => {
  const a = identityKeyOf('https://www.example.com/p?utm_source=a&utm_medium=b');
  const b = identityKeyOf('https://EXAMPLE.com:443/p/?_ga=1');
  assert.equal(a, b);
  assert.equal(a, 'https://example.com/p');
  assert.equal(isSameIdentity('https://example.com/p?utm_source=a', 'https://example.com/p#frag'), true);
  // 协议默认不归一：http 与 https 视为两个身份（除非开启 forceHttps）
  assert.equal(isSameIdentity('http://example.com/p', 'https://example.com/p'), false);
});

test('11. 无协议输入补 https，非 http(s) 协议报错', () => {
  assert.equal(normalizeUrl('example.com/a').identityKey, 'https://example.com/a');
  assert.throws(() => normalizeUrl('ftp://example.com/a'), (err: unknown) => {
    assert.ok(err instanceof InvalidUrlError);
    assert.match(err.message, /仅支持 http\/https/);
    return true;
  });
  assert.throws(() => normalizeUrl('javascript:alert(1)'), InvalidUrlError);
  assert.throws(() => normalizeUrl(''), InvalidUrlError);
  assert.throws(() => normalizeUrl('   '), InvalidUrlError);
});

test('12. forceHttps：可选把 http 归一为 https（非默认）', () => {
  assert.equal(normalizeUrl('http://example.com/a', { forceHttps: true }).identityKey, 'https://example.com/a');
  assert.equal(normalizeUrl('http://example.com:80/a', { forceHttps: true }).identityKey, 'https://example.com/a');
  // 非默认端口不擅自改协议，避免语义漂移
  assert.equal(normalizeUrl('http://example.com:8080/a', { forceHttps: true }).identityKey, 'http://example.com:8080/a');
  assert.equal(normalizeUrl('http://example.com/a').identityKey, 'http://example.com/a');
});

test('13. 端口写入规范化 host：normalizedHost 去 www、port 单独给出', () => {
  const n = normalizeUrl('https://WWW.Example.com:8443/x');
  assert.equal(n.normalizedHost, 'example.com');
  assert.equal(n.host, 'www.example.com');
  assert.equal(n.port, '8443');
  assert.equal(n.origin, 'https://example.com:8443');
  assert.equal(n.identityKey, 'https://example.com:8443/x');
});

test('14. 编码与空 query：query 值保序语义正确', () => {
  assert.equal(
    normalizeUrl('https://example.com/s?q=%E4%B8%AD%E6%96%87&lang=zh').identityKey,
    'https://example.com/s?lang=zh&q=%E4%B8%AD%E6%96%87',
  );
  assert.equal(normalizeUrl('https://example.com/s?').identityKey, 'https://example.com/s');
  assert.equal(normalizeUrl('https://example.com/s?a=1&a=2').identityKey, 'https://example.com/s?a=1&a=2');
});

test('15. scope 字段：协议判定', () => {
  assert.equal(normalizeUrl('https://example.com/a').scope, 'https');
  assert.equal(normalizeUrl('http://example.com/a').scope, 'http');
});

test('16. isSameIdentity 对非法 URL 返回 false 而不抛异常', () => {
  assert.equal(isSameIdentity('not a url with spaces', 'https://example.com'), false);
  assert.equal(isSameIdentity('https://example.com/a', 'https://example.com/b'), false);
});
