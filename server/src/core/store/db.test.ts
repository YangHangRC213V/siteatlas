/**
 * 数据库迁移自检（dev-spec §4）
 * 断言：§4 全部表、全部索引、v_nodes_effective 视图存在；DDL 可重复执行（幂等跳过）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { loadMigrations, migrate, splitStatements } from './migrate.ts';

const EXPECTED_M2_TABLES = ['node_override_ops', 'manual_overrides'];

const EXPECTED_TABLES = [
  'sites',
  'nodes',
  'edges',
  'node_overrides',
  'materials',
  'crawl_tasks',
  'crawl_queue',
  'fetch_logs',
  'access_counts',
  'presets',
  'exports',
  'settings',
];

const EXPECTED_INDEXES = [
  'idx_nodes_parent',
  'idx_nodes_depth',
  'idx_nodes_status',
  'idx_nodes_hash',
  'idx_edges_from',
  'idx_edges_to',
  'idx_edges_site',
  'idx_ov_node',
  'idx_ov_seq',
  'idx_mat_node',
  'idx_queue_pick',
];

test('迁移建出 §4 全部表', () => {
  const handle = openDb({ file: ':memory:' });
  try {
    const rows = handle.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    for (const t of [...EXPECTED_TABLES, ...EXPECTED_M2_TABLES]) assert.ok(names.includes(t), `缺少表 ${t}`);
    assert.ok(names.includes('schema_migrations'), '缺少迁移记录表');
  } finally {
    handle.close();
  }
});

test('迁移建出 §4 全部索引与 v_nodes_effective 视图', () => {
  const handle = openDb({ file: ':memory:' });
  try {
    const idx = (handle.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    for (const i of EXPECTED_INDEXES) assert.ok(idx.includes(i), `缺少索引 ${i}`);
    const view = handle.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'v_nodes_effective'")
      .get() as { sql: string } | undefined;
    assert.ok(view, '缺少视图 v_nodes_effective');
    assert.match(view.sql, /effective_parent_id/);
    assert.match(view.sql, /field='parent'/);
  } finally {
    handle.close();
  }
});

test('迁移幂等：第二次执行全部跳过，不重复建表', () => {
  const handle = openDb({ file: ':memory:', runMigrations: false });
  try {
    const first = migrate(handle.db);
    assert.deepEqual(first.applied, ['001_init', '002_override_operations', '003_manual_overrides', '004_export_records', '005_preset_created_at']);
    const second = migrate(handle.db);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, ['001_init', '002_override_operations', '003_manual_overrides', '004_export_records', '005_preset_created_at']);
  } finally {
    handle.close();
  }
});

test('DML 允许：sites + 根节点写入后 v_nodes_effective 可见 effective_parent_id', () => {
  const handle = openDb({ file: ':memory:' });
  try {
    handle.db
      .prepare(
        `INSERT INTO sites (id, name, root_url, root_host, scope, allowlist_json, created_at, updated_at, archived, note)
         VALUES ('S1','示例','https://example.com/','example.com','same_site','[]',1,1,0,NULL)`,
      )
      .run();
    handle.db
      .prepare(
        `INSERT INTO nodes (id, site_id, identity_key, url, depth, auto_parent_id, status, first_seen_at)
         VALUES ('N1','S1','https://example.com/','https://example.com/',0,NULL,'ok',1)`,
      )
      .run();
    handle.db
      .prepare(
        `INSERT INTO nodes (id, site_id, identity_key, url, depth, auto_parent_id, status, first_seen_at)
         VALUES ('N2','S1','https://example.com/a','https://example.com/a',1,'N1','queued',1)`,
      )
      .run();
    const rows = (
      handle.db.prepare('SELECT id, effective_parent_id FROM v_nodes_effective ORDER BY id').all() as Array<{
        id: string;
        effective_parent_id: string | null;
      }>
    ).map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { id: 'N1', effective_parent_id: null },
      { id: 'N2', effective_parent_id: 'N1' },
    ]);
    // 修正层生效：最新未撤销的 parent override 覆盖 auto_parent_id
    handle.db
      .prepare(
        `INSERT INTO node_overrides (site_id, node_id, field, value, prev_value, op_group, seq, undone, created_at)
         VALUES ('S1','N2','parent','N1','N1',NULL,1,0,1)`,
      )
      .run();
    const row = handle.db.prepare("SELECT effective_parent_id FROM v_nodes_effective WHERE id = 'N2'").get() as {
      effective_parent_id: string | null;
    };
    assert.equal(row.effective_parent_id, 'N1');
  } finally {
    handle.close();
  }
});

test('UNIQUE(site_id, identity_key) 生效：同站同指纹不能重复建节点', () => {
  const handle = openDb({ file: ':memory:' });
  try {
    handle.db
      .prepare(
        `INSERT INTO sites (id, name, root_url, root_host, scope, allowlist_json, created_at, updated_at, archived, note)
         VALUES ('S1','示例','https://example.com/','example.com','same_site','[]',1,1,0,NULL)`,
      )
      .run();
    const ins = handle.db.prepare(
      `INSERT INTO nodes (id, site_id, identity_key, url, depth, status, first_seen_at) VALUES (?, 'S1', ?, ?, 1, 'queued', 1)`,
    );
    ins.run('N1', 'https://example.com/a', 'https://example.com/a');
    assert.throws(() => ins.run('N2', 'https://example.com/a', 'https://example.com/a?utm_source=x'));
  } finally {
    handle.close();
  }
});

test('splitStatements：注释与字符串内的分号不切分', () => {
  const sql = `
    -- 行注释；这里有个分号
    CREATE TABLE a (x TEXT DEFAULT ';'); /* 块注释 ; */
    INSERT INTO a (x) VALUES ('a;b');
  `;
  const stmts = splitStatements(sql);
  assert.equal(stmts.length, 2);
  assert.match(stmts[0] as string, /CREATE TABLE a/);
  assert.match(stmts[1] as string, /INSERT INTO a/);
});

test('loadMigrations：按文件名排序且带校验和', () => {
  const migrations = loadMigrations();
  assert.ok(migrations.length >= 1);
  assert.equal(migrations[0]?.version, '001_init');
  assert.equal(migrations[1]?.version, '002_override_operations');
  assert.match(migrations[0]?.checksum as string, /^[0-9a-f]{64}$/);
});
