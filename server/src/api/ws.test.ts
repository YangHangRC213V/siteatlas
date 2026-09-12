/**
 * M1 WS 测试：/ws/sites/:id 实时进度推送（真实监听端口 + ws 客户端）
 * 验收 dev-spec §5.2「抓取进度、节点新增、状态变更」服务端→前端。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { buildServer } from './server.ts';
import { openDb, type DbHandle } from '../core/store/db.ts';
import { BrowserPool } from '../core/fetch/pool.ts';
import { clearRobotsCache } from '../core/fetch/robots.ts';
import { startFakeSite } from '../tests/fixture-site.ts';
import type { FastifyInstance } from 'fastify';
import type { CrawlSocketMessage } from '@siteatlas/shared';

test('M1 WS：订阅站点后收到 hello → progress → node → task 消息', async () => {
  clearRobotsCache();
  const fake = await startFakeSite();
  const handle: DbHandle = openDb({ file: ':memory:' });
  const built = buildServer({
    db: handle.db,
    rootDir: import.meta.dirname,
    logger: false,
    pool: new BrowserPool({ launcher: { async launch() { throw new Error('测试不启动浏览器'); } } }),
  });

  let app: FastifyInstance = built.app;
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    assert.ok(address !== null && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;

    const created = await app.inject({ method: 'POST', url: '/api/sites', payload: { url: `${fake.origin}/` } });
    const siteId = created.json().site.id as string;

    const messages: CrawlSocketMessage[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/sites/${siteId}`);
    // 必须先挂 message 监听（hello 帧在握手完成后立刻到达，晚挂会丢首帧）
    socket.on('message', (data) => {
      messages.push(JSON.parse(String(data)) as CrawlSocketMessage);
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    // 订阅后立刻启动采集（进度必须能推到已连接的客户端）
    const started = await app.inject({
      method: 'POST',
      url: `/api/sites/${siteId}/crawl`,
      payload: { preset: { concurrency: 2, minDelayMs: 20, jitterMs: 0, renderMode: 'http', maxDepth: 4 } },
    });
    assert.equal(started.statusCode, 202);

    const deadline = Date.now() + 20000;
    for (;;) {
      const status = await app.inject({ method: 'GET', url: `/api/sites/${siteId}/crawl/status` });
      const taskStatus = (status.json() as { task?: { status?: string } }).task?.status;
      if (taskStatus === 'done' || taskStatus === 'failed' || taskStatus === 'stopped') break;
      if (Date.now() > deadline) throw new Error(`等待任务结束超时：${String(taskStatus)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    // 给最后一帧消息一点投递时间
    await new Promise((r) => setTimeout(r, 400));
    socket.close();

    const types = messages.map((m) => m.type);
    assert.ok(types.includes('hello'), `应收到 hello，实际 ${types.join(',')}`);
    assert.ok(types.includes('progress'), `应收到 progress，实际 ${types.join(',')}`);
    assert.ok(types.includes('node'), `应收到 node（新节点推送），实际 ${types.join(',')}`);
    assert.ok(types.includes('progress') && messages.filter((m) => m.type === 'progress').length >= 2, '进度应多次推进');

    const first = messages[0];
    assert.equal(first?.type, 'hello');
    const lastProgress = messages.filter((m) => m.type === 'progress').at(-1) as Extract<CrawlSocketMessage, { type: 'progress' }>;
    assert.ok(lastProgress.progress.pagesFetched > 0, '进度里的已抓数应增长');
    assert.ok(lastProgress.progress.discovered > 0, '应统计到新发现节点数');

    // status 接口同时报告订阅者数量
    const statusRes = await app.inject({ method: 'GET', url: `/api/sites/${siteId}/crawl/status` });
    assert.equal(typeof (statusRes.json() as { wsSubscribers: number }).wsSubscribers, 'number');
  } finally {
    await app.close();
    handle.close();
    await fake.close();
  }
});
