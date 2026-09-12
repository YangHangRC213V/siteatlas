/**
 * core/store/repos/overrides.ts —— 人工修正层 + 撤销/重做栈（dev-spec §4 node_overrides / §6.4）
 *
 * 叠加层模型：一行 override = 一次人工改动的记录，读树时取「最新生效」的一条。
 *
 * 撤销/重做的实现（M2 起）：
 *   单靠 `node_overrides.undone` 一个标志无法表达真正的栈语义 ——
 *   「还原为自动结果」会一次清掉多条旧修正（它本身也要可撤销），
 *   而「撤销别名后重做」必须把别名补回来（LIFO），不能把更早的地址修正重放一遍。
 *   因此把「一次用户操作」显式建模为 `node_override_ops` 的一行，栈位置由 ops 状态派生：
 *     撤销栈顶 = 序号最大且仍生效的操作；重做栈顶 = 序号最小且已失效的操作。
 *   操作行之间用 `prev_op_group` 串成单链（便于追溯「上一步是什么」）；
 *   `node_overrides.undone` 同时表示「这行修正当前是否生效」，供读路径 COALESCE 使用。
 *
 * 不变式（决定了边界行为，已记入 DECISIONS.md）：
 *   1. 生效集是一个**前缀**：撤销 = 弹出栈顶（序号最大的生效操作），因此不能跳着撤销；
 *   2. 「还原为自动结果 / 从回收站恢复」是重置语义，会**永久截断重做栈**
 *      （那些待重做的历史被放弃，否则撤销还原时会把它们一并翻回来）；
 *   3. 重做 = 从被截断/被撤销的区间里按序号从小到大补回一步。
 *
 * 批量操作（批量重挂 / 删子树）共用一个 op_group，保证原子撤销（§6.4）。
 */
import type { OverrideField, OverrideRecord } from '@siteatlas/shared';
import type { DatabaseSync } from 'node:sqlite';
import { nowSec, ulid } from '../ids.ts';

type Row = Record<string, unknown>;

export interface AppendOverrideInput {
  siteId: string;
  nodeId: string;
  field: OverrideField;
  value: string | null;
  /** 仅用于属性面板展示「改前是什么」（不参与撤销计算） */
  prevValue: string | null;
  /** 同一次用户操作（批量重挂/删子树）共享 */
  opGroup: string;
}

/** 撤销/重做的结果：受影响的行 + 受影响节点（前端局部刷新用） */
export interface UndoOutcome {
  opGroup: string;
  kind: string;
  seq: number;
  /** 受影响的 override 行（「还原」类操作没有自己的行） */
  rows: OverrideRecord[];
  /** 受影响的节点 id */
  nodeIds: string[];
}

interface OpRow {
  opGroup: string;
  kind: string;
  seq: number;
  prevOpGroup: string | null;
  payload: string | null;
}

function toOverride(row: Row): OverrideRecord {
  return {
    id: Number(row['id']),
    site_id: String(row['site_id']),
    node_id: String(row['node_id']),
    field: row['field'] as OverrideField,
    value: (row['value'] as string | null) ?? null,
    prev_value: (row['prev_value'] as string | null) ?? null,
    op_group: (row['op_group'] as string | null) ?? null,
    seq: Number(row['seq']),
    undone: Number(row['undone'] ?? 0),
    created_at: Number(row['created_at']),
  };
}

/** 解析「还原操作」记录里被清掉的 override id 列表 */
function parseAffectedIds(raw: unknown): number[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : [];
  } catch {
    return [];
  }
}

export class OverridesRepo {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /* ---------------- 序列号 ---------------- */

