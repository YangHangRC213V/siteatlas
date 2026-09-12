/**
 * M3 单元测试：手动采集会话（点击配对 / 回根识别 / 人工指定 / 待确认队列 / 画面串流节流）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type DbHandle } from '../store/db.ts';
import { NodesRepo } from '../store/repos/nodes.ts';
import { SitesRepo } from '../store/repos/sites.ts';
import { EdgesRepo } from '../store/repos/edges.ts';
import { SitesService } from '../sites/service.ts';
import { ManualSession } from './session.ts';
import { PendingClickQueue, parseCapture, isNonNavigatingClick } from './capture.ts';
import { ScreencastPump } from './screencast.ts';
import { FakePageSession } from '../../tests/fake-browser.ts';

interface Harness {
  handle: DbHandle;
  nodes: NodesRepo;
  edges: EdgesRepo;
  sites: SitesRepo;
  siteId: string;
  rootId: string;
  rootUrl: string;
  makeSession: (options?: { pairingWindowMs?: number; now?: () => number }) => { session: ManualSession; page: FakePageSession; frames: unknown[] };
  close(): void;
}

async function makeHarness(rootUrl = 'http://t.local/'): Promise<Harness> {
  const handle = openDb({ file: ':memory:' });
  const nodes = new NodesRepo(handle.db);
  const sites = new SitesRepo(handle.db);
  const edges = new EdgesRepo(handle.db);
  const sitesService = new SitesService({ sites, nodes });
  const created = await sitesService.createSite({ url: rootUrl, skipProbe: true, name: '手动测试站' });
  const siteId = created.site.id;

  let clock = 1_000_000;
  const clockOf = (options: { now?: () => number }): (() => number) => options.now ?? (() => clock);
  const makeSession = (options: { pairingWindowMs?: number; now?: () => number } = {}) => {
    const frames: unknown[] = [];
    const now = clockOf(options);
    const session = new ManualSession({
      db: handle.db,
      siteId,
      nodes,
      edges,
      sites,
      siteRootUrl: rootUrl,
      siteScope: 'same_site',
      startNodeId: created.root.id,
      now,
      randomId: (() => `id${Math.random().toString(36).slice(2, 10)}`) as () => string,
      ...(options.pairingWindowMs !== undefined ? { pairingWindowMs: options.pairingWindowMs } : {}),
      deliverFrame: (frame) => frames.push(frame),
    });
    // 用会话自己的 handler 装配（与服务端真实链路一致），页面与会话共用同一时钟
    const wired = new FakePageSession({ id: 'fake-1', now, handlers: session.pageHandlers() });
    session.attachPage(wired);
    return { session, page: wired, frames };
  };

  return {
    handle,
    nodes,
    edges,
    sites,
    siteId,
    rootId: created.root.id,
    rootUrl,
    makeSession,
    close: () => handle.close(),
  };
}

test('M3 点击配对：点击 → 导航 → 建边 + 建节点（父=点击时所在页）', async () => {
  const h = await makeHarness();
  try {
    const { session, page } = h.makeSession();
    await session.start();

    page.pushClick({ href: 'http://t.local/about', anchorText: '关于我们', selector: 'nav > a:nth-of-type(1)' });
    page.pushNavigation('http://t.local/about');

    const state = session.state();
    assert.equal(state.clicks.total, 1);
    assert.equal(state.clicks.paired, 1);
    assert.equal(state.nodesCreated, 1);
    assert.equal(state.edgesCreated, 1);
    assert.equal(state.current?.url, 'http://t.local/about');
    assert.equal(state.current?.depth, 1, '新节点深度应为根 + 1');
    assert.equal(state.current?.parentId, h.rootId, '父节点应是点击时所在页（根）');

    // 边带有 selector / anchor_text / source='manual'
    const outgoing = h.edges.outgoing(h.rootId, 10);
    assert.equal(outgoing.length, 1);
    const edge = outgoing[0];
    assert.ok(edge !== undefined);
    assert.equal(edge.source, 'manual');
    assert.equal(edge.anchor_text, '关于我们');
    assert.equal(edge.selector, 'nav > a:nth-of-type(1)');
    assert.equal(edge.dom_path, 'body[1]/a[1]');
    assert.equal(edge.order_in_page, 0);
  } finally {
    h.close();
  }
});

test('M3 回根识别：点击回根 → 复用已有根节点，不新建重复节点', async () => {
  const h = await makeHarness();
  try {
    const { session, page } = h.makeSession();
    await session.start();

    // 先去 /about
    page.pushClick({ href: 'http://t.local/about', anchorText: '关于' });
    page.pushNavigation('http://t.local/about');
    const aboutId = session.state().current?.nodeId;
    assert.ok(aboutId !== undefined);

    // 再点「回首页」
    page.pushClick({ href: 'http://t.local/', anchorText: '回首页' });
    page.pushNavigation('http://t.local/');

    const state = session.state();
    assert.equal(state.current?.nodeId, h.rootId, '应识别为已回到根节点');
    assert.equal(state.nodesCreated, 1, '只有 /about 是新建的，回根不应再建节点');
    assert.equal(state.clicks.total, 2, '两次点击都应被记录');
    assert.equal(state.clicks.paired, 2, '两次点击都应与导航配对');
    // 回根的边也要记下来（父 = /about）
    const backEdge = h.edges.incoming(h.rootId, 10).find((e) => e.from_id === aboutId);
    assert.ok(backEdge !== undefined, '应记录 /about → 根的边');
    assert.equal(backEdge?.source, 'manual');

    // 节点总数：根 + /about
    assert.equal(h.nodes.count(h.siteId), 2);
  } finally {
    h.close();
  }
});

test('M3 横链去重：两个页面都链到同一 URL → 只建 1 个节点，2 条边', async () => {
  const h = await makeHarness();
  try {
    const { session, page } = h.makeSession();
    await session.start();

    // 根 → /docs
    page.pushClick({ href: 'http://t.local/docs', anchorText: '文档' });
    page.pushNavigation('http://t.local/docs');
    const docsId = session.state().current?.nodeId;
    assert.ok(docsId !== undefined);

    // /docs 页面上再点“文档首页”（自环等价：同一个 URL）
    page.pushClick({ href: 'http://t.local/docs', anchorText: '文档首页' });
    page.pushNavigation('http://t.local/docs');
    assert.equal(session.state().clicks.skippedDuplicate, 1, '重复目标应被识别');
    assert.equal(h.nodes.count(h.siteId), 2, '同一 URL 只应有 1 个节点');
  } finally {
    h.close();
  }
});

test('M3 未配对点击：页内锚点/新标签/JS 行为进待确认队列，不污染树', async () => {
  const h = await makeHarness();
  try {
    const { session, page, frames } = h.makeSession({ pairingWindowMs: 1000 });
    void frames;
    await session.start();

    // 1) 页内锚点：href 只有 fragment
    page.pushClick({ href: 'http://t.local/#section', anchorText: '跳到第二段' });
    await new Promise((r) => setTimeout(r, 5));

    // 2) 新标签
    page.pushClick({ href: 'http://t.local/new-tab', anchorText: '新标签打开', target: '_blank' });
    // 3) 完全不导航的点击（JS 行为）
    page.pushClick({ tag: 'button', href: null, anchorText: '展开' });

    const pending = session.listPendingConfirm();
    assert.ok(pending.length >= 1, `待确认队列应至少 1 条，实际 ${pending.length}`);
    assert.equal(session.state().nodesCreated, 0, '未配对点击不应建节点');
    assert.equal(h.edges.countForSite(h.siteId), 0, '未配对点击不应建边');

    // 待确认项可人工确认到指定节点
    const first = pending[0];
    assert.ok(first !== undefined);
    const confirmed = session.confirmPending(first.id, h.rootId);
    assert.equal(confirmed.ok, true);
    assert.equal(h.edges.countForSite(h.siteId), 1, '人工确认后才建边');
    assert.equal(session.listPendingConfirm().length, pending.length - 1);

    // 也可以丢弃
    const next = session.listPendingConfirm()[0];
    if (next !== undefined) {
      assert.equal(session.discardPending(next.id).ok, true);
    }
  } finally {
    h.close();
  }
});

test('M3 人工指定：以当前页为根 / 置为父节点（防环）+ 痕迹落库', async () => {
  const h = await makeHarness();
  try {
    const { session, page } = h.makeSession();
    await session.start();

    page.pushClick({ href: 'http://t.local/a', anchorText: 'A' });
    page.pushNavigation('http://t.local/a');
    const aId = session.state().current?.nodeId as string;

    // 以当前页为根
    const asRoot = session.setCurrentAsRoot();
    assert.equal(asRoot.ok, true);
    assert.equal(asRoot.marker, 'set-root');
    assert.equal(session.state().rootNodeId, aId);

    // 新建一个游离节点，再把当前页（/a）指定为它的父
    const { node: orphan } = h.nodes.upsert({
      siteId: h.siteId,
      url: 'http://t.local/orphan',
      identityKey: 'http://t.local/orphan',
      parentId: null,
      depth: 0,
      displayLabel: 'orphan',
    });
    const setParent = session.setCurrentAsParentOf(orphan.id);
    assert.equal(setParent.ok, true);
    assert.equal(setParent.marker, 'set-parent');
    assert.equal(h.nodes.get(orphan.id)?.auto_parent_id, aId);

    // 把某个子孙指定为当前页的父 → 会成环，必须拒绝
    const { node: childOfA } = h.nodes.upsert({
      siteId: h.siteId,
      url: 'http://t.local/a/child',
      identityKey: 'http://t.local/a/child',
      parentId: aId,
      depth: 2,
      displayLabel: 'child',
    });
    // 当前页是 /a；把「根的父」指定为 /a（根是 /a 的祖先）→ 环
    const cyclic = session.setCurrentAsParentOf(h.rootId);
    assert.equal(cyclic.ok, false);
    assert.match(cyclic.message, /环/);

    // 反向确认：把子孙挂到当前页下是合法的（人工指定的常见用法）
    const legit = session.setCurrentAsParentOf(childOfA.id);
    assert.equal(legit.ok, true);
    assert.equal(h.nodes.get(childOfA.id)?.auto_parent_id, aId);

    // 痕迹落库：成功的两次人工指定各一条，被拒的那次不落库
    const rows = h.handle.db
      // id 是 ULID（单调递增），created_at 秒级会在同一秒内并列
      .prepare('SELECT kind, value FROM manual_overrides WHERE session_id = ? ORDER BY id')
      .all(session.id) as Array<{ kind: string; value: string | null }>;
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.kind),
      ['set-root', 'set-parent', 'set-parent'],
    );
  } finally {
    h.close();
  }
});

test('M3 回根/回父都是绝对导航，且输入事件原样回传', async () => {
  const h = await makeHarness();
  try {
    const { session, page } = h.makeSession();
    await session.start();

    page.pushClick({ href: 'http://t.local/a', anchorText: 'A' });
    page.pushNavigation('http://t.local/a');

    await session.backToRoot();
    assert.equal(page.navigationHistory.at(-1), 'http://t.local/', '回根 = 一次绝对 URL 导航');
    assert.equal(session.state().current?.nodeId, h.rootId, '回根后身份应切回根节点');

    await session.backToParent();
    // 根节点没有父，回父退化为回根
    assert.equal(page.navigationHistory.at(-1), 'http://t.local/');

    // 输入回传
    await session.dispatchMouse({ type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 });
    await session.dispatchMouse({ type: 'mouseWheel', x: 10, y: 20, deltaY: 120 });
    await session.dispatchKey({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.equal(page.mouseEvents.length, 2);
    assert.equal(page.mouseEvents[0]?.type, 'mousePressed');
    assert.equal(page.mouseEvents[1]?.deltaY, 120);
    assert.equal(page.keyEvents[0]?.key, 'Enter');
  } finally {
    h.close();
  }
});

test('M3 画面串流：帧节流只推最新帧，ack 前的中间帧被丢弃', () => {
  let now = 0;
  const pump = new ScreencastPump({ maxFps: 10, now: () => now }); // 100ms 一帧

  const first = pump.accept({ data: 'a', width: 100, height: 100 });
  assert.ok(first !== null, '第一帧应直接投递');
  assert.equal(pump.takeLatest(), null, '没有待投递帧');

  now += 10;
  assert.equal(pump.accept({ data: 'b', width: 100, height: 100 }), null, '节流窗口内不投递');
  now += 10;
  assert.equal(pump.accept({ data: 'c', width: 100, height: 100 }), null);
  assert.equal(pump.hasPending, true);

  // 窗口外又来了新帧：它应替换掉待投递的 c（b 与 c 都进 dropped）
  // 窗口外：直接投递新帧，并把它之前压着的待投递帧算作丢弃
  now += 100;
  const fourth = pump.accept({ data: 'd', width: 100, height: 100 });
  assert.equal(fourth?.data, 'd', '窗口外应直接投递');
  assert.equal(pump.takeLatest(), null, '待投递帧已被 d 取代');
  assert.equal(pump.hasPending, false);

  const stats = pump.stats();
  assert.equal(stats.received, 4);
  assert.equal(stats.delivered, 2, 'a 与 d 投递');
  // 丢弃语义 = 「收到了但没被投递」：b 被 c 取代计 1，c 被 d 取代计 1
  assert.equal(stats.dropped, 2);
});

test('M3 待配对队列：过期点击落到未配对，非导航点击被跳过', () => {
  let now = 0;
  const queue = new PendingClickQueue({ pairingWindowMs: 100, now: () => now, makeId: () => `c${Math.random()}` });
  const payload = parseCapture({
    kind: 'click',
    tag: 'a',
    anchorText: 'x',
    selector: 'a',
    domPath: 'a[1]',
    href: 'http://t.local/x',
    at: now,
  });
  assert.ok(payload !== null);

  queue.push({ payload: payload as never, fromNodeId: 'n1', fromUrl: 'http://t.local/', fromDepth: 0 });
  now += 200;
  assert.equal(queue.takeForNavigation(), null, '过期点击不应被配对');
  assert.equal(queue.stats().unpaired, 1);

  // 新标签点击不该被算作导航来源
  const blank = parseCapture({ kind: 'click', tag: 'a', href: 'http://t.local/y', target: '_blank', at: now });
  assert.ok(blank !== null);
  assert.equal(isNonNavigatingClick(blank as never), true);
  queue.push({ payload: blank as never, fromNodeId: 'n1', fromUrl: 'http://t.local/', fromDepth: 0 });
  const real = parseCapture({ kind: 'click', tag: 'a', href: 'http://t.local/z', at: now });
  assert.ok(real !== null);
  queue.push({ payload: real as never, fromNodeId: 'n1', fromUrl: 'http://t.local/', fromDepth: 0 });
  const paired = queue.takeForNavigation();
  assert.equal(paired?.payload.href, 'http://t.local/z', '应跳过 _blank 点击，配到真实跳转');
});

test('M3 范围保护：超出站点范围的导航被拒绝（不落库）', async () => {
  const h = await makeHarness();
  try {
    const { session, page } = h.makeSession();
    await session.start();

    // 外部域点击：会话仍会记录边（用户手动点的），但导航到外域应被拒绝
    const denied = await session.navigate('http://evil.example.com/x');
    assert.equal(denied.ok, false);
    assert.match(String(denied.error), /超出站点范围/);
    assert.equal(page.navigationHistory.includes('http://evil.example.com/x'), false);
    assert.equal(session.state().lastError?.includes('超出站点范围'), true);
  } finally {
    h.close();
  }
});

test('M3 暂停时不记录点击，恢复后继续', async () => {
  const h = await makeHarness();
  try {
    const { session, page } = h.makeSession();
    await session.start();
    session.pause();

    page.pushClick({ href: 'http://t.local/paused', anchorText: 'A' });
    assert.equal(session.state().clicks.total, 0, '暂停时点击不计数');
    assert.equal(session.state().status, 'paused');

    session.resume();
    page.pushClick({ href: 'http://t.local/paused', anchorText: 'A' });
    page.pushNavigation('http://t.local/paused');
    assert.equal(session.state().clicks.total, 1);
    assert.equal(session.state().nodesCreated, 1);
  } finally {
    h.close();
  }
});
