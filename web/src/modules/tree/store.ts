/**
 * 树模块状态（Zustand）：懒加载 + 折叠展开 + 扁平化（供虚拟滚动）+ 节点抽屉 + 修正层操作
 *
 * dev-spec §1 强制：子节点按 parent_id 懒加载 + 分页；
 * §4.5/§6.4：行内只显示短标签（别名 > 标题 > 路径末段），URL 不占布局，仅 tooltip。
 * M2 新增：拖拽重挂、软删子树、撤销/重做、还原为自动结果、回收站恢复。
 *
 * 局部刷新策略：
 *   - 重挂/软删/撤销后，用「受影响父节点的 id 集合」重新拉取这些父节点的子列表，
 *     而不是整棵树刷新 —— 万级树下全量刷新会让虚拟滚动位置与展开状态全部丢失。
 */
import { create } from 'zustand';
import type { NodeRecord, OverrideRecord, TreeNodeRow, TrashEntry } from '@siteatlas/shared';
import { TreeApiError, treeApi, type NodeDetailPayload } from './api.ts';

export interface TreeRow {
  node: TreeNodeRow;
  /** 缩进层级（= 树中层级，不等于 node.depth，后者是最小深度） */
  level: number;
  expanded: boolean;
  loading: boolean;
  /** 已加载的直接子节点数 */
  loadedChildren: number;
  /** 多选状态（批量重挂/软删用） */
  selected: boolean;
}

export type TreeMode = 'tree' | 'trash';

export interface TreeStoreState {
  siteId: string | null;
  rows: TreeRow[];
  loading: boolean;
  error: string | null;
  /** 提示条（最近一次操作的结果） */
  notice: string | null;
  /** 关键字过滤（标题/别名/URL） */
  query: string;
  statusFilter: string | null;
  regexMode: boolean;
  /** 服务端检索结果（有 query/depth/status 时用；为空表示走本地过滤） */
  searchHits: Array<{ id: string; url: string; display_label: string | null; depth: number; status: string }> | null;

  mode: TreeMode;
  trash: TrashEntry[];

  detail: NodeDetailPayload | null;
  detailLoading: boolean;
  detailError: string | null;
  saving: boolean;

  depths: { undoDepth: number; redoDepth: number };
  busy: boolean;
  /** 拖拽中的节点 id（多选时可能是多个） */
  dragging: string[];

  bind: (siteId: string) => Promise<void>;
  unbind: () => void;
  loadRoot: () => Promise<void>;
  reloadSubtrees: (parentIds: Array<string | null>) => Promise<void>;
  /** 重载根 + 自顶向下重放已展开分支（保留展开态 + alsoExpand 指定的分支），并同步撤销栈深度 */
  refreshExpandedBranches: (alsoExpand?: string[]) => Promise<void>;
  toggle: (nodeId: string) => Promise<void>;
  expandAll: (maxNodes?: number) => Promise<void>;
  collapseAll: () => void;
  setQuery: (query: string) => void;
  setStatusFilter: (status: string | null) => void;
  setRegexMode: (value: boolean) => void;
  runSearch: () => Promise<void>;
  setMode: (mode: TreeMode) => Promise<void>;
  loadTrash: () => Promise<void>;
  restore: (nodeId: string) => Promise<void>;
  toggleSelect: (nodeId: string, exclusive?: boolean) => void;
  clearSelection: () => void;
  moveNodes: (ids: string[], newParentId: string | null) => Promise<void>;
  deleteNodes: (ids: string[]) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  revertNode: (nodeId: string) => Promise<void>;
  select: (nodeId: string) => Promise<void>;
  closeDetail: () => void;
  saveDetail: (patch: { alias?: string | null; title?: string | null; url?: string }) => Promise<void>;
  clearNotice: () => void;
  setDragging: (ids: string[]) => void;
}

