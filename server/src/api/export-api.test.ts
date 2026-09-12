/**
 * M4 接口测试（dev-spec §5.1 / §5.3）
 *
 * 用真实 Fastify 实例 + 本地 fixture 站点，验证：
 *   · POST /api/sites/:id/export → 产物落盘、manifest 可读；
 *   · GET  /api/exports/:id、/files、站点导出列表；
 *   · GET  /api/sites/:id/materials（含采集时归档的 raw/parsed）；
 *   · 对外只读 API：graph.json / nodes.jsonl / edges.csv / manifest.json / nodes/:nodeId / 产物文件；
 *   · 目录穿越被拒绝。
 *
 * 导出根目录用临时目录（`rootDir`），避免污染仓库里的 data/。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.ts';
import { openDb, type DbHandle } from '../core/store/db.ts';
import { BrowserPool } from '../core/fetch/pool.ts';
import { clearRobotsCache } from '../core/fetch/robots.ts';
import { startFakeSite, type FakeSite } from '../tests/fixture-site.ts';
import type { ExportManifest } from '@siteatlas/shared';

interface Harness {
  app: FastifyInstance;
  handle: DbHandle;
  site: FakeSite;
  siteId: string;
  rootId: string;
  rootDir: string;
  close(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  clearRobotsCache();
  const rootDir = mkdtempSync(join(tmpdir(), 'siteatlas-export-api-'));
  const fakeSite = await startFakeSite();
  const handle = openDb({ file: ':memory:', rootDir });
  const built = buildServer({
    db: handle.db,
    rootDir,
    logger: false,
    pool: new BrowserPool({
      launcher: {
        async launch() {
          throw new Error('测试不启动真实浏览器');
        },
      },
    }),
  });
  await built.app.ready();
  const created = await built.app.inject({
    method: 'POST',
    url: '/api/sites',
    payload: { url: `${fakeSite.origin}/`, name: 'M4 接口测试站' },
  });
  const siteId = created.json().site.id as string;
  const rootId = created.json().root.id as string;

  // 采一遍：产生多级节点/边 + 素材归档（raw/parsed）
  await built.app.inject({
    method: 'POST',
    url: `/api/sites/${siteId}/crawl`,
    // downloadAssets=true → 留 HTML 原件（raw/）；解析结果（parsed/）无论如何都留
    payload: { preset: { concurrency: 4, minDelayMs: 0, jitterMs: 0, maxDepth: 3, renderMode: 'http', downloadAssets: true } },
  });
  for (let i = 0; i < 300; i++) {
    const status = await built.app.inject({ method: 'GET', url: `/api/sites/${siteId}/crawl/status` });
    if ((status.json() as { task?: { status?: string } }).task?.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    app: built.app,
    handle,
    site: fakeSite,
    siteId,
    rootId,
    rootDir,
    async close() {
      await built.app.close();
      handle.close();
      await fakeSite.close();
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

test('M4 接口：采集时归档素材（raw 原件 + parsed 解析结果）并在节点详情里可见', async () => {
  const h = await makeHarness();
  try {
    const materials = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/materials` });
    assert.equal(materials.statusCode, 200);
    const body = materials.json() as { total: number; materials: Array<{ kind: string; rel_path: string; node_id: string }> };
    assert.ok(body.total > 0, '采集后应有素材登记');
    assert.ok(body.materials.some((m) => m.kind === 'html' && m.rel_path.startsWith('raw/')));
    assert.ok(body.materials.some((m) => m.kind === 'body' && m.rel_path.startsWith('parsed/')));
    // 文件真的落盘
    const first = body.materials[0];
    assert.ok(first !== undefined);
    assert.ok(existsSync(join(h.rootDir, 'data', 'sites', h.siteId, first.rel_path)));

    // 按 nodeId 过滤
    const one = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/materials?nodeId=${h.rootId}` });
    assert.ok((one.json() as { total: number }).total >= 1);
    // 按 kind 过滤
    const onlyHtml = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/materials?kind=html` });
    assert.ok((onlyHtml.json() as { materials: Array<{ kind: string }> }).materials.every((m) => m.kind === 'html'));

    // 节点详情带 materials[]
    const detail = await h.app.inject({ method: 'GET', url: `/api/nodes/${h.rootId}` });
    const node = detail.json() as { materials: Array<{ kind: string }> };
    assert.ok(node.materials.length >= 2, '节点详情应带 html + body 两档素材');
  } finally {
    await h.close();
  }
});

test('M4 接口：导出 → 状态/文件清单/站点列表，manifest 与实际文件一致', async () => {
  const h = await makeHarness();
  try {
    const created = await h.app.inject({
      method: 'POST',
      url: `/api/sites/${h.siteId}/export`,
      payload: { format: 'sqlite', scope: 'site' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const payload = created.json() as { export: { id: string; status: string; dir: string; counts_json: string }; manifest: ExportManifest };
    assert.equal(payload.export.status, 'done');
    assert.equal(payload.manifest.schemaVersion, '1.0');
    assert.ok(payload.manifest.layers.raw.length > 0, 'manifest 应登记素材原件');
    assert.ok(payload.manifest.layers.parsed.length > 0, 'manifest 应登记解析结果');

    const manifestOnDisk = JSON.parse(readFileSync(join(payload.export.dir, 'manifest.json'), 'utf8')) as ExportManifest;
    for (const [name, entry] of Object.entries(manifestOnDisk.files)) {
      const data = readFileSync(join(payload.export.dir, name));
      assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, `${name} 校验和应一致`);
      assert.equal(data.byteLength, entry.bytes);
    }

    const status = await h.app.inject({ method: 'GET', url: `/api/exports/${payload.export.id}` });
    assert.equal(status.statusCode, 200);
    assert.equal((status.json() as { export: { id: string } }).export.id, payload.export.id);

    const files = await h.app.inject({ method: 'GET', url: `/api/exports/${payload.export.id}/files` });
    const names = (files.json() as { files: Array<{ name: string }> }).files.map((f) => f.name);
    assert.ok(names.includes('manifest.json'));
    assert.ok(names.includes('siteatlas.db'));

    const list = await h.app.inject({ method: 'GET', url: `/api/sites/${h.siteId}/export` });
    assert.equal((list.json() as { exports: unknown[] }).exports.length, 1);

    // 不存在的导出 → 404
    const missing = await h.app.inject({ method: 'GET', url: '/api/exports/01ZZZZZZZZZZZZZZZZZZZZZZZZ' });
    assert.equal(missing.statusCode, 404);

    // 非法格式 → 400（body schema 拦截）
    const bad = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/export`, payload: { format: 'xml' } });
    assert.equal(bad.statusCode, 400);
  } finally {
    await h.close();
  }
});

test('M4 只读 API：manifest 是唯一入口，凭它就能取回全部数据；目录穿越被拒', async () => {
  const h = await makeHarness();
  try {
    const created = await h.app.inject({ method: 'POST', url: `/api/sites/${h.siteId}/export`, payload: { format: 'json' } });
    const exportId = (created.json() as { export: { id: string } }).export.id;

    // 1) 读 manifest
    const manifestRes = await h.app.inject({ method: 'GET', url: `/open/v1/exports/${exportId}/manifest.json` });
    assert.equal(manifestRes.statusCode, 200);
    const manifest = JSON.parse(manifestRes.body) as ExportManifest;

    // 2) 按 files 映射逐个取回，并逐个校验 sha256（第三方脚本能做的事，这里就照做）
    for (const [name, entry] of Object.entries(manifest.files)) {
      const res = await h.app.inject({ method: 'GET', url: `/open/v1/exports/${exportId}/${name}` });
      assert.equal(res.statusCode, 200, `${name} 应能取回`);
      const raw = res.rawPayload;
      assert.equal(raw.byteLength, entry.bytes, `${name} 字节数应一致`);
      assert.equal(createHash('sha256').update(raw).digest('hex'), entry.sha256, `${name} 校验和应一致`);
    }

    // 3) 从 graph.json 里读出节点与边（下游最典型的用法）
    const graphRes = await h.app.inject({ method: 'GET', url: `/open/v1/exports/${exportId}/graph.json` });
    const graph = JSON.parse(graphRes.body) as { meta: { counts: { nodes: number } }; nodes: unknown[]; edges: unknown[] };
    assert.equal(graph.nodes.length, manifest.counts.nodes);
    assert.equal(graph.edges.length, manifest.counts.edges);
    assert.ok(graph.meta.counts.nodes > 1, 'fixture 站点应采到多级节点');

    // 4) 站点级即时入口（不需要先建导出任务）
    const live = await h.app.inject({ method: 'GET', url: `/open/v1/sites/${h.siteId}/manifest.json` });
    assert.equal(live.statusCode, 200);
    const liveManifest = JSON.parse(live.body) as ExportManifest & { exports: Array<{ exportId: string }> };
    assert.equal(liveManifest.exportId, 'live');
    assert.equal(liveManifest.exports[0]?.exportId, exportId, '站点 manifest 应列出已有导出');
    for (const path of ['graph.json', 'nodes.jsonl', 'edges.csv']) {
      const res = await h.app.inject({ method: 'GET', url: `/open/v1/sites/${h.siteId}/${path}` });
      assert.equal(res.statusCode, 200, `${path} 应可即时导出`);
    }
    const jsonl = (await h.app.inject({ method: 'GET', url: `/open/v1/sites/${h.siteId}/nodes.jsonl` })).body.trimEnd().split('\n');
    assert.equal(jsonl.length, liveManifest.counts.nodes + 1, 'nodes.jsonl = meta 行 + 每节点一行');

    // 5) 单节点查询
    const node = await h.app.inject({ method: 'GET', url: `/open/v1/sites/${h.siteId}/nodes/${h.rootId}` });
    assert.equal(node.statusCode, 200);
    const nodeBody = JSON.parse(node.body) as { node: { id: string; url: string; parent_id: string | null }; edges: unknown[] };
    assert.equal(nodeBody.node.id, h.rootId);
    assert.equal(nodeBody.node.parent_id, null, '根节点的有效父节点为空');
    assert.ok(nodeBody.edges.length > 0);

    // 6) 目录穿越：编码后的 ../ 必须被拒绝，且不能读到导出目录之外的文件
    for (const evil of ['..%2F..%2F..%2Fmanifest.json', '%2E%2E%2F%2E%2E%2Fetc%2Fpasswd', '%2Fetc%2Fpasswd']) {
      const res = await h.app.inject({ method: 'GET', url: `/open/v1/exports/${exportId}/${evil}` });
      assert.equal(res.statusCode, 400, `${evil} 应被拒绝`);
    }
    const health = await h.app.inject({ method: 'GET', url: `/open/v1/exports/${exportId}/manifest.json` });
    assert.equal(health.statusCode, 200, '正常文件不受影响');
  } finally {
    await h.close();
  }
});

test('M4 只读 API：不存在的站点/节点/导出返回 404', async () => {
  const h = await makeHarness();
  try {
    const bogus = '01ZZZZZZZZZZZZZZZZZZZZZZZZ';
    assert.equal((await h.app.inject({ method: 'GET', url: `/open/v1/sites/${bogus}/graph.json` })).statusCode, 404);
    assert.equal((await h.app.inject({ method: 'GET', url: `/open/v1/sites/${h.siteId}/nodes/${bogus}` })).statusCode, 404);
    assert.equal((await h.app.inject({ method: 'GET', url: `/open/v1/exports/${bogus}/manifest.json` })).statusCode, 404);
  } finally {
    await h.close();
  }
});
