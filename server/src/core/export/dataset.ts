/**
 * core/export/dataset.ts —— 导出数据集投影（dev-spec §6.7）
 *
 * 导出的「一个站点的结构层」= 有效投影（自动层叠加修正层，§6.4）里的节点 + 过滤后的边。
 * 关键约定：
 *   · 一律走 `effectiveProjection()`：下游拿到的父节点就是用户看到的父节点，
 *     而不是自动层里那个被重挂覆盖掉的旧值；
 *   · **软删节点默认不导出**（它们在回收站里），但要计数并在 manifest 里说明；
 *     `includeDeleted=true` 时导出且带 `_deleted: true` 标记；
 *   · 边只保留两端都在导出集合内的（子树导出时不能把外部的边带出去）。
 */
import { effectiveProjection, hasOverrideExpr } from '../store/effective.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { EdgeSource, MaterialKind } from '@siteatlas/shared';

type Row = Record<string, unknown>;

/** 导出用节点行（结构层 + 展示层字段，字段名与 §4 nodes 表对齐） */
export interface ExportNode {
  id: string;
  identity_key: string;
  url: string;
  alias: string | null;
  display_label: string | null;
  title: string | null;
  http_status: number | null;
  content_type: string | null;
  depth: number;
  parent_id: string | null;
  auto_parent_id: string | null;
  status: string;
  content_hash: string | null;
  in_link_count: number;
  out_link_count: number;
  is_deleted: boolean;
  has_override: boolean;
  first_seen_at: number;
  last_fetch_at: number | null;
  /** 素材（raw/parsed 层）——按 nodeId 关联，§4.6「按 nodeId 关联」 */
  materials: Array<{ kind: MaterialKind; rel_path: string; bytes: number | null; sha256: string | null }>;
}

/** 导出用边行（字段名与 §4 edges 表对齐） */
export interface ExportEdge {
  id: number;
  from_id: string;
  to_id: string;
  anchor_text: string | null;
  selector: string | null;
  dom_path: string | null;
  rel: string | null;
  target: string | null;
  is_nofollow: boolean;
  fragment: string | null;
  source: EdgeSource;
  order_in_page: number | null;
  created_at: number;
}

export interface ExportDataset {
  site: { id: string; name: string; rootUrl: string; rootHost: string; scope: string; note: string | null; createdAt: number; updatedAt: number };
  generatedAt: number;
  nodes: ExportNode[];
  edges: ExportEdge[];
  counts: { nodes: number; edges: number; materials: number; deleted: number };
  scope: { kind: 'site' | 'subtree' | 'all'; nodeId: string | null; includeDeleted: boolean };
}

export interface BuildDatasetOptions {
  db: DatabaseSync;
  siteId: string;
  /** 子树导出的根节点；null = 整站 */
  subtreeRootId?: string | null;
  includeDeleted?: boolean;
  now?: () => number;
}

