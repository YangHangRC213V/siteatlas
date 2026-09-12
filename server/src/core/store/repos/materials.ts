/**
 * core/store/repos/materials.ts —— 素材登记（dev-spec §4 materials / §6.7 三档数据）
 *
 * 三档数据分层：
 *   · 结构（nodes/edges）→ 数据库；
 *   · 原件 raw/         → `kind='html'`（浏览器渲染的页面存存档 HTML）、`kind='attachment'`（M5+）；
 *   · 解析 parsed/      → `kind='body'`（正文文本）、`kind='screenshot'`（M5+）。
 * `rel_path` 一律相对 `data/sites/<siteId>/`，与 §4 注释一致。
 *
 * 幂等：同一 (node_id, kind, rel_path) 重复登记时覆盖 bytes/sha256，不产生重复行——
 * 断点续爬重抓同一页时不希望素材清单里出现两条同样的记录。
 */
import type { MaterialKind, MaterialRecord } from '@siteatlas/shared';
import type { DatabaseSync } from 'node:sqlite';
import { nowSec } from '../ids.ts';

type Row = Record<string, unknown>;

function toMaterial(row: Row): MaterialRecord {
  return {
    id: Number(row['id']),
    site_id: String(row['site_id']),
    node_id: String(row['node_id']),
    kind: row['kind'] as MaterialKind,
    rel_path: String(row['rel_path']),
    bytes: row['bytes'] === null || row['bytes'] === undefined ? null : Number(row['bytes']),
    sha256: (row['sha256'] as string | null) ?? null,
    created_at: Number(row['created_at']),
  };
}

export interface UpsertMaterialInput {
  siteId: string;
  nodeId: string;
  kind: MaterialKind;
  relPath: string;
  bytes: number | null;
  sha256: string | null;
}

export class MaterialsRepo {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  upsert(input: UpsertMaterialInput): MaterialRecord {
    const existing = this.db
      .prepare('SELECT id FROM materials WHERE node_id = ? AND kind = ? AND rel_path = ? LIMIT 1')
      .get(input.nodeId, input.kind, input.relPath) as Row | undefined;
    if (existing !== undefined) {
      this.db
        .prepare('UPDATE materials SET bytes = ?, sha256 = ? WHERE id = ?')
        .run(input.bytes, input.sha256, Number(existing['id']));
      return this.get(Number(existing['id'])) as MaterialRecord;
    }
    const res = this.db
      .prepare(
        `INSERT INTO materials (site_id, node_id, kind, rel_path, bytes, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.siteId, input.nodeId, input.kind, input.relPath, input.bytes, input.sha256, nowSec());
    return this.get(Number(res.lastInsertRowid)) as MaterialRecord;
  }

  get(id: number): MaterialRecord | null {
    const row = this.db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : toMaterial(row);
  }

  /** 素材清单（§5.1 /api/sites/:id/materials，可按 nodeId / kind 过滤） */
  list(siteId: string, options: { nodeId?: string; kind?: MaterialKind; limit?: number } = {}): MaterialRecord[] {
    const where: string[] = ['site_id = ?'];
    const args: Array<string | number> = [siteId];
    if (options.nodeId !== undefined) {
      where.push('node_id = ?');
      args.push(options.nodeId);
    }
    if (options.kind !== undefined) {
      where.push('kind = ?');
      args.push(options.kind);
    }
    const rows = this.db
      .prepare(`SELECT * FROM materials WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`)
      .all(...args, Math.min(options.limit ?? 500, 5000)) as Row[];
    return rows.map((r) => toMaterial(r));
  }

  countForSite(siteId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM materials WHERE site_id = ?').get(siteId) as Row;
    return Number(row['c'] ?? 0);
  }

  /** 导出用：把 (node_id, kind) → rel_path 摊平成一张表，避免导出时逐节点查库 */
  mapForSite(siteId: string): Map<string, MaterialRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM materials WHERE site_id = ? ORDER BY node_id, kind, id')
      .all(siteId) as Row[];
    const out = new Map<string, MaterialRecord[]>();
    for (const row of rows) {
      const record = toMaterial(row);
      const list = out.get(record.node_id);
      if (list === undefined) out.set(record.node_id, [record]);
      else list.push(record);
    }
    return out;
  }
}
