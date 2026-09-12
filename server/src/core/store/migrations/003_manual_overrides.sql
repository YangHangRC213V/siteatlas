-- 003_manual_overrides.sql —— 手动采集的人工指定标记（M3）
--
-- dev-spec §6.5 的兜底路径：「识别失败时允许手动『置为根/置为父节点』，并打『人工指定』标记」。
--
-- 为什么单独一张表而不是复用 node_overrides：
--   · node_overrides 是「树的形态」修正层（父/地址/名/删），参与撤销栈与有效投影；
--   · manual_overrides 是**会话级的操作痕迹**（谁在哪个会话里把哪一页指定成了什么），
--     用于追溯与「本次会话都动了什么」，不参与树形态计算。
-- 两者职责不同，混用会让撤销栈里出现一堆「看不出发生了什么」的记录。
--
-- 注意：不改动 §4 已定的任何表/字段。

CREATE TABLE manual_overrides (
  id         TEXT PRIMARY KEY,          -- ULID
  site_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,             -- set-root|set-parent|confirm-click|discard-click
  value      TEXT,                      -- 关联节点 id（如被指定的父节点）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_manual_site    ON manual_overrides(site_id, created_at DESC);
CREATE INDEX idx_manual_session ON manual_overrides(session_id, created_at DESC);
