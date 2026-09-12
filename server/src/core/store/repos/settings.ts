/**
 * core/store/repos/settings.ts —— 键值设置表（dev-spec §4 settings(k, v)）
 *
 * 表结构一字不动：`k TEXT PRIMARY KEY, v TEXT`。
 * 值的编码是 **JSON**（不是裸字符串）——理由：设置里有布尔/数字/枚举，
 * 裸字符串会让 `"false"` 这种值在 truthy 判断上翻车（本仓库踩过的同族坑）。
 * 读取时按 `SETTING_FIELDS` 的类型归一化，多余的键忽略、缺的键补默认值。
 */
import type { AppSettings, SettingFieldDef } from '@siteatlas/shared';
import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;

export class SettingsRepo {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 全部设置行（raw JSON 已解析；解析失败的项直接忽略，由上层补默认值） */
  all(): AppSettings {
    const rows = this.db.prepare('SELECT k, v FROM settings').all() as Row[];
    const out: AppSettings = {};
    for (const row of rows) {
      const key = String(row['k']);
      try {
        out[key] = JSON.parse(String(row['v'])) as number | boolean | string | string[];
      } catch {
        /* 坏值忽略：宁可回落默认值，也不要让整个设置页打不开 */
      }
    }
    return out;
  }

  get(key: string): unknown {
    const row = this.db.prepare('SELECT v FROM settings WHERE k = ?').get(key) as Row | undefined;
    if (row === undefined) return undefined;
    try {
      return JSON.parse(String(row['v'])) as unknown;
    } catch {
      return undefined;
    }
  }

  put(key: string, value: number | boolean | string | string[]): void {
    this.db
      .prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(key, JSON.stringify(value));
  }

  putMany(values: Record<string, number | boolean | string | string[]>): void {
    for (const [key, value] of Object.entries(values)) this.put(key, value);
  }

  /** 把某键恢复成默认（删除行即可，读取侧会自动补默认值） */
  remove(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE k = ?').run(key);
  }
}

export interface SettingsValidationError {
  key: string;
  message: string;
}

/**
 * 按字段定义归一化 + 校验。
 * 返回归一化后的值或错误：**校验失败不写库**（宁可整体拒绝，也不要半套设置生效）。
 */
export function normalizeSetting(
  field: SettingFieldDef,
  raw: unknown,
): { ok: true; value: number | boolean | string | string[] } | { ok: false; error: SettingsValidationError } {
  const fail = (message: string) => ({ ok: false as const, error: { key: field.key, message } });

  switch (field.kind) {
    case 'int': {
      if (typeof raw === 'boolean' || (typeof raw !== 'number' && typeof raw !== 'string')) return fail('需要是数字');
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(num)) return fail('需要是数字');
      const min = field.min ?? Number.NEGATIVE_INFINITY;
      const max = field.max ?? Number.POSITIVE_INFINITY;
      const rounded = Math.round(num);
      if (rounded < min || rounded > max) return fail(`需要在 ${min} 与 ${max} 之间`);
      return { ok: true, value: rounded };
    }
    case 'bool': {
      if (typeof raw !== 'boolean') return fail('需要是布尔值');
      return { ok: true, value: raw };
    }
    case 'enum': {
      if (typeof raw !== 'string') return fail('需要是字符串');
      if (field.options !== undefined && !field.options.includes(raw)) return fail(`只能是 ${field.options.join(' / ')}`);
      return { ok: true, value: raw };
    }
    case 'string': {
      if (typeof raw !== 'string') return fail('需要是字符串');
      if (raw.trim().length === 0) return fail('不能为空');
      return { ok: true, value: raw.trim() };
    }
    case 'stringList': {
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) return fail('需要是字符串数组');
      return { ok: true, value: (raw as string[]).map((s) => s.trim()).filter((s) => s.length > 0) };
    }
    default:
      return fail('未知的设置类型');
  }
}

/** 用默认值补齐缺失项（不写库，纯内存合并） */
export function withDefaults(fields: readonly SettingFieldDef[], values: AppSettings): AppSettings {
  const out: AppSettings = {};
  for (const field of fields) {
    const current = values[field.key];
    out[field.key] = current === undefined ? field.default : current;
  }
  return out;
}
