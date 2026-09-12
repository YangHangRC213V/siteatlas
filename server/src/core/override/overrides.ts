/**
 * core/override/overrides.ts —— 修正层用例（dev-spec §6.4 / §5.1）
 *
 * 所有人工改动都落成 node_overrides 行；树的最终形态 = 自动层叠加修正层。
 * 这里集中三件事：写入前校验（防环/防跨站）、批量原子写（op_group）、子树软删。
 */
import type { NodeRecord, OverrideRecord } from '@siteatlas/shared';
import type { DatabaseSync } from 'node:sqlite';
import { effectiveNodeSql } from '../store/effective.ts';
import { ulid } from '../store/ids.ts';
import { NodesRepo } from '../store/repos/nodes.ts';
import { OverridesRepo } from '../store/repos/overrides.ts';
import { SitesRepo } from '../store/repos/sites.ts';

type Row = Record<string, unknown>;

export class OverrideError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'OverrideError';
    this.code = code;
    this.status = status;
  }
}

export interface MoveResult {
  opGroup: string;
  moved: number;
  /** 被移动的节点（已应用修正后的形态） */
  nodes: NodeRecord[];
}

export interface DeleteSubtreesResult {
  opGroup: string;
  /** 影响面：被软删的节点总数（含子树） */
  affectedNodes: number;
  nodeIds: string[];
}

export interface UndoRedoResult {
  /** 本次影响的 override 行（「还原」类操作没有自己的行，此时为空） */
  rows: OverrideRecord[];
  /** 受影响的 override 行数（用于「本次撤销了 N 处修改」提示） */
  affected: number;
  /** 操作类型（parent/url/alias/title/deleted/reverted） */
  kind: string;
  /** 受影响节点（用于前端局部刷新） */
  nodeIds: string[];
  action: 'undo' | 'redo';
  undoDepth: number;
  redoDepth: number;
}

export class OverridesService {
  private readonly db: DatabaseSync;
  private readonly nodes: NodesRepo;
  private readonly sites: SitesRepo;
  private readonly overrides: OverridesRepo;

  constructor(deps: { db: DatabaseSync; nodes: NodesRepo; sites: SitesRepo; overrides: OverridesRepo }) {
    this.db = deps.db;
    this.nodes = deps.nodes;
    this.sites = deps.sites;
    this.overrides = deps.overrides;
  }

  /** 有效形态的节点（自动层 + 修正层）。找不到返回 null */
  effectiveNode(nodeId: string): (NodeRecord & { has_override: boolean }) | null {
    const row = this.db.prepare(effectiveNodeSql()).get(nodeId) as Row | undefined;
    if (row === undefined) return null;
    const node = NodesRepo.fromRow(row) as unknown as NodeRecord & { has_override: boolean };
    node.has_override = Number(row['has_override'] ?? 0) > 0;
    return node;
  }

  /** 同站校验 + 取节点，否则抛 404/409 */
  private requireNode(siteId: string, nodeId: string, label: string): { id: string; effective_parent_id: string | null; auto_parent_id: string | null } {
    const row = this.db
      .prepare('SELECT id, site_id, effective_parent_id, auto_parent_id FROM v_nodes_effective WHERE id = ?')
      .get(nodeId) as Row | undefined;
    if (row === undefined) throw new OverrideError('NODE_NOT_FOUND', `${label}不存在：${nodeId}`, 404);
    if (String(row['site_id']) !== siteId) {
      throw new OverrideError('NODE_OTHER_SITE', `${label}不属于该站点：${nodeId}`, 409);
    }
    return {
      id: String(row['id']),
      effective_parent_id: (row['effective_parent_id'] as string | null) ?? null,
      auto_parent_id: (row['auto_parent_id'] as string | null) ?? null,
    };
  }

  /** 有效父 id（修正层叠加后的真实挂载点）——对外暴露，供路由组装详情 */
  effectiveParentOf(nodeId: string): string | null {
    return this.effectiveParent(nodeId);
  }

