/**
 * core/export/writers.ts —— 各格式写出器（dev-spec §6.7）
 *
 * 统一输入 = `ExportDataset`（已套用有效投影），输出 = 文件名 + 行数 + 内容；
 * 由 service 落盘并登记 sha256/bytes 到 manifest（§6.7 files 映射）。
 *
 * 约定（下游可依赖）：
 *   · graph.json —— 完整图：{ meta, nodes[], edges[] }，自描述；
 *   · nodes.jsonl —— 一行一个节点（流式，第一行是 meta，便于无 JSON 解析器时也要能读）；
 *   · edges.csv / nodes.csv —— RFC4180：逗号分隔、双引号包裹、内部引号加倍、CRLF；
 *   · siteatlas.db —— 可被任何 SQLite 工具直接打开的只读快照（含 meta 表与文档表）；
 *   · graph.mmd —— Mermaid flowchart（万级树按上限截断，并写明被截断）。
 */
import { DatabaseSync } from 'node:sqlite';
import type { ExportDataset, ExportEdge, ExportNode } from './dataset.ts';
import { closeSync, mkdtempSync, openSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface WrittenArtifact {
  name: string;
  dataset: 'nodes' | 'edges' | 'graph' | 'materials' | 'manifest' | 'sqlite';
  rows?: number;
  /** 文本内容（sqlite 为 null，直接写文件） */
  content: string | null;
  /** 非文本产物（sqlite）的磁盘来源 */
  fromFile?: string;
}

/* ---------------- CSV（RFC4180） ---------------- */

/** 转义一个 CSV 字段：含分隔符/引号/换行就加引号，内部引号加倍 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvLine(values: unknown[]): string {
  return `${values.map(csvField).join(',')}\r\n`;
}

const EDGE_COLUMNS = [
  'id',
  'from_id',
  'to_id',
  'anchor_text',
  'selector',
  'dom_path',
  'rel',
  'target',
  'is_nofollow',
  'fragment',
  'source',
  'order_in_page',
  'created_at',
] as const;

const NODE_COLUMNS = [
  'id',
  'identity_key',
  'url',
  'alias',
  'display_label',
  'title',
  'http_status',
  'content_type',
  'depth',
  'parent_id',
  'auto_parent_id',
  'status',
  'content_hash',
  'in_link_count',
  'out_link_count',
  'is_deleted',
  'has_override',
  'first_seen_at',
  'last_fetch_at',
  'materials',
] as const;

export function edgesCsv(edges: ExportEdge[]): WrittenArtifact {
  let out = csvLine([...EDGE_COLUMNS]);
  for (const edge of edges) out += csvLine(EDGE_COLUMNS.map((col) => edge[col]));
  return { name: 'edges.csv', dataset: 'edges', rows: edges.length, content: out };
}

function edgeToCsvRecord(edge: ExportEdge): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const col of EDGE_COLUMNS) record[col] = edge[col];
  return record;
}

function nodeToCsvRecord(node: ExportNode): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const col of NODE_COLUMNS) {
    record[col] = col === 'materials' ? node.materials.map((m) => m.rel_path).join(' ') : node[col];
  }
  return record;
}

export function nodesCsv(nodes: ExportNode[]): WrittenArtifact {
  let out = csvLine([...NODE_COLUMNS]);
  for (const node of nodes) out += csvLine(NODE_COLUMNS.map((col) => nodeToCsvRecord(node)[col]));
  return { name: 'nodes.csv', dataset: 'nodes', rows: nodes.length, content: out };
}

/* ---------------- JSON / JSONL ---------------- */

export function graphJson(dataset: ExportDataset): WrittenArtifact {
  const payload = {
    meta: {
      schemaVersion: '1.0',
      siteId: dataset.site.id,
      siteName: dataset.site.name,
      rootUrl: dataset.site.rootUrl,
      generatedAt: dataset.generatedAt,
      scope: dataset.scope,
      counts: dataset.counts,
      /** 下游可据此判断「父节点是有效父节点（已叠加人工修正）」 */
      projection: 'effective',
    },
    nodes: dataset.nodes.map((node) => ({ ...node })),
    edges: dataset.edges.map((edge) => edgeToCsvRecord(edge)),
  };
  return { name: 'graph.json', dataset: 'graph', rows: dataset.nodes.length, content: `${JSON.stringify(payload, null, 2)}\n` };
}

/**
 * JSONL：第一行 meta，其余一行一个节点。
 * 为什么把 meta 放进 JSONL：下游可能只有一个逐行读取器（不需要 JSON 解析整图），
 * 也能在流式读取时立刻知道 schemaVersion 与计数（§6.7 manifest 之外的冗余保险）。
 */
export function nodesJsonl(dataset: ExportDataset): WrittenArtifact {
  const lines: string[] = [
    JSON.stringify({ meta: { schemaVersion: '1.0', siteId: dataset.site.id, rootUrl: dataset.site.rootUrl, generatedAt: dataset.generatedAt, counts: dataset.counts } }),
  ];
  for (const node of dataset.nodes) lines.push(JSON.stringify(node));
  return { name: 'nodes.jsonl', dataset: 'nodes', rows: dataset.nodes.length, content: `${lines.join('\n')}\n` };
}

/**
 * 流式写出（大站用）：逐行 append，内存占用与站点规模无关。
 * 输出字节与对应的内存版**完全一致**？不保证 —— 因此这两种路径不会混用：
 * 一个导出任务要么走内存版要么走流式版，manifest 里登记的都是实际写出的字节。
 */
export function writeGraphJsonToFile(dataset: ExportDataset, path: string): { rows: number } {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, '{\n  "meta": ');
    writeSync(
      fd,
      JSON.stringify({
        schemaVersion: '1.0',
        siteId: dataset.site.id,
        siteName: dataset.site.name,
        rootUrl: dataset.site.rootUrl,
        generatedAt: dataset.generatedAt,
        scope: dataset.scope,
        counts: dataset.counts,
        projection: 'effective',
      }),
    );
    writeSync(fd, ',\n  "nodes": [\n');
    dataset.nodes.forEach((node, index) => {
      writeSync(fd, `${index === 0 ? '' : ',\n'}    ${JSON.stringify(node)}`);
    });
    writeSync(fd, '\n  ],\n  "edges": [\n');
    dataset.edges.forEach((edge, index) => {
      writeSync(fd, `${index === 0 ? '' : ',\n'}    ${JSON.stringify(edge)}`);
    });
    writeSync(fd, '\n  ]\n}\n');
  } finally {
    closeSync(fd);
  }
  return { rows: dataset.nodes.length };
}

