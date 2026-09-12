/**
 * 节点仓储（dev-spec §4 nodes / v_nodes_effective 视图）
 *
 * M0 只落地「建根节点」与「按站点取根 / 统计」这几条路径；
 * 子树懒加载、重挂、软删子树属于 M2（§7 里程碑），此处仅提供 v_nodes_effective 的读取入口。
 */
import type { NodeRecord, NodeStatus } from '@siteatlas/shared';
import type { DatabaseSync } from 'node:sqlite';
import { nowSec, ulid } from '../ids.ts';

type Row = Record<string, unknown>;

/** 表列 → 契约字段（列名逐字一致，此处仅做类型收敛） */
export function toNode(row: Row): NodeRecord & { effective_parent_id?: string | null; has_override?: number } {
  const node: NodeRecord = {
    id: String(row['id']),
    site_id: String(row['site_id']),
    identity_key: String(row['identity_key']),
    url: String(row['url']),
    alias: (row['alias'] as string | null) ?? null,
    display_label: (row['display_label'] as string | null) ?? null,
    title: (row['title'] as string | null) ?? null,
    http_status: row['http_status'] === null || row['http_status'] === undefined ? null : Number(row['http_status']),
    content_type: (row['content_type'] as string | null) ?? null,
    depth: Number(row['depth']),
    auto_parent_id: (row['auto_parent_id'] as string | null) ?? null,
    status: row['status'] as NodeStatus,
    content_hash: (row['content_hash'] as string | null) ?? null,
    in_link_count: Number(row['in_link_count'] ?? 0),
    out_link_count: Number(row['out_link_count'] ?? 0),
    is_deleted: Number(row['is_deleted'] ?? 0),
    first_seen_at: Number(row['first_seen_at']),
    last_fetch_at:
      row['last_fetch_at'] === null || row['last_fetch_at'] === undefined ? null : Number(row['last_fetch_at']),
  };
  if ('effective_parent_id' in row) {
    (node as { effective_parent_id?: string | null }).effective_parent_id =
      (row['effective_parent_id'] as string | null) ?? null;
  }
  if ('has_override' in row) (node as { has_override?: number }).has_override = Number(row['has_override'] ?? 0);
  return node;
}

export interface CreateRootNodeInput {
  siteId: string;
  url: string;
  identityKey: string;
  displayLabel: string;
  status: NodeStatus;
  httpStatus?: number | null;
  contentType?: string | null;
  title?: string | null;
  id?: string;
}

export class NodesRepo {
  private readonly db: DatabaseSync;

  // 同上：不使用参数属性，保持 Node 原生 TS 剥离可运行
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 建根节点：depth=0、auto_parent_id=NULL（requirements §4.1「当前页即根节点」） */
  createRoot(input: CreateRootNodeInput): NodeRecord {
    const ts = nowSec();
    const id = input.id ?? ulid();
    const fetchedAt = input.status === 'queued' ? null : ts;
    this.db
      .prepare(
        `INSERT INTO nodes (id, site_id, identity_key, url, alias, display_label, title,
                            http_status, content_type, depth, auto_parent_id, status,
                            content_hash, in_link_count, out_link_count, is_deleted,
                            first_seen_at, last_fetch_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, NULL, ?, NULL, 0, 0, 0, ?, ?)`,
      )
      .run(
        id,
        input.siteId,
        input.identityKey,
        input.url,
        input.displayLabel,
        input.title ?? null,
        input.httpStatus ?? null,
        input.contentType ?? null,
        input.status,
        ts,
        fetchedAt,
      );
    const node = this.get(id);
    if (node === null) throw new Error(`建根节点后读取失败：${id}`);
    return node;
  }

  get(id: string): NodeRecord | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : toNode(row);
  }

  findByUrl(siteId: string, url: string): NodeRecord | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE site_id = ? AND url = ?').get(siteId, url) as Row | undefined;
    return row === undefined ? null : toNode(row);
  }

  findByUrlForSite(siteId: string, url: string, identityKey: string): NodeRecord | null {
    const byIdentity = this.db
      .prepare('SELECT * FROM nodes WHERE site_id = ? AND identity_key = ?')
      .get(siteId, identityKey) as Row | undefined;
    if (byIdentity !== undefined) return toNode(byIdentity);
    return this.findByUrl(siteId, url);
  }

  /** 站点根节点（auto_parent_id 为空且未被软删的节点） */
  root(siteId: string): NodeRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM nodes
         WHERE site_id = ? AND auto_parent_id IS NULL AND is_deleted = 0
         ORDER BY depth ASC, first_seen_at ASC LIMIT 1`,
      )
      .get(siteId) as Row | undefined;
    return row === undefined ? null : toNode(row);
  }

  count(siteId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM nodes WHERE site_id = ? AND is_deleted = 0')
      .get(siteId) as Row;
    return Number(row['c'] ?? 0);
  }

  /**
   * 按有效父节点（视图投影：auto_parent_id 叠加最新未撤销 override）懒加载直接子节点。
   * M2 的树视图直接复用，M0 只用于自检视图可查。
   */
  childrenOf(siteId: string, parentId: string | null, offset = 0, limit = 200): NodeRecord[] {
    const rows = (
      parentId === null
        ? this.db
            .prepare(
              `SELECT v.*, (SELECT COUNT(*) FROM node_overrides o
                            WHERE o.node_id = v.id AND o.field = 'parent' AND o.undone = 0) AS has_override
               FROM v_nodes_effective v
               WHERE v.site_id = ? AND v.effective_parent_id IS NULL AND v.is_deleted = 0
               ORDER BY v.id LIMIT ? OFFSET ?`,
            )
            .all(siteId, limit, offset)
        : this.db
            .prepare(
              `SELECT v.*, (SELECT COUNT(*) FROM node_overrides o
                            WHERE o.node_id = v.id AND o.field = 'parent' AND o.undone = 0) AS has_override
               FROM v_nodes_effective v
               WHERE v.site_id = ? AND v.effective_parent_id = ? AND v.is_deleted = 0
               ORDER BY v.id LIMIT ? OFFSET ?`,
            )
            .all(siteId, parentId, limit, offset)
    ) as Row[];
    return rows.map((r) => toNode(r));
  }

  countChildren(siteId: string, parentId: string | null): number {
    const row = (
      parentId === null
        ? this.db
            .prepare(
              `SELECT COUNT(*) AS c FROM v_nodes_effective
               WHERE site_id = ? AND effective_parent_id IS NULL AND is_deleted = 0`,
            )
            .get(siteId)
        : this.db
            .prepare(
              `SELECT COUNT(*) AS c FROM v_nodes_effective
               WHERE site_id = ? AND effective_parent_id = ? AND is_deleted = 0`,
            )
            .get(siteId, parentId)
    ) as Row;
    return Number(row['c'] ?? 0);
  }
}