  private effectiveParent(nodeId: string): string | null {
    const row = this.db
      .prepare('SELECT effective_parent_id FROM v_nodes_effective WHERE id = ?')
      .get(nodeId) as Row | undefined;
    return row === undefined ? null : ((row['effective_parent_id'] as string | null) ?? null);
  }

  /** 沿有效父链向上回溯，判断 candidateAncestorId 是否在 nodeId 的祖先链上（防环） */
  private isAncestor(nodeId: string, candidateAncestorId: string): boolean {
    const seen = new Set<string>();
    let current: string | null = this.effectiveParent(nodeId);
    while (current !== null) {
      if (current === candidateAncestorId) return true;
      if (seen.has(current)) return false; // 已有环，防死循环
      seen.add(current);
      current = this.effectiveParent(current);
    }
    return false;
  }

  /** 直达子节点 id（有效父关系） */
  private childIds(nodeId: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM v_nodes_effective WHERE effective_parent_id = ? AND is_deleted = 0')
      .all(nodeId) as Row[];
    return rows.map((r) => String(r['id']));
  }

  /** 子树节点 id（含自身，前序） */
  subtreeIds(nodeId: string): string[] {
    const out: string[] = [];
    const stack = [nodeId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) continue;
      out.push(current);
      for (const child of this.childIds(current)) stack.push(child);
    }
    return out;
  }

  /**
   * 重挂（支持批量）：{ids[], newParentId}
   * - 校验：同站、目标父存在、不能挂到自身或自己的子孙下（防环）
   * - 写入：每节点一条 field='parent' override，共享同一个 op_group（原子撤销）
   */
  move(siteId: string, nodeIds: string[], newParentId: string | null, opGroupInput?: string): MoveResult {
    if (this.sites.get(siteId) === null) throw new OverrideError('SITE_NOT_FOUND', `站点不存在：${siteId}`, 404);
    if (nodeIds.length === 0) throw new OverrideError('INVALID_BODY', 'ids 不能为空', 400);

    if (newParentId !== null) {
      this.requireNode(siteId, newParentId, '目标父节点');
    }

    const inputs: Array<{ siteId: string; nodeId: string; field: 'parent'; value: string | null; prevValue: string | null; opGroup: string }> = [];
    const opGroup = opGroupInput ?? ulid();

    for (const nodeId of new Set(nodeIds)) {
      const node = this.requireNode(siteId, nodeId, '节点');
      if (newParentId === nodeId) throw new OverrideError('INVALID_MOVE', '不能把节点挂到它自己下面', 400);
      if (newParentId !== null && this.isAncestor(newParentId, nodeId)) {
        throw new OverrideError('INVALID_MOVE', '不能把节点挂到它自己的子孙下面（会形成环）', 400);
      }
      const prev = this.effectiveParent(nodeId);
      if (prev === newParentId) continue; // 目标相同：不产生无意义的修正
      inputs.push({
        siteId,
        nodeId,
        field: 'parent',
        value: newParentId,
        prevValue: prev,
        opGroup,
      });
    }

    if (inputs.length === 0) {
      return { opGroup, moved: 0, nodes: [] };
    }
    const rows = this.overrides.appendBatch(inputs);
    void rows;
    const movedNodes = inputs
      .map((input) => this.effectiveNode(input.nodeId))
      .filter((n): n is NodeRecord & { has_override: boolean } => n !== null);
    return { opGroup, moved: inputs.length, nodes: movedNodes };
  }

  /** 改地址（§6.8 语义：旧记录保留为历史，修正层写 url） */
  updateUrl(siteId: string, nodeId: string, url: string): { opGroup: string; node: NodeRecord & { has_override: boolean } } {
    const node = this.requireNode(siteId, nodeId, '节点');
    const effective = this.effectiveNode(nodeId);
    if (effective === null) throw new OverrideError('NODE_NOT_FOUND', `节点不存在：${nodeId}`, 404);
    if (effective.url === url) throw new OverrideError('NO_CHANGE', '地址与当前值相同', 400);
    const opGroup = ulid();
    this.overrides.append({
      siteId,
      nodeId: node.id,
      field: 'url',
      value: url,
      prevValue: effective.url,
      opGroup,
    });
    const updated = this.effectiveNode(nodeId);
    if (updated === null) throw new OverrideError('NODE_NOT_FOUND', `节点不存在：${nodeId}`, 404);
    return { opGroup, node: updated };
  }

  /** 改别名 / 标题（纯展示字段，仍走修正层以便统一撤销） */
  updateDisplay(
    siteId: string,
    nodeId: string,
    patch: { alias?: string | null; title?: string | null },
  ): { opGroup: string | null; node: NodeRecord & { has_override: boolean } } {
    this.requireNode(siteId, nodeId, '节点');
    const effective = this.effectiveNode(nodeId);
    if (effective === null) throw new OverrideError('NODE_NOT_FOUND', `节点不存在：${nodeId}`, 404);

    const inputs: Array<{ siteId: string; nodeId: string; field: 'alias' | 'title'; value: string | null; prevValue: string | null; opGroup: string }> = [];
    const opGroup = ulid();
    if (patch.alias !== undefined && patch.alias !== effective.alias) {
      inputs.push({ siteId, nodeId, field: 'alias', value: patch.alias, prevValue: effective.alias, opGroup });
    }
    if (patch.title !== undefined && patch.title !== effective.title) {
      inputs.push({ siteId, nodeId, field: 'title', value: patch.title, prevValue: effective.title, opGroup });
    }
    if (inputs.length === 0) {
      return { opGroup: null, node: effective };
    }
    this.overrides.appendBatch(inputs);
    const updated = this.effectiveNode(nodeId);
    if (updated === null) throw new OverrideError('NODE_NOT_FOUND', `节点不存在：${nodeId}`, 404);
    return { opGroup, node: updated };
  }

  /**
   * 软删节点及其子树（§4「删除子树：写 field='deleted' override（批量 op_group），原数据不动，可整体撤销」）。
   * 返回影响面：被删节点总数（含子树）。
   */
  deleteSubtrees(siteId: string, nodeIds: string[]): DeleteSubtreesResult {
    if (this.sites.get(siteId) === null) throw new OverrideError('SITE_NOT_FOUND', `站点不存在：${siteId}`, 404);
    if (nodeIds.length === 0) throw new OverrideError('INVALID_BODY', 'ids 不能为空', 400);

    // 去重并去掉已被其它待删节点包含的子孙（避免重复计数）
    const roots: string[] = [];
    for (const id of new Set(nodeIds)) {
      this.requireNode(siteId, id, '节点');
      if (roots.some((root) => this.isAncestor(id, root))) continue;
      roots.push(id);
    }

    const targets = new Set<string>();
    for (const root of roots) {
      for (const id of this.subtreeIds(root)) targets.add(id);
    }

    const opGroup = ulid();
    const inputs = [...targets].map((id) => ({
      siteId,
      nodeId: id,
      field: 'deleted' as const,
      value: '1',
      prevValue: String(this.effectiveNode(id)?.is_deleted ?? 0),
      opGroup,
    }));
    this.overrides.appendBatch(inputs);
    return { opGroup, affectedNodes: targets.size, nodeIds: [...targets] };
  }

  /** 还原为自动结果（单节点） */
  revertNode(siteId: string, nodeId: string): { opGroup: string; node: NodeRecord & { has_override: boolean } } {
    this.requireNode(siteId, nodeId, '节点');
    const result = this.overrides.revertNode(siteId, nodeId);
    if (result === null) throw new OverrideError('NO_OVERRIDE', '该节点没有人工修正，无需还原', 409);
    const node = this.effectiveNode(nodeId);
    if (node === null) throw new OverrideError('NODE_NOT_FOUND', `节点不存在：${nodeId}`, 404);
    return { opGroup: result.opGroup, node };
  }

  /** 撤销 / 重做（站点级，按 op_group 原子） */
  undo(siteId: string): UndoRedoResult {
    if (this.sites.get(siteId) === null) throw new OverrideError('SITE_NOT_FOUND', `站点不存在：${siteId}`, 404);
    const outcome = this.overrides.undo(siteId);
    if (outcome === null) throw new OverrideError('NOTHING_TO_UNDO', '没有可撤销的操作', 409);
    return {
      rows: outcome.rows,
      affected: Math.max(outcome.rows.length, outcome.nodeIds.length),
      kind: outcome.kind,
      nodeIds: outcome.nodeIds,
      action: 'undo',
      undoDepth: this.overrides.undoDepth(siteId),
      redoDepth: this.overrides.redoDepth(siteId),
    };
  }

  redo(siteId: string): UndoRedoResult {
    if (this.sites.get(siteId) === null) throw new OverrideError('SITE_NOT_FOUND', `站点不存在：${siteId}`, 404);
    const outcome = this.overrides.redo(siteId);
    if (outcome === null) throw new OverrideError('NOTHING_TO_REDO', '没有可重做的操作', 409);
    return {
      rows: outcome.rows,
      affected: Math.max(outcome.rows.length, outcome.nodeIds.length),
      kind: outcome.kind,
      nodeIds: outcome.nodeIds,
      action: 'redo',
      undoDepth: this.overrides.undoDepth(siteId),
      redoDepth: this.overrides.redoDepth(siteId),
    };
  }

  /** 回收站：被软删的子树根（父节点未被删的才算根） */
  trash(siteId: string): Array<{ nodeId: string; opGroup: string | null; node: NodeRecord & { has_override: boolean } | null; affectedNodes: number }> {
    const entries = this.overrides.deletedRoots(siteId, (nodeId) => this.effectiveParent(nodeId));
    return entries.map((entry) => ({
      ...entry,
      node: this.effectiveNode(entry.nodeId),
      affectedNodes: this.subtreeIds(entry.nodeId).length,
    }));
  }

  /** 从回收站恢复：撤销该子树根的 deleted override（一次 op_group） */
  restoreFromTrash(siteId: string, nodeId: string): { restored: number } {
    this.requireNode(siteId, nodeId, '节点');
    const row = this.db
      .prepare(
        `SELECT op_group AS op_group FROM node_overrides
         WHERE site_id = ? AND node_id = ? AND field = 'deleted' AND undone = 0 AND value = '1'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(siteId, nodeId) as Row | undefined;
    if (row === undefined) throw new OverrideError('NOT_IN_TRASH', '该节点不在回收站里', 409);
    const opGroup = (row['op_group'] as string | null) ?? null;
    const targets = this.subtreeIds(nodeId);
    if (opGroup !== null && opGroup.length > 0) {
      // 走操作栈：恢复本身也是一次可撤销的操作
      this.overrides.restoreOp(siteId, opGroup);
    } else {
      const ids = this.db
        .prepare('SELECT id FROM node_overrides WHERE site_id = ? AND node_id = ? AND field = ? AND undone = 0')
        .all(siteId, nodeId, 'deleted') as Row[];
      this.db.exec('BEGIN');
      try {
        const stmt = this.db.prepare('UPDATE node_overrides SET undone = 1 WHERE id = ?');
        for (const r of ids) stmt.run(Number(r['id']));
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
    return { restored: targets.length };
  }

  /** 撤销栈深度（前端按钮禁用态） */
  depths(siteId: string): { undoDepth: number; redoDepth: number } {
    return { undoDepth: this.overrides.undoDepth(siteId), redoDepth: this.overrides.redoDepth(siteId) };
  }

  /** 修改历史（属性面板） */
  history(nodeId: string, limit = 50): OverrideRecord[] {
    return this.overrides.historyForNode(nodeId, limit);
  }
}
