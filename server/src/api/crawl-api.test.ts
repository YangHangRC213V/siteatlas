/**
 * M1 接口测试：/api/sites/:id/crawl*、/api/sites/:id/tree、/api/nodes/:id
 * 用 Fastify inject（免端口）+ 本地 fixture 站点，不依赖外网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.ts';
import { openDb, type DbHandle } from '../core/store/db.ts';
import { BrowserPool } from '../core/fetch/pool.ts';
import { clearRobotsCache } from '../core/fetch/robots.ts';
import { startFakeSite, type FakeSite } from '../tests/fixture-site.ts';

interface Harness {
  app: FastifyInstance;
  handle: DbHandle;
  site: FakeSite;
  siteId: string;
  close(): Promise<void>;
}

/** 无浏览器池：M1 接口测试只走静态路径（回落链路已在内核集成测试覆盖） */
function noBrowserPool(): BrowserPool {
  return new BrowserPool({
    launcher: {
      async launch() {
        throw new Error('测试环境不启动浏览器');
      },
    },
  });
}

async function makeHarness(): Promise<Harness> {
  clearRobotsCache();
  const fake = await startFakeSite();
  const handle = openDb({ file: ':memory:' });
  const built = buildServer({ db: handle.db, rootDir: import.meta.dirname, logger: false, pool: noBrowserPool() });
  await built.app.ready();

  const res = await built.app.inject({
    method: 'POST',
    url: '/api/sites',
    payload: { url: `${fake.origin}/`, name: '本地测试站' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const siteId = res.json().site.id as string;

  return {
    app: built.app,
    handle,
    site: fake,
    siteId,
    async close() {
      await built.app.close();
      handle.close();
      await fake.close();
    },
  };
}

async function waitForTask(app: FastifyInstance, siteId: string, timeoutMs = 20000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/sites/${siteId}/crawl/status` });
    const body = res.json() as { task?: { status?: string } | null };
    const status = body.task?.status;
    if (status !== 'running' && status !== undefined && status !== null) return body as Record<string, unknown>;
    if (Date.now() > deadline) throw new Error(`等待任务结束超时，最后状态：${String(status)}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

const PRESET = {
  concurrency: 4,
  perHostConcurrency: 4,
  minDelayMs: 0,
  jitterMs: 0,
  maxDepth: 4,
  maxPages: 100,
  paginationPageLimit: 3,
  renderMode: 'http' as const,
};

test('M1 REST：POST /crawl 启动 → status 进度 → 队列落库 → 队列为空后任务 done', async () => {
  const h = await makeHarness();
  try {
    const started = await h.app.inject({
      method: 'POST',
      url: `/api/sites/${h.siteId}/crawl`,
      payload: { preset: PRESET },
    });
    assert.equal(started.statusCode, 202, started.body);
    const task = started.json().task as { id: string; status: string };
    assert.equal(task.status, 'running');
    assert.equal(typeof task.id, 'string');

    // 重复启动应被拒绝
    const again = await h.app.inject({
      method: 'POST',
      url: `/api/sites/${h.siteId}/crawl`,
      payload: { preset: PRESET },
    });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, 'CRAWL_ALREADY_RUNNING');

    const status = (await waitForTask(h.app, h.siteId)) as {
      task: { status: string; stats_json: string };
      progress: { pagesFetched: number; discovered: number; queueLength: number; ok: number };
      stats: { fetched: number; ok: number; skipped: number; depthDistribution: Record<string, number> };
      recentLogs: Array<{ url: string; http_status: number | null }>;
    };
    assert.equal(status.task.status, 'done');
    assert.ok(status.stats.fetched >= 8, `应抓取 >= 8 页，实际 ${status.stats.fetched}`);
    assert.ok(Object.keys(status.stats.depthDistribution).length >= 3, '深度分布应覆盖多级');
    assert.equal(status.progress.queueLength, 0, '任务结束后队列应为空');
    assert.ok(status.recentLogs.length > 0, '应写入 fetch_logs');
    assert.equal(JSON.parse(status.task.stats_json) !== null, true, 'stats_json 应落库');

    // 任务历史
    const tasks = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/crawl/tasks` });
    assert.equal(tasks.json().tasks.length, 1);
  } finally {
    await h.close();
  }
});

test('M1 REST：GET /tree 懒加载多级节点、无重复、带子节点计数', async () => {
  const h = await makeHarness();
  try {
    await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/crawl`, payload: { preset: PRESET } });
    await waitForTask(h.app, h.siteId);

    const rootRes = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/tree` });
    assert.equal(rootRes.statusCode, 200);
    const rootPage = rootRes.json() as {
      parentId: null;
      total: number;
      nodes: Array<{ id: string; depth: number; status: string; child_count: number; effective_parent_id: null; has_override: number; is_deleted: number }>;
    };
    assert.equal(rootPage.parentId, null);
    assert.equal(rootPage.total, 1, '默认只返回根节点一行');
    const rootNode = rootPage.nodes[0];
    assert.ok(rootNode !== undefined);
    assert.equal(rootNode.depth, 0);
    assert.equal(rootNode.status, 'ok');
    assert.ok(rootNode.child_count >= 8, `根节点应有 >= 8 个子节点，实际 ${rootNode.child_count}`);
    assert.equal(rootNode.has_override, false, '尚未有人工修正');
    assert.equal(rootNode.effective_parent_id, null);

    // 懒加载根节点的子节点
    const childrenRes = await h.app.inject({
      method: 'GET',
      url: `/api/sites/${h.siteId}/tree?parentId=${rootNode.id}&limit=100`,
    });
    const children = childrenRes.json() as { total: number; nodes: Array<{ id: string; depth: number; url: string; child_count: number }> };
    assert.equal(children.total, rootNode.child_count);
    assert.equal(children.nodes.length, children.total);
    assert.equal(children.nodes.every((n) => n.depth === 1), true, '子节点深度应为 1');

    // 分页：limit=2 只返回 2 条，total 不变
    const paged = await h.app.inject({
      method: 'GET',
      url: `/api/sites/${h.siteId}/tree?parentId=${rootNode.id}&limit=2&offset=0`,
    });
    const page1 = paged.json() as { total: number; nodes: unknown[]; limit: number; offset: number };
    assert.equal(page1.total, children.total);
    assert.equal(page1.nodes.length, 2);
    assert.equal(page1.limit, 2);

    // 下钻多级
    const docsNode = children.nodes.find((n) => n.url.endsWith('/docs'));
    assert.ok(docsNode !== undefined, '子节点里应有 /docs');
    const docsChildren = await h.app.inject({
      method: 'GET',
      url: `/api/sites/${h.siteId}/tree?parentId=${docsNode.id}`,
    });
    const deeper = docsChildren.json() as { nodes: Array<{ url: string; depth: number }> };
    assert.ok(deeper.nodes.length >= 2, '/docs 下应有子节点');
    assert.equal(deeper.nodes.every((n) => n.depth === 2), true);

    // 全站无重复（identity_key 唯一由 UNIQUE 约束保证，这里再从树接口侧确认节点总数）
    const ids = new Set<string>();
    const stack = [null as string | null];
    let visited = 0;
    while (stack.length > 0) {
      const parent = stack.pop() ?? null;
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/sites/${h.siteId}/tree?parentId=${parent === null ? '' : parent}&limit=500`,
      });
      for (const node of (res.json() as { nodes: Array<{ id: string; child_count: number }> }).nodes) {
        assert.equal(ids.has(node.id), false, `节点重复出现在树中：${node.id}`);
        ids.add(node.id);
        visited += 1;
        if (node.child_count > 0) stack.push(node.id);
      }
    }
    assert.ok(visited >= 10, `树中节点应 >= 10，实际 ${visited}`);
  } finally {
    await h.close();
  }
});