  /** 该站点下一个 seq（override 与 op 共享同一序列，保证全局可比） */
  private nextSeq(siteId: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(next) AS next FROM (
           SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM node_overrides WHERE site_id = ?
           UNION ALL
           SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM node_override_ops WHERE site_id = ?
         )`,
      )
      .get(siteId, siteId) as Row;
    return Number(row['next'] ?? 1);
  }

  /* ---------------- 操作行与栈派生 ---------------- */

  private static readonly OP_COLUMNS = 'op_group, kind, seq, prev_op_group, payload';

  private static toOpRow(row: Row): OpRow {
    return {
      opGroup: String(row['op_group']),
      kind: String(row['kind']),
      seq: Number(row['seq']),
      prevOpGroup: (row['prev_op_group'] as string | null) ?? null,
      payload: (row['payload'] as string | null) ?? null,
    };
  }

  /** 全部操作行（含被丢弃的），按 seq 升序 —— 数组下标即「时间线位置」 */
  private allOps(siteId: string): OpRow[] {
    const rows = this.db
      .prepare(`SELECT ${OverridesRepo.OP_COLUMNS} FROM node_override_ops WHERE site_id = ? ORDER BY seq ASC, id ASC`)
      .all(siteId) as Row[];
    return rows.map((r) => OverridesRepo.toOpRow(r));
  }

  /**
   * 时间线上的「已生效前缀」长度（游标）。
   * = 已应用操作数 + 夹在中间、尚未重做回来的操作数（它们占位置但未生效）。
   * 被丢弃（永久失效）的操作不占位置，因此游标只落在真实可撤销的历史上。
   */
  private appliedCount(siteId: string): number {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN undone = 0 THEN 1 ELSE 0 END) AS applied,
           SUM(CASE WHEN undone = 1 AND discarded = 0 THEN 1 ELSE 0 END) AS redoable
         FROM node_override_ops WHERE site_id = ?`,
      )
      .get(siteId) as Row;
    return Number(row['applied'] ?? 0) + Number(row['redoable'] ?? 0);
  }

  /** 时间线视图（截断逻辑共用：按 seq 顺序标注 applied / redoable / discarded） */
  private timeline(siteId: string): Array<{ op: OpRow; state: 'applied' | 'redoable' | 'discarded' }> {
    const rows = this.db
      .prepare(
        `SELECT ${OverridesRepo.OP_COLUMNS}, undone, discarded FROM node_override_ops
         WHERE site_id = ? ORDER BY seq ASC, id ASC`,
      )
      .all(siteId) as Row[];
    return rows.map((r) => {
      const undone = Number(r['undone'] ?? 0) === 1;
      const discarded = Number(r['discarded'] ?? 0) === 1;
      const state: 'applied' | 'redoable' | 'discarded' = discarded ? 'discarded' : undone ? 'redoable' : 'applied';
      return { op: OverridesRepo.toOpRow(r), state };
    });
  }

  /** 撤销栈顶 = 时间线上最后一个已生效操作 */
  private undoTop(siteId: string): OpRow | null {
    const line = this.timeline(siteId).filter((entry) => entry.state === 'applied');
    return line.at(-1)?.op ?? null;
  }

  /** 重做栈顶 = 时间线上最早一个「待重做」操作 */
  private redoTop(siteId: string): OpRow | null {
    return this.timeline(siteId).find((entry) => entry.state === 'redoable')?.op ?? null;
  }

  /**
   * 登记一次新操作：先把「待重做」的历史永久丢弃（新操作分叉历史），再追加到时间线末尾。
   * 不自己开事务：调用方（append / appendBatch / revertNode / restoreOp）已经在一个事务里，
   * node:sqlite 不支持嵌套 BEGIN（踩过一次：cannot start a transaction within a transaction）。
   */
  private recordOp(siteId: string, opGroup: string, kind: string, seq: number, payload: string | null = null): void {
    const prev = this.undoTop(siteId);
    this.discardRedo(siteId);
    this.db
      .prepare(
        `INSERT INTO node_override_ops (site_id, op_group, kind, seq, prev_op_group, payload, undone, discarded, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)
         ON CONFLICT(op_group) DO NOTHING`,
      )
      .run(siteId, opGroup, kind, seq, prev?.opGroup ?? null, payload, nowSec());
  }

  /**
   * 丢弃重做栈：把「待重做」的操作标为永久失效（discarded=1），
   * 并把它们写入的 override 行恢复为「未生效」（discarded 的操作不该留下生效值）。
   */
  private discardRedo(siteId: string): void {
    const redoable = this.timeline(siteId).filter((entry) => entry.state === 'redoable');
    for (const entry of redoable) {
      this.setOpActive(entry.op, false);
      this.db.prepare('UPDATE node_override_ops SET discarded = 1 WHERE op_group = ?').run(entry.op.opGroup);
    }
  }

  /** 把某操作标为永久失效并回到未生效状态 */
  private discardOp(op: OpRow): void {
    this.setOpActive(op, false);
    this.db.prepare('UPDATE node_override_ops SET discarded = 1 WHERE op_group = ?').run(op.opGroup);
  }

  /** 把某操作设为生效/失效，并同步它写入的 override 行 */
  private setOpActive(op: OpRow, active: boolean): void {
    if (op.kind === 'reverted') {
      // 还原类操作：生效 = 它清掉的修正保持失效；撤销它 = 把那些修正恢复
      const stmt = this.db.prepare('UPDATE node_overrides SET undone = ? WHERE id = ?');
      for (const id of parseAffectedIds(op.payload)) stmt.run(active ? 1 : 0, id);
    } else {
      const rows = this.db.prepare('SELECT id FROM node_overrides WHERE op_group = ?').all(op.opGroup) as Row[];
      const stmt = this.db.prepare('UPDATE node_overrides SET undone = ? WHERE id = ?');
      for (const row of rows) stmt.run(active ? 0 : 1, Number(row['id']));
    }
    this.db.prepare('UPDATE node_override_ops SET undone = ? WHERE op_group = ?').run(active ? 0 : 1, op.opGroup);
  }

  /** 该操作影响的节点 id */
  private opNodeIds(op: OpRow): string[] {
    if (op.kind === 'reverted') {
      const ids = parseAffectedIds(op.payload);
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT DISTINCT node_id FROM node_overrides WHERE id IN (${placeholders})`)
        .all(...ids) as Row[];
      return rows.map((r) => String(r['node_id']));
    }
    const rows = this.db
      .prepare('SELECT DISTINCT node_id FROM node_overrides WHERE op_group = ?')
      .all(op.opGroup) as Row[];
    return rows.map((r) => String(r['node_id']));
  }

  /** 该操作写入的 override 行 */
  private opRows(op: OpRow): OverrideRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM node_overrides WHERE op_group = ? ORDER BY seq, id')
      .all(op.opGroup) as Row[];
    return rows.map((r) => toOverride(r));
  }

  private describeOp(op: OpRow): { opGroup: string; seq: number; kind: string; count: number; payload: string | null } {
    const countRow = this.db
      .prepare('SELECT COUNT(*) AS c FROM node_overrides WHERE op_group = ?')
      .get(op.opGroup) as Row;
    return { opGroup: op.opGroup, seq: op.seq, kind: op.kind, count: Number(countRow['c'] ?? 0), payload: op.payload };
  }

  /* ---------------- 写入 ---------------- */

  /** 追加一条修正（seq 递增；同 op_group 视为同一次操作） */
  append(input: AppendOverrideInput): OverrideRecord {
    const seq = this.nextSeq(input.siteId);
    const res = this.db
      .prepare(
        `INSERT INTO node_overrides (site_id, node_id, field, value, prev_value, op_group, seq, undone, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(input.siteId, input.nodeId, input.field, input.value, input.prevValue, input.opGroup, seq, nowSec());
    const row = this.db.prepare('SELECT * FROM node_overrides WHERE id = ?').get(Number(res.lastInsertRowid)) as
      | Row
      | undefined;
    if (row === undefined) throw new Error('写入 override 后读取失败');
    this.recordOp(input.siteId, input.opGroup, input.field, seq);
    return toOverride(row);
  }

  /** 批量追加（一次事务，全部成功或全部回滚；只登记一次操作） */
  appendBatch(inputs: AppendOverrideInput[]): OverrideRecord[] {
    if (inputs.length === 0) return [];
    const first = inputs[0] as AppendOverrideInput;
    const seq = this.nextSeq(first.siteId);
    this.db.exec('BEGIN');
    try {
      const stmt = this.db.prepare(
        `INSERT INTO node_overrides (site_id, node_id, field, value, prev_value, op_group, seq, undone, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      );
      const created: OverrideRecord[] = [];
      for (const input of inputs) {
        const res = stmt.run(
          input.siteId,
          input.nodeId,
          input.field,
          input.value,
          input.prevValue,
          input.opGroup,
          seq,
          nowSec(),
        );
        const row = this.db.prepare('SELECT * FROM node_overrides WHERE id = ?').get(Number(res.lastInsertRowid)) as
          | Row
          | undefined;
        if (row === undefined) throw new Error('写入 override 后读取失败');
        created.push(toOverride(row));
      }
      this.recordOp(first.siteId, first.opGroup, first.field, seq);
      this.db.exec('COMMIT');
      return created;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * 还原为自动结果（§6.4）：清掉该节点当前生效的全部修正。
   * 这本身是一次新操作（kind='reverted'），因此可被撤销 —— 撤销它 = 恢复这些旧修正
   * （被清掉的 override id 列表存在 op.payload）。
   */
  revertNode(siteId: string, nodeId: string): { opGroup: string; rows: OverrideRecord[] } | null {
    const active = this.activeForNode(nodeId);
    if (active.length === 0) return null;
    const opGroup = ulid();
    const seq = this.nextSeq(siteId);
    this.db.exec('BEGIN');
    try {
      const stmt = this.db.prepare('UPDATE node_overrides SET undone = 1 WHERE id = ?');
      for (const row of active) stmt.run(row.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    // 还原是回到自动形态：先放弃「待重做」的历史（否则撤销还原时会把它们一并翻回来）
    this.discardRedo(siteId);
    this.recordOp(siteId, opGroup, 'reverted', seq, JSON.stringify(active.map((r) => r.id)));
    return { opGroup, rows: active };
  }

  /**
   * 从回收站恢复：让某个操作组（通常是「删子树」）的修正失效，并压入一次新的「还原」操作，
   * 使恢复动作本身也可撤销。
   */
  restoreOp(siteId: string, targetOpGroup: string): { opGroup: string } {
    const rows = this.db
      .prepare('SELECT * FROM node_overrides WHERE op_group = ? ORDER BY seq, id')
      .all(targetOpGroup) as Row[];
    const opGroup = ulid();
    const seq = this.nextSeq(siteId);
    this.db.exec('BEGIN');
    try {
      const stmt = this.db.prepare('UPDATE node_overrides SET undone = 1 WHERE id = ?');
      for (const row of rows) stmt.run(Number(row['id']));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.discardRedo(siteId);
    this.recordOp(siteId, opGroup, 'reverted', seq, JSON.stringify(rows.map((r) => Number(r['id']))));
    return { opGroup };
  }

  /* ---------------- 撤销 / 重做 ---------------- */

  /** 撤销栈深度：已生效的操作数 */
  undoDepth(siteId: string): number {
    return this.timeline(siteId).filter((entry) => entry.state === 'applied').length;
  }

  /** 重做栈深度：待重做的操作数（被丢弃的不算） */
  redoDepth(siteId: string): number {
    return this.timeline(siteId).filter((entry) => entry.state === 'redoable').length;
  }

  /**
   * 撤销一步：把撤销栈顶（时间线上最后一个已生效操作）标为「未生效但可重做」。
   * 时间线是不变式「已生效前缀 + 待重做区间 + 被丢弃」，因此不存在「更晚却仍生效」的操作。
   */
  undo(siteId: string): UndoOutcome | null {
    const op = this.undoTop(siteId);
    if (op === null) return null;
    const nodeIds = this.opNodeIds(op);
    this.db.exec('BEGIN');
    try {
      this.setOpActive(op, false);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { opGroup: op.opGroup, kind: op.kind, seq: op.seq, rows: this.opRows(op), nodeIds };
  }

  /** 重做一步：重新激活重做栈顶（序号最小的已失效操作） */
  redo(siteId: string): UndoOutcome | null {
    const op = this.redoTop(siteId);
    if (op === null) return null;
    const nodeIds = new Set<string>(this.opNodeIds(op));
    this.db.exec('BEGIN');
    try {
      this.setOpActive(op, true);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { opGroup: op.opGroup, kind: op.kind, seq: op.seq, rows: this.opRows(op), nodeIds: [...nodeIds] };
  }

  /* ---------------- 读取 ---------------- */

  /** 某节点某字段的当前生效值（无 override 时返回 null，调用方自行回落到 auto 值） */
  effectiveValue(nodeId: string, field: OverrideField): string | null {
    const row = this.db
      .prepare(
        `SELECT value FROM node_overrides
         WHERE node_id = ? AND field = ? AND undone = 0
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(nodeId, field) as Row | undefined;
    return row === undefined ? null : ((row['value'] as string | null) ?? null);
  }

  /** 某节点全部生效中的 override（按 seq 升序） */
  activeForNode(nodeId: string): OverrideRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM node_overrides WHERE node_id = ? AND undone = 0 ORDER BY seq ASC')
      .all(nodeId) as Row[];
    return rows.map((r) => toOverride(r));
  }

  /** 节点修改历史（含已失效，用于属性面板「修改历史」） */
  historyForNode(nodeId: string, limit = 50): OverrideRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM node_overrides WHERE node_id = ? ORDER BY seq DESC LIMIT ?')
      .all(nodeId, limit) as Row[];
    return rows.map((r) => toOverride(r));
  }

  /** 站点级最近修正 */
  recentForSite(siteId: string, limit = 20): OverrideRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM node_overrides WHERE site_id = ? ORDER BY seq DESC LIMIT ?')
      .all(siteId, limit) as Row[];
    return rows.map((r) => toOverride(r));
  }

  hasAnyOverride(nodeId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM node_overrides WHERE node_id = ? AND undone = 0 LIMIT 1')
      .get(nodeId) as Row | undefined;
    return row !== undefined;
  }

  /** 撤销栈顶（服务层判断「还有没有可撤销的操作」） */
  lastUndoableGroup(
    siteId: string,
  ): { opGroup: string; seq: number; kind: string; count: number; payload: string | null } | null {
    const op = this.undoTop(siteId);
    return op === null ? null : this.describeOp(op);
  }

  /** 重做栈顶 */
  lastRedoableGroup(
    siteId: string,
  ): { opGroup: string; seq: number; kind: string; count: number; payload: string | null } | null {
    const op = this.redoTop(siteId);
    return op === null ? null : this.describeOp(op);
  }

  /** 操作栈快照（前端展示「可撤销/可重做」状态） */
  recentOps(
    siteId: string,
    limit = 20,
  ): Array<{ opGroup: string; kind: string; seq: number; active: boolean; createdAt: number }> {
    const rows = this.db
      .prepare(
        `SELECT op_group, kind, seq, undone, created_at FROM node_override_ops
         WHERE site_id = ? ORDER BY seq DESC, id DESC LIMIT ?`,
      )
      .all(siteId, limit) as Row[];
    return rows.map((r) => ({
      opGroup: String(r['op_group']),
      kind: String(r['kind']),
      seq: Number(r['seq']),
      active: Number(r['undone'] ?? 0) === 0,
      createdAt: Number(r['created_at']),
    }));
  }

  /** 回收站：返回被 deleted override 生效覆盖的子树根（父节点也未被删的才算根） */
  deletedRoots(
    siteId: string,
    parentOf: (nodeId: string) => string | null,
  ): Array<{ nodeId: string; opGroup: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT o.node_id AS node_id, o.op_group AS op_group
         FROM node_overrides o
         WHERE o.site_id = ? AND o.field = 'deleted' AND o.undone = 0 AND o.value = '1'
         ORDER BY o.seq DESC`,
      )
      .all(siteId) as Row[];
    const deletedIds = new Set(rows.map((r) => String(r['node_id'])));
    const roots: Array<{ nodeId: string; opGroup: string | null }> = [];
    for (const row of rows) {
      const nodeId = String(row['node_id']);
      const parentId = parentOf(nodeId);
      if (parentId !== null && deletedIds.has(parentId)) continue;
      roots.push({ nodeId, opGroup: (row['op_group'] as string | null) ?? null });
    }
    return roots;
  }
}
