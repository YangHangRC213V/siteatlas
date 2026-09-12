/**
 * M2 修正层单元测试 + 集成测试（dev-spec §6.4 / §5.1）
 *
 * 单元：叠加语义（最新未撤销生效）、撤销/重做、批量原子性、防环校验、软删影响面、回收站。
 * 集成：在 M1 采集出的真实树上做拖拽重挂 → 子树跟着动 → 撤销还原 → 地址/别名修改 → 软删/恢复。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type DbHandle } from '../store/db.ts';
import { NodesRepo } from '../store/repos/nodes.ts';
import { SitesRepo } from '../store/repos/sites.ts';
import { EdgesRepo } from '../store/repos/edges.ts';
import { CrawlRepo } from '../store/repos/crawl.ts';
import { OverridesRepo } from '../store/repos/overrides.ts';
import { OverridesService, OverrideError } from './overrides.ts';
import { SitesService } from '../sites/service.ts';
import { CrawlService } from '../crawl/service.ts';
import { BrowserPool } from '../fetch/pool.ts';
import { clearRobotsCache } from '../fetch/robots.ts';
import { startFakeSite, type FakeSite } from '../../tests/fixture-site.ts';

interface Harness {
  handle: DbHandle;
  nodes: NodesRepo;
  sites: SitesRepo;
  edges: EdgesRepo;
  crawl: CrawlRepo;
  overrides: OverridesService;
  overridesRepo: OverridesRepo;
  sitesService: SitesService;
  crawlService: CrawlService;
  close(): Promise<void>;
}

function makeHarness(): Harness {
  const handle = openDb({ file: ':memory:' });
  const nodes = new NodesRepo(handle.db);
  const sites = new SitesRepo(handle.db);
  const edges = new EdgesRepo(handle.db);
  const crawl = new CrawlRepo(handle.db);
  const overridesRepo = new OverridesRepo(handle.db);
  const overrides = new OverridesService({ db: handle.db, nodes, sites, overrides: overridesRepo });
  const sitesService = new SitesService({ sites, nodes });
  const pool = new BrowserPool({ launcher: { async launch() { throw new Error('测试不启动浏览器'); } } });
  const crawlService = new CrawlService({ db: handle.db, sites, nodes, edges, crawl, pool });
  return {
    handle,
    nodes,
    sites,
    edges,
    crawl,
    overrides,
    overridesRepo,
    sitesService,
    crawlService,
    async close() {
      await crawlService.stopAll();
      await pool.close();
      handle.close();
    },
  };
}

/** 造一棵简单的手工树：root → a → a1, a2 ; root → b */
function seedTree(h: Harness, siteId: string): Record<string, string> {
  const mk = (url: string, depth: number, parentId: string | null): string => {
    const { node } = h.nodes.upsert({
      siteId,
      url,
      identityKey: url,
      parentId,
      depth,
      displayLabel: url.split('/').pop() ?? url,
    });
    return node.id;
  };
  const root = mk('http://t.local/', 0, null);
  const a = mk('http://t.local/a', 1, root);
  const a1 = mk('http://t.local/a/1', 2, a);
  const a2 = mk('http://t.local/a/2', 2, a);
  const b = mk('http://t.local/b', 1, root);
  const b1 = mk('http://t.local/b/1', 2, b);
  for (const [from, to] of [
    [root, a],
    [a, a1],
    [a, a2],
    [root, b],
    [b, b1],
  ] as Array<[string, string]>) {
    h.edges.insert({
      siteId,
      fromId: from,
      toId: to,
      anchorText: null,
      selector: null,
      domPath: null,
      rel: null,
      target: null,
      isNofollow: false,
      fragment: null,
      source: 'auto',
      orderInPage: null,
    });
  }
  return { root, a, a1, a2, b, b1 };
}

