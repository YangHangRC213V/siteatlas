-- 002_override_operations.sql —— 修正层「操作栈」（M2）
--
-- 背景：单靠 node_overrides.undone 一个标志无法表达真正的撤销/重做栈：
--   · 「还原为自动结果」会清掉多条旧修正，它本身也必须可撤销；
--   · 撤销别名之后，重做必须补回别名（LIFO），而不是把更早的地址修正重放一遍。
--
-- 因此把「一次用户操作」显式建模为一行，栈位置由 ops 状态派生：
--   撤销栈顶 = 序号最大且仍生效的操作（undone=0）
--   重做栈顶 = 序号最小且已失效的操作（undone=1）
-- prev_op_group 串出「上一步是什么」的单链，便于排查与说明；
-- 撤销/重做只翻转 undone 与 override 行的 undone，两者语义一致。
--
-- 注意：不改动 §4 已定的任何表/字段：本表是新增，且 node_overrides 结构保持不变。

CREATE TABLE node_override_ops (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id       TEXT NOT NULL,
  op_group      TEXT NOT NULL,
  kind          TEXT NOT NULL,   -- parent|url|alias|title|deleted|reverted
  seq           INTEGER NOT NULL,-- 与 node_overrides.seq 同源：同一操作内的行共享 seq
  -- prev_op_group：入栈前的栈顶（用于追溯「上一步是什么」）
  prev_op_group TEXT,
  -- 操作载荷：kind='reverted' 时存被清掉的 override id 列表（撤销该操作时用于恢复）
  payload       TEXT,
  undone        INTEGER NOT NULL DEFAULT 0,
  -- discarded：永久失效（新操作或「还原」会丢弃待重做的历史）。用于区分
  -- 「撤销后还能重做」(undone=1,discarded=0) 与「已放弃重做」(discarded=1)
  discarded     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_ov_ops_site ON node_override_ops(site_id, seq DESC, id DESC);
CREATE INDEX idx_ov_ops_top  ON node_override_ops(site_id, undone, seq);
CREATE UNIQUE INDEX idx_ov_ops_group ON node_override_ops(op_group);
