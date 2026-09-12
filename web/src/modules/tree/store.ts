/**
 * 树模块状态（Zustand）：懒加载 + 折叠展开 + 扁平化（供虚拟滚动）+ 节点抽屉
 *
 * dev-spec §1 强制：子节点必须按 parent_id 懒加载 + 分页；
 * §4.5/§6.4：行内只显示短标签（别名 > 标题 > 路径末段），URL 不占布局，仅 tooltip。
 */
import { create } from 'zustand';
import type { NodeRecord, TreeNodeRow } from '@siteatlas/shared';
import { TreeApiError, treeApi } from './api.ts';

export interface TreeRow {
  node: TreeNodeRow;
  /** 缩进层级（= 树中层级，不等于 node.depth，后者是最小深度） */
  level: number;
  expanded: boolean;
  loading: boolean;
  /** 已加载的直接子节点数 */
  loadedChildren: number;
}

export interface NodeDetailState {
  node: TreeNodeRow;
  parents: Array<{ anchor: string | null; from: NodeRecord | null }>;
  children: Array<{ order: number | null; to: NodeRecord | null }>;
}

export interface TreeStoreState {
  siteId: string | null;
  rows: TreeRow[];
  loading: boolean;
  error: string | null;
  /** 关键字过滤（标题/别名/URL） */
  query: string;
  statusFilter: string | null;
  detail: NodeDetailState | null;
  detailLoading: boolean;
  detailError: string | null;
  saving: boolean;

  bind: (siteId: string) => Promise<void>;
  unbind: () => void;
  loadRoot: () => Promise<void>;
  toggle: (nodeId: string) => Promise<void>;
  expandAll: (maxNodes?: number) => Promise<void>;
  collapseAll: () => void;
  setQuery: (query: string) => void;
  setStatusFilter: (status: string | null) => void;
  select: (nodeId: string) => Promise<void>;
  closeDetail: () => void;
  saveDetail: (patch: { alias?: string | null; title?: string | null }) => Promise<void>;
}

function countLoadedChildren(rows: TreeRow[], parentId: string): number {
  const index = rows.findIndex((r) => r.node.id === parentId);
  if (index < 0) return 0;
  const level = rows[index]?.level ?? 0;
  let count = 0;
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined || row.level <= level) break;
    if (row.level === level + 1) count += 1;
  }
  return count;
}

export const useTreeStore = create<TreeStoreState>((set, get) => ({
  siteId: null,
  rows: [],
  loading: false,
  error: null,
  query: '',
  statusFilter: null,
  detail: null,
  detailLoading: false,
  detailError: null,
  saving: false,

  async bind(siteId) {
    if (get().siteId === siteId && get().rows.length > 0) return;
    set({ siteId, rows: [], detail: null, error: null, query: '', statusFilter: null });
    await get().loadRoot();
  },

  unbind() {
    set({ siteId: null, rows: [], detail: null, error: null });
  },

  async loadRoot() {
    const siteId = get().siteId;
    if (siteId === null) return;
    set({ loading: true });
    try {
      const page = await treeApi.children(siteId, null, 0, 50);
      set({
        rows: page.nodes.map((node) => ({ node, level: 0, expanded: false, loading: false, loadedChildren: 0 })),
        loading: false,
        error: null,
      });
    } catch (err) {
      set({ loading: false, error: err instanceof TreeApiError ? err.message : String(err) });
    }
  },

  async toggle(nodeId) {
    const state = get();
    const index = state.rows.findIndex((r) => r.node.id === nodeId);
    const row = state.rows[index];
    if (row === undefined) return;

    if (row.expanded) {
      // 折叠：移除其后所有更深层级行
      const rows = [...state.rows];
      let end = index + 1;
      while (end < rows.length && (rows[end]?.level ?? 0) > row.level) end += 1;
      rows.splice(index, 1, { ...row, expanded: false });
      rows.splice(index + 1, end - index - 1);
      set({ rows });
      return;
    }

    if (row.loadedChildren > 0) {
      // 已加载过：仅展开（不重复请求）
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
        level: (current[at]?.level ?? 0) + 1,
        expanded: false,
        loading: false,
        loadedChildren: 0,
      }));
      const next = [...current];
      next.splice(at, 1, { ...(current[at] as TreeRow), loading: false, expanded: true, loadedChildren: children.length });
      next.splice(at + 1, 0, ...children);
      set({ rows: next });
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
    // 广度优先逐层展开，直到没有可展开节点或达到上限（防止误点把万级树全拉下来）
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

  async select(nodeId) {
    set({ detailLoading: true, detailError: null });
    try {
      const response = await treeApi.node(nodeId);
      set({
        detail: {
          node: response.node,
          parents: response.parents.map((p) => ({ anchor: p.edge.anchor_text, from: p.from })),
          children: response.children.map((c) => ({ order: c.edge.order_in_page, to: c.to })),
        },
        detailLoading: false,
      });
    } catch (err) {
      set({ detailLoading: false, detailError: err instanceof TreeApiError ? err.message : String(err) });
    }
  },

  closeDetail() {
    set({ detail: null, detailError: null });
  },

  async saveDetail(patch) {
    const detail = get().detail;
    if (detail === null) return;
    set({ saving: true });
    try {
      const response = await treeApi.patch(detail.node.id, patch);
      const rows = get().rows.map((row) => (row.node.id === response.node.id ? { ...row, node: response.node } : row));
      set({ rows, detail: { ...detail, node: response.node }, saving: false, detailError: null });
    } catch (err) {
      set({ saving: false, detailError: err instanceof TreeApiError ? err.message : String(err) });
    }
  },
}));

export { countLoadedChildren };