async function seedSite(h: Harness): Promise<{ siteId: string; ids: Record<string, string> }> {
  const created = await h.sitesService.createSite({ url: 'http://t.local/', skipProbe: true, name: '测试站' });
  const siteId = created.site.id;
  h.handle.db.prepare('UPDATE nodes SET auto_parent_id = NULL WHERE id = ?').run(created.root.id);
  const ids = seedTree(h, siteId);
  return { siteId, ids };
}

test('M2 叠加：最新未撤销的 override 生效，撤销后回落自动值', async () => {
  const h = makeHarness();
  try {
    const { siteId, ids } = await seedSite(h);
    const rootId = ids['root'] as string;
    const aId = ids['a'] as string;
    const bId = ids['b'] as string;

    // 初始：a 挂在 root 下
    assert.equal(h.overrides.effectiveParentOf(aId), rootId);
    assert.equal(h.overrides.effectiveNode(aId)?.has_override, false);

    // 重挂 a → b
    const move = h.overrides.move(siteId, [aId], bId);
    assert.equal(move.moved, 1);
    assert.equal(h.overrides.effectiveParentOf(aId), bId);
    assert.equal(h.overrides.effectiveNode(aId)?.has_override, true);

    // 子树跟着动：a 的子节点仍在 a 下
    const aChildren = h.nodes.childrenPage(siteId, aId, 0, 10);
    assert.equal(aChildren.total, 2);
    const bChildren = h.nodes.childrenPage(siteId, bId, 0, 10);
    assert.equal(bChildren.total, 2, 'b 现在应有 b/1 与 a 两个子节点');

    // 撤销 → 回到 root 下
    const undo = h.overrides.undo(siteId);
    assert.equal(undo.action, 'undo');
    assert.equal(h.overrides.effectiveParentOf(aId), rootId);
    assert.equal(h.overrides.effectiveNode(aId)?.has_override, false);

    // 重做 → 又挂到 b 下
    const redo = h.overrides.redo(siteId);
    assert.equal(redo.action, 'redo');
    assert.equal(h.overrides.effectiveParentOf(aId), bId);

    // 再撤销一次后不能再撤销、但可以重做
    h.overrides.undo(siteId);
    assert.equal(h.overrides.depths(siteId).undoDepth, 0);
    assert.equal(h.overrides.depths(siteId).redoDepth, 1);
    assert.throws(() => h.overrides.undo(siteId), (err: unknown) => {
      assert.ok(err instanceof OverrideError);
      assert.equal(err.code, 'NOTHING_TO_UNDO');
      return true;
    });
  } finally {
    await h.close();
  }
});

test('M2 批量重挂：同一 op_group 原子撤销', async () => {
  const h = makeHarness();
  try {
    const { siteId, ids } = await seedSite(h);
    const rootId = ids['root'] as string;
    const a1 = ids['a1'] as string;
    const a2 = ids['a2'] as string;
    const bId = ids['b'] as string;

    const move = h.overrides.move(siteId, [a1, a2], bId);
    assert.equal(move.moved, 2);
    assert.equal(h.overrides.effectiveParentOf(a1), bId);
    assert.equal(h.overrides.effectiveParentOf(a2), bId);
    // 一次操作 = 一次撤销
    const undo = h.overrides.undo(siteId);
    assert.equal(undo.rows.length, 2, '批量操作应作为一个 op_group 原子撤销');
    assert.equal(h.overrides.effectiveParentOf(a1), ids['a']);
    assert.equal(h.overrides.effectiveParentOf(a2), ids['a']);
    assert.equal(h.overrides.effectiveParentOf(ids['a'] as string), rootId);
  } finally {
    await h.close();
  }
});

