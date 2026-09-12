/**
 * core/settings/service.ts —— 全局设置与导出预设（导航「设置」模块）
 *
 * 两件事：
 *   1. **全局默认采集参数**：抓取时若调用方没显式传值，就用这里的默认（§4.7 的
 *      「默认限速 ≥1s/请求、默认并发 5、UA 可配置」正是这些默认值）。
 *   2. **导出预设**：requirements §4.6 要求「保存常用格式/字段/过滤条件，一键复用」，
 *      存在 §4 的 `presets` 表（`kind='export'`）。
 *
 * 校验一律走 `normalizeSetting()`：非法值整体拒绝，不写库（避免「半套设置生效」）。
 */
import type { AppSettings, CrawlPreset, ExportPreset, ExportPresetPayload, SettingFieldDef } from '@siteatlas/shared';
import { DEFAULT_CRAWL_PRESET, EXPORT_FORMATS, EXPORT_SCOPES, SETTING_FIELDS } from '@siteatlas/shared';
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '../store/ids.ts';
import { SettingsRepo, normalizeSetting, withDefaults } from '../store/repos/settings.ts';

export class SettingsError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;
  constructor(code: string, message: string, status: number, detail?: unknown) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

type Row = Record<string, unknown>;

interface PresetRow {
  id: string;
  name: string | null;
  payload_json: string | null;
  is_default: number;
  created_at?: number;
}

export interface SettingsServiceDeps {
  db: DatabaseSync;
}

export class SettingsService {
  private readonly db: DatabaseSync;
  private readonly repo: SettingsRepo;

  constructor(deps: SettingsServiceDeps) {
    this.db = deps.db;
    this.repo = new SettingsRepo(deps.db);
  }

  fields(): readonly SettingFieldDef[] {
    return SETTING_FIELDS;
  }

  /** 全部设置（缺失项补默认值） */
  get(): AppSettings {
    return withDefaults(SETTING_FIELDS, this.repo.all());
  }

  /**
   * 批量更新：先全量校验，全部通过才写库（事务内）。
   * 未知键直接拒绝：安静忽略会让人以为设置生效了。
   */
  update(patch: Record<string, unknown>): AppSettings {
    const known = new Map(SETTING_FIELDS.map((f) => [f.key, f]));
    const normalized: Record<string, number | boolean | string | string[]> = {};
    for (const [key, raw] of Object.entries(patch)) {
      const field = known.get(key);
      if (field === undefined) throw new SettingsError('UNKNOWN_SETTING', `未知的设置项：${key}`, 400);
      const result = normalizeSetting(field, raw);
      if (!result.ok) {
        throw new SettingsError('INVALID_SETTING', `设置项 ${field.label}（${key}）不合法：${result.error.message}`, 400, result.error);
      }
      normalized[key] = result.value;
    }
    this.db.exec('BEGIN');
    try {
      this.repo.putMany(normalized);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.get();
  }

  /** 恢复默认：删掉所有落在设置表里的行 */
  reset(): AppSettings {
    this.db.exec('BEGIN');
    try {
      for (const field of SETTING_FIELDS) this.repo.remove(field.key);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.get();
  }

  /**
   * 由全局设置算出「默认抓取预设」：只覆盖设置里标记为 `inPreset` 的字段，
   * 其余沿用 §6.3 的内置默认（深度/页数等护栏不会被设置项悄悄放宽）。
   */
  crawlFallback(): CrawlPreset {
    const settings = this.get();
    const fallback: CrawlPreset = { ...DEFAULT_CRAWL_PRESET };
    for (const field of SETTING_FIELDS) {
      if (!field.inPreset) continue;
      const key = (field.presetKey ?? field.key) as keyof CrawlPreset;
      const value = settings[field.key];
      if (value === undefined) continue;
      // 只写类型匹配的值：设置表里的类型由 normalizeSetting 保证，这里再兜一次底
      if (typeof fallback[key] === typeof value) {
        (fallback as unknown as Record<string, unknown>)[key as string] = value;
      }
    }
    return fallback;
  }

  /** 素材归档是否开启（采集时决定是否写 parsed/） */
  archiveMaterials(): boolean {
    return this.get()['archiveMaterials'] !== false;
  }

  /* ---------------- 导出预设（§4 presets 表，kind='export'） ---------------- */

  listExportPresets(): ExportPreset[] {
    const rows = this.db
      .prepare("SELECT id, name, payload_json, is_default, created_at FROM presets WHERE kind = 'export' ORDER BY is_default DESC, created_at DESC, id DESC")
      .all() as Row[];
    return rows.flatMap((row) => {
      const preset = this.toPreset(row as unknown as PresetRow);
      return preset === null ? [] : [preset];
    });
  }

  createExportPreset(input: { name?: unknown; payload?: unknown; isDefault?: unknown }): ExportPreset {
    const name = typeof input.name === 'string' && input.name.trim().length > 0 ? input.name.trim().slice(0, 60) : null;
    if (name === null) throw new SettingsError('INVALID_PRESET', '预设需要一个名字', 400);
    const payload = this.normalizePresetPayload(input.payload);
    const isDefault = input.isDefault === true ? 1 : 0;
    const id = ulid();
    const createdAt = Math.floor(Date.now() / 1000);
    this.db.exec('BEGIN');
    try {
      if (isDefault === 1) this.db.prepare("UPDATE presets SET is_default = 0 WHERE kind = 'export'").run();
      this.db
        .prepare("INSERT INTO presets (id, kind, name, payload_json, is_default, created_at) VALUES (?, 'export', ?, ?, ?, ?)")
        .run(id, name, JSON.stringify(payload), isDefault, createdAt);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { id, name, payload, isDefault: isDefault === 1, createdAt };
  }

  deleteExportPreset(id: string): boolean {
    const res = this.db.prepare("DELETE FROM presets WHERE id = ? AND kind = 'export'").run(id);
    return Number(res.changes ?? 0) > 0;
  }

  /** 校验导出预设载荷（格式/范围必须是契约里的枚举） */
  private normalizePresetPayload(raw: unknown): ExportPresetPayload {
    if (raw === null || typeof raw !== 'object') throw new SettingsError('INVALID_PRESET', '预设内容缺失', 400);
    const payload = raw as { format?: unknown; scope?: unknown; includeDeleted?: unknown };
    const format =
      typeof payload.format === 'string' && (EXPORT_FORMATS as readonly string[]).includes(payload.format)
        ? (payload.format as ExportPresetPayload['format'])
        : null;
    if (format === null) throw new SettingsError('INVALID_PRESET', `预设格式不合法（可选 ${EXPORT_FORMATS.join('/')}）`, 400);
    const scope: ExportPresetPayload['scope'] =
      typeof payload.scope === 'string' && (EXPORT_SCOPES as readonly string[]).includes(payload.scope)
        ? (payload.scope as ExportPresetPayload['scope'])
        : 'site';
    return { format, scope, includeDeleted: payload.includeDeleted === true };
  }

  private toPreset(row: PresetRow): ExportPreset | null {
    try {
      const payload = this.normalizePresetPayload(JSON.parse(String(row.payload_json ?? '{}')));
      return {
        id: String(row.id),
        name: row.name ?? '未命名预设',
        payload,
        isDefault: Number(row.is_default) === 1,
        createdAt: row.created_at === undefined ? null : Number(row.created_at),
      };
    } catch {
      return null;
    }
  }
}
