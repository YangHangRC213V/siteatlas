-- 001_init.sql —— dev-spec §4「数据表结构」逐字落地
-- 除本注释头外，下方 SQL 与规格书 §4 代码块完全一致（含全部索引与 v_nodes_effective 视图）。
-- 注意：规格中的 PRAGMA journal_mode=WAL / foreign_keys=ON 属于连接级设置，
--       在 core/store/db.ts 建连接时执行，不放在迁移脚本里重复。

CREATE TABLE sites (
  id             TEXT PRIMARY KEY,            -- ULID
  name           TEXT NOT NULL,
  root_url       TEXT NOT NULL,               -- 绝对 URL
  root_host      TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'same_site', -- same_domain|same_site|allowlist|all
  allowlist_json TEXT NOT NULL DEFAULT '[]',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  archived       INTEGER NOT NULL DEFAULT 0,  -- 软删/归档
  note           TEXT
);

CREATE TABLE nodes (
  id              TEXT PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  identity_key    TEXT NOT NULL,              -- 规范化指纹（不含 fragment）
  url             TEXT NOT NULL,              -- 完整绝对 URL（可含 fragment）
  alias           TEXT,                       -- 用户别名（展示优先）
  display_label   TEXT,                       -- 缓存展示标签（见 §6.4）
  title           TEXT,
  http_status     INTEGER,
  content_type    TEXT,
  depth           INTEGER NOT NULL DEFAULT 0, -- 最小深度
  auto_parent_id  TEXT,                       -- 自动投影父节点（可空=根）
  status          TEXT NOT NULL DEFAULT 'queued',
                  -- queued|crawling|ok|error|skipped|blocked|need_human
  content_hash    TEXT,                       -- 正文指纹，用于内容去重
  in_link_count   INTEGER NOT NULL DEFAULT 0,
  out_link_count  INTEGER NOT NULL DEFAULT 0,
  is_deleted      INTEGER NOT NULL DEFAULT 0, -- 软删除
  first_seen_at   INTEGER NOT NULL,
  last_fetch_at   INTEGER,
  UNIQUE(site_id, identity_key)
);
CREATE INDEX idx_nodes_parent ON nodes(site_id, auto_parent_id);
CREATE INDEX idx_nodes_depth  ON nodes(site_id, depth);
CREATE INDEX idx_nodes_status ON nodes(site_id, status);
CREATE INDEX idx_nodes_hash   ON nodes(site_id, content_hash);

CREATE TABLE edges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id       TEXT NOT NULL,
  from_id       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  anchor_text   TEXT,
  selector      TEXT,          -- css 选择器（重放定位用）
  dom_path      TEXT,          -- 结构化 DOM 路径
  rel           TEXT,
  target        TEXT,
  is_nofollow   INTEGER NOT NULL DEFAULT 0,
  fragment      TEXT,
  source        TEXT NOT NULL, -- auto|manual|sitemap|redirect
  order_in_page INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_edges_from ON edges(from_id);
CREATE INDEX idx_edges_to   ON edges(to_id);
CREATE INDEX idx_edges_site ON edges(site_id);

-- 人工修正层：树的最终形态 = auto_parent_id 叠加最新 override
CREATE TABLE node_overrides (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  field      TEXT NOT NULL,   -- parent|url|alias|title|deleted|locked
  value      TEXT,
  prev_value TEXT,            -- 撤销用
  op_group   TEXT,            -- 同一次用户操作（批量重挂/删子树）
  seq        INTEGER NOT NULL,-- 单调递增，撤销/重做栈依据
  undone     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ov_node ON node_overrides(node_id, field, seq);
CREATE INDEX idx_ov_seq  ON node_overrides(site_id, seq);

-- 素材登记（仅当对应开关开启时产生记录）
CREATE TABLE materials (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,   -- body|html|screenshot|attachment
  rel_path   TEXT NOT NULL,   -- 相对 data/sites/<id>/ 的路径
  bytes      INTEGER,
  sha256     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mat_node ON materials(node_id, kind);

CREATE TABLE crawl_tasks (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL,
  preset_json TEXT NOT NULL,   -- 冻结的抓取参数
  status      TEXT NOT NULL,   -- running|paused|done|failed|stopped
  stats_json  TEXT,
  started_at  INTEGER,
  finished_at INTEGER
);

CREATE TABLE crawl_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL,
  site_id       TEXT NOT NULL,
  node_id       TEXT NOT NULL,
  depth         INTEGER NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed|skipped
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  UNIQUE(task_id, node_id)
);
CREATE INDEX idx_queue_pick ON crawl_queue(task_id, state, priority DESC, id);

CREATE TABLE fetch_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT, node_id TEXT, url TEXT, http_status INTEGER,
  duration_ms INTEGER, error TEXT, redirect_chain TEXT, at INTEGER
);

CREATE TABLE access_counts (            -- 循环护栏：按 identity 计数
  site_id TEXT NOT NULL, identity_key TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0, last_at INTEGER,
  PRIMARY KEY (site_id, identity_key)
);

CREATE TABLE presets (id TEXT PRIMARY KEY, kind TEXT, name TEXT,
  payload_json TEXT, is_default INTEGER NOT NULL DEFAULT 0);

CREATE TABLE exports (id TEXT PRIMARY KEY, site_id TEXT, format TEXT,
  scope_json TEXT, dir TEXT, status TEXT, manifest_path TEXT, created_at INTEGER);

CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT);

-- 有效父节点查询（不用闭包表，重挂子树成本 = 1 行）：
CREATE VIEW v_nodes_effective AS
SELECT n.*,
  COALESCE((SELECT o.value FROM node_overrides o
            WHERE o.node_id = n.id AND o.field='parent' AND o.undone=0
            ORDER BY o.seq DESC LIMIT 1), n.auto_parent_id) AS effective_parent_id
FROM nodes n;
