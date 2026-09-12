/**
 * /api/sites 接口自检（dev-spec §5.1 / §7 M0 验收：输入 URL 能建站并显示根节点）
 *
 * 用 Fastify 的 `inject` 免端口测试；探测函数注入假实现，避免测试依赖外网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { UrlProbeResult } from '@siteatlas/shared';
import { buildServer } from './server.ts';
import { openDb, type DbHandle } from '../core/store/db.ts';

function okProbe(overrides: Partial<UrlProbeResult> = {}) {
  return async (url: string): Promise<UrlProbeResult> => ({
    reachable: true,
    isHtml: true,
    status: 200,
    contentType: 'text/html; charset=utf-8',
    finalUrl: url,
    redirectChain: [url],
    error: null,
    ...overrides,
  });
}

interface Harness {
  app: FastifyInstance;
  handle: DbHandle;
  close(): Promise<void>;
}

function makeHarness(
  probe: (url: string, options?: unknown) => Promise<UrlProbeResult> = okProbe(),
): Harness {
  const handle = openDb({ file: ':memory:' });
  const built = buildServer({ db: handle.db, rootDir: import.meta.dirname, logger: false });
  // 注入假探测：绕过网络，仅验证建站编排与校验分支
  const service = built.service as unknown as { probe: typeof probe };
  service.probe = probe as never;
  return {
    app: built.app,
    handle,
    close: async () => {
      await built.app.close();
      handle.close();
    },
  };
}

async function createSite(
  app: FastifyInstance,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; json: any }> {
  const res = await app.inject({ method: 'POST', url: '/api/sites', payload: body });
  return { statusCode: res.statusCode, json: res.json() };
}

test('POST /api/sites：建站 + 建 depth=0 根节点，根节点 url 保留 fragment', async () => {
  const h = makeHarness();
  try {
    const { statusCode, json } = await createSite(h.app, { url: 'https://www.Example.com/docs/?utm_source=x#install' });
    assert.equal(statusCode, 201);
    assert.equal(json.site.root_url, 'https://example.com/docs');
    assert.equal(json.site.root_host, 'example.com');
    assert.equal(json.site.name, 'example.com');
    assert.equal(json.site.scope, 'same_site');
    assert.equal(json.site.archived, 0);
    assert.equal(json.root.site_id, json.site.id);
    assert.equal(json.root.depth, 0);
    assert.equal(json.root.auto_parent_id, null);
    assert.equal(json.root.status, 'ok');
    assert.equal(json.root.http_status, 200);
    assert.equal(json.root.identity_key, 'https://example.com/docs');
    assert.equal(json.root.url, 'https://example.com/docs#install');
    assert.equal(json.root.display_label, 'docs');
    assert.equal(json.probe.isHtml, true);
  } finally {
    await h.close();
  }
});

test('POST /api/sites：非 http/https 协议 → 400 INVALID_URL', async () => {
  const h = makeHarness();
  try {
    const { statusCode, json } = await createSite(h.app, { url: 'ftp://example.com/a' });
    assert.equal(statusCode, 400);
    assert.equal(json.error.code, 'INVALID_URL');
  } finally {
    await h.close();
  }
});

test('POST /api/sites：非 HTML 响应 → 422 NOT_HTML', async () => {
  const h = makeHarness(okProbe({ isHtml: false, contentType: 'application/pdf' }));
  try {
    const { statusCode, json } = await createSite(h.app, { url: 'https://example.com/a.pdf' });
    assert.equal(statusCode, 422);
    assert.equal(json.error.code, 'NOT_HTML');
    assert.match(json.error.message, /application\/pdf/);
  } finally {
    await h.close();
  }
});

test('POST /api/sites：探测失败仍建站，根节点标 error 并在 note 记录原因', async () => {
  const h = makeHarness(async (url: string) => ({
    reachable: false,
    isHtml: false,
    status: null,
    contentType: null,
    finalUrl: null,
    redirectChain: [url],
    error: 'getaddrinfo ENOTFOUND example.invalid',
  }));
  try {
    const { statusCode, json } = await createSite(h.app, { url: 'https://example.invalid/' });
    assert.equal(statusCode, 201);
    assert.equal(json.root.status, 'error');
    assert.equal(json.root.http_status, null);
    assert.match(json.site.note, /探测失败/);
    assert.equal(json.probe.reachable, false);
  } finally {
    await h.close();
  }
});

test('POST /api/sites：skipProbe 时节点保持 queued', async () => {
  const h = makeHarness();
  try {
    const { statusCode, json } = await createSite(h.app, { url: 'https://offline.local/', skipProbe: true });
    assert.equal(statusCode, 201);
    assert.equal(json.root.status, 'queued');
    assert.equal(json.root.last_fetch_at, null);
  } finally {
    await h.close();
  }
});

test('POST /api/sites：同根 URL 重复建站 → 409 SITE_EXISTS', async () => {
  const h = makeHarness();
  try {
    const first = await createSite(h.app, { url: 'https://example.com/' });
    assert.equal(first.statusCode, 201);
    const second = await createSite(h.app, { url: 'https://www.example.com/?utm_source=dup' });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json.error.code, 'SITE_EXISTS');
    assert.equal(second.json.error.detail.siteId, first.json.site.id);
  } finally {
    await h.close();
  }
});

test('POST /api/sites：缺失 url / 非法 scope → 400', async () => {
  const h = makeHarness();
  try {
    const noUrl = await h.app.inject({ method: 'POST', url: '/api/sites', payload: {} });
    assert.equal(noUrl.statusCode, 400);
    assert.equal(noUrl.json().error.code, 'INVALID_BODY');

    const badScope = await createSite(h.app, { url: 'https://example.com/', scope: 'galaxy' });
    assert.equal(badScope.statusCode, 400);
    assert.equal(badScope.json.error.code, 'INVALID_BODY');
  } finally {
    await h.close();
  }
});

test('GET /api/sites：卡片列表含节点数/状态/更新时间统计', async () => {
  const h = makeHarness();
  try {
    await createSite(h.app, { url: 'https://a.example.com/', name: '站点A' });
    await createSite(h.app, { url: 'https://b.example.com/', name: '站点B' });

    const res = await h.app.inject({ method: 'GET', url: '/api/sites' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      sites: Array<{ site: { name: string; updated_at: number }; stats: Record<string, unknown> }>;
    };
    assert.equal(body.sites.length, 2);
    const names = body.sites.map((c) => c.site.name).sort();
    assert.deepEqual(names, ['站点A', '站点B']);
    for (const card of body.sites) {
      assert.equal(card.stats['nodeCount'], 1);
      assert.equal(card.stats['rootStatus'], 'ok');
      assert.equal(card.stats['maxDepth'], 0);
      assert.equal(typeof card.site.updated_at, 'number');
    }
  } finally {
    await h.close();
  }
});

test('GET/PATCH /api/sites/:id：详情、改名、改范围、备注、归档', async () => {
  const h = makeHarness();
  try {
    const created = await createSite(h.app, { url: 'https://example.com/' });
    const id = created.json.site.id as string;

    const detail = await h.app.inject({ method: 'GET', url: `/api/sites/${id}` });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().root.depth, 0);
    assert.equal(detail.json().stats.nodeCount, 1);

    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/sites/${id}`,
      payload: { name: '改后的名字', scope: 'same_domain', note: '备注', allowlist: ['*.cdn.net'] },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().site.name, '改后的名字');
    assert.equal(patched.json().site.scope, 'same_domain');
    assert.equal(patched.json().site.note, '备注');
    assert.equal(patched.json().site.allowlist_json, '["*.cdn.net"]');

    const archived = await h.app.inject({ method: 'PATCH', url: `/api/sites/${id}`, payload: { archived: true } });
    assert.equal(archived.json().site.archived, 1);
  } finally {
    await h.close();
  }
});

test('GET/PATCH /api/sites/:id：不存在 → 404 SITE_NOT_FOUND', async () => {
  const h = makeHarness();
  try {
    const missing = await h.app.inject({ method: 'GET', url: '/api/sites/01JZZZZZZZZZZZZZZZZZZZZZZZ' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'SITE_NOT_FOUND');
  } finally {
    await h.close();
  }
});

test('DELETE /api/sites/:id：软删整站，返回影响节点数，列表不再返回该站', async () => {
  const h = makeHarness();
  try {
    const created = await createSite(h.app, { url: 'https://example.com/' });
    const id = created.json.site.id as string;

    const del = await h.app.inject({ method: 'DELETE', url: `/api/sites/${id}` });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().deleted, true);
    assert.equal(del.json().affectedNodes, 1);
    assert.equal(del.json().site.archived, 1);

    const list = await h.app.inject({ method: 'GET', url: '/api/sites' });
    assert.equal(list.json().sites.length, 0);

    // 软删：数据仍在，记录仍可读
    const detail = await h.app.inject({ method: 'GET', url: `/api/sites/${id}` });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().site.archived, 1);
    assert.equal((h.handle.db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c, 1);
    assert.equal(
      (h.handle.db.prepare('SELECT is_deleted FROM nodes WHERE site_id = ?').get(id) as { is_deleted: number })
        .is_deleted,
      1,
    );

    // 回收站视图与恢复
    const archivedList = await h.app.inject({ method: 'GET', url: '/api/sites?archived=1' });
    assert.equal(archivedList.json().sites.length, 1);
    const restored = await h.app.inject({ method: 'POST', url: `/api/sites/${id}/restore` });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().site.archived, 0);

    const deleteAgain = await h.app.inject({ method: 'DELETE', url: `/api/sites/${id}` });
    assert.equal(deleteAgain.json().affectedNodes, 1);
    const notFound = await h.app.inject({ method: 'DELETE', url: '/api/sites/01JZZZZZZZZZZZZZZZZZZZZZZZ' });
    assert.equal(notFound.statusCode, 404);
  } finally {
    await h.close();
  }
});

test('GET /api/health：返回契约版本', async () => {
  const h = makeHarness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
    assert.equal(res.json().schemaVersion, '1.0');
  } finally {
    await h.close();
  }
});

test('未知 /api 路由 → 404 JSON 错误体；未知页面路由 → SPA 回落', async () => {
  const h = makeHarness();
  try {
    const api = await h.app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(api.statusCode, 404);
    assert.equal(api.json().error.code, 'NOT_FOUND');

    const page = await h.app.inject({ method: 'GET', url: '/sites/abc/tree' });
    assert.ok([200, 503].includes(page.statusCode));
  } finally {
    await h.close();
  }
});