test('M2 防环与非法重挂：挂到自己/子孙下被拒绝，挂回相同父节点不产生修正', async () => {
  const h = makeHarness();
  try {
    const { siteId, ids } = await seedSite(h);
    const aId = ids['a'] as string;
    const a1 = ids['a1'] as string;
    const rootId = ids['root'] as string;

    assert.throws(() => h.overrides.move(siteId, [aId], aId), (err: unknown) => {
      assert.ok(err instanceof OverrideError);
      assert.equal(err.code, 'INVALID_MOVE');
      return true;
    });
    assert.throws(() => h.overrides.move(siteId, [aId], a1), /子孙/);
    assert.throws(() => h.overrides.move(siteId, ['01JZZZZZZZZZZZZZZZZZZZZZZZ'], rootId), (err: unknown) => {
      assert.ok(err instanceof OverrideError);
      assert.equal(err.code, 'NODE_NOT_FOUND');
      return true;
    });

    // 目标与当前相同 → moved=0，且不写 override
    const noop = h.overrides.move(siteId, [aId], rootId);
    assert.equal(noop.moved, 0);
    assert.equal(h.overridesRepo.recentForSite(siteId).length, 0);
  } finally {
    await h.close();
  }
});

test('M2 地址与别名：写修正层、可撤销、旧值保留在 prev_value', async () => {
  const h = makeHarness();
  try {
    const { siteId, ids } = await seedSite(h);
    const aId = ids['a'] as string;

    const before = h.overrides.effectiveNode(aId);
    assert.equal(before?.url, 'http://t.local/a');

    h.overrides.updateUrl(siteId, aId, 'http://t.local/a-moved');
    const afterUrl = h.overrides.effectiveNode(aId);
    assert.equal(afterUrl?.url, 'http://t.local/a-moved');
    // identity_key 是采集指纹，不因人工改地址而变（§6.8 旧记录保留为历史）
    assert.equal(afterUrl?.identity_key, 'http://t.local/a');

    const history = h.overrides.history(aId, 10);
    assert.equal(history[0]?.field, 'url');
    assert.equal(history[0]?.prev_value, 'http://t.local/a');

    h.overrides.updateDisplay(siteId, aId, { alias: '产品文档' });
    const afterAlias = h.overrides.effectiveNode(aId);
    assert.equal(afterAlias?.alias, '产品文档');
    assert.equal(afterAlias?.has_override, true);

    // 撤销别名 → 回落自动值
    h.overrides.undo(siteId);
    assert.equal(h.overrides.effectiveNode(aId)?.alias, null);
    assert.equal(h.overrides.effectiveNode(aId)?.url, 'http://t.local/a-moved', '只撤销别名，不改动地址修正');

    // 「还原为自动结果」清掉该节点当前生效的全部修正（别名此前已被撤销，故只需清地址）
    const reverted = h.overrides.revertNode(siteId, aId);
    assert.equal(h.overrides.effectiveNode(aId)?.url, 'http://t.local/a');
    assert.equal(h.overrides.effectiveNode(aId)?.has_override, false);
    assert.ok(reverted.opGroup.length > 0);

    // 撤销「还原」= 恢复它清掉的旧修正（地址回来）。别名此前已被「还原」丢弃（重置语义），不会回来
    h.overrides.undo(siteId);
    assert.equal(h.overrides.effectiveNode(aId)?.url, 'http://t.local/a-moved');
    assert.equal(h.overrides.effectiveNode(aId)?.alias, null, '被「还原」丢弃的历史不再回来（重置语义）');
    assert.equal(h.overrides.depths(siteId).undoDepth, 1, '此时只剩地址修正生效');

    // 再撤销一次 → 回到纯自动形态
    h.overrides.undo(siteId);
    assert.equal(h.overrides.effectiveNode(aId)?.url, 'http://t.local/a');
    assert.equal(h.overrides.effectiveNode(aId)?.has_override, false);
    assert.equal(h.overrides.depths(siteId).undoDepth, 0);
    assert.equal(h.overrides.depths(siteId).redoDepth, 2, '地址修正与「还原」两步可重做');

    // 重做 → 依次补回：先是地址修正
    h.overrides.redo(siteId);
    assert.equal(h.overrides.effectiveNode(aId)?.url, 'http://t.local/a-moved');
    // 再重做 → 「还原」步重新生效（地址被清掉）
    h.overrides.redo(siteId);
    assert.equal(h.overrides.effectiveNode(aId)?.url, 'http://t.local/a');
    assert.equal(h.overrides.depths(siteId).redoDepth, 0);
  } finally {
    await h.close();
  }
});