export function writeNodesJsonlToFile(dataset: ExportDataset, path: string): { rows: number } {
  const fd = openSync(path, 'w');
  try {
    writeSync(
      fd,
      `${JSON.stringify({ meta: { schemaVersion: '1.0', siteId: dataset.site.id, rootUrl: dataset.site.rootUrl, generatedAt: dataset.generatedAt, counts: dataset.counts } })}\n`,
    );
    for (const node of dataset.nodes) writeSync(fd, `${JSON.stringify(node)}\n`);
  } finally {
    closeSync(fd);
  }
  return { rows: dataset.nodes.length };
}

export function writeEdgesCsvToFile(dataset: ExportDataset, path: string): { rows: number } {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, csvLine([...EDGE_COLUMNS]));
    for (const edge of dataset.edges) writeSync(fd, csvLine(EDGE_COLUMNS.map((col) => edge[col])));
  } finally {
    closeSync(fd);
  }
  return { rows: dataset.edges.length };
}

export function materialsJson(dataset: ExportDataset): WrittenArtifact | null {
  const rows = dataset.nodes.flatMap((node) =>
    node.materials.map((material) => ({
      node_id: node.id,
      url: node.url,
      kind: material.kind,
      rel_path: material.rel_path,
      bytes: material.bytes,
      sha256: material.sha256,
    })),
  );
  if (rows.length === 0) return null;
  return { name: 'materials.json', dataset: 'materials', rows: rows.length, content: `${JSON.stringify({ meta: { siteId: dataset.site.id, count: rows.length }, materials: rows }, null, 2)}\n` };
}

/* ---------------- Mermaid ---------------- */

