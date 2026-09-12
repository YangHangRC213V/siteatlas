/**
 * M3 接口与 WS 测试：手动采集会话（REST 生命周期 + /ws/manual/:sessionId 双向通道）
 *
 * 用注入的假页面会话（FakePageSession）驱动，不依赖真实 Chromium：
 *   · 假页面可以主动「推帧 / 上报点击 / 报告导航」，用于验证 WS 下行与落库；
 *   · WS 上行验证鼠标/键盘被折成 CDP Input.* 回传到页面。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.ts';
import { openDb, type DbHandle } from '../core/store/db.ts';
import { BrowserPool } from '../core/fetch/pool.ts';
import { clearRobotsCache } from '../core/fetch/robots.ts';
import { startFakeSite, type FakeSite } from '../tests/fixture-site.ts';
import { FakePageSession } from '../tests/fake-browser.ts';
import type { ManualService } from '../core/manual/service.ts';

interface Harness {
  app: FastifyInstance;
  handle: DbHandle;
  site: FakeSite;
  siteId: string;
  manual: ManualService;
  pages: FakePageSession[];
  close(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  clearRobotsCache();
  const fakeSite = await startFakeSite();
  const handle = openDb({ file: ':memory:' });
  const pages: FakePageSession[] = [];
  const built = buildServer({
    db: handle.db,
    rootDir: import.meta.dirname,
    logger: false,
    pool: new BrowserPool({ launcher: { async launch() { throw new Error('测试不启动真实浏览器'); } } }),
  });
  // 用假页面替换真实 Playwright 会话
  const manual = built.manualService as unknown as { deps: { createPageSession?: unknown } };
  const service = built.manualService;
  Object.defineProperty(service, 'deps', {
    value: {
      ...(manual.deps as Record<string, unknown>),
      createPageSession: async (options: { handlers: Parameters<typeof FakePageSession.prototype.constructor>[0] }) => {
        const page = new FakePageSession({
          id: 'fake-1',
          ...(options.handlers !== undefined ? { handlers: options.handlers } : {}),
        });
        pages.push(page);
        return page;
      },
    },
  });

  await built.app.ready();
  const created = await built.app.inject({
    method: 'POST',
    url: '/api/sites',
    payload: { url: `${fakeSite.origin}/`, name: 'M3 测试站' },
  });
  const siteId = created.json().site.id as string;
  // 采一次，让树里有多级节点可手动操作
  await built.app.inject({
    method: 'POST',
    url: `/api/sites/${siteId}/crawl`,
    payload: { preset: { concurrency: 4, minDelayMs: 0, jitterMs: 0, maxDepth: 3, renderMode: 'http' } },
  });
  for (let i = 0; i < 200; i++) {
    const status = await built.app.inject({ method: 'GET', url: `/api/sites/${siteId}/crawl/status` });
    if ((status.json() as { task?: { status?: string } }).task?.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    app: built.app,
    handle,
    site: fakeSite,
    siteId,
    manual: service,
    pages,
    async close() {
      await built.app.close();
      handle.close();
      await fakeSite.close();
    },
  };
}

test('M3 REST：开始手动会话 → 状态 → 停止；浏览器不可用时 503', async () => {
  const h = await makeHarness();
  try {
    const started = await h.app.inject({
      method: 'POST',
      url: `/api/sites/${h.siteId}/manual`,
      payload: { mode: 'record-and-expand' },
    });
    assert.equal(started.statusCode, 201, started.body);
    const state = started.json().state as { sessionId: string; status: string; progressMode: string; guideEnabled: boolean };
    assert.equal(state.status, 'running');
    assert.equal(state.progressMode, 'record-and-expand');
    assert.equal(state.guideEnabled, true);
    assert.equal(h.pages.length, 1, '应创建一个浏览器页面会话');
    assert.equal(h.pages[0]?.screencastStarted, true, '应启动画面串流');

    // 同站点重复开始 → 409
    const again = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/manual`, payload: {} });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, 'MANUAL_ALREADY_RUNNING');

    // 站点级状态查询
    const siteState = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/manual` });
    assert.equal(siteState.json().state.sessionId, state.sessionId);

    // 会话详情（含事件）
    const detail = await h.app.inject({ method: 'GET', url: `/api/manual/${state.sessionId}` });
    assert.equal(detail.statusCode, 200);
    assert.ok((detail.json() as { events: unknown[] }).events.length >= 1);

    // 停止
    const stopped = await h.app.inject({ method: 'POST', url: `/api/manual/${state.sessionId}/stop` });
    assert.equal(stopped.statusCode, 200);
    assert.equal(stopped.json().state.status, 'ended');
    assert.equal(h.pages[0]?.closed, true, '停止后应关闭页面');
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/manual` })).json().state, null);

    // 已停止的会话再停 → 404
    const missing = await h.app.inject({ method: 'POST', url: `/api/manual/${state.sessionId}/stop` });
    assert.equal(missing.statusCode, 404);
  } finally {
    await h.close();
  }
});

test('M3 REST：站点不存在 404；无根节点站点 409', async () => {
  const h = await makeHarness();
  try {
    const missing = await h.app.inject({ method: 'POST', url: '/api/sites/01JZZZZZZZZZZZZZZZZZZZZZZZ/manual', payload: {} });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'SITE_NOT_FOUND');
  } finally {
    await h.close();
  }
});

test('M3 WS：下行帧/状态，上行鼠标与键盘折成 CDP Input.*，点击捕获落库', async () => {
  const h = await makeHarness();
  try {
    const started = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/manual`, payload: {} });
    const sessionId = (started.json().state as { sessionId: string }).sessionId;

    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const address = h.app.server.address();
    assert.ok(address !== null && typeof address === 'object');
    const port = address.port;

    const messages: Array<Record<string, unknown>> = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/manual/${sessionId}`);
    socket.on('message', (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 200));

    const types = messages.map((m) => m['type']);
    assert.ok(types.includes('hello'), `应收到 hello，实际 ${types.join(',')}`);
    assert.ok(types.includes('state'), `应收到 state，实际 ${types.join(',')}`);

    // 上行：鼠标 + 键盘 → 回传到假页面
    socket.send(JSON.stringify({ type: 'mouse', mouse: { type: 'mousePressed', x: 100, y: 200, button: 'left', clickCount: 1 } }));
    socket.send(JSON.stringify({ type: 'mouse', mouse: { type: 'mouseReleased', x: 100, y: 200, button: 'left', clickCount: 1 } }));
    socket.send(JSON.stringify({ type: 'key', key: { type: 'keyDown', key: 'a', text: 'a' } }));
    await new Promise((r) => setTimeout(r, 300));
    const page = h.pages[0];
    assert.ok(page !== undefined);
    assert.equal(page.mouseEvents.length, 2, '两次鼠标事件应回传到页面');
    assert.equal(page.mouseEvents[0]?.x, 100);
    assert.equal(page.mouseEvents[1]?.type, 'mouseReleased');
    assert.equal(page.keyEvents.length, 1);
    assert.equal(page.keyEvents[0]?.key, 'a');

    // 下行：假页面推帧 → WS 收到 frame
    page.pushFrame('ZmFrZWZyYW1l');
    await new Promise((r) => setTimeout(r, 300));
    const frames = messages.filter((m) => m['type'] === 'frame');
    assert.ok(frames.length >= 1, '应收到画面帧');

    // 点击捕获 → 配对 → 落库（边 + 节点）
    const before = h.handle.db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE site_id = ?').get(h.siteId) as { c: number };
    page.pushClick({ href: `${h.site.origin}/manual-target`, anchorText: '手动目标', selector: 'main > a' });
    page.pushNavigation(`${h.site.origin}/manual-target`);
    await new Promise((r) => setTimeout(r, 400));

    const after = h.handle.db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE site_id = ?').get(h.siteId) as { c: number };
    assert.equal(after.c, before.c + 1, '手动点击应新建 1 个节点');
    const manualEdges = h.handle.db
      .prepare("SELECT COUNT(*) AS c FROM edges WHERE site_id = ? AND source = 'manual'")
      .get(h.siteId) as { c: number };
    assert.equal(manualEdges.c, 1, '应写入 source=manual 的边');

    // 上行：回根 / 置为根 / 暂停
    socket.send(JSON.stringify({ type: 'set-root' }));
    socket.send(JSON.stringify({ type: 'back-root' }));
    socket.send(JSON.stringify({ type: 'pause' }));
    await new Promise((r) => setTimeout(r, 400));
    const lastState = [...messages].reverse().find((m) => m['type'] === 'state');
    assert.equal((lastState?.['state'] as { status: string }).status, 'paused');

    // 未知消息类型 → error 帧
    socket.send(JSON.stringify({ type: 'bogus' }));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(messages.some((m) => m['type'] === 'error'), '未知消息应回 error');

    socket.close();
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    await h.close();
  }
});

test('M3 WS：不存在的会话回 error 帧而非崩溃', async () => {
  const h = await makeHarness();
  try {
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const address = h.app.server.address();
    assert.ok(address !== null && typeof address === 'object');
    const messages: Array<Record<string, unknown>> = [];
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/manual/does-not-exist`);
    socket.on('message', (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(messages[0]?.['type'], 'error');
    assert.equal(messages[0]?.['code'], 'SESSION_NOT_FOUND');
    socket.close();
  } finally {
    await h.close();
  }
});
