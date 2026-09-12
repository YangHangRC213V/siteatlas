/**
 * 节点仓储（dev-spec §4 nodes / v_nodes_effective 视图）
 *
 * M0 只落地「建根节点」与「按站点取根 / 统计」这几条路径；
 * 子树懒加载、重挂、软删子树属于 M2（§7 里程碑），此处仅提供 v_nodes_effective 的读取入口。
 */
import type { NodeRecord, NodeStatus } from '@siteatlas/shared';
import type { DatabaseSync } from 'node:sqlite';
import { nowSec, ulid } from '../ids.ts';
import { effectiveProjection, hasOverrideExpr } from '../effective.ts';

type Row = Record<string, unknown>;

/** 表列 → 契约字段（列名逐字一致，此处仅做类型收敛） */
export function toNode(row: Row): NodeRecord & { effective_parent_id?: string | null; has_override?: number } {
  const node: NodeRecord = {
    id: String(row['id']),
    site_id: String(row['site_id']),
    identity_key: String(row['identity_key']),
    url: String(row['url']),
    alias: (row['alias'] as string | null) ?? null,
    display_label: (row['display_label'] as string | null) ?? null,
    title: (row['title'] as string | null) ?? null,
    http_status: row['http_status'] === null || row['http_status'] === undefined ? null : Number(row['http_status']),
    content_type: (row['content_type'] as string | null) ?? null,
    depth: Number(row['depth']),
    auto_parent_id: (row['auto_parent_id'] as string | null) ?? null,
    status: row['status'] as NodeStatus,
    content_hash: (row['content_hash'] as string | null) ?? null,
    in_link_count: Number(row['in_link_count'] ?? 0),
    out_link_count: Number(row['out_link_count'] ?? 0),
    is_deleted: Number(row['is_deleted'] ?? 0),
    first_seen_at: Number(row['first_seen_at']),
    last_fetch_at:
      row['last_fetch_at'] === null || row['last_fetch_at'] === undefined ? null : Number(row['last_fetch_at']),
  };
  if ('effective_parent_id' in row) {
    (node as { effective_parent_id?: string | null }).effective_parent_id =
      (row['effective_parent_id'] as string | null) ?? null;
  }
  if ('has_override' in row) (node as { has_override?: number }).has_override = Number(row['has_override'] ?? 0);
  return node;
}

export interface CreateRootNodeInput {
  siteId: string;
  url: string;
  identityKey: string;
  displayLabel: string;
  status: NodeStatus;
  httpStatus?: number | null;
  contentType?: string | null;
  title?: string | null;
  id?: string;
}

export class NodesRepo {
  /** 行 → 契约对象（供核心外层的自定义查询复用，避免重复实现列映射） */
  static fromRow(row: Record<string, unknown>): NodeRecord {
    return toNode(row);
  }

  private readonly db: DatabaseSync;

  // 同上：不使用参数属性，保持 Node 原生 TS 剥离可运行
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 建根节点：depth=0、auto_parent_id=NULL（requirements §4.1「当前页即根节点」） */
  createRoot(input: CreateRootNodeInput): NodeRecord {
    const ts = nowSec();
    const id = input.id ?? ulid();
    // 建站时的探测不算「抓取」：last_fetch_at 保持 NULL，
    // 否则采集内核的「已抓节点直连复用」会误判根节点已抓完而跳过整站。
    this.db
      .prepare(
        `INSERT INTO nodes (id, site_id, identity_key, url, alias, display_label, title,
                            http_status, content_type, depth, auto_parent_id, status,
                            content_hash, in_link_count, out_link_count, is_deleted,
                            first_seen_at, last_fetch_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, NULL, ?, NULL, 0, 0, 0, ?, NULL)`,
      )
      .run(
        id,
        input.siteId,
        input.identityKey,
        input.url,
        input.displayLabel,
        input.title ?? null,
        input.httpStatus ?? null,
        input.contentType ?? null,
        input.status,
        ts,
      );
    const node = this.get(id);
    if (node === null) throw new Error(`建根节点后读取失败：${id}`);
    return node;
  }

