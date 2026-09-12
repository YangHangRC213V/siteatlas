/**
 * core/store/effective.ts —— 「自动层 + 修正层」合并查询（dev-spec §4 / §6.4）
 *
 * 树的最终形态 = `nodes.auto_*` 叠加 `node_overrides` 里最新一条未撤销的 override。
 *
 * 规格 §4 的视图 `v_nodes_effective` 只投影了 `parent` 一个字段，因此这里在其之上再
 * 叠加 `url`/`alias`/`title`/`deleted` 四类有效值。**视图定义不改**（§4 一字不差），
 * 而是在查询侧统一套用同一段投影，避免「一半走视图、一半走自算」的语义分裂。
 *
 * 约定：任何读树/读节点的 SQL 都必须用 `effectiveProjection()`，否则会出现
 * 「拖拽重挂后树变了、但节点详情还是老父节点」这类不一致。
 */
import type { OverrideField } from '@siteatlas/shared';

/** 投影列：id 取原值，其余字段取「最新未撤销 override，否则 auto 值」 */
export function effectiveProjection(alias = 'v'): string {
  return `
    ${alias}.id AS id,
    ${alias}.site_id AS site_id,
    ${alias}.identity_key AS identity_key,
    COALESCE((SELECT o.value FROM node_overrides o
              WHERE o.node_id = ${alias}.id AND o.field = 'url' AND o.undone = 0
              ORDER BY o.seq DESC LIMIT 1), ${alias}.url) AS url,
    COALESCE((SELECT o.value FROM node_overrides o
              WHERE o.node_id = ${alias}.id AND o.field = 'alias' AND o.undone = 0
              ORDER BY o.seq DESC LIMIT 1), ${alias}.alias) AS alias,
    COALESCE((SELECT o.value FROM node_overrides o
              WHERE o.node_id = ${alias}.id AND o.field = 'title' AND o.undone = 0
              ORDER BY o.seq DESC LIMIT 1), ${alias}.title) AS title,
    COALESCE((SELECT o.value FROM node_overrides o
              WHERE o.node_id = ${alias}.id AND o.field = 'deleted' AND o.undone = 0
              ORDER BY o.seq DESC LIMIT 1), ${alias}.is_deleted) AS is_deleted,
    COALESCE(
      NULLIF((SELECT o.value FROM node_overrides o
              WHERE o.node_id = ${alias}.id AND o.field = 'alias' AND o.undone = 0
              ORDER BY o.seq DESC LIMIT 1), ''),
      NULLIF((SELECT o.value FROM node_overrides o
              WHERE o.node_id = ${alias}.id AND o.field = 'title' AND o.undone = 0
              ORDER BY o.seq DESC LIMIT 1), ''),
      ${alias}.display_label
    ) AS display_label,
    ${alias}.http_status AS http_status,
    ${alias}.content_type AS content_type,
    ${alias}.depth AS depth,
    ${alias}.auto_parent_id AS auto_parent_id,
    ${alias}.status AS status,
    ${alias}.content_hash AS content_hash,
    ${alias}.in_link_count AS in_link_count,
    ${alias}.out_link_count AS out_link_count,
    ${alias}.first_seen_at AS first_seen_at,
    ${alias}.last_fetch_at AS last_fetch_at,
    ${alias}.effective_parent_id AS effective_parent_id`.trim();
}

/** 是否存在该字段的未撤销 override（用于 has_override 徽标，§6.4） */
export function hasOverrideExpr(alias = 'v'): string {
  return `(SELECT COUNT(*) FROM node_overrides o
           WHERE o.node_id = ${alias}.id AND o.undone = 0) > 0`;
}

/** 单节点有效形态查询（详情页/写操作前置校验用，与树查询同一套投影） */
export function effectiveNodeSql(): string {
  return `SELECT ${effectiveProjection('v')}, ${hasOverrideExpr('v')} AS has_override
          FROM v_nodes_effective v WHERE v.id = ?`;
}

/** 是否存在指定字段的未撤销 override（用于「还原为自动结果」的分级提示） */
export function hasOverrideFieldExpr(field: OverrideField, alias = 'v'): string {
  return `(SELECT COUNT(*) FROM node_overrides o
           WHERE o.node_id = ${alias}.id AND o.field = '${field}' AND o.undone = 0) > 0`;
}
