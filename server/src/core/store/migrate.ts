/**
 * 迁移机制（dev-spec §4 的 DDL 以迁移文件形式落地）
 *
 * 约定：
 * - 迁移文件命名 `NNN_name.sql`，按文件名字典序执行；
 * - 已执行记录写入 `schema_migrations`，记录 sha256 校验和；
 * - 已应用迁移的内容发生变化 → 直接报错（防止「悄悄改了已经跑过的 DDL」导致各机器 schema 漂移）；
 * - 每个迁移文件内的多条语句在一个事务里执行（PRAGMA 属于连接级设置，不放迁移文件里）。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: string;
  file: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = join(HERE, 'migrations');

/**
 * 切分 SQL 脚本为单条语句。
 * 处理：`--` 行注释、`/* *\/` 块注释、单/双引号字符串、`;` 结尾。
 * 本项目 DDL 不含触发器/自定义分隔符，故无需更复杂的解析。
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let buf = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      buf += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      buf += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      buf += ch;
      i++;
      while (i < sql.length) {
        const c = sql[i] as string;
        buf += c;
        if (c === ch) {
          if (sql[i + 1] === ch) {
            buf += sql[i + 1] as string;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === ';') {
      statements.push(buf.trim());
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim().length > 0) statements.push(buf.trim());
  return statements.filter((s) => s.length > 0);
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/** 读取迁移目录，按文件名排序 */
export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  return files.map((file) => {
    const sql = readFileSync(join(dir, file), 'utf8');
    return { version: file.replace(/\.sql$/, ''), file, sql, checksum: checksumOf(sql) };
  });
}

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  checksum   TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`);
}

/** 已应用迁移的版本与校验和 */
export function appliedMigrations(db: DatabaseSync): Map<string, string> {
  ensureMigrationsTable(db);
  const rows = db.prepare('SELECT version, checksum FROM schema_migrations').all() as Array<{
    version: string;
    checksum: string;
  }>;
  return new Map(rows.map((r) => [r.version, r.checksum]));
}

/** 执行所有未应用的迁移；已应用且校验和一致的跳过 */
export function migrate(
  db: DatabaseSync,
  options: { dir?: string; migrations?: Migration[] } = {},
): MigrationResult {
  const migrations = options.migrations ?? loadMigrations(options.dir ?? DEFAULT_MIGRATIONS_DIR);
  const applied = appliedMigrations(db);
  const result: MigrationResult = { applied: [], skipped: [] };

  for (const m of migrations) {
    const prev = applied.get(m.version);
    if (prev !== undefined) {
      if (prev !== m.checksum) {
        throw new Error(
          `迁移 ${m.version} 已应用但内容发生变化（校验和不一致）。` +
            `请新增迁移文件而不是修改历史迁移；如需强制重置，删除 data/siteatlas.db 后重启。`,
        );
      }
      result.skipped.push(m.version);
      continue;
    }
    const statements = splitStatements(m.sql);
    db.exec('BEGIN');
    try {
      for (const stmt of statements) db.exec(stmt);
      db.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.checksum,
        Math.floor(Date.now() / 1000),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${m.version} 执行失败：${(err as Error).message}`);
    }
    result.applied.push(m.version);
  }
  return result;
}