/** 子树节点集合（在有效投影上做递归 CTE，§4「子树查询」） */
function subtreeIds(db: DatabaseSync, siteId: string, rootId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT ? 
         UNION
         SELECT v.id FROM v_nodes_effective v JOIN sub ON v.effective_parent_id = sub.id
         WHERE v.site_id = ?
       )
       SELECT id FROM sub`,
    )
    .all(rootId, siteId) as Row[];
  return rows.map((r) => String(r['id']));
}

export function buildDataset(options: BuildDatasetOptions): ExportDataset {
  const { db, siteId } = options;
  const includeDeleted = options.includeDeleted ?? false;
  const now = options.now ?? (() => Date.now());

  const siteRow = db
    .prepare('SELECT id, name, root_url, root_host, scope, note, created_at, updated_at FROM sites WHERE id = ?')
    .get(siteId) as Row | undefined;
  if (siteRow === undefined) throw new Error(`站点不存在：${siteId}`);

  const allowed: Set<string> | null =
    options.subtreeRootId === undefined || options.subtreeRootId === null
      ? null
      : new Set(subtreeIds(db, siteId, options.subtreeRootId));

  const nodeRows = db
    .prepare(
      `SELECT t.* FROM (
         SELECT ${effectiveProjection('v')}, ${hasOverrideExpr('v')} AS has_override
         FROM v_nodes_effective v WHERE v.site_id = ?
       ) t
       ORDER BY t.depth ASC, t.id ASC`,
    )
    .all(siteId) as Row[];

  // 素材：(node_id → 记录[]) 一次查出，避免导出 N 个节点查 N 次
  const materialRows = db
    .prepare('SELECT node_id, kind, rel_path, bytes, sha256 FROM materials WHERE site_id = ? ORDER BY node_id, kind, id')
    .all(siteId) as Row[];
  const materialsByNode = new Map<string, ExportNode['materials']>();
  for (const row of materialRows) {
    const nodeId = String(row['node_id']);
    const list = materialsByNode.get(nodeId) ?? [];
    list.push({
      kind: row['kind'] as MaterialKind,
      rel_path: String(row['rel_path']),
      bytes: row['bytes'] === null || row['bytes'] === undefined ? null : Number(row['bytes']),
      sha256: (row['sha256'] as string | null) ?? null,
    });
    materialsByNode.set(nodeId, list);
  }

  const nodes: ExportNode[] = [];
  let deletedCount = 0;
  for (const row of nodeRows) {
    const isDeleted = Number(row['is_deleted'] ?? 0) === 1;
    if (isDeleted) deletedCount += 1;
    if (isDeleted && !includeDeleted) continue;
    const id = String(row['id']);
    if (allowed !== null && !allowed.has(id)) continue;
    nodes.push({
      id,
      identity_key: String(row['identity_key']),
      url: String(row['url']),
      alias: (row['alias'] as string | null) ?? null,
      display_label: (row['display_label'] as string | null) ?? null,
      title: (row['title'] as string | null) ?? null,
      http_status: row['http_status'] === null || row['http_status'] === undefined ? null : Number(row['http_status']),
      content_type: (row['content_type'] as string | null) ?? null,
      depth: Number(row['depth'] ?? 0),
      parent_id: (row['effective_parent_id'] as string | null) ?? null,
      auto_parent_id: (row['auto_parent_id'] as string | null) ?? null,
      status: String(row['status']),
      content_hash: (row['content_hash'] as string | null) ?? null,
      in_link_count: Number(row['in_link_count'] ?? 0),
      out_link_count: Number(row['out_link_count'] ?? 0),
      is_deleted: isDeleted,
      has_override: Number(row['has_override'] ?? 0) > 0,
      first_seen_at: Number(row['first_seen_at'] ?? 0),
      last_fetch_at: row['last_fetch_at'] === null || row['last_fetch_at'] === undefined ? null : Number(row['last_fetch_at']),
      materials: materialsByNode.get(id) ?? [],
    });
  }

  const includedIds = new Set(nodes.map((n) => n.id));
  const edgeRows = db.prepare('SELECT * FROM edges WHERE site_id = ? ORDER BY id').all(siteId) as Row[];
  const edges: ExportEdge[] = [];
  for (const row of edgeRows) {
    const fromId = String(row['from_id']);
    const toId = String(row['to_id']);
    if (!includedIds.has(fromId) || !includedIds.has(toId)) continue;
    edges.push({
      id: Number(row['id']),
      from_id: fromId,
      to_id: toId,
      anchor_text: (row['anchor_text'] as string | null) ?? null,
      selector: (row['selector'] as string | null) ?? null,
      dom_path: (row['dom_path'] as string | null) ?? null,
      rel: (row['rel'] as string | null) ?? null,
      target: (row['target'] as string | null) ?? null,
      is_nofollow: Number(row['is_nofollow'] ?? 0) === 1,
      fragment: (row['fragment'] as string | null) ?? null,
      source: row['source'] as EdgeSource,
      order_in_page: row['order_in_page'] === null || row['order_in_page'] === undefined ? null : Number(row['order_in_page']),
      created_at: Number(row['created_at'] ?? 0),
    });
  }

  const materialsExported = nodes.reduce((sum, node) => sum + node.materials.length, 0);

  return {
    site: {
      id: String(siteRow['id']),
      name: String(siteRow['name']),
      rootUrl: String(siteRow['root_url']),
      rootHost: String(siteRow['root_host']),
      scope: String(siteRow['scope']),
      note: (siteRow['note'] as string | null) ?? null,
      createdAt: Number(siteRow['created_at'] ?? 0),
      updatedAt: Number(siteRow['updated_at'] ?? 0),
    },
    generatedAt: now(),
    nodes,
    edges,
    counts: { nodes: nodes.length, edges: edges.length, materials: materialsExported, deleted: deletedCount },
    scope: {
      kind: options.subtreeRootId === undefined || options.subtreeRootId === null ? 'site' : 'subtree',
      nodeId: options.subtreeRootId ?? null,
      includeDeleted,
    },
  };
}