const KIND_LABELS: Record<string, string> = {
  parent: '重挂父节点',
  url: '修改地址',
  alias: '改别名',
  title: '改标题',
  deleted: '软删除子树',
  reverted: '还原为自动结果',
  locked: '锁定',
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * 树里只有根节点时自动展开它：否则打开的是一片「一个节点」的树，
 * 用户必须自己点开才看得到内容（首次进入与修正操作之后都要保证这一点）。
 */
async function ensureRootExpanded(
  get: () => TreeStoreState,
  _set: (partial: Partial<TreeStoreState>) => void,
): Promise<void> {
  const rows = get().rows;
  if (rows.length !== 1) return;
  const rootRow = rows[0] as TreeRow;
  if (rootRow.expanded || rootRow.node.child_count === 0) return;
  await get().toggle(rootRow.node.id);
}

export const useTreeStore = create<TreeStoreState>((set, get) => ({
  siteId: null,
  rows: [],
  loading: false,
  error: null,
  notice: null,
  query: '',
  statusFilter: null,
  regexMode: false,
  searchHits: null,
  mode: 'tree',
  trash: [],
  detail: null,
  detailLoading: false,
  detailError: null,
  saving: false,
  depths: { undoDepth: 0, redoDepth: 0 },
  busy: false,
  dragging: [],

  async bind(siteId) {
    if (get().siteId === siteId && get().rows.length > 0) return;
    set({ siteId, rows: [], detail: null, error: null, query: '', statusFilter: null, mode: 'tree', trash: [], searchHits: null });
    await get().loadRoot();
    await ensureRootExpanded(get, set);
  },

  unbind() {
    set({ siteId: null, rows: [], detail: null, error: null, searchHits: null });
  },

  async loadRoot() {
    const siteId = get().siteId;
    if (siteId === null) return;
    set({ loading: true });
    try {
      const page = await treeApi.children(siteId, null, 0, 50);
      set({
        rows: page.nodes.map((node) => ({
          node,
          level: 0,
          expanded: false,
          loading: false,
          loadedChildren: 0,
          selected: false,
        })),
        loading: false,
        error: null,
        ...(page.depths !== undefined ? { depths: page.depths } : {}),
      });
    } catch (err) {
      set({ loading: false, error: err instanceof TreeApiError ? err.message : String(err) });
    }
  },

  /**
   * 局部刷新：只重新拉取这些父节点的子列表（保留其余展开状态与滚动位置）。
   * parentId=null 表示根层。
   */
  async reloadSubtrees(parentIds) {
    const siteId = get().siteId;
    if (siteId === null) return;
    const unique = [...new Set(parentIds)];
    for (const parentId of unique) {
      const rows = get().rows;
      const index = parentId === null ? -1 : rows.findIndex((r) => r.node.id === parentId);
      if (parentId !== null && index < 0) continue;
      const level = parentId === null ? 0 : (rows[index] as TreeRow).level + 1;
      const expanded = parentId === null ? true : (rows[index] as TreeRow).expanded;
      if (!expanded) continue;
      try {
        const page = await treeApi.children(siteId, parentId, 0, 500);
        const current = get().rows;
        const at = parentId === null ? -1 : current.findIndex((r) => r.node.id === parentId);
        if (parentId !== null && at < 0) continue;
        // 删除该父节点原有的子树行
        const next = [...current];
        const start = at + 1;
        let end = start;
        while (end < next.length && (next[end] as TreeRow).level > level - 1) end += 1;
        next.splice(start, end - start);
        // 插入新拉取的子行
        const children: TreeRow[] = page.nodes.map((node) => ({
          node,
          level,
          expanded: false,
          loading: false,
          loadedChildren: 0,
          selected: false,
        }));
        if (parentId === null) {
          set({ rows: children, ...(page.depths !== undefined ? { depths: page.depths } : {}) });
        } else {
          next.splice(start, 0, ...children);
          next[at] = { ...(next[at] as TreeRow), loading: false, expanded: true, loadedChildren: children.length };
          set({ rows: next, ...(page.depths !== undefined ? { depths: page.depths } : {}) });
        }
      } catch (err) {
        set({ error: err instanceof TreeApiError ? err.message : String(err) });
      }
    }
  },

  /**
   * 重载根 + 自顶向下重放已展开分支（保留展开态），并同步撤销栈深度。
   * 修正层操作（重挂/软删/撤销/还原）之后统一调用它。
   * 为什么不直接把所有 parentId 交给 reloadSubtrees：重载根层会先清空 rows，
   * 随后按旧 id 找不到父行，表现为「重挂后整棵树塌成一行」（踩过的坑）。
   */
  async refreshExpandedBranches(alsoExpand: string[] = []) {
    const previouslyExpanded = new Set([
      ...get().rows.filter((r) => r.expanded).map((r) => r.node.id),
      ...alsoExpand,
    ]);
    await get().loadRoot();

    await ensureRootExpanded(get, set);

    // 自顶向下逐层恢复：每轮挑「层级最小且尚未展开」的节点
    for (let guard = 0; guard < 200; guard++) {
      const candidate = get()
        .rows.filter((r) => r.node.child_count > 0 && !r.expanded && previouslyExpanded.has(r.node.id))
        .sort((a, b) => a.level - b.level)[0];
      if (candidate === undefined) break;
      await get().toggle(candidate.node.id);
    }
  },

  async toggle(nodeId) {
    const state = get();
    const index = state.rows.findIndex((r) => r.node.id === nodeId);
    const row = state.rows[index];
    if (row === undefined) return;

    if (row.expanded) {
      const rows = [...state.rows];
      let end = index + 1;
      while (end < rows.length && (rows[end]?.level ?? 0) > row.level) end += 1;
      rows.splice(index, 1, { ...row, expanded: false });
      rows.splice(index + 1, end - index - 1);
      set({ rows });
      return;
    }

    if (row.loadedChildren > 0) {
      const rows = [...state.rows];
      rows.splice(index, 1, { ...row, expanded: true });
      set({ rows });
      return;
    }

    const rows = [...state.rows];
    rows.splice(index, 1, { ...row, loading: true, expanded: true });
    set({ rows });

    const siteId = state.siteId;
    if (siteId === null) return;
    try {
      const page = await treeApi.children(siteId, nodeId, 0, 200);
      const current = get().rows;
      const at = current.findIndex((r) => r.node.id === nodeId);
      if (at < 0) return;
      const children: TreeRow[] = page.nodes.map((child) => ({
        node: child,
        level: (current[at] as TreeRow).level + 1,
        expanded: false,
        loading: false,
        loadedChildren: 0,
        selected: false,
      }));
      const next = [...current];
      next.splice(at, 1, {
        ...(current[at] as TreeRow),
        loading: false,
        expanded: true,
        loadedChildren: children.length,
      });
      next.splice(at + 1, 0, ...children);
      set({ rows: next, ...(page.depths !== undefined ? { depths: page.depths } : {}) });
    } catch (err) {
      const current = get().rows;
      const at = current.findIndex((r) => r.node.id === nodeId);
      if (at >= 0) {
        const next = [...current];
        next.splice(at, 1, { ...(current[at] as TreeRow), loading: false });
        set({ rows: next });
      }
      set({ error: err instanceof TreeApiError ? err.message : String(err) });
    }
  },

  async expandAll(maxNodes = 800) {
    const siteId = get().siteId;
    if (siteId === null) return;
    for (let guard = 0; guard < 12; guard++) {
      const pending = get()
        .rows.filter((r) => !r.expanded && r.node.child_count > 0)
        .map((r) => r.node.id);
      if (pending.length === 0) break;
      if (get().rows.length >= maxNodes) {
        set({ error: `已达展开上限 ${maxNodes} 个节点，停止自动展开（可逐个展开或使用检索）` });
        break;
      }
      for (const id of pending) {
        await get().toggle(id);
        if (get().rows.length >= maxNodes) break;
      }
    }
  },

  collapseAll() {
    set({ rows: get().rows.filter((r) => r.level === 0).map((r) => ({ ...r, expanded: false })) });
  },

  setQuery(query) {
    set({ query });
  },

  setStatusFilter(status) {
    set({ statusFilter: status });
  },

  setRegexMode(value) {
    set({ regexMode: value });
  },

  /** 服务端检索（走 GET /api/sites/:id/search，大站不必把整棵树拉进内存） */
  async runSearch() {
    const state = get();
    const siteId = state.siteId;
    if (siteId === null) return;
    const q = state.query.trim();
    if (q.length === 0 && state.statusFilter === null) {
      set({ searchHits: null });
      return;
    }
    try {
      const result = await treeApi.search(siteId, {
        q,
        status: state.statusFilter,
        regex: state.regexMode,
        limit: 200,
      });
      set({ searchHits: result.nodes, error: null });
    } catch (err) {
      set({ error: err instanceof TreeApiError ? err.message : String(err), searchHits: [] });
    }
  },

  async setMode(mode) {
    set({ mode, detail: null });
    if (mode === 'trash') await get().loadTrash();
    else await get().loadRoot();
  },

  async loadTrash() {
    const siteId = get().siteId;
    if (siteId === null) return;
    set({ loading: true });
    try {
      const response = await treeApi.trash(siteId);
      set({
        trash: response.entries,
        loading: false,
        error: null,
        ...(response.depths !== undefined ? { depths: response.depths } : {}),
      });
    } catch (err) {
      set({ loading: false, error: err instanceof TreeApiError ? err.message : String(err) });
    }
  },

  async restore(nodeId) {
    const siteId = get().siteId;
    if (siteId === null) return;
    set({ busy: true });
    try {
      const result = await treeApi.restoreFromTrash(siteId, nodeId);
      set({ notice: `已恢复 ${result.restored} 个节点（恢复动作本身也可撤销）`, busy: false });
      await get().loadTrash();
    } catch (err) {
      set({ busy: false, error: err instanceof TreeApiError ? err.message : String(err) });
    }
  },

  toggleSelect(nodeId, exclusive = false) {
    const rows = get().rows.map((row) => {
      if (exclusive) return { ...row, selected: row.node.id === nodeId };
      if (row.node.id === nodeId) return { ...row, selected: !row.selected };
      return row;
    });
    set({ rows });
  },

  clearSelection() {
    set({ rows: get().rows.map((row) => (row.selected ? { ...row, selected: false } : row)) });
  },

  setDragging(ids) {
    set({ dragging: ids });
  },

  /** 重挂（支持批量）：写修正层，成功后局部刷新受影响的两棵子树 */
  async moveNodes(ids, newParentId) {
    const state = get();
    const siteId = state.siteId;
    if (siteId === null || ids.length === 0) return;
    set({ busy: true, notice: null });
    try {
      const affectedParents = new Set<string | null>([newParentId]);
      for (const id of ids) {
        const row = state.rows.find((r) => r.node.id === id);
        if (row !== undefined) {
          const parent = state.rows.find((r) => r.node.id === id)?.node.effective_parent_id ?? null;
          affectedParents.add(parent);
        }
        // 折叠被移动的节点，避免留下悬空的子行
        void row;
      }
      const result = await treeApi.move(ids[0] as string, newParentId, ids);
      set({
        busy: false,
        notice:
          result.moved === 0
            ? '目标与当前父节点相同，未产生修改'
            : `已重挂 ${result.moved} 个节点（可 ⌘Z 撤销）`,
      });
      void affectedParents;
      /*
       * 让目标父节点在刷新后自动展开 —— 否则被移动的节点会「消失」，用户看不到结果。
       * 注意不能依赖内存里那行的 child_count 判断：重挂前 /team 的 child_count 还是 0
       * （它是被移动节点的「新」父节点），照它判断会跳过展开（踩过的坑）。
       */
      const mustExpand = result.moved > 0 && newParentId !== null ? [newParentId] : [];
      await get().refreshExpandedBranches(mustExpand);
      set({ rows: get().rows.map((r) => ({ ...r, selected: false })) });
    } catch (err) {
      set({ busy: false, error: err instanceof TreeApiError ? `${err.message}（${err.code}）` : String(err) });
    }
  },

  /** 软删子树（二次确认在 UI 层）：返回影响面 */
  async deleteNodes(ids) {
    const state = get();
    const siteId = state.siteId;
    if (siteId === null || ids.length === 0) return;
    set({ busy: true, notice: null });
    try {
      const affectedParents = new Set<string | null>();
      for (const id of ids) {
        const row = state.rows.find((r) => r.node.id === id);
        if (row !== undefined) affectedParents.add(row.node.effective_parent_id);
      }
      const result = await treeApi.remove(ids[0] as string, ids);
      set({
        busy: false,
        notice: `已软删 ${result.affectedNodes} 个节点（进回收站，可 ⌘Z 撤销）`,
        detail: state.detail !== null && result.nodeIds.includes(state.detail.node.id) ? null : state.detail,
      });
      void affectedParents;
      if (get().mode === 'trash') await get().loadTrash();
      else await get().refreshExpandedBranches();
      set({ rows: get().rows.map((r) => ({ ...r, selected: false })) });
    } catch (err) {
      set({ busy: false, error: err instanceof TreeApiError ? `${err.message}（${err.code}）` : String(err) });
    }
  },

  async undo() {
    const state = get();
    const siteId = state.siteId;
    if (siteId === null) return;
    set({ busy: true });
    try {
      const result = await treeApi.undo(siteId);
      set({
        busy: false,
        notice: `已撤销：${kindLabel(result.kind)}（影响 ${result.affected} 处）`,
        depths: { undoDepth: result.undoDepth, redoDepth: result.redoDepth },
      });
      if (state.mode === 'trash') await get().loadTrash();
      else await get().refreshExpandedBranches();
      if (state.detail !== null && state.mode === 'tree') await get().select(state.detail.node.id);
    } catch (err) {
      set({ busy: false, error: err instanceof TreeApiError ? `${err.message}（${err.code}）` : String(err) });
    }
  },

  async redo() {
    const state = get();
    const siteId = state.siteId;
    if (siteId === null) return;
    set({ busy: true });
    try {
      const result = await treeApi.redo(siteId);
      set({
        busy: false,
        notice: `已重做：${kindLabel(result.kind)}（影响 ${result.affected} 处）`,
        depths: { undoDepth: result.undoDepth, redoDepth: result.redoDepth },
      });
      if (state.mode === 'trash') await get().loadTrash();
      else await get().refreshExpandedBranches();
      if (state.detail !== null && state.mode === 'tree') await get().select(state.detail.node.id);
    } catch (err) {
      set({ busy: false, error: err instanceof TreeApiError ? `${err.message}（${err.code}）` : String(err) });
    }
  },

  /** 还原为自动结果（单节点） */
  async revertNode(nodeId) {
    const state = get();
    if (state.siteId === null) return;
    set({ busy: true });
    try {
      await treeApi.revert(nodeId);
      set({ busy: false, notice: '已还原为自动结果（该操作本身可撤销）' });
      await get().refreshExpandedBranches();
      await get().select(nodeId);
    } catch (err) {
      set({ busy: false, error: err instanceof TreeApiError ? `${err.message}（${err.code}）` : String(err) });
    }
  },

  async select(nodeId) {
    set({ detailLoading: true, detailError: null });
    try {
      const response = await treeApi.node(nodeId);
      set({ detail: response, detailLoading: false, depths: response.depths });
    } catch (err) {
      set({ detailLoading: false, detailError: err instanceof TreeApiError ? err.message : String(err) });
    }
  },

  closeDetail() {
    set({ detail: null, detailError: null });
  },

  async saveDetail(patch) {
    const state = get();
    const detail = state.detail;
    if (detail === null) return;
    set({ saving: true, notice: null });
    try {
      const response = await treeApi.patch(detail.node.id, patch);
      const rows = state.rows.map((row) => (row.node.id === response.node.id ? { ...row, node: response.node } : row));
      set({ rows, saving: false, detailError: null, notice: '已保存修改（可 ⌘Z 撤销）' });
      await get().select(detail.node.id);
    } catch (err) {
      set({ saving: false, detailError: err instanceof TreeApiError ? `${err.message}（${err.code}）` : String(err) });
    }
  },

  clearNotice() {
    set({ notice: null });
  },
}));

export type { NodeRecord, OverrideRecord, TrashEntry };
