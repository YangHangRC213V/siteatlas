/**
 * M4 导出内核测试（dev-spec §6.7 / §7 M4）
 *
 * 覆盖：
 *   · 数据集投影：有效父节点（叠加修正层）、软删过滤、子树范围、边随节点一起裁剪；
 *   · 写出器：CSV RFC4180 转义、JSONL 首行 meta、Mermaid 截断与标签转义、SQLite 快照可查；
 *   · 服务编排：目录约定、manifest 的 sha256/bytes 与实际文件一致、五种格式产物齐备。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, type DbHandle } from '../store/db.ts';
import { NodesRepo } from '../store/repos/nodes.ts';
import { EdgesRepo } from '../store/repos/edges.ts';
import { SitesRepo } from '../store/repos/sites.ts';
import { MaterialsRepo } from '../store/repos/materials.ts';
import { OverridesRepo } from '../store/repos/overrides.ts';
import { OverridesService } from '../override/overrides.ts';
import { buildDataset } from './dataset.ts';
import {
  csvField,
  edgesCsv,
  graphJson,
  mermaidTree,
  nodesJsonl,
  writeEdgesCsvToFile,
  writeGraphJsonToFile,
  writeNodesJsonlToFile,
} from './writers.ts';
import { ExportService } from './service.ts';
import type { ExportManifest } from '@siteatlas/shared';

interface Ctx {
  handle: DbHandle;
  nodes: NodesRepo;
  edges: EdgesRepo;
  sites: SitesRepo;
  materials: MaterialsRepo;
  overrides: OverridesService;
  rootDir: string;
  siteId: string;
  rootId: string;
  aboutId: string;
  docsId: string;
  guideId: string;
  cleanup(): void;
}

function makeCtx(): Ctx {
  const rootDir = mkdtempSync(join(tmpdir(), 'siteatlas-export-test-'));
  const handle = openDb({ file: ':memory:', rootDir });
  const db = handle.db;
  const sites = new SitesRepo(db);
  const nodes = new NodesRepo(db);
  const edges = new EdgesRepo(db);
  const materials = new MaterialsRepo(db);
  const overrides = new OverridesService({ db, nodes, sites, overrides: new OverridesRepo(db) });

  const site = sites.create({ name: '导出测试站', rootUrl: 'http://export.test/', rootHost: 'export.test', scope: 'same_site', allowlist: [] });
  const root = nodes.createRoot({
    siteId: site.id,
    identityKey: 'http://export.test/',
    url: 'http://export.test/',
    displayLabel: '首页',
    status: 'ok',
  });
  const about = nodes.upsert({
    siteId: site.id,
    url: 'http://export.test/about',
    identityKey: 'http://export.test/about',
    parentId: root.id,
    depth: 1,
    displayLabel: '关于我们',
    status: 'ok',
  });
  const docs = nodes.upsert({
    siteId: site.id,
    url: 'http://export.test/docs',
    identityKey: 'http://export.test/docs',
    parentId: root.id,
    depth: 1,
    displayLabel: '文档',
    status: 'ok',
  });
  const guide = nodes.upsert({
    siteId: site.id,
    url: 'http://export.test/docs/guide',
    identityKey: 'http://export.test/docs/guide',
    parentId: docs.node.id,
    depth: 2,
    displayLabel: '指南',
    status: 'ok',
  });
  edges.insert({
    siteId: site.id,
    fromId: root.id,
    toId: about.node.id,
    anchorText: '关于',
    selector: 'a',
    domPath: 'body/a',
    rel: null,
    target: null,
    isNofollow: false,
    fragment: null,
    source: 'auto',
    orderInPage: 1,
  });
  edges.insert({
    siteId: site.id,
    fromId: root.id,
    toId: docs.node.id,
    anchorText: '文档',
    selector: 'a',
    domPath: 'body/a',
    rel: null,
    target: null,
    isNofollow: false,
    fragment: null,
    source: 'auto',
    orderInPage: 2,
  });
  edges.insert({
    siteId: site.id,
    fromId: docs.node.id,
    toId: guide.node.id,
    anchorText: '指南',
    selector: 'a',
    domPath: 'body/a',
    rel: null,
    target: null,
    isNofollow: false,
    fragment: null,
    source: 'auto',
    orderInPage: 1,
  });
  materials.upsert({
    siteId: site.id,
    nodeId: root.id,
    kind: 'html',
    relPath: `raw/${root.id}.html`,
    bytes: 123,
    sha256: 'a'.repeat(64),
  });

  return {
    handle,
    nodes,
    edges,
    sites,
    materials,
    overrides,
    rootDir,
    siteId: site.id,
    rootId: root.id,
    aboutId: about.node.id,
    docsId: docs.node.id,
    guideId: guide.node.id,
    cleanup() {
      handle.close();
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

test('M4 数据集：父节点取有效值（叠加重挂修正），自动层不变', () => {
  const ctx = makeCtx();
  try {
    // 把 /about 从根重挂到 /docs 下
    ctx.overrides.move(ctx.siteId, [ctx.aboutId], ctx.docsId);

    const dataset = buildDataset({ db: ctx.handle.db, siteId: ctx.siteId });
    const about = dataset.nodes.find((n) => n.id === ctx.aboutId);
    assert.equal(about?.parent_id, ctx.docsId, '导出的父节点应是有效父节点');
    assert.equal(about?.auto_parent_id, ctx.rootId, '自动层父节点仍保留原值');
    assert.equal(about?.has_override, true);

    const auto = ctx.nodes.get(ctx.aboutId);
    assert.equal(auto?.auto_parent_id, ctx.rootId, '自动层数据不应被导出过程改动');
  } finally {
    ctx.cleanup();
  }
});

test('M4 数据集：软删节点默认不导出但计数，includeDeleted 时带标记导出', () => {
  const ctx = makeCtx();
  try {
    ctx.overrides.deleteSubtrees(ctx.siteId, [ctx.docsId]);

    const withoutDeleted = buildDataset({ db: ctx.handle.db, siteId: ctx.siteId });
    assert.equal(withoutDeleted.nodes.length, 2, '只应剩根与 /about');
    assert.equal(withoutDeleted.counts.deleted, 2, '软删的 /docs 与 /guide 应计数');
    assert.equal(withoutDeleted.edges.length, 1, '指向软删节点的边也要一起裁掉');

    const withDeleted = buildDataset({ db: ctx.handle.db, siteId: ctx.siteId, includeDeleted: true });
    assert.equal(withDeleted.nodes.length, 4);
    assert.equal(withDeleted.nodes.filter((n) => n.is_deleted).length, 2);
    assert.equal(withDeleted.edges.length, 3, '带软删时边应完整');
  } finally {
    ctx.cleanup();
  }
});

test('M4 数据集：子树范围只含该子树，跨出子树的边被裁掉', () => {
  const ctx = makeCtx();
  try {
    const dataset = buildDataset({ db: ctx.handle.db, siteId: ctx.siteId, subtreeRootId: ctx.docsId });
    assert.deepEqual(
      dataset.nodes.map((n) => n.url).sort(),
      ['http://export.test/docs', 'http://export.test/docs/guide'],
    );
    // root→docs 这条边的起点在子树外，必须裁掉；docs→guide 保留
    assert.equal(dataset.edges.length, 1);
    assert.equal(dataset.edges[0]?.from_id, ctx.docsId);
    assert.equal(dataset.scope.kind, 'subtree');
    assert.equal(dataset.scope.nodeId, ctx.docsId);
  } finally {
    ctx.cleanup();
  }
});

test('M4 写出器：CSV 转义、JSONL 首行 meta、Mermaid 截断与标签清洗', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('line\nbreak'), '"line\nbreak"');
  assert.equal(csvField(null), '');
  assert.equal(csvField(true), 'true');

  const ctx = makeCtx();
  try {
    // 造一条带逗号/引号的锚文本边
    ctx.edges.insert({
      siteId: ctx.siteId,
      fromId: ctx.rootId,
      toId: ctx.guideId,
      anchorText: '跳转, "指南"',
      selector: null,
      domPath: null,
      rel: 'nofollow',
      target: null,
      isNofollow: true,
      fragment: null,
      source: 'manual',
      orderInPage: 9,
    });
    const dataset = buildDataset({ db: ctx.handle.db, siteId: ctx.siteId });

    const csv = edgesCsv(dataset.edges).content ?? '';
    assert.ok(csv.startsWith('id,from_id,to_id,'), 'CSV 应有表头');
    assert.ok(csv.includes('"跳转, ""指南"""'), '含逗号与引号的字段必须按 RFC4180 转义');
    assert.ok(csv.includes('\r\n'), 'CSV 用 CRLF 行尾');
    assert.equal(csv.trimEnd().split('\r\n').length, dataset.edges.length + 1);

    const jsonl = (nodesJsonl(dataset).content ?? '').trimEnd().split('\n');
    assert.equal(jsonl.length, dataset.nodes.length + 1, 'JSONL = meta 行 + 每个节点一行');
    const meta = JSON.parse(jsonl[0] as string) as { meta: { schemaVersion: string; counts: { nodes: number } } };
    assert.equal(meta.meta.schemaVersion, '1.0');
    assert.equal(meta.meta.counts.nodes, dataset.nodes.length);
    for (const line of jsonl.slice(1)) JSON.parse(line); // 每行都必须是独立合法 JSON

    const mermaid = mermaidTree(dataset, { maxNodes: 2 }).content ?? '';
    assert.ok(mermaid.startsWith('flowchart TD'));
    assert.ok(mermaid.includes('未画出（上限 2）'), '超上限要写明被截断');
    // 节点声明行形如 `  n1["标签"]`，截断提示行的标签是「… 另有 N 个节点未画出」，要用前缀区分
    const declared = mermaid.split('\n').filter((line) => /^  n\d+\["/.test(line));
    assert.equal(declared.length, 2, '最多画 maxNodes 个节点');
  } finally {
    ctx.cleanup();
  }
});

test('M4 写出器：流式版与内存版语义一致（大站走流式，形状不能变）', () => {
  const ctx = makeCtx();
  try {
    const dataset = buildDataset({ db: ctx.handle.db, siteId: ctx.siteId });
    const graphPath = join(ctx.rootDir, 'stream-graph.json');
    const jsonlPath = join(ctx.rootDir, 'stream-nodes.jsonl');
    const csvPath = join(ctx.rootDir, 'stream-edges.csv');
    writeGraphJsonToFile(dataset, graphPath);
    writeNodesJsonlToFile(dataset, jsonlPath);
    writeEdgesCsvToFile(dataset, csvPath);

    const streamed = JSON.parse(readFileSync(graphPath, 'utf8')) as { meta: { counts: { nodes: number } }; nodes: unknown[]; edges: unknown[] };
    const inMemory = JSON.parse(graphJson(dataset).content ?? '{}') as { nodes: unknown[]; edges: unknown[] };
    assert.deepEqual(streamed.nodes, inMemory.nodes, '流式与内存版的节点数组必须一致');
    assert.deepEqual(streamed.edges, inMemory.edges, '流式与内存版的边数组必须一致');
    assert.equal(streamed.meta.counts.nodes, dataset.counts.nodes);

    assert.equal(readFileSync(jsonlPath, 'utf8'), nodesJsonl(dataset).content, 'JSONL 两种路径应逐字节一致');
    assert.equal(readFileSync(csvPath, 'utf8'), edgesCsv(dataset.edges).content, 'CSV 两种路径应逐字节一致');
  } finally {
    ctx.cleanup();
  }
});

test('M4 导出服务：五种格式产物 + manifest 校验和与实际文件一致', () => {
  const ctx = makeCtx();
  try {
    const service = new ExportService({ db: ctx.handle.db, rootDir: ctx.rootDir });
    for (const format of ['json', 'jsonl', 'csv', 'sqlite', 'mermaid'] as const) {
      const outcome = service.run({ siteId: ctx.siteId, format });
      const dir = outcome.export.dir as string;
      assert.equal(outcome.export.status, 'done', `${format} 应导出成功`);
      assert.ok(dir.startsWith(join(ctx.rootDir, 'data', 'sites', ctx.siteId, 'exports')), '目录应符合 §6.7 约定');
      assert.ok(existsSync(join(dir, 'manifest.json')), 'manifest.json 必须存在');

      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ExportManifest;
      assert.equal(manifest.counts.nodes, 4);
      assert.equal(manifest.counts.edges, 3);
      assert.equal(manifest.counts.materials, 1);
      assert.equal(manifest.format, format);

      const expected = ['graph.json', 'nodes.jsonl', 'edges.csv'];
      if (format === 'csv') expected.push('nodes.csv');
      if (format === 'mermaid') expected.push('graph.mmd');
      if (format === 'sqlite') expected.push('siteatlas.db');
      for (const name of expected) {
        assert.ok(manifest.layers.structure.includes(name), `${format} 的 layers.structure 应含 ${name}`);
        const entry = manifest.files[name];
        assert.ok(entry !== undefined, `${name} 应登记在 files 里`);
        const data = readFileSync(join(dir, name));
        assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, `${name} 的 sha256 必须与文件一致`);
        assert.equal(data.byteLength, entry.bytes, `${name} 的 bytes 必须与文件一致`);
      }

      if (format === 'sqlite') {
        const snapshot = new DatabaseSync(join(dir, 'siteatlas.db'), { readOnly: true });
        try {
          const nodes = snapshot.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number };
          const edges = snapshot.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number };
          assert.equal(Number(nodes.c), 4);
          assert.equal(Number(edges.c), 3);
          // 父节点是有效父节点（导出快照里没有修正层，读到的就是叠加后的结果）
          const child = snapshot.prepare('SELECT parent_id FROM nodes WHERE id = ?').get(ctx.docsId) as { parent_id: string };
          assert.equal(child.parent_id, ctx.rootId);
          const manifestTable = snapshot.prepare('SELECT json FROM manifest LIMIT 1').get() as { json: string };
          assert.equal((JSON.parse(manifestTable.json) as ExportManifest).exportId, outcome.export.id);
          const examples = snapshot.prepare('SELECT COUNT(*) AS c FROM query_examples').get() as { c: number };
          assert.ok(Number(examples.c) >= 5, '快照应带查询示例表');
        } finally {
          snapshot.close();
        }
      }
    }
  } finally {
    ctx.cleanup();
  }
});

test('M4 导出服务：非法格式 400、站点不存在 404、子树缺 nodeId 400、跨站节点 409', () => {
  const ctx = makeCtx();
  try {
    const service = new ExportService({ db: ctx.handle.db, rootDir: ctx.rootDir });
    assert.throws(
      () => service.run({ siteId: ctx.siteId, format: 'xml' as unknown as 'json' }),
      (err: Error & { code?: string }) => err.code === 'INVALID_FORMAT',
    );
    assert.throws(
      () => service.run({ siteId: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', format: 'json' }),
      (err: Error & { code?: string }) => err.code === 'SITE_NOT_FOUND',
    );
    assert.throws(
      () => service.run({ siteId: ctx.siteId, format: 'json', scope: 'subtree' }),
      (err: Error & { code?: string }) => err.code === 'NODE_ID_REQUIRED',
    );

    const other = ctx.sites.create({ name: '别的站', rootUrl: 'http://other.test/', rootHost: 'other.test', scope: 'same_site', allowlist: [] });
    assert.throws(
      () => service.run({ siteId: other.id, format: 'json', scope: 'subtree', nodeId: ctx.rootId }),
      (err: Error & { code?: string }) => err.code === 'NODE_OTHER_SITE',
    );
  } finally {
    ctx.cleanup();
  }
});