test('M2 REST：GET /api/nodes/:id 详情含入链出链与修正历史；PATCH 改别名/地址写修正层', async () => {
  const h = await makeHarness();
  try {
    await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/crawl`, payload: { preset: PRESET } });
    await waitForTask(h.app, h.siteId);

    const rootRes = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/tree` });
    const rootId = (rootRes.json() as { nodes: Array<{ id: string }> }).nodes[0]?.id as string;
    const childrenRes = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/tree?parentId=${rootId}` });
    const teamNode = (childrenRes.json() as { nodes: Array<{ id: string; url: string }> }).nodes.find((n) => n.url.endsWith('/team'));
    assert.ok(teamNode !== undefined);

    const detail = await h.app.inject({ method: 'GET', url: `/api/nodes/${teamNode.id}` });
    assert.equal(detail.statusCode, 200);
    const body = detail.json() as {
      node: { id: string; in_link_count: number; out_link_count: number; title: string | null; content_hash: string | null };
      parents: Array<{ edge: { anchor_text: string | null; selector: string | null; source: string }; from: { url: string } | null }>;
    };
    assert.equal(body.parents.length, 2, '/team 应有 2 条入链（首页 + 关于页）');
    assert.equal(body.parents.every((p) => p.edge.source === 'auto'), true);
    assert.ok(body.parents.every((p) => p.from !== null));
    assert.ok(body.node.content_hash !== null, '应写入正文指纹');

    // 别名
    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/nodes/${teamNode.id}`,
      payload: { alias: '我们的团队' },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().node.alias, '我们的团队');
    assert.equal(patched.json().node.display_label, '我们的团队', 'display_label 应优先取别名（§6.4）');
    assert.equal(patched.json().node.has_override, true, '改别名后应带修正徽标');

    // 改地址：M2 起写修正层（identity_key 不变，旧值进 prev_value 作为历史）
    const urlPatch = await h.app.inject({
      method: 'PATCH',
      url: `/api/nodes/${teamNode.id}`,
      payload: { url: 'https://example.com/team-renamed' },
    });
    assert.equal(urlPatch.statusCode, 200);
    assert.equal(urlPatch.json().node.url, 'https://example.com/team-renamed');
    assert.equal(urlPatch.json().node.identity_key, teamNode.url, 'identity_key 不因人工改地址而变');
    assert.equal(urlPatch.json().node.has_override, true);

    // 修正历史可读
    const after = await h.app.inject({ method: 'GET', url: `/api/nodes/${teamNode.id}` });
    const history = (after.json() as { history: Array<{ field: string; prev_value: string | null }> }).history;
    assert.ok(history.some((h) => h.field === 'url' && h.prev_value === teamNode.url));
    assert.ok(history.some((h) => h.field === 'alias'));
  } finally {
    await h.close();
  }
});