  get(id: string): NodeRecord | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : toNode(row);
  }

  findByUrl(siteId: string, url: string): NodeRecord | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE site_id = ? AND url = ?').get(siteId, url) as Row | undefined;
    return row === undefined ? null : toNode(row);
  }

  findByUrlForSite(siteId: string, url: string, identityKey: string): NodeRecord | null {
    const byIdentity = this.db
      .prepare('SELECT * FROM nodes WHERE site_id = ? AND identity_key = ?')
      .get(siteId, identityKey) as Row | undefined;
    if (byIdentity !== undefined) return toNode(byIdentity);
    return this.findByUrl(siteId, url);
  }

  /** 站点根节点（auto_parent_id 为空且未被软删的节点） */
  root(siteId: string): NodeRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM nodes
         WHERE site_id = ? AND auto_parent_id IS NULL AND is_deleted = 0
         ORDER BY depth ASC, first_seen_at ASC LIMIT 1`,
      )
      .get(siteId) as Row | undefined;
    return row === undefined ? null : toNode(row);
  }

  count(siteId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM nodes WHERE site_id = ? AND is_deleted = 0')
      .get(siteId) as Row;
    return Number(row['c'] ?? 0);
  }

  /**
   * 按有效父节点（视图投影：auto_parent_id 叠加最新未撤销 override）懒加载直接子节点。
   * M2 的树视图直接复用，M0 只用于自检视图可查。
   */
  childrenOf(siteId: string, parentId: string | null, offset = 0, limit = 200): NodeRecord[] {
    const rows = (
      parentId === null
        ? this.db
            .prepare(
              `SELECT v.*, (SELECT COUNT(*) FROM node_overrides o
                            WHERE o.node_id = v.id AND o.field = 'parent' AND o.undone = 0) AS has_override
               FROM v_nodes_effective v
               WHERE v.site_id = ? AND v.effective_parent_id IS NULL AND v.is_deleted = 0
               ORDER BY v.id LIMIT ? OFFSET ?`,
            )
            .all(siteId, limit, offset)
        : this.db
            .prepare(
              `SELECT v.*, (SELECT COUNT(*) FROM node_overrides o
                            WHERE o.node_id = v.id AND o.field = 'parent' AND o.undone = 0) AS has_override
               FROM v_nodes_effective v
               WHERE v.site_id = ? AND v.effective_parent_id = ? AND v.is_deleted = 0
               ORDER BY v.id LIMIT ? OFFSET ?`,
            )
            .all(siteId, parentId, limit, offset)
    ) as Row[];
    return rows.map((r) => toNode(r));
  }

  countChildren(siteId: string, parentId: string | null): number {
    const row = (
      parentId === null
        ? this.db
            .prepare(
              `SELECT COUNT(*) AS c FROM v_nodes_effective
               WHERE site_id = ? AND effective_parent_id IS NULL AND is_deleted = 0`,
            )
            .get(siteId)
        : this.db
            .prepare(
              `SELECT COUNT(*) AS c FROM v_nodes_effective
               WHERE site_id = ? AND effective_parent_id = ? AND is_deleted = 0`,
            )
            .get(siteId, parentId)
    ) as Row;
    return Number(row['c'] ?? 0);
  }

  /* ---------------- M1：采集期使用的写路径 ---------------- */

  /**
   * 幂等建节点（§6.3 一层去重）：
   * - 命中 UNIQUE(site_id, identity_key) → 不新建、不改父，仅把现有最小深度往下调；
   * - 未命中 → 以「首次发现的父节点」作为 auto_parent_id（§4「父节点由边决定」）。
   * 返回 created 与节点。
   */
  upsert(input: {
    siteId: string;
    url: string;
    identityKey: string;
    parentId: string | null;
    depth: number;
    displayLabel: string;
    status?: NodeStatus;
  }): { created: boolean; node: NodeRecord } {
    const ts = nowSec();
    const id = ulid();
    const res = this.db
      .prepare(
        `INSERT INTO nodes (id, site_id, identity_key, url, alias, display_label, title,
                            http_status, content_type, depth, auto_parent_id, status,
                            content_hash, in_link_count, out_link_count, is_deleted,
                            first_seen_at, last_fetch_at)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, ?, NULL, 0, 0, 0, ?, NULL)
         ON CONFLICT(site_id, identity_key) DO NOTHING`,
      )
      .run(id, input.siteId, input.identityKey, input.url, input.displayLabel, input.depth, input.parentId, input.status ?? 'queued', ts);

    const created = Number(res.changes ?? 0) > 0;
    const existing = this.findByUrlForSite(input.siteId, input.url, input.identityKey);
    if (existing === null) throw new Error(`upsert 后读取节点失败：${input.identityKey}`);
    if (!created && input.depth < existing.depth) {
      this.db.prepare('UPDATE nodes SET depth = ? WHERE id = ?').run(input.depth, existing.id);
      existing.depth = input.depth;
    }
    return { created, node: existing };
  }

  setStatus(id: string, status: NodeStatus): void {
    this.db.prepare('UPDATE nodes SET status = ? WHERE id = ?').run(status, id);
  }

  /** 抓取结果回写（标题/状态/HTTP/内容类型/指纹/时间） */
  applyFetchResult(input: {
    id: string;
    status: NodeStatus;
    httpStatus: number | null;
    contentType: string | null;
    title: string | null;
    displayLabel: string | null;
    contentHash: string | null;
  }): void {
    this.db
      .prepare(
        `UPDATE nodes
         SET status = ?, http_status = ?, content_type = ?, title = ?,
             display_label = COALESCE(?, display_label), content_hash = COALESCE(?, content_hash),
             last_fetch_at = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.httpStatus,
        input.contentType,
        input.title,
        input.displayLabel,
        input.contentHash,
        nowSec(),
        input.id,
      );
  }

  /**
   * 人工直接改写自动投影父节点（M3 手动采集的「置为父节点」兜底）。
   * 与 M2 的 node_overrides 修正层不同：这是把「自动结果」本身改掉，
   * 因为手动采集时用户是在**创造**自动层（而不是修正已有结果）。
   * 调用方需自行做防环校验并写 manual_overrides 痕迹。
   */
  applyAutoParent(nodeId: string, parentId: string | null): void {
    this.db.prepare('UPDATE nodes SET auto_parent_id = ? WHERE id = ?').run(parentId, nodeId);
  }

  /** 出链数回写（每抓一页写一次，避免逐边自增） */
  setOutLinkCount(id: string, count: number): void {
    this.db.prepare('UPDATE nodes SET out_link_count = ? WHERE id = ?').run(count, id);
  }

  /**
   * 重定向落库（dev-spec §6.2「最终 URL 建节点，原 URL 保留为别名/历史，不建独立节点」）。
   * M1 策略：同一节点直接改写为最终 URL（identity_key 一并更新）；
   * 若最终 URL 的 identity 已被别的节点占用，则只更新 url 字段，避免 UNIQUE 冲突。
   */
  applyRedirect(id: string, siteId: string, finalUrl: string, finalIdentityKey: string): boolean {
    const node = this.get(id);
    if (node === null) return false;
    if (node.url === finalUrl && node.identity_key === finalIdentityKey) return false;
    const holder = this.db
      .prepare('SELECT id FROM nodes WHERE site_id = ? AND identity_key = ?')
      .get(siteId, finalIdentityKey) as Row | undefined;
    if (holder !== undefined && String(holder['id']) !== id) {
      this.db.prepare('UPDATE nodes SET url = ? WHERE id = ?').run(finalUrl, id);
      return false;
    }
    this.db.prepare('UPDATE nodes SET url = ?, identity_key = ? WHERE id = ?').run(finalUrl, finalIdentityKey, id);
    return true;
  }

  /** 入链数 = 指向该节点的边数 */
  refreshInLinkCount(id: string): void {
    this.db
      .prepare('UPDATE nodes SET in_link_count = (SELECT COUNT(*) FROM edges WHERE to_id = ?) WHERE id = ?')
      .run(id, id);
  }

  /**
   * 纯展示字段直写（别名/标题）。
   * M1 只开放这两个字段；父节点/地址/删除/锁定一律走 node_overrides 修正层（M2），
   * 以免 M2 引入修正层时出现「一半直写一半叠层」的语义分裂。
   */
  updateDisplayFields(id: string, patch: { alias?: string | null; title?: string | null }): void {
    const sets: string[] = [];
    const values: Array<string | null> = [];
    if (patch.alias !== undefined) {
      sets.push('alias = ?');
      values.push(patch.alias);
    }
    if (patch.title !== undefined) {
      sets.push('title = ?');
      values.push(patch.title);
    }
    if (sets.length === 0) return;
    // display_label 优先级：别名 > 标题 > 路径末段（§6.4）
    sets.push('display_label = COALESCE(NULLIF(?, \'\'), NULLIF(?, \'\'), display_label)');
    const aliasForLabel = patch.alias ?? null;
    const titleForLabel = patch.title ?? null;
    values.push(aliasForLabel, titleForLabel);
    values.push(id);
    this.db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /** 是否已抓过（成功/失败/待人工确认都算抓过，用于直连复用不重复请求） */
  isCrawled(id: string): boolean {
    const row = this.db.prepare('SELECT status, last_fetch_at FROM nodes WHERE id = ?').get(id) as Row | undefined;
    if (row === undefined) return false;
    const status = String(row['status']);
    return row['last_fetch_at'] !== null && (status === 'ok' || status === 'error' || status === 'need_human');
  }

  /**
   * 树视图懒加载（dev-spec §1 强制：按 parent_id 懒加载 + 分页）。
   * 读 v_nodes_effective，因此人工重挂（M2）立即生效。
   */
  childrenPage(
    siteId: string,
    parentId: string | null,
    offset: number,
    limit: number,
  ): { total: number; nodes: Array<NodeRecord & { effective_parent_id: string | null; has_override: boolean; child_count: number }> } {
    // 读 v_nodes_effective（父节点叠加修正层），再叠加 url/alias/title/deleted 四类修正（§6.4）
    const where =
      parentId === null
        ? 'v.site_id = ? AND v.effective_parent_id IS NULL'
        : 'v.site_id = ? AND v.effective_parent_id = ?';
    const args: Array<string | number> = parentId === null ? [siteId] : [siteId, parentId];

    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT ${effectiveProjection('v')} FROM v_nodes_effective v WHERE ${where}
         ) t WHERE t.is_deleted = 0`,
      )
      .get(...args) as Row;

    const rows = this.db
      .prepare(
        `SELECT t.*,
                (SELECT COUNT(*) FROM v_nodes_effective c
                  WHERE c.site_id = t.site_id AND c.effective_parent_id = t.id
                    AND c.is_deleted = 0
                    AND NOT EXISTS (SELECT 1 FROM node_overrides od
                                    WHERE od.node_id = c.id AND od.field = 'deleted' AND od.undone = 0 AND od.value = '1')
                ) AS child_count
         FROM (
           SELECT ${effectiveProjection('v')},
                  ${hasOverrideExpr('v')} AS has_override
           FROM v_nodes_effective v WHERE ${where}
         ) t
         WHERE t.is_deleted = 0
         ORDER BY t.depth ASC, t.id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as Row[];

    return {
      total: Number(totalRow['c'] ?? 0),
      nodes: rows.map((r) => {
        const node = toNode(r) as unknown as NodeRecord & {
          effective_parent_id: string | null;
          has_override: boolean;
          child_count: number;
        };
        node.has_override = Number(r['has_override'] ?? 0) > 0;
        node.child_count = Number(r['child_count'] ?? 0);
        return node;
      }),
    };
  }

  /**
   * 整树平面列表（有效投影），按深度 + id 排序，供「图形视图」（层级图/关系图）使用。
   *
   * 为什么不复用 childrenPage：懒加载接口一次最多 500 行、且要逐层递归请求，
   * 画图需要**一次拿到同一批节点**才能做布局。这里给一个带上限的整体查询，
   * 由调用方根据 `total` 判断是否被截断（前端会提示「只画了前 N 个」）。
   */
  flatForSite(siteId: string, limit = 5000): { nodes: Array<NodeRecord & { effective_parent_id: string | null; has_override: boolean; child_count: number }>; total: number } {
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT ${effectiveProjection('v')} FROM v_nodes_effective v WHERE v.site_id = ?
         ) t WHERE t.is_deleted = 0`,
      )
      .get(siteId) as Row;
    const rows = this.db
      .prepare(
        `SELECT t.*,
                (SELECT COUNT(*) FROM v_nodes_effective c
                  WHERE c.site_id = t.site_id AND c.effective_parent_id = t.id
                    AND c.is_deleted = 0
                    AND NOT EXISTS (SELECT 1 FROM node_overrides od
                                    WHERE od.node_id = c.id AND od.field = 'deleted' AND od.undone = 0 AND od.value = '1')
                ) AS child_count
         FROM (
           SELECT ${effectiveProjection('v')}, ${hasOverrideExpr('v')} AS has_override
           FROM v_nodes_effective v WHERE v.site_id = ?
         ) t
         WHERE t.is_deleted = 0
         ORDER BY t.depth ASC, t.id ASC
         LIMIT ?`,
      )
      .all(siteId, limit) as Row[];
    return {
      total: Number(totalRow['c'] ?? 0),
      nodes: rows.map((r) => {
        const node = toNode(r) as unknown as NodeRecord & {
          effective_parent_id: string | null;
          has_override: boolean;
          child_count: number;
        };
        node.has_override = Number(r['has_override'] ?? 0) > 0;
        node.child_count = Number(r['child_count'] ?? 0);
        return node;
      }),
    };
  }

  /** 站点全部未删节点的 id/url（供导出与测试断言，M1 用于「无重复」自检） */
  allIdentityKeys(siteId: string): string[] {
    const rows = this.db
      .prepare('SELECT identity_key FROM nodes WHERE site_id = ? AND is_deleted = 0 ORDER BY identity_key')
      .all(siteId) as Row[];
    return rows.map((r) => String(r['identity_key']));
  }
}

