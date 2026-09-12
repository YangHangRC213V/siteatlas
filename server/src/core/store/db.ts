/**
 * SQLite 连接与迁移入口（dev-spec §2 存储 / §4 数据表）
 *
 * 实现说明（与规格的差异，已记入 docs/DECISIONS.md）：
 * dev-spec §2 写的是 `better-sqlite3`，本机 Node 26 已内置 `node:sqlite` 且 API 同族
 * （DatabaseSync/prepare/run/all），因此改用 `node:sqlite`，避免原生模块本地编译。
 * 表名/字段名/视图名不受影响。
 *
 * 连接级 PRAGMA 按 §4 声明：journal_mode=WAL、foreign_keys=ON。
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate, type MigrationResult } from './migrate.ts';

export interface OpenDbOptions {
  /** 数据库文件路径，`:memory:` 表示内存库（测试用） */
  file?: string;
  /** 项目根目录，用于解析默认 data/ 路径 */
  rootDir?: string;
  /** 打开后是否立即跑迁移，默认 true */
  runMigrations?: boolean;
}

export interface DbHandle {
  db: DatabaseSync;
  file: string;
  migrations: MigrationResult | null;
  close(): void;
}

/** 默认数据库文件：`data/siteatlas.db`（dev-spec §3 目录结构） */
export function defaultDbFile(rootDir: string): string {
  return join(resolve(rootDir), 'data', 'siteatlas.db');
}

export function openDb(options: OpenDbOptions = {}): DbHandle {
  const rootDir = options.rootDir ?? process.cwd();
  const file = options.file ?? defaultDbFile(rootDir);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  // dev-spec §4：PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec('PRAGMA busy_timeout=5000;');

  const migrations = options.runMigrations === false ? null : migrate(db);
  return {
    db,
    file,
    migrations,
    close() {
      try {
        db.close();
      } catch {
        /* 已关闭则忽略 */
      }
    },
  };
}