test('M1 REST：pause/resume/stop 状态流转与错误码', async () => {
  const h = await makeHarness();
  try {
    // 未启动时控制接口应报 409
    const early = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/crawl/pause` });
    assert.equal(early.statusCode, 409);
    assert.equal(early.json().error.code, 'CRAWL_NOT_RUNNING');

    // 慢速任务便于控制
    await h.app.inject({
      method: 'POST',
      url: `/api/sites/${h.siteId}/crawl`,
      payload: { preset: { ...PRESET, concurrency: 1, perHostConcurrency: 1, minDelayMs: 400 } },
    });
    await new Promise((r) => setTimeout(r, 250));

    const paused = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/crawl/pause` });
    assert.equal(paused.statusCode, 200);
    assert.equal(paused.json().task.status, 'paused');

    const statusPaused = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/crawl/status` });
    assert.equal(statusPaused.json().task.status, 'paused');
    assert.equal(statusPaused.json().progress.status, 'paused');

    const resumed = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/crawl/resume` });
    assert.equal(resumed.json().task.status, 'running');

    const stopped = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/crawl/stop` });
    assert.equal(stopped.json().task.status, 'stopped');

    const finalStatus = (await waitForTask(h.app, h.siteId)) as { task: { status: string } };
    assert.equal(finalStatus.task.status, 'stopped');

    // 已停止的任务不能「继续」
    const resumeStopped = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/crawl/resume` });
    assert.equal(resumeStopped.statusCode, 409);
  } finally {
    await h.close();
  }
});

test('M1 REST：归档站点不可启动采集；不存在的站点返回 404', async () => {
  const h = await makeHarness();
  try {
    await h.app.inject({ method: 'DELETE', url: `/api/sites/${h.siteId}` });
    const archived = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/crawl`, payload: { preset: PRESET } });
    assert.equal(archived.statusCode, 409);
    assert.equal(archived.json().error.code, 'SITE_ARCHIVED');

    const missing = await h.app.inject({ method: 'POST', url: '/api/sites/01JZZZZZZZZZZZZZZZZZZZZZZZ/crawl', payload: {} });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'SITE_NOT_FOUND');

    const missingTree = await h.app.inject({ method: 'GET', url: '/api/sites/01JZZZZZZZZZZZZZZZZZZZZZZZ/tree' });
    assert.equal(missingTree.statusCode, 404);
  } finally {
    await h.close();
  }
});
