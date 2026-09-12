-- 005_preset_created_at.sql —— 预设的创建时间（设置模块 · 导出预设）
--
-- dev-spec §4 的 presets 表是 5 个字段：
--   presets(id, kind, name, payload_json, is_default)
-- 这 5 个字段一字不改。但「导出预设」列表要按「最近保存的在前」排序、
-- 界面要显示保存时间，没有时间戳就只能靠 id 排序（ULID 虽单调，但界面无法展示时间）。
-- 追加一列（可空），旧行仍然可读，按 NULLS LAST 排在后面。

ALTER TABLE presets ADD COLUMN created_at INTEGER;

CREATE INDEX idx_presets_kind ON presets(kind, is_default DESC, created_at DESC);
