/**
 * M1 集成测试：采集内核跑通真实 HTTP（本地站点），验收 dev-spec §7 M1
 * 「采集一个真实站点，树中出现多级节点且无重复」。
 *
 * 用本地站点而不是公网站点，保证 CI/离线可复现；跟踪参数归并、入链多父、
 * robots 禁止、素材不递归、分页护栏都在 fixture 里覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../store/db.ts';
import { SitesRepo } from '../store/repos/sites.ts';
import { NodesRepo } from '../store/repos/nodes.ts';
import { EdgesRepo } from '../store/repos/edges.ts';
import { CrawlRepo } from '../store/repos/crawl.ts';
import { SitesService } from '../sites/service.ts';
import { CrawlService } from './service.ts';
import { BrowserPool, type BrowserLauncher } from '../fetch/pool.ts';
import { clearRobotsCache } from '../fetch/robots.ts';
import { startFakeSite } from '../../tests/fixture-site.ts';

interface Harness {
  handle: DbHandle;
  sites: SitesRepo;
  nodes: NodesRepo;
  edges: EdgesRepo;
  crawl: CrawlRepo;
  sitesService: SitesService;
  crawlService: CrawlService;
  close(): Promise<void>;
}

function makeHarness(pool: BrowserPool, dbFile: string = ':memory:'): Harness {
  const handle = openDb({ file: dbFile });
  const sites = new SitesRepo(handle.db);
  const nodes = new NodesRepo(handle.db);
  const edges = new EdgesRepo(handle.db);
  const crawl = new CrawlRepo(handle.db);
  const sitesService = new SitesService({
    sites,
    nodes,
    // 本地 fixture 站点：跳过可达性探测的语义在这里也要走真实探测
    probe: async (url) => {
      const res = await fetch(url);
      return {
        reachable: true,
        isHtml: (res.headers.get('content-type') ?? '').includes('text/html'),
        status: res.status,
        contentType: res.headers.get('content-type'),
        finalUrl: res.url,
        redirectChain: [url, res.url],
        error: null,
      };
    },
  });
  const crawlService = new CrawlService({ db: handle.db, sites, nodes, edges, crawl, pool });
  return {
    handle,
    sites,
    nodes,
    edges,
    crawl,
    sitesService,
    crawlService,
    async close() {
      await crawlService.stopAll();
      await pool.close();
      handle.close();
    },
  };
}

/** 假浏览器：不启动 Chromium，只返回一个「有链接的」水合 HTML（验证回落链路被触发） */
function fakeBrowserPool(): { pool: BrowserPool; launched: () => number } {
  let launches = 0;
  const launcher: BrowserLauncher = {
    async launch() {
      launches += 1;
      return {
        async newPage() {
          // 按被导航的 URL 返回「水合后」的 HTML：验证渲染回落后发现的新链接能正确建节点
          let currentUrl = 'about:blank';
          const originOf = (): string => {
            try {
              return new URL(currentUrl).origin;
            } catch {
              return '';
            }
          };
          return {
            async goto(url: string) {
              currentUrl = url;
              return url;
            },
            async content() {
              return `<!doctype html><html><head><title>水合后的 SPA</title></head><body>
                <div id="root"><a href="${originOf()}/hydrated-child">水合后的子页</a></div>
                <p>这是 JavaScript 渲染后才出现的正文内容，长度足够用于内容指纹判定，避免被当成空页面处理。</p>
                </body></html>`;
            },
            url() {
              return currentUrl;
            },
            async close() {},
          };
        },
        async close() {},
        version() {
          return 'fake-1.0';
        },
        isConnected() {
          return true;
        },
      };
    },
  };
  return { pool: new BrowserPool({ launcher }), launched: () => launches };
}

const FAST_PRESET = {
  concurrency: 4,
  perHostConcurrency: 4,
  minDelayMs: 0,
  jitterMs: 0,
  timeoutMs: 5000,
  maxDepth: 4,
  maxPages: 100,
  respectRobots: true,
  renderMode: 'auto' as const,
  paginationPageLimit: 3,
};

