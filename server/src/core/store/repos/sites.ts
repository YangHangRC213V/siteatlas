/**
 * 站点仓储（dev-spec §4 sites 表 / §5.1 /api/sites）
 *
 * 所有写操作保持 `updated_at` 同步；删除一律软删（archived=1），
 * 同时把该站节点标记 is_deleted=1（requirements §3「删根 = 删整站」）。
 */
import type { SiteScope, SiteRecord, SiteCardStats, NodeStatus, UpdateSiteRequest } from '@siteatlas/shared';
import type { DatabaseSync } from 'node:sqlite';
import { nowSec, ulid } from '../ids.ts';

type Row = Record<string, unknown>;

function toSite(row: Row): SiteRecord {
  return {
    id: String(row['id']),
    name: String(row['name']),
    root_url: String(row['root_url']),
    root_host: String(row['root_host']),
    scope: row['scope'] as SiteScope,
    allowlist_json: String(row['allowlist_json']),
    created_at: Number(row['created_at']),
    updated_at: Number(row['updated_at']),
    archived: Number(row['archived']),
    note: (row['note'] as string | null) ?? null,
  };
}

const STATS_SQL = `
  (SELECT COUNT(*) FROM nodes n WHERE n.site_id = s.id AND n.is_deleted = 0) AS node_count,
  (SELECT COUNT(*) FROM nodes n WHERE n.site_id = s.id AND n.is_deleted = 0 AND n.status = 'ok') AS ok_count,
  (SELECT COUNT(*) FROM nodes n WHERE n.site_id = s.id AND n.is_deleted = 0 AND n.status = 'error') AS error_count,
  (SELECT COALESCE(MAX(n.depth), 0) FROM nodes n WHERE n.site_id = s.id AND n.is_deleted = 0) AS max_depth,
  (SELECT MAX(n.last_fetch_at) FROM nodes n WHERE n.site_id = s.id) AS last_fetch_at,
  (SELECT n.status FROM nodes n WHERE n.site_id = s.id AND n.auto_parent_id IS NULL ORDER BY n.depth ASC, n.first_seen_at ASC LIMIT 1) AS root_status
`;

function toStats(row: Row): SiteCardStats {
  return {
    nodeCount: Number(row['node_count'] ?? 0),
    rootStatus: (row['root_status'] as NodeStatus | null) ?? null,
    okCount: Number(row['ok_count'] ?? 0),
    errorCount: Number(row['error_count'] ?? 0),
    maxDepth: Number(row['max_depth'] ?? 0),
    lastFetchAt: row['last_fetch_at'] === null || row['last_fetch_at'] === undefined ? null : Number(row['last_fetch_at']),
  };
}

export interface CreateSiteInput {
  name: string;
  rootUrl: string;
  rootHost: string;
  scope: SiteScope;
  allowlist: string[];
  note?: string | null;
  id?: string;
}

export class SitesRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** 建站（不建根节点，根节点由 NodesRepo 负责，保证调用方在同一事务语义下组合） */
  create(input: CreateSiteInput): SiteRecord {
    const ts = nowSec();
    const id = input.id ?? ulid();
    this.db
      .prepare(
        `INSERT INTO sites (id, name, root_url, root_host, scope, allowlist_json, created_at, updated_at, archived, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        id,
        input.name,
        input.rootUrl,
        input.rootHost,
        input.scope,
        JSON.stringify(input.allowlist ?? []),
        ts,
        ts,
        input.note ?? null,
      );
    const site = this.get(id);
    if (site === null) throw new Error(`建站后读取失败：${id}`);
    return site;
  }

  get(id: string): SiteRecord | null {
    const row = this.db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : toSite(row);
  }

  /** 卡片列表：默认排除已归档站点（?archived=1 可查看回收站） */
  list(options: { includeArchived?: boolean; archivedOnly?: boolean } = {}): Array<{ site: SiteRecord; stats: SiteCardStats }> {
    const where = options.archivedOnly ? 'WHERE s.archived = 1' : options.includeArchived ? '' : 'WHERE s.archived = 0';
    const rows = this.db
      .prepare(`SELECT s.*, ${STATS_SQL} FROM sites s ${where} ORDER BY s.updated_at DESC, s.id DESC`)
      .all() as Row[];
    return rows.map((row) => ({ site: toSite(row), stats: toStats(row) }));
  }

  stats(id: string): SiteCardStats {
    const row = this.db.prepare(`SELECT ${STATS_SQL} FROM sites s WHERE s.id = ?`).get(id) as Row | undefined;
    return row === undefined ? toStats({}) : toStats(row);
  }

  update(id: string, patch: UpdateSiteRequest): SiteRecord | null {
    const current = this.get(id);
    if (current === null) return null;

    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      values.push(patch.name);
    }
    if (patch.scope !== undefined) {
      sets.push('scope = ?');
      values.push(patch.scope);
    }
    if (patch.allowlist !== undefined) {
      sets.push('allowlist_json = ?');
      values.push(JSON.stringify(patch.allowlist));
    }
    if (patch.archived !== undefined) {
      sets.push('archived = ?');
      values.push(patch.archived ? 1 : 0);
    }
    if (patch.note !== undefined) {
      sets.push('note = ?');
      values.push(patch.note);
    }
    if (sets.length === 0) return current;

    sets.push('updated_at = ?');
    values.push(nowSec());
    values.push(id);
    this.db.prepare(`UPDATE sites SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  /** 软删整站：sites.archived=1 且该站节点 is_deleted=1，返回受影响节点数 */
  softDelete(id: string): { site: SiteRecord; affectedNodes: number } | null {
    const site = this.get(id);
    if (site === null) return null;
    const res = this.db
      .prepare('UPDATE nodes SET is_deleted = 1 WHERE site_id = ? AND is_deleted = 0')
      .run(id);
    this.db
      .prepare('UPDATE sites SET archived = 1, updated_at = ? WHERE id = ?')
      .run(nowSec(), id);
    const updated = this.get(id);
    if (updated === null) return null;
    return { site: updated, affectedNodes: Number(res.changes ?? 0) };
  }

  /** 恢复软删站点（回收站） */
  restore(id: string): SiteRecord | null {
    const site = this.get(id);
    if (site === null) return null;
    this.db.prepare('UPDATE nodes SET is_deleted = 0 WHERE site_id = ?').run(id);
    this.db.prepare('UPDATE sites SET archived = 0, updated_at = ? WHERE id = ?').run(nowSec(), id);
    return this.get(id);
  }
}
