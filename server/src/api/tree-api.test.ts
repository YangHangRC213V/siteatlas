/**
 * M2 接口测试：重挂 / 软删子树 / 撤销重做 / 还原 / 回收站 / 检索（dev-spec §5.1 / §6.4）
 * 在真实采集出的树上操作，验证「树 = 自动投影 + 修正层」端到端一致。
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
  ids: { root: string; docs: string; team: string; guide: string; install: string };
  close(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  clearRobotsCache();
  const fake = await startFakeSite();
  const handle = openDb({ file: ':memory:' });
  const built = buildServer({
    db: handle.db,
    rootDir: import.meta.dirname,
    logger: false,
    pool: new BrowserPool({ launcher: { async launch() { throw new Error('测试不启动浏览器'); } } }),
  });
  await built.app.ready();

  const created = await built.app.inject({
    method: 'POST',
    url: '/api/sites',
    payload: { url: `${fake.origin}/`, name: 'M2 测试站' },
  });
  const siteId = created.json().site.id as string;
  await built.app.inject({
    method: 'POST',
    url: `/api/sites/${siteId}/crawl`,
    payload: { preset: { concurrency: 4, perHostConcurrency: 4, minDelayMs: 0, jitterMs: 0, maxDepth: 4, maxPages: 100, renderMode: 'http' } },
  });
  // 等采集结束
  for (let i = 0; i < 200; i++) {
    const status = await built.app.inject({ method: 'GET', url: `/api/sites/${siteId}/crawl/status` });
    const s = (status.json() as { task?: { status?: string } }).task?.status;
    if (s !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const roots = await built.app.inject({ method: 'GET', url: `/api/sites/${siteId}/tree` });
  const root = (roots.json() as { nodes: Array<{ id: string; url: string }> }).nodes[0];
  assert.ok(root !== undefined);
  const children = await built.app.inject({ method: 'GET', url: `/api/sites/${siteId}/tree?parentId=${root.id}` });
  const list = (children.json() as { nodes: Array<{ id: string; url: string }> }).nodes;
  const docs = list.find((n) => n.url.endsWith('/docs'));
  const team = list.find((n) => n.url.endsWith('/team'));
  assert.ok(docs !== undefined && team !== undefined);
  const docsChildren = await built.app.inject({ method: 'GET', url: `/api/sites/${siteId}/tree?parentId=${docs.id}` });
  const guide = (docsChildren.json() as { nodes: Array<{ id: string; url: string }> }).nodes.find((n) => n.url.endsWith('/docs/guide'));
  assert.ok(guide !== undefined);
  const guideChildren = await built.app.inject({ method: 'GET', url: `/api/sites/${siteId}/tree?parentId=${guide.id}` });
  const install = (guideChildren.json() as { nodes: Array<{ id: string; url: string }> }).nodes.find((n) =>
    n.url.endsWith('/docs/guide/install'),
  );
  assert.ok(install !== undefined);

  return {
    app: built.app,
    handle,
    site: fake,
    siteId,
    ids: { root: root.id, docs: docs.id, team: team.id, guide: guide.id, install: install.id },
    async close() {
      await built.app.close();
      handle.close();
      await fake.close();
    },
  };
}

const childrenOf = async (h: Harness, parentId: string | null): Promise<Array<{ id: string; url: string; has_override: boolean; display_label: string | null }>> => {
  const url = parentId === null ? `/api/sites/${h.siteId}/tree` : `/api/sites/${h.siteId}/tree?parentId=${parentId}&limit=200`;
  const res = await h.app.inject({ method: 'GET', url });
  return (res.json() as { nodes: Array<{ id: string; url: string; has_override: boolean; display_label: string | null }> }).nodes;
};

test('M2 REST：拖拽重挂 → 树结构变化 → 撤销 → 重做', async () => {
  const h = await makeHarness();
  try {
    // 初始：/docs 挂在根下
    assert.equal((await childrenOf(h, h.ids.root)).some((n) => n.id === h.ids.docs), true);
    assert.equal((await childrenOf(h, h.ids.team)).length, 0);

    // 重挂 /docs → /team
    const moved = await h.app.inject({
      method: 'POST',
      url: `/api/nodes/${h.ids.docs}/move`,
      payload: { newParentId: h.ids.team },
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(moved.json().moved, 1);
    assert.equal(moved.json().depths.undoDepth, 1);

    const rootAfter = await childrenOf(h, h.ids.root);
    assert.equal(rootAfter.some((n) => n.id === h.ids.docs), false, '根下不该再有 /docs');
    const teamAfter = await childrenOf(h, h.ids.team);
    assert.equal(teamAfter.some((n) => n.id === h.ids.docs), true, '/team 下应出现 /docs');
    assert.equal(teamAfter.find((n) => n.id === h.ids.docs)?.has_override, true, '重挂后应带修正徽标');
    // 子树完整性：/docs 的子节点数量不变
    assert.ok((await childrenOf(h, h.ids.docs)).length >= 2, '/docs 的子树应完整跟着走');

    // 撤销
    const undone = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/undo` });
    assert.equal(undone.statusCode, 200);
    assert.equal(undone.json().kind, 'parent');
    assert.equal(undone.json().affected, 1);
    assert.equal((await childrenOf(h, h.ids.root)).some((n) => n.id === h.ids.docs), true);
    assert.equal((await childrenOf(h, h.ids.team)).length, 0);
    assert.equal((await childrenOf(h, h.ids.root)).find((n) => n.id === h.ids.docs)?.has_override, false);

    // 重做
    const redone = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/redo` });
    assert.equal(redone.json().kind, 'parent');
    assert.equal((await childrenOf(h, h.ids.team)).some((n) => n.id === h.ids.docs), true);
  } finally {
    await h.close();
  }
});

test('M2 REST：批量重挂（ids[]）一次撤销全部回滚', async () => {
  const h = await makeHarness();
  try {
    const moved = await h.app.inject({
      method: 'POST',
      url: `/api/nodes/${h.ids.guide}/move`,
      payload: { newParentId: h.ids.team, ids: [h.ids.guide, h.ids.install] },
    });
    assert.equal(moved.json().moved, 2);
    assert.equal((await childrenOf(h, h.ids.team)).length, 2);

    const undone = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/undo` });
    assert.equal(undone.json().affected, 2, '批量重挂应作为一个 op_group 原子撤销');
    assert.equal((await childrenOf(h, h.ids.team)).length, 0);
  } finally {
    await h.close();
  }
});

test('M2 REST：防环与非法重挂返回 400，跨站返回 409', async () => {
  const h = await makeHarness();
  try {
    const self = await h.app.inject({
      method: 'POST',
      url: `/api/nodes/${h.ids.docs}/move`,
      payload: { newParentId: h.ids.docs },
    });
    assert.equal(self.statusCode, 400);
    assert.equal(self.json().error.code, 'INVALID_MOVE');

    const descendant = await h.app.inject({
      method: 'POST',
      url: `/api/nodes/${h.ids.docs}/move`,
      payload: { newParentId: h.ids.guide },
    });
    assert.equal(descendant.statusCode, 400);
    assert.equal(descendant.json().error.code, 'INVALID_MOVE');

    const other = await h.app.inject({ method: 'POST', url: '/api/sites', payload: { url: 'http://other.local/', skipProbe: true } });
    const otherRoot = (await h.app.inject({ method: 'GET', url: `/api/sites/${other.json().site.id}/tree` })).json().nodes[0].id;
    const crossSite = await h.app.inject({
      method: 'POST',
      url: `/api/nodes/${h.ids.docs}/move`,
      payload: { newParentId: otherRoot },
    });
    assert.equal(crossSite.statusCode, 409);
    assert.equal(crossSite.json().error.code, 'NODE_OTHER_SITE');
  } finally {
    await h.close();
  }
});

test('M2 REST：PATCH 改地址/别名写修正层，identity_key 不变且有历史', async () => {
  const h = await makeHarness();
  try {
    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/nodes/${h.ids.team}`,
      payload: { url: 'http://example.com/team-renamed', alias: '核心团队' },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().node.url, 'http://example.com/team-renamed');
    assert.equal(patched.json().node.alias, '核心团队');
    assert.equal(patched.json().node.display_label, '核心团队', '行标签优先取别名（§6.4）');
    assert.equal(patched.json().node.has_override, true);

    // 树行也显示新别名，且 URL 已是改后的值
    const rows = await childrenOf(h, h.ids.root);
    const teamRow = rows.find((n) => n.id === h.ids.team);
    assert.equal(teamRow?.display_label, '核心团队');
    assert.equal(teamRow?.url, 'http://example.com/team-renamed');
    assert.equal(teamRow?.has_override, true);

    const detail = await h.app.inject({ method: 'GET', url: `/api/nodes/${h.ids.team}` });
    const history = (detail.json() as { history: Array<{ field: string; prev_value: string | null; undone: number }> }).history;
    assert.equal(history.length, 2, '地址与别名各一条修正记录');
    assert.equal(history.some((entry) => entry.field === 'url' && entry.prev_value?.endsWith('/team')), true);
    assert.equal(history.some((entry) => entry.field === 'alias'), true);
  } finally {
    await h.close();
  }
});

test('M2 REST：还原为自动结果清空单节点修正，且还原本身可撤销', async () => {
  const h = await makeHarness();
  try {
    await h.app.inject({ method: 'PATCH', url: `/api/nodes/${h.ids.team}`, payload: { alias: '临时别名' } });
    assert.equal((await childrenOf(h, h.ids.root)).find((n) => n.id === h.ids.team)?.has_override, true);

    const reverted = await h.app.inject({ method: 'POST', url: `/api/nodes/${h.ids.team}/revert` });
    assert.equal(reverted.statusCode, 200);
    assert.equal(reverted.json().node.has_override, false);
    assert.equal(reverted.json().node.alias, null);

    // 撤销「还原」→ 别名回来
    await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/undo` });
    assert.equal((await childrenOf(h, h.ids.root)).find((n) => n.id === h.ids.team)?.display_label, '临时别名');

    // 没有修正时再还原 → 409
    await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/undo` });
    const again = await h.app.inject({ method: 'POST', url: `/api/nodes/${h.ids.team}/revert` });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, 'NO_OVERRIDE');
  } finally {
    await h.close();
  }
});

test('M2 REST：软删子树返回影响面 → 进回收站 → 恢复 → 撤销', async () => {
  const h = await makeHarness();
  try {
    const subtreeSize = 1 + (await childrenOf(h, h.ids.docs)).length + (await childrenOf(h, h.ids.guide)).length;
        // 不带 body、也不带 content-type（浏览器 fetch 的默认行为）
    const deleted = await h.app.inject({ method: 'DELETE', url: `/api/nodes/${h.ids.docs}` });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(deleted.json().affectedNodes, subtreeSize, `/docs 子树应共 ${subtreeSize} 个节点`);
    assert.equal(deleted.json().nodeIds.length, subtreeSize);

    // 树里消失，但数据库仍保留（软删）
    assert.equal((await childrenOf(h, h.ids.root)).some((n) => n.id === h.ids.docs), false);
    const rawCount = (h.handle.db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE site_id = ?').get(h.siteId) as { c: number }).c;
    assert.ok(rawCount > subtreeSize, '原始行不该被物理删除');

    // 回收站：只列子树根
    const trash = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/tree?trash=1` });
    const entries = (trash.json() as { entries: Array<{ nodeId: string; affectedNodes: number }> }).entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.nodeId, h.ids.docs);
    assert.equal(entries[0]?.affectedNodes, subtreeSize);

    // 恢复
    const restored = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/trash/${h.ids.docs}/restore` });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().restored, subtreeSize);
    assert.equal((await childrenOf(h, h.ids.root)).some((n) => n.id === h.ids.docs), true);
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/tree?trash=1` })).json().entries.length, 0);

    // 再删一次，用撤销恢复
    await h.app.inject({ method: 'DELETE', url: `/api/nodes/${h.ids.guide}` });
    assert.equal((await childrenOf(h, h.ids.docs)).some((n) => n.id === h.ids.guide), false);
    const undo = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/undo` });
    assert.equal(undo.json().kind, 'deleted');
    assert.equal((await childrenOf(h, h.ids.docs)).some((n) => n.id === h.ids.guide), true);
  } finally {
    await h.close();
  }
});

test('M2 REST：撤销栈空/重做栈空返回 409；检索走服务端过滤', async () => {
  const h = await makeHarness();
  try {
    const emptyUndo = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/undo` });
    assert.equal(emptyUndo.statusCode, 409);
    assert.equal(emptyUndo.json().error.code, 'NOTHING_TO_UNDO');
    const emptyRedo = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/redo` });
    assert.equal(emptyRedo.statusCode, 409);
    assert.equal(emptyRedo.json().error.code, 'NOTHING_TO_REDO');

    // 关键词检索
    const search = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/search?q=guide` });
    assert.equal(search.statusCode, 200);
    const hits = (search.json() as { nodes: Array<{ url: string }> }).nodes;
    assert.ok(hits.length >= 2, `应命中 /docs/guide 与 /docs/guide/install，实际 ${hits.length}`);
    assert.equal(hits.every((n) => n.url.includes('guide')), true);

    // 正则检索
    const regex = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/search?q=%5E.*%2Fdocs%2F%5B0-9%5D&regex=1` });
    assert.equal(regex.statusCode, 200);

    // 非法正则 → 400
    const bad = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/search?q=%28%5B&regex=1` });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, 'INVALID_REGEX');

    // 状态过滤
    const blocked = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/search?status=blocked` });
    assert.equal((blocked.json() as { nodes: Array<{ status: string }> }).nodes.every((n) => n.status === 'blocked'), true);

    // 改过别名后能被新别名检索到（读路径走有效投影）
    await h.app.inject({ method: 'PATCH', url: `/api/nodes/${h.ids.team}`, payload: { alias: '绝密入口' } });
    const byAlias = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/search?q=${encodeURIComponent('绝密入口')}` });
    assert.equal((byAlias.json() as { nodes: Array<{ id: string }> }).nodes.length, 1);
  } finally {
    await h.close();
  }
});

test('M4 接口：整树平面列表（图形视图用）—— 上限、截断标记与有效父节点', async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/tree/flat` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { nodes: Array<{ id: string; depth: number; effective_parent_id: string | null }>; total: number; limit: number; truncated: boolean };
    assert.ok(body.nodes.length > 1, '应返回整棵树的节点');
    assert.equal(body.total, body.nodes.length);
    assert.equal(body.truncated, false);
    assert.equal(body.nodes[0]?.depth, 0, '按深度排序，根在最前');
    assert.equal(body.nodes[0]?.effective_parent_id, null);

    // 上限：只要 2 个 → 截断标记为真
    const limited = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/tree/flat?limit=2` });
    const limitedBody = limited.json() as { nodes: unknown[]; total: number; truncated: boolean };
    assert.equal(limitedBody.nodes.length, 2);
    assert.equal(limitedBody.truncated, true);
    assert.ok(limitedBody.total > 2);

    // 不存在的站点 → 404
    const missing = await h.app.inject({ method: 'GET', url: '/api/sites/01ZZZZZZZZZZZZZZZZZZZZZZZZ/tree/flat' });
    assert.equal(missing.statusCode, 404);
  } finally {
    await h.close();
  }
});