test('M1：本地站点采集出多级树、无重复节点、护栏全部生效', async (t) => {
  clearRobotsCache();
  const site = await startFakeSite();
  const { pool, launched } = fakeBrowserPool();
  const h = makeHarness(pool);

  try {
    const created = await h.sitesService.createSite({ url: `${site.origin}/` });
    const siteId = created.site.id;

    const { task } = h.crawlService.start(siteId, FAST_PRESET);
    const result = await h.crawlService.wait(siteId);

    assert.ok(result !== null, '任务应返回结果');
    assert.equal(result.status, 'done', `任务应正常结束，实际 ${result.status}：${result.reason ?? ''}`);

    // ---- 树：多级节点 ----
    const root = h.nodes.root(siteId);
    assert.ok(root !== null);
    assert.equal(root.depth, 0);
    assert.equal(root.status, 'ok');

    const all = h.handle.db
      .prepare('SELECT id, url, identity_key, depth, status, auto_parent_id, display_label FROM nodes WHERE site_id = ?')
      .all(siteId)
      .map((r) => ({ ...(r as Record<string, unknown>) })) as Array<{
      id: string;
      url: string;
      identity_key: string;
      depth: number;
      status: string;
      auto_parent_id: string | null;
      display_label: string | null;
    }>;
    const depths = new Set(all.map((n) => n.depth));
    assert.ok(depths.has(0) && depths.has(1) && depths.has(2), `应出现 0/1/2 三级节点，实际 ${[...depths].join(',')}`);

    // ---- 无重复：identity_key 唯一（UNIQUE 约束 + 去重）----
    const keys = all.map((n) => n.identity_key);
    assert.equal(new Set(keys).size, keys.length, 'identity_key 不应重复');

    // 跟踪参数/尾斜杠/fragment 变体全部归并到同一个节点
    const guide = all.filter((n) => n.identity_key.endsWith('/docs/guide'));
    assert.equal(guide.length, 1, `「指南」页面应只有 1 个节点，实际 ${guide.length}：${JSON.stringify(guide.map((g) => g.identity_key))}`);
    assert.equal(guide[0]?.depth, 2, '/docs/guide 深度应为 2（根 → 文档 → 指南）');
    // 真实 query 变体是不同资源，各自成节点（规范化不是「一刀切去掉 query」）
    assert.equal(
      all.filter((n) => n.identity_key.endsWith('/docs/guide?a=1&b=2')).length,
      1,
      '真实 query 应成为独立节点',
    );

    // www/大小写变体的资源只抓一次
    assert.equal(all.filter((n) => n.identity_key.endsWith('/assets/logo.png')).length, 1);

    // ---- 多级关系：父节点由首次发现的链接决定 ----
    const by = (needle: string) => all.find((n) => n.identity_key.endsWith(needle));
    const docsNode = by('/docs');
    const aboutNode = by('/about');
    const teamNode = by('/team');
    const installNode = by('/docs/guide/install');
    const apiNode = by('/docs/api');
    assert.ok(docsNode && aboutNode && teamNode && installNode && apiNode);
    assert.equal(docsNode.auto_parent_id, root.id, '/docs 的父节点应是根');
    assert.equal(guide[0]?.auto_parent_id, docsNode.id, '/docs/guide 的父节点应是 /docs');
    assert.equal(installNode.auto_parent_id, guide[0]?.id, '/docs/guide/install 的父节点应是指南');
    assert.equal(installNode.depth, 3, '/docs/guide/install 深度应为 3');
    assert.equal(apiNode.auto_parent_id, docsNode.id);
    assert.equal(apiNode.depth, 2);
    // 尾斜杠归一：/about/ → /about
    assert.equal(aboutNode.identity_key.endsWith('/about'), true);
    // /team 被首页与 /about 同时链接 → 入链 2 条，但树中只挂 1 处
    assert.equal(teamNode.auto_parent_id, root.id);

    // ---- 边：入链/出链计数 ----
    const inLinks = h.edges.incoming(teamNode.id, 50);
    assert.equal(inLinks.length, 2, `/team 应有 2 条入链，实际 ${inLinks.length}`);
    const homeEdges = h.edges.outgoing(root.id, 100);
    // 首页 9 个链接，其中 1 个是外域（同域策略过滤）→ 站内出链 8 条
    assert.equal(homeEdges.length, 8, `首页站内出链应为 8，实际 ${homeEdges.length}`);
    assert.equal(homeEdges.every((e) => e.source === 'auto'), true);
    // fragment 记在边里，而不是新建节点
    const guideEdges = h.edges.incoming(guide[0]?.id ?? '', 50);
    const fragments = guideEdges.map((e) => e.fragment).filter((f): f is string => f !== null);
    assert.deepEqual([...fragments].sort(), ['step-2', 'step-3']);
    // selector / dom_path / anchor_text 立案可重放定位
    const sample = guideEdges[0];
    assert.ok(sample !== undefined);
    assert.ok((sample.selector ?? '').includes('a'));
    assert.ok((sample.dom_path ?? '').length > 0);
    assert.equal(sample.anchor_text, '指南');

    // ---- 状态：ok / error / blocked / skipped ----
    assert.equal(by('/missing')?.status, 'error', '404 页面应标 error');
    assert.equal(by('/blocked/secret')?.status, 'blocked', 'robots 禁止页应标 blocked');
    assert.equal(by('/assets/logo.png')?.status, 'skipped', '素材应标 skipped');
    assert.equal(by('/docs')?.status, 'ok');

    // ---- 范围：外域链接不入站 ----
    assert.equal(all.some((n) => n.identity_key.includes('/outside')), false, '不同主机名的链接不应入站');

    // ---- 分页护栏：?page=n 只保留到上限（fixture 里 /paged 是自环翻页）----
    const paged = h.handle.db
      .prepare("SELECT COUNT(*) AS c FROM nodes WHERE site_id = ? AND url LIKE '%/paged%'")
      .get(siteId) as { c: number };
    assert.ok(Number(paged.c) >= 1, '分页页面应被发现');
    assert.ok(Number(paged.c) <= 3, `分页页数应受 paginationPageLimit=3 限制，实际 ${paged.c}`);

    // ---- 请求次数：变体不会重复请求（去重真的省了请求）----
    // 跟踪参数/尾斜杠/fragment 变体合计只请求 1 次（去重真的省了请求）
    assert.equal(site.hits.get('/docs'), 1, `/docs 只应被请求 1 次，实际 ${site.hits.get('/docs')}`);
    assert.equal(site.hits.get('/assets/logo.png') ?? 0, 0, '素材不应发请求（只登记）');
    assert.equal(site.hits.get('/blocked/secret') ?? 0, 0, 'robots 禁止路径不应发请求');

    // ---- 渲染回落：SPA 页面触发 Playwright 回落 ----
    assert.ok(launched() >= 1, 'SPA 页面应触发浏览器回落');
    const spaNode = by('/spa');
    assert.ok(spaNode !== null && spaNode !== undefined);
    assert.equal(spaNode.status, 'ok');
    assert.equal(h.nodes.childrenPage(siteId, spaNode.id, 0, 10).nodes.length, 1, 'SPA 渲染后应发现 1 个子节点');

    // ---- 任务与状态统计 ----
    const status = h.crawlService.statusOf(siteId);
    assert.equal(status.task?.id, task.id);
    assert.ok((status.stats?.fetched ?? 0) > 0);
    assert.ok(Object.keys(status.stats?.depthDistribution ?? {}).length >= 3);
    assert.ok((status.stats?.statusCounts['ok'] ?? 0) >= 5);
  } finally {
    await h.close();
    await site.close();
  }
});

