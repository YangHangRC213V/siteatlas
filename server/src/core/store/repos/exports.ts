/**
 * core/store/repos/exports.ts —— 导出任务登记（dev-spec §4 exports / §5.1 / §6.7）
 *
 * §4 的 8 个字段（id/site_id/format/scope_json/dir/status/manifest_path/created_at）保持原义，
 * 迁移 004 追加了 site_name/root_url/preset_id/counts_json/error/finished_at 六个实现字段
 * （见 DECISIONS.md M4）。
 *
 * 状态机：pending → running → done | failed（同步导出，但状态仍落库，便于失败可查）。
 */
import type { ExportRecord } from '@siteatlas/shared';
import type { DatabaseSync } from 'node:sqlite';
import { nowSec } from '../ids.ts';

type Row = Record<string, unknown>;

const NULLABLE_STRINGS = ['site_name', 'root_url', 'preset_id', 'dir', 'manifest_path', 'scope_json', 'counts_json', 'error'] as const;

function toExport(row: Row): ExportRecord {
  const out: Record<string, unknown> = {
    id: String(row['id']),
    site_id: (row['site_id'] as string | null) ?? null,
    format: String(row['format']),
    status: String(row['status']),
    created_at: Number(row['created_at']),
    finished_at: row['finished_at'] === null || row['finished_at'] === undefined ? null : Number(row['finished_at']),
  };
  for (const key of NULLABLE_STRINGS) out[key] = (row[key] as string | null) ?? null;
  return out as unknown as ExportRecord;
}

export interface CreateExportInput {
  id: string;
  siteId: string;
  siteName: string;
  rootUrl: string;
  format: string;
  scopeJson: string;
  presetId: string | null;
  dir: string;
}

export class ExportsRepo {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(input: CreateExportInput): ExportRecord {
    this.db
      .prepare(
        `INSERT INTO exports (id, site_id, format, scope_json, dir, status, manifest_path, created_at,
                              site_name, root_url, preset_id, counts_json, error, finished_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        input.id,
        input.siteId,
        input.format,
        input.scopeJson,
        input.dir,
        nowSec(),
        input.siteName,
        input.rootUrl,
        input.presetId,
      );
    return this.get(input.id) as ExportRecord;
  }

  get(id: string): ExportRecord | null {
    const row = this.db.prepare('SELECT * FROM exports WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : toExport(row);
  }

  list(siteId: string, limit = 50): ExportRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM exports WHERE site_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(siteId, limit) as Row[];
    return rows.map((r) => toExport(r));
  }

  markRunning(id: string): void {
    this.db.prepare("UPDATE exports SET status = 'running' WHERE id = ?").run(id);
  }

  markDone(id: string, input: { manifestPath: string; countsJson: string }): void {
    this.db
      .prepare("UPDATE exports SET status = 'done', manifest_path = ?, counts_json = ?, error = NULL, finished_at = ? WHERE id = ?")
      .run(input.manifestPath, input.countsJson, nowSec(), id);
  }

  markFailed(id: string, error: string): void {
    this.db
      .prepare("UPDATE exports SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(error.slice(0, 2000), nowSec(), id);
  }
}
