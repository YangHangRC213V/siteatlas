-- 004_export_records.sql —— 导出任务的可查询扩展字段（M4）
--
-- dev-spec §4 已定 exports 表：
--   exports(id, site_id, format, scope_json, dir, status, manifest_path, created_at)
-- 这 8 个字段一字不改。但「导出任务」在实现上还需要几个字段才能自洽：
--   · site_name / root_url —— 站点被改名或归档后，历史导出仍要能说明「这是谁导的」；
--   · preset_id            —— requirements §4.6 的「导出预设」复用记录；
--   · counts_json          —— 节点/边/素材计数（列表页不必读 manifest 文件即可显示）；
--   · error                —— 失败原因（下游排障）；
--   · finished_at          —— 耗时统计。
-- 追加列而不是新建表：§4 的表名与字段语义保持，旧行仍然可读（列可空）。

ALTER TABLE exports ADD COLUMN site_name   TEXT;
ALTER TABLE exports ADD COLUMN root_url    TEXT;
ALTER TABLE exports ADD COLUMN preset_id   TEXT;
ALTER TABLE exports ADD COLUMN counts_json TEXT;
ALTER TABLE exports ADD COLUMN error       TEXT;
ALTER TABLE exports ADD COLUMN finished_at INTEGER;

CREATE INDEX idx_exports_site ON exports(site_id, created_at DESC);