test('M1：访问上限护栏阻止同一 URL 被反复抓取', async (t) => {
  clearRobotsCache();
  const site = await startFakeSite();
  const { pool } = fakeBrowserPool();
  const h = makeHarness(pool);
  try {
    const created = await h.sitesService.createSite({ url: `${site.origin}/` });
    const siteId = created.site.id;
    h.crawlService.start(siteId, { ...FAST_PRESET, visitLimit: 1 });
    await h.crawlService.wait(siteId);

    // access_counts 记录了访问次数，且不超过 visitLimit + 1（超限那次只做判定不发请求）
    const visits = h.crawl.getVisits(siteId, `${site.origin}/`);
    assert.ok(visits >= 1 && visits <= 2, `根 URL 访问次数应受 visitLimit 约束，实际 ${visits}`);
  } finally {
    await h.close();
    await site.close();
  }
});

test('M1：暂停/继续可控，暂停期间不发请求，续跑后树结构完整', async (t) => {
  clearRobotsCache();
  const site = await startFakeSite();
  const { pool } = fakeBrowserPool();
  const h = makeHarness(pool);
  try {
    const created = await h.sitesService.createSite({ url: `${site.origin}/` });
    const siteId = created.site.id;
    // 单并发 + 1s 限速：保证中途暂停时队列里一定还有待抓项
    h.crawlService.start(siteId, { ...FAST_PRESET, concurrency: 1, perHostConcurrency: 1, minDelayMs: 1000 });

    await new Promise((r) => setTimeout(r, 300));
    const paused = h.crawlService.pause(siteId);
    assert.equal(paused.status, 'paused');
    const countsPaused = h.crawl.queueCounts(paused.id);
    assert.ok((countsPaused['pending'] ?? 0) > 0, `暂停时队列应仍有待抓项，实际 ${JSON.stringify(countsPaused)}`);

    // 暂停期间不得继续发请求（含等待中的限速项）
    const totalHits = (): number => [...site.hits.values()].reduce((a, b) => a + b, 0);
    const atPause = totalHits();
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(totalHits(), atPause, '暂停期间不应继续请求');

    const resumed = h.crawlService.resume(siteId);
    assert.equal(resumed.status, 'running');
    const result = await h.crawlService.wait(siteId);
    assert.equal(result?.status, 'done', `续跑应正常结束，实际 ${result?.status}`);

    // 续跑后树依然完整且无重复
    const keys = h.nodes.allIdentityKeys(siteId);
    assert.equal(new Set(keys).size, keys.length, 'identity_key 不应重复');
    const depths = h.handle.db
      .prepare('SELECT DISTINCT depth FROM nodes WHERE site_id = ? ORDER BY depth')
      .all(siteId)
      .map((r) => Number((r as { depth: number }).depth));
    assert.ok(depths.includes(0) && depths.includes(1) && depths.includes(2), `应出现多级节点，实际 ${depths.join(',')}`);
    assert.equal(result?.reason, null);
  } finally {
    await h.close();
    await site.close();
  }
});