export interface MermaidOptions {
  /** 最大节点数（默认 800）：万级树画成图会不可读，且 mermaid 会卡 */
  maxNodes?: number;
}

/**
 * Mermaid 树：按有效父节点组织。
 * 用 `flowchart TD` + 带引号的标签；同一父节点的子节点按 display_label 排序，
 * 保证同一份数据的两次导出产生完全相同的文本（可 diff、可做校验和）。
 */
export function mermaidTree(dataset: ExportDataset, options: MermaidOptions = {}): WrittenArtifact {
  const maxNodes = options.maxNodes ?? 800;
  const nodes = [...dataset.nodes].sort((a, b) => (a.depth - b.depth) || a.id.localeCompare(b.id));
  const kept = nodes.slice(0, maxNodes);
  const keptIds = new Set(kept.map((n) => n.id));
  const ids = new Map<string, string>();
  kept.forEach((node, index) => ids.set(node.id, `n${index + 1}`));

  const label = (node: ExportNode): string => {
    const text = node.display_label ?? node.alias ?? node.title ?? node.url;
    // 引号与方括号会破坏 mermaid 语法
    return text.replace(/"/g, "'").replace(/[[\]{}()]/g, ' ').slice(0, 60);
  };

  const lines: string[] = ['flowchart TD'];
  for (const node of kept) lines.push(`  ${ids.get(node.id) as string}["${label(node)}"]`);
  for (const node of kept) {
    if (node.parent_id === null || !keptIds.has(node.parent_id)) continue;
    lines.push(`  ${ids.get(node.parent_id) as string} --> ${ids.get(node.id) as string}`);
  }
  if (nodes.length > kept.length) {
    lines.push(`  truncated["… 另有 ${nodes.length - kept.length} 个节点未画出（上限 ${maxNodes}）"]`);
  }
  return { name: 'graph.mmd', dataset: 'nodes', rows: kept.length, content: `${lines.join('\n')}\n` };
}

/* ---------------- SQLite 快照 ---------------- */

const EXPORT_SQLITE_SCHEMA = `
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE nodes (
  id TEXT PRIMARY KEY, identity_key TEXT NOT NULL, url TEXT NOT NULL, alias TEXT, display_label TEXT, title TEXT,
  http_status INTEGER, content_type TEXT, depth INTEGER NOT NULL, parent_id TEXT, auto_parent_id TEXT,
  status TEXT NOT NULL, content_hash TEXT, in_link_count INTEGER NOT NULL, out_link_count INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL, has_override INTEGER NOT NULL, first_seen_at INTEGER NOT NULL, last_fetch_at INTEGER
);
CREATE INDEX idx_export_nodes_parent ON nodes(parent_id);
CREATE INDEX idx_export_nodes_depth  ON nodes(depth);
CREATE TABLE edges (
  id INTEGER PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, anchor_text TEXT, selector TEXT, dom_path TEXT,
  rel TEXT, target TEXT, is_nofollow INTEGER NOT NULL, fragment TEXT, source TEXT NOT NULL,
  order_in_page INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX idx_export_edges_from ON edges(from_id);
CREATE INDEX idx_export_edges_to   ON edges(to_id);
CREATE TABLE materials (
  node_id TEXT NOT NULL, kind TEXT NOT NULL, rel_path TEXT NOT NULL, bytes INTEGER, sha256 TEXT,
  PRIMARY KEY (node_id, kind, rel_path)
);
CREATE TABLE manifest (json TEXT NOT NULL);
CREATE TABLE query_examples (title TEXT NOT NULL, sql TEXT NOT NULL);
`;

const QUERY_EXAMPLES: Array<[string, string]> = [
  ['节点总数 / 边总数', "SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM edges) AS edges;"],
  ['顶层节点（父为空）', 'SELECT id, url, display_label FROM nodes WHERE parent_id IS NULL ORDER BY id;'],
  ['某节点的直接子节点', "SELECT id, display_label FROM nodes WHERE parent_id = '<nodeId>' ORDER BY display_label;"],
  ['某节点的入链（谁指向它）', "SELECT e.from_id, n.url AS from_url, e.anchor_text FROM edges e JOIN nodes n ON n.id = e.from_id WHERE e.to_id = '<nodeId>';"],
  [
    '整棵子树（递归）',
    "WITH RECURSIVE sub(id, depth) AS (SELECT '<nodeId>', 0 UNION ALL SELECT n.id, sub.depth + 1 FROM nodes n JOIN sub ON n.parent_id = sub.id) SELECT * FROM sub;",
  ],
  ['最深的前 10 个节点', 'SELECT id, url, depth FROM nodes ORDER BY depth DESC, id LIMIT 10;'],
];

/**
 * 只读 SQLite 快照：写一张与导出范围完全一致的库，外加 meta/manifest/query_examples 三张说明表。
 * 实现方式：另开一个临时库，用同一份 dataset 逐行插入（不用 ATTACH 复制主库），
 * 这样「导出范围」与其它格式天然一致，也不会把主库的 WAL/内部表带出去。
 */
export function sqliteSnapshot(
  dataset: ExportDataset,
  input: { exportId: string; manifest: unknown },
): WrittenArtifact {
  const dir = mkdtempSync(join(tmpdir(), 'siteatlas-export-'));
  const file = join(dir, 'siteatlas.db');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=DELETE;');
    db.exec(EXPORT_SQLITE_SCHEMA);

    const insertNode = db.prepare(
      `INSERT INTO nodes (id, identity_key, url, alias, display_label, title, http_status, content_type, depth,
                          parent_id, auto_parent_id, status, content_hash, in_link_count, out_link_count,
                          is_deleted, has_override, first_seen_at, last_fetch_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const node of dataset.nodes) {
      insertNode.run(
        node.id,
        node.identity_key,
        node.url,
        node.alias,
        node.display_label,
        node.title,
        node.http_status,
        node.content_type,
        node.depth,
        node.parent_id,
        node.auto_parent_id,
        node.status,
        node.content_hash,
        node.in_link_count,
        node.out_link_count,
        node.is_deleted ? 1 : 0,
        node.has_override ? 1 : 0,
        node.first_seen_at,
        node.last_fetch_at,
      );
    }

    const insertEdge = db.prepare(
      `INSERT INTO edges (id, from_id, to_id, anchor_text, selector, dom_path, rel, target, is_nofollow, fragment,
                          source, order_in_page, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const edge of dataset.edges) {
      insertEdge.run(
        edge.id,
        edge.from_id,
        edge.to_id,
        edge.anchor_text,
        edge.selector,
        edge.dom_path,
        edge.rel,
        edge.target,
        edge.is_nofollow ? 1 : 0,
        edge.fragment,
        edge.source,
        edge.order_in_page,
        edge.created_at,
      );
    }

    const insertMaterial = db.prepare('INSERT INTO materials (node_id, kind, rel_path, bytes, sha256) VALUES (?, ?, ?, ?, ?)');
    for (const node of dataset.nodes) {
      for (const material of node.materials) {
        insertMaterial.run(node.id, material.kind, material.rel_path, material.bytes, material.sha256);
      }
    }

    const insertMeta = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)');
    for (const [k, v] of Object.entries({
      schema_version: '1.0',
      export_id: input.exportId,
      site_id: dataset.site.id,
      site_name: dataset.site.name,
      root_url: dataset.site.rootUrl,
      generated_at: String(dataset.generatedAt),
      nodes: String(dataset.counts.nodes),
      edges: String(dataset.counts.edges),
      materials: String(dataset.counts.materials),
      projection: 'effective',
    })) {
      insertMeta.run(k, v);
    }

    db.prepare('INSERT INTO manifest (json) VALUES (?)').run(JSON.stringify(input.manifest));
    const insertExample = db.prepare('INSERT INTO query_examples (title, sql) VALUES (?, ?)');
    for (const [title, sql] of QUERY_EXAMPLES) insertExample.run(title, sql);
  } finally {
    db.close();
  }
  return { name: 'siteatlas.db', dataset: 'sqlite', rows: dataset.nodes.length, content: null, fromFile: file };
}

export function sqliteQueryExamples(): Array<[string, string]> {
  return QUERY_EXAMPLES.map(([title, sql]) => [title, sql]);
}