test('M2 还原为自动结果会截断重做栈（重置语义，已记 DECISIONS）', async () => {
  const h = makeHarness();
  try {
    const { siteId, ids } = await seedSite(h);
    const aId = ids['a'] as string;
    h.overrides.updateDisplay(siteId, aId, { alias: '第一次' });
    h.overrides.updateDisplay(siteId, aId, { alias: '第二次' });
    // 撤销一次 → 「第二次」进重做栈
    h.overrides.undo(siteId);
    assert.equal(h.overrides.depths(siteId).redoDepth, 1);
    assert.equal(h.overrides.effectiveNode(aId)?.alias, '第一次');

    // 还原为自动结果：放弃待重做的历史
    h.overrides.revertNode(siteId, aId);
    assert.equal(h.overrides.effectiveNode(aId)?.alias, null);
    assert.equal(h.overrides.depths(siteId).redoDepth, 0, '还原后重做栈应被截断');

    // 撤销还原 → 回到「第一次」，而不是「第二次」
    h.overrides.undo(siteId);
    assert.equal(h.overrides.effectiveNode(aId)?.alias, '第一次');
  } finally {
    await h.close();
  }
});

test('M2 软删子树：影响面 = 子树节点数，父节点数据不动，可整体撤销并可从回收站恢复', async () => {
  const h = makeHarness();
  try {
    const { siteId, ids } = await seedSite(h);
    const aId = ids['a'] as string;
    const rootId = ids['root'] as string;

    const del = h.overrides.deleteSubtrees(siteId, [aId]);
    assert.equal(del.affectedNodes, 3, 'a + a/1 + a/2 共 3 个节点');

    // 树里消失
    const rootChildren = h.nodes.childrenPage(siteId, rootId, 0, 10);
    assert.equal(rootChildren.total, 1, 'root 下只剩 b');
    assert.equal(rootChildren.nodes[0]?.url, 'http://t.local/b');
    // 但原始行仍在（软删）
    assert.equal((h.handle.db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE site_id = ?').get(siteId) as { c: number }).c, 6);

    // 回收站：只列子树根
    const trash = h.overrides.trash(siteId);
    assert.equal(trash.length, 1);
    assert.equal(trash[0]?.nodeId, aId);
    assert.equal(trash[0]?.affectedNodes, 3);

    // 从回收站恢复
    const restored = h.overrides.restoreFromTrash(siteId, aId);
    assert.equal(restored.restored, 3);
    assert.equal(h.nodes.childrenPage(siteId, rootId, 0, 10).total, 2);
    assert.equal(h.overrides.trash(siteId).length, 0);

    // 再删一次，用撤销恢复
    h.overrides.deleteSubtrees(siteId, [aId]);
    assert.equal(h.nodes.childrenPage(siteId, rootId, 0, 10).total, 1);
    const undo = h.overrides.undo(siteId);
    assert.equal(undo.rows.length, 3, '删子树是批量写入，一次撤销');
    assert.equal(h.nodes.childrenPage(siteId, rootId, 0, 10).total, 2);
  } finally {
    await h.close();
  }
});

test('M2 跨站保护：不能移动/删除别的站点的节点', async () => {
  const h = makeHarness();
  try {
    const { ids } = await seedSite(h);
    const other = await h.sitesService.createSite({ url: 'http://other.local/', skipProbe: true, name: '另一个站' });
    assert.throws(() => h.overrides.move(other.site.id, [ids['a'] as string], null), (err: unknown) => {
      assert.ok(err instanceof OverrideError);
      assert.equal(err.code, 'NODE_OTHER_SITE');
      return true;
    });
    assert.throws(() => h.overrides.deleteSubtrees(other.site.id, [ids['a'] as string]), /不属于该站点/);
  } finally {
    await h.close();
  }
});

test('M2 集成：真实采集出的树上重挂 → 树结构随修正层变化 → 撤销还原', async (t) => {
  clearRobotsCache();
  const site: FakeSite = await startFakeSite();
  const h = makeHarness();
  try {
    const created = await h.sitesService.createSite({ url: `${site.origin}/` });
    const siteId = created.site.id;
    h.crawlService.start(siteId, {
      concurrency: 4,
      perHostConcurrency: 4,
      minDelayMs: 0,
      jitterMs: 0,
      maxDepth: 4,
      maxPages: 100,
      renderMode: 'http',
      paginationPageLimit: 3,
    });
    await h.crawlService.wait(siteId);

    const root = h.nodes.root(siteId);
    assert.ok(root !== null);
    const rootChildren = h.nodes.childrenPage(siteId, root.id, 0, 50);
    const docs = rootChildren.nodes.find((n) => n.url.endsWith('/docs'));
    const team = rootChildren.nodes.find((n) => n.url.endsWith('/team'));
    assert.ok(docs !== undefined && team !== undefined);

    // 最初 /docs 挂在 root 下，depth=1
    assert.equal(h.overrides.effectiveParentOf(docs.id), root.id);
    const docsChildrenBefore = h.nodes.childrenPage(siteId, docs.id, 0, 50);
    assert.ok(docsChildrenBefore.total >= 2);

    // 把 /docs 重挂到 /team 下
    const move = h.overrides.move(siteId, [docs.id], team.id);
    assert.equal(move.moved, 1);
    assert.equal(h.overrides.effectiveParentOf(docs.id), team.id);

    // 树里：root 下不再有 /docs；team 下出现 /docs，且 /docs 的子树完整跟着走
    const rootAfter = h.nodes.childrenPage(siteId, root.id, 0, 50);
    assert.equal(rootAfter.nodes.some((n) => n.url.endsWith('/docs')), false);
    const teamAfter = h.nodes.childrenPage(siteId, team.id, 0, 50);
    assert.equal(teamAfter.nodes.some((n) => n.url.endsWith('/docs')), true);
    const docsChildrenAfter = h.nodes.childrenPage(siteId, docs.id, 0, 50);
    assert.equal(docsChildrenAfter.total, docsChildrenBefore.total, '子树节点数不变');
    assert.equal(teamAfter.nodes.find((n) => n.url.endsWith('/docs'))?.has_override, true, '重挂后应带修正徽标');

    // 撤销 → 回到 root 下
    h.overrides.undo(siteId);
    assert.equal(h.overrides.effectiveParentOf(docs.id), root.id);
    const rootBack = h.nodes.childrenPage(siteId, root.id, 0, 50);
    assert.equal(rootBack.nodes.some((n) => n.url.endsWith('/docs')), true);
    assert.equal(
      rootBack.nodes.find((n) => n.url.endsWith('/docs'))?.has_override,
      false,
      '撤销后修正徽标消失',
    );

    // 软删 /team 子树 → root 下少一个；撤销恢复
    const teamChildren = h.nodes.childrenPage(siteId, team.id, 0, 50).total;
    const del = h.overrides.deleteSubtrees(siteId, [team.id]);
    assert.equal(del.affectedNodes, 1 + teamChildren);
    const rootDeleted = h.nodes.childrenPage(siteId, root.id, 0, 50);
    assert.equal(rootDeleted.nodes.some((n) => n.url.endsWith('/team')), false);
    h.overrides.undo(siteId);
    assert.equal(h.nodes.childrenPage(siteId, root.id, 0, 50).nodes.some((n) => n.url.endsWith('/team')), true);
  } finally {
    await h.close();
    await site.close();
  }
});