test('M1：停止后任务终结、队列 running 归零（可续跑）', async (t) => {
  clearRobotsCache();
  const site = await startFakeSite();
  const { pool } = fakeBrowserPool();
  const h = makeHarness(pool);
  try {
    const created = await h.sitesService.createSite({ url: `${site.origin}/` });
    const siteId = created.site.id;
    h.crawlService.start(siteId, { ...FAST_PRESET, concurrency: 1, perHostConcurrency: 1, minDelayMs: 1000 });
    await new Promise((r) => setTimeout(r, 200));

    const stopped = h.crawlService.stop(siteId);
    assert.equal(stopped.status, 'stopped');
    const result = await h.crawlService.wait(siteId);
    assert.equal(result?.status, 'stopped');
    assert.equal(h.crawlService.busy(siteId), false, '任务结束后不再占用站点');

    const counts = h.crawl.queueCounts(stopped.id);
    assert.equal(counts['running'], 0, 'running 应被释放');
    assert.ok((counts['pending'] ?? 0) + (counts['done'] ?? 0) > 0);

    // 已停止的任务再点「继续」应被拒绝（不静默失败）
    assert.throws(() => h.crawlService.resume(siteId), /没有可继续的任务/);
  } finally {
    await h.close();
    await site.close();
  }
});

test('M1：进程重启后队列复位并可续跑（§6.6 断点续爬）', async (t) => {
  clearRobotsCache();
  const site = await startFakeSite();
  const { pool } = fakeBrowserPool();
  // 模拟「进程被杀」：只关数据库句柄，不调用 stopAll（进程崩溃时不会走优雅关闭）
  const tmpDir = mkdtempSync(join(tmpdir(), 'siteatlas-m1-'));
  const dbFile = join(tmpDir, 'siteatlas.db');
  const h1 = makeHarness(pool, dbFile);
  try {
    const created = await h1.sitesService.createSite({ url: `${site.origin}/` });
    const siteId = created.site.id;
    h1.crawlService.start(siteId, { ...FAST_PRESET, concurrency: 1, perHostConcurrency: 1, minDelayMs: 300 });
    // 抓一小部分后暂停（等价于崩溃时队列里还有 pending/running）
    await new Promise((r) => setTimeout(r, 700));
    h1.crawlService.pause(siteId);
    const pauseTask = h1.crawl.latestTask(siteId);
    assert.equal(pauseTask?.status, 'paused');
    const countsBefore = h1.crawl.queueCounts(pauseTask?.id ?? '');
    assert.ok((countsBefore['pending'] ?? 0) > 0, '暂停时队列应仍有待抓项');
    const nodesBefore = h1.nodes.count(siteId);

    // 重启：手工把任务标成 running 模拟「进程崩溃时的残留状态」，再走恢复逻辑
    h1.handle.db.prepare("UPDATE crawl_tasks SET status = 'running' WHERE id = ?").run(pauseTask?.id ?? '');
    h1.handle.db.prepare("UPDATE crawl_queue SET state = 'running' WHERE task_id = ? AND state = 'pending'").run(pauseTask?.id ?? '');
    const recovered = h1.crawl.recoverStaleQueue();
    assert.ok(recovered > 0, `崩溃残留的 running 队列项应被复位，实际 ${recovered}`);
    const afterRecover = h1.crawl.queueCounts(pauseTask?.id ?? '');
    assert.equal(afterRecover['running'], 0, '复位后不应再有 running');

    // 旧实例退场（对话已断），新实例接管同一数据库
    h1.handle.close();

    const h2 = makeHarness(pool, dbFile);
    try {
      const active = h2.crawl.activeTask(siteId);
      assert.equal(active?.status, 'paused', '恢复后任务应为 paused，等待续跑');
      const resumedTask = h2.crawlService.resume(siteId);
      assert.equal(resumedTask.status, 'running');
      const result = await h2.crawlService.wait(siteId);
      assert.equal(result?.status, 'done');

      // 续跑不重复建节点，且节点数只增不减
      const keys = h2.nodes.allIdentityKeys(siteId);
      assert.equal(new Set(keys).size, keys.length, '续跑后 identity_key 仍无重复');
      assert.ok(h2.nodes.count(siteId) >= nodesBefore);
      assert.ok((result?.fetched ?? 0) > 0);
    } finally {
      await h2.close();
    }
  } finally {
    await site.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
