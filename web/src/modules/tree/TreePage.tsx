/**
 * 树视图 —— 路由 /sites/:id/tree（requirements §4.5 / dev-spec §1 / §6.4）
 *
 * M2 交付范围：
 *   ✅ 虚拟滚动（@tanstack/react-virtual：万级节点只渲染可视行）
 *   ✅ 懒加载子节点 + 分页、行内短标签、URL 仅 tooltip、状态徽标、修正徽标
 *   ✅ 拖拽重挂（HTML5 原生 DnD）+ 多选批量重挂、软删子树（二次确认 + 影响面）
 *   ✅ 撤销/重做（按钮 + ⌘/Ctrl+Z、⌘/Ctrl+Shift+Z），按 op_group 原子
 *   ✅ 节点属性抽屉：改别名/标题/地址、还原为自动结果、修改历史
 *   ✅ 回收站：被软删的子树根，可恢复（恢复本身也可撤销）
 *   ✅ 检索走服务端 GET /search（正则/状态过滤）
 *
 * 本轮新增（requirements §4.5「其它易于理解和查看的拓扑展现形式」+ 原始网页视图）：
 *   ✅ 五种展现形式：目录树（虚拟滚动）/ 缩进列表 / 层级图 / 关系图（力导向）/ 径向图
 *   ✅ 网页视图：点任意节点的「查看网页」→ 服务端 Chromium 打开该节点原始页面（复用 M3 会话），
 *      在画面里点到**未收录的链接**会立即建边建节点，树与图形视图自动刷新
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { NODE_STATUSES } from '@siteatlas/shared';
import { navigate } from '../../router/useRoute.ts';
import { sitesApi } from '../sites/api.ts';
import { statusClass, statusLabel } from '../sites/types.ts';
import { deriveLabel, kindLabel, useTreeStore, type TreeRow, type TreeViewKind } from './store.ts';
import { IndentedView } from './IndentedView.tsx';
import { TopoView } from './TopoView.tsx';
import { RemoteBrowserView } from '../../components/RemoteBrowserView.tsx';
import { applyMaximizedAttribute, useFullscreen } from '../../components/useFullscreen.ts';
import { useManualStore } from '../manual/store.ts';
import type { GraphNode } from './store.ts';
import './tree.css';

export interface TreePageProps {
  siteId: string;
}

const ROW_HEIGHT = 32;

export function TreePage({ siteId }: TreePageProps): React.JSX.Element {
  const [siteName, setSiteName] = useState<string | null>(null);
  // 网页视图里的实时采集：会话每建一个节点就刷新树（点未收录链接 → 自动进拓扑）
  const nodesCreated = useManualStore((s) => s.state?.nodesCreated ?? 0);
  const manualSessionId = useManualStore((s) => s.sessionId);
  const manualState = useManualStore((s) => s.state);
  const manualViewport = useManualStore((s) => s.viewport);
  const manualBind = useManualStore((s) => s.bind);
  const manualUnbind = useManualStore((s) => s.unbind);
  const manualStart = useManualStore((s) => s.start);
  const manualStop = useManualStore((s) => s.stop);
  const manualSend = useManualStore((s) => s.send);
  const rows = useTreeStore((s) => s.rows);
  const loading = useTreeStore((s) => s.loading);
  const error = useTreeStore((s) => s.error);
  const notice = useTreeStore((s) => s.notice);
  const query = useTreeStore((s) => s.query);
  const statusFilter = useTreeStore((s) => s.statusFilter);
  const regexMode = useTreeStore((s) => s.regexMode);
  const searchHits = useTreeStore((s) => s.searchHits);
  const mode = useTreeStore((s) => s.mode);
  const trash = useTreeStore((s) => s.trash);
  const detail = useTreeStore((s) => s.detail);
  const detailLoading = useTreeStore((s) => s.detailLoading);
  const detailError = useTreeStore((s) => s.detailError);
  const saving = useTreeStore((s) => s.saving);
  const depths = useTreeStore((s) => s.depths);
  const busy = useTreeStore((s) => s.busy);
  const dragging = useTreeStore((s) => s.dragging);
  const viewKind = useTreeStore((s) => s.viewKind);
  const graphNodes = useTreeStore((s) => s.graphNodes);
  const graphTotal = useTreeStore((s) => s.graphTotal);
  const graphTruncated = useTreeStore((s) => s.graphTruncated);
  const graphLoading = useTreeStore((s) => s.graphLoading);
  const webNodeId = useTreeStore((s) => s.webNodeId);

  const bind = useTreeStore((s) => s.bind);
  const unbind = useTreeStore((s) => s.unbind);
  const toggle = useTreeStore((s) => s.toggle);
  const expandAll = useTreeStore((s) => s.expandAll);
  const collapseAll = useTreeStore((s) => s.collapseAll);
  const setQuery = useTreeStore((s) => s.setQuery);
  const setStatusFilter = useTreeStore((s) => s.setStatusFilter);
  const setRegexMode = useTreeStore((s) => s.setRegexMode);
  const runSearch = useTreeStore((s) => s.runSearch);
  const setMode = useTreeStore((s) => s.setMode);
  const restore = useTreeStore((s) => s.restore);
  const toggleSelect = useTreeStore((s) => s.toggleSelect);
  const clearSelection = useTreeStore((s) => s.clearSelection);
  const moveNodes = useTreeStore((s) => s.moveNodes);
  const deleteNodes = useTreeStore((s) => s.deleteNodes);
  const undo = useTreeStore((s) => s.undo);
  const setViewKind = useTreeStore((s) => s.setViewKind);
  const loadGraph = useTreeStore((s) => s.loadGraph);
  const refreshExpandedBranches = useTreeStore((s) => s.refreshExpandedBranches);
  const setWebNode = useTreeStore((s) => s.setWebNode);

  // 网页视图放大：应用内最大化 + 浏览器真全屏（两个独立开关，可组合）
  const fullscreen = useFullscreen();
  const webPanelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    applyMaximizedAttribute(fullscreen.maximized && webNodeId !== null);
  }, [fullscreen.maximized, webNodeId]);

  // Esc 先退最大化，再关网页视图（不与应用内的其它快捷键冲突）
  useEffect(() => {
    if (webNodeId === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (fullscreen.maximized || fullscreen.browserFullscreen) fullscreen.exit();
      else setWebNode(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [webNodeId, fullscreen, setWebNode]);
  const redo = useTreeStore((s) => s.redo);
  const revertNode = useTreeStore((s) => s.revertNode);
  const select = useTreeStore((s) => s.select);
  const closeDetail = useTreeStore((s) => s.closeDetail);
  const saveDetail = useTreeStore((s) => s.saveDetail);
  const clearNotice = useTreeStore((s) => s.clearNotice);
  const setDragging = useTreeStore((s) => s.setDragging);

  /**
   * 打开「原始网页」视图：
   *   · 该站点还没有会话 → 先起一个（M3 的手动会话，画面走 CDP 串流）；
   *   · 已有会话 → 直接让它打开这个节点的 URL；
   * 打开后画面里的点击由 M3 的配对逻辑处理，点到未收录链接会自动建边建节点。
   */
  const openWebView = useCallback(
    async (nodeId: string) => {
      setWebNode(nodeId);
      if (manualSessionId === null) {
        await manualStart({ url: undefined });
      }
      const sessionId = useManualStore.getState().sessionId;
      if (sessionId === null) return;
      try {
        const res = await fetch(`/api/manual/${encodeURIComponent(sessionId)}/open-node`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nodeId }),
        });
        if (!res.ok) {
          const body = (await res.json()) as { error?: { message?: string } };
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
      } catch (err) {
        useTreeStore.setState({ error: `打开原始网页失败：${(err as Error).message}` });
        setWebNode(null);
      }
    },
    [manualSessionId, manualStart, setWebNode],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 拖拽悬停目标：null = 没有，'' = 根层，其他 = 节点 id */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /**
   * 正在拖拽的节点 id（ref 同步保存）。
   * 不能只依赖 store 里的 dragging：dragstart → drop 可能在同一帧内完成，
   * React 状态更新尚未落地，drop 读到空数组就直接放弃了（拖拽"没反应"的根因）。
   */
  const dragIdsRef = useRef<string[]>([]);

  useEffect(() => {
    void bind(siteId);
    return () => unbind();
  }, [bind, unbind, siteId]);

  // 网页视图复用 M3 的手动会话：进入树视图时先看该站点有没有活动会话（有就直接能看画面）
  useEffect(() => {
    void manualBind(siteId);
    return () => manualUnbind();
  }, [manualBind, manualUnbind, siteId]);

  /**
   * 自动增量：网页视图里点到未收录的链接 → 会话建了节点 → 这里把树与图形视图刷新一遍。
   * 依赖 `state.nodesCreated`（会话内新建节点数）而不是手动点「刷新」——
   * requirements 要的是「点击未收录节点会自动添加节点拓扑信息」。
   */
  useEffect(() => {
    if (manualSessionId === null || nodesCreated === 0) return;
    void refreshExpandedBranches();
    if (useTreeStore.getState().graphNodes.length > 0) void loadGraph();
  }, [nodesCreated, manualSessionId, refreshExpandedBranches, loadGraph]);

  useEffect(() => {
    let cancelled = false;
    sitesApi
      .get(siteId)
      .then((payload) => {
        if (!cancelled) setSiteName(payload.site.name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  // 检索防抖：走服务端 GET /search
  useEffect(() => {
    if (mode !== 'tree') return;
    const timer = setTimeout(() => void runSearch(), 250);
    return () => clearTimeout(timer);
  }, [query, statusFilter, regexMode, mode, runSearch]);

  const selectedIds = useMemo(() => rows.filter((r) => r.selected).map((r) => r.node.id), [rows]);

  const doDelete = useCallback(() => {
    const ids = selectedIds.length > 0 ? selectedIds : detail !== null ? [detail.node.id] : [];
    if (ids.length === 0) return;
    let affected = 0;
    for (const id of ids) {
      const row = rows.find((r) => r.node.id === id);
      if (row !== undefined) affected += 1 + countDescendants(rows, row);
    }
    const label =
      ids.length === 1
        ? (rows.find((r) => r.node.id === ids[0])?.node.display_label ?? ids[0])
        : `${ids.length} 个节点`;
    if (
      !window.confirm(
        `确定软删除「${label}」及其子树？\n影响面：约 ${affected} 个节点（进回收站，可用 ⌘Z 撤销）`,
      )
    ) {
      return;
    }
    void deleteNodes(ids);
  }, [selectedIds, detail, rows, deleteNodes]);

  // 键盘：⌘/Ctrl+Z 撤销、⌘/Ctrl+Shift+Z 或 Ctrl+Y 重做、Delete 软删
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) void redo();
        else void undo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        void redo();
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length > 0) {
        event.preventDefault();
        doDelete();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo, doDelete, selectedIds.length]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const visibleItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  const dragOver = (event: React.DragEvent, targetId: string | null): void => {
    if (targetId !== null && dragIdsRef.current.includes(targetId)) return;
    // 必须 preventDefault，否则浏览器不会把它当成有效放置目标、drop 事件不触发
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
    setDropTarget(targetId);
  };

  const drop = (event: React.DragEvent, targetId: string | null): void => {
    event.preventDefault();
    // 阻止冒泡：行的 drop 会继续冒到容器的「放到根层」处理器，
    // 导致同一次拖拽先挂到目标行、紧接着又被移回根层（踩过的坑：拖拽"看起来没反应"）
    event.stopPropagation();
    setDropTarget(null);
    // 优先用 ref（同步）里的拖拽集合，state 作为兜底
    const ids = dragIdsRef.current.length > 0 ? dragIdsRef.current : dragging;
    dragIdsRef.current = [];
    setDragging([]);
    if (ids.length === 0) return;
    if (targetId !== null && ids.includes(targetId)) return;
    void moveNodes(ids, targetId);
  };

  return (
    <div className="page tree-page">
      <nav className="breadcrumb" aria-label="面包屑">
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => navigate('/sites')}>
          ← 站点
        </button>
        <span className="breadcrumb__sep" aria-hidden="true">
          /
        </span>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => navigate(`/sites/${siteId}`)}>
          {siteName ?? siteId}
        </button>
        <span className="breadcrumb__sep" aria-hidden="true">
          /
        </span>
        <span>结构</span>
      </nav>

      <header className="page__header">
        <div className="page__title-group">
          <h1>结构</h1>
          <p className="page__subtitle">
            树是 URL 图的生成树投影；拖拽改挂父节点（写入修正层，可撤销），删除一律软删进回收站。
          </p>
        </div>
        <div className="crawl-controlbar">
          <button
            type="button"
            className="btn"
            onClick={() => void undo()}
            disabled={busy || depths.undoDepth === 0}
            title="撤销最近一次人工修正（⌘Z）"
          >
            ↺ 撤销{depths.undoDepth > 0 ? ` (${depths.undoDepth})` : ''}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void redo()}
            disabled={busy || depths.redoDepth === 0}
            title="重做（⌘⇧Z）"
          >
            ↻ 重做{depths.redoDepth > 0 ? ` (${depths.redoDepth})` : ''}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void expandAll()} disabled={loading || mode === 'trash'}>
            展开全部
          </button>
          <button type="button" className="btn btn--ghost" onClick={collapseAll} disabled={mode === 'trash'}>
            折叠全部
          </button>
          <button
            type="button"
            className={mode === 'trash' ? 'btn btn--primary' : 'btn'}
            onClick={() => void setMode(mode === 'trash' ? 'tree' : 'trash')}
          >
            🗑 回收站
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => navigate(`/sites/${siteId}/crawl`)}>
            ← 采集控制台
          </button>
        </div>
      </header>

      {error !== null ? (
        <div className="alert alert--warning" role="alert">
          {error}
        </div>
      ) : null}
      {notice !== null ? (
        <div className="alert alert--info" role="status">
          <span>{notice}</span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={clearNotice}>
            知道了
          </button>
        </div>
      ) : null}

      {selectedIds.length > 0 && mode === 'tree' ? (
        <div className="tree-batchbar" role="toolbar" aria-label="批量操作">
          <span className="badge badge--muted">已选 {selectedIds.length} 个节点</span>
          <span className="field__hint">拖拽其中任意一行到目标行即可批量重挂</span>
          <button type="button" className="btn btn--sm" onClick={() => void moveNodes(selectedIds, null)} disabled={busy}>
            移到根层
          </button>
          <button type="button" className="btn btn--sm btn--danger" onClick={doDelete} disabled={busy}>
            软删选中子树
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={clearSelection}>
            取消选择
          </button>
        </div>
      ) : null}

      {mode === 'tree' ? (
        <>
          <div className="tree-toolbar">
            <label className="field tree-toolbar__search">
              <span className="visually-hidden">检索</span>
              <input
                className="input"
                type="search"
                placeholder="按标题 / 别名 / URL 检索（服务端过滤）"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="visually-hidden">状态过滤</span>
              <select
                className="select"
                value={statusFilter ?? ''}
                onChange={(e) => setStatusFilter(e.target.value === '' ? null : e.target.value)}
              >
                <option value="">全部状态</option>
                {NODE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(status)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field__hint" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
              <input type="checkbox" checked={regexMode} onChange={(e) => setRegexMode(e.target.checked)} />
              正则
            </label>
            <label className="field tree-toolbar__view">
              <span className="visually-hidden">展现形式</span>
              <select
                className="select"
                data-testid="tree-view-kind"
                value={viewKind}
                onChange={(e) => void setViewKind(e.target.value as TreeViewKind)}
                title="同一棵树的不同看法：目录树适合万级站点，缩进列表适合扫读，层级/关系/径向图适合看结构"
              >
                <option value="outline">目录树（虚拟滚动）</option>
                <option value="indent">缩进列表（整树铺开）</option>
                <option value="layered">层级图（按深度分层）</option>
                <option value="force">关系图（力导向）</option>
                <option value="radial">径向图（根在圆心）</option>
              </select>
            </label>
            <span className="field__hint">
              已加载 {rows.length} 行
              {searchHits !== null ? ` · 检索命中 ${searchHits.length} 个节点` : ''}
            </span>
          </div>

          <div className={`tree-layout${webNodeId !== null ? ' tree-layout--with-web' : ''}`}>
            <div className="panel tree-panel">
              {viewKind === 'indent' || viewKind === 'layered' || viewKind === 'force' || viewKind === 'radial' ? (
                <div className="tree-alt-view">
                  {graphLoading && graphNodes.length === 0 ? (
                    <div className="skeleton" style={{ height: 320 }} />
                  ) : graphNodes.length === 0 ? (
                    <div className="empty">
                      <p>这个站点还没有节点。</p>
                    </div>
                  ) : viewKind === 'indent' ? (
                    <IndentedView
                      nodes={graphNodes}
                      selectedId={detail?.node.id ?? null}
                      onSelect={(nodeId) => void select(nodeId)}
                      onOpen={(nodeId) => openWebView(nodeId)}
                    />
                  ) : (
                    <TopoView
                      nodes={graphNodes}
                      layoutKind={viewKind}
                      selectedId={detail?.node.id ?? null}
                      onSelect={(nodeId) => void select(nodeId)}
                      onOpen={(nodeId) => openWebView(nodeId)}
                    />
                  )}
                  {graphTruncated && (
                    <p className="field__hint">
                      站点共 {graphTotal} 个节点，图形视图只画前 {graphNodes.length} 个（再多请用「导出」拿全量数据）。
                    </p>
                  )}
                </div>
              ) : loading && rows.length === 0 ? (
                <div className="tree-skeleton" aria-busy="true">
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="skeleton" style={{ height: 22, marginBottom: 6 }} />
                  ))}
                </div>
              ) : rows.length === 0 ? (
                <div className="empty">
                  <span className="empty__icon" aria-hidden="true">
                    ⌥
                  </span>
                  <p>这个站点还没有节点。先去采集控制台跑一次自动采集，树会长出来。</p>
                  <button type="button" className="btn btn--primary" onClick={() => navigate(`/sites/${siteId}/crawl`)}>
                    去采集
                  </button>
                </div>
              ) : (
                <div
                  className={`tree-viewport${dropTarget === '' ? ' tree-viewport--drop-root' : ''}`}
                  ref={scrollRef}
                  onDragOver={(e) => dragOver(e, null)}
                  onDrop={(e) => drop(e, null)}
                  onDragLeave={() => setDropTarget(null)}
                  data-droppable="root"
                >
                  <div className="tree-rows" style={{ height: totalSize }}>
                    <div
                      style={{
                        transform: `translateY(${visibleItems[0]?.start ?? 0}px)`,
                        position: 'absolute',
                        width: '100%',
                      }}
                    >
                      {visibleItems.map((item) => {
                        const row = rows[item.index] as TreeRow;
                        return (
                          <TreeRowView
                            key={row.node.id}
                            row={row}
                            height={ROW_HEIGHT}
                            selected={detail?.node.id === row.node.id}
                            isDropTarget={dropTarget === row.node.id}
                            dragging={dragging.includes(row.node.id)}
                            onToggle={() => void toggle(row.node.id)}
                            onSelect={(exclusive) => {
                              void select(row.node.id);
                              if (exclusive) toggleSelect(row.node.id, true);
                            }}
                            onToggleSelect={() => toggleSelect(row.node.id)}
                            onDragStart={(event) => {
                              const ids =
                                selectedIds.length > 0
                                  ? [...new Set([...selectedIds, row.node.id])]
                                  : [row.node.id];
                              dragIdsRef.current = ids;
                              setDragging(ids);
                              // 明确写入 dataTransfer：空 dataTransfer 会让部分浏览器取消拖拽
                              if (event.dataTransfer !== null) {
                                event.dataTransfer.effectAllowed = 'move';
                                event.dataTransfer.setData('text/plain', ids.join(','));
                              }
                            }}
                            onDragEnd={() => {
                              dragIdsRef.current = [];
                              setDragging([]);
                            }}
                            onDragOver={(e) => dragOver(e, row.node.id)}
                            onDrop={(e) => drop(e, row.node.id)}
                          />
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
              <p className="field__hint tree-hint">
                提示：拖拽行到另一行 = 改挂父节点；⌘/Ctrl 点击行 = 多选；⌘Z 撤销、⌘⇧Z 重做、Delete 软删选中。
              </p>
            </div>

            <aside className="panel tree-detail" aria-label="节点属性">
              <header className="crawl-panel__head">
                <h2>节点属性</h2>
                {detail !== null ? (
                  <>
                    <button
                      type="button"
                      className="btn btn--sm"
                      data-testid="open-web-view"
                      onClick={() => void openWebView(detail.node.id)}
                      title="在右侧网页视图里打开该节点的原始页面；点到未收录的链接会自动加入拓扑"
                    >
                      🔗 查看原始网页
                    </button>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={closeDetail}>
                      关闭
                    </button>
                  </>
                ) : null}
              </header>
              {detailLoading ? (
                <div className="skeleton" style={{ height: 200 }} />
              ) : detail === null ? (
                <p className="field__hint">点击左侧任意节点查看属性；拖拽可改挂父节点。</p>
              ) : (
                <NodeDetailPanel
                  detail={detail}
                  saving={saving}
                  error={detailError}
                  onSave={(patch) => void saveDetail(patch)}
                  onRevert={() => void revertNode(detail.node.id)}
                  onDelete={() => {
                    if (window.confirm(`确定软删除「${detail.node.display_label ?? detail.node.url}」及其子树？`)) {
                      void deleteNodes([detail.node.id]);
                    }
                  }}
                  onGoParent={(parentId) => void select(parentId)}
                />
              )}
            </aside>

            {webNodeId !== null && (
              <aside className="panel tree-web" aria-label="原始网页" data-testid="tree-web-view" ref={webPanelRef}>
                <header className="crawl-panel__head">
                  <h2>原始网页</h2>
                  <span className="field__hint">
                    {manualState?.clicks.paired ?? 0} 次配对 → 新建 {manualState?.nodesCreated ?? 0} 个节点 /{' '}
                    {manualState?.edgesCreated ?? 0} 条边
                  </span>
                  <button
                    type="button"
                    className="btn btn--sm"
                    data-testid="web-maximize"
                    onClick={() => fullscreen.toggleMaximize()}
                    title="最大化画面（隐藏其它面板；Esc 退出）"
                  >
                    {fullscreen.maximized ? '⤡ 退出最大化' : '⤢ 最大化'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    data-testid="web-fullscreen"
                    onClick={() => fullscreen.toggleBrowserFullscreen(webPanelRef.current)}
                    title="浏览器全屏显示这块画面（支持时用 F11 / Esc 退出）"
                  >
                    {fullscreen.browserFullscreen ? '⤡ 退出全屏' : '⛶ 全屏'}
                  </button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setWebNode(null)}>
                    收起
                  </button>
                </header>

                {manualSessionId === null ? (
                  <div className="skeleton" style={{ height: 240 }} />
                ) : (
                  <>
                    <div className="tree-web__bar">
                      <input
                        className="input mono"
                        readOnly
                        value={manualState?.current?.url ?? ''}
                        title="当前网页地址（由所选节点决定）"
                      />
                      <button type="button" className="btn btn--sm" onClick={() => manualSend({ type: 'back-root' })}>
                        回根
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() => void manualStop()}
                        title="结束后画面关闭；已采集到的节点与边都保留"
                      >
                        结束
                      </button>
                    </div>
                    <RemoteBrowserView
                      viewport={manualViewport}
                      interactive={manualState?.status === 'running'}
                      fit={fullscreen.maximized || fullscreen.browserFullscreen ? 'fill' : 'contain'}
                    />
                    <p className="field__hint">
                      在画面里点击**未收录的链接**：会自动新建节点与边并刷新左侧拓扑（已收录的链接只补边，不重复建节点）。
                      页内锚点/JS 行为等未触发导航的点击进「待确认」，可在采集页处理。
                    </p>
                  </>
                )}
              </aside>
            )}
          </div>
        </>
      ) : (
        <section className="panel tree-trash" aria-label="回收站">
          <header className="crawl-panel__head">
            <h2>回收站</h2>
            <span className="field__hint">软删的子树根；恢复后可再撤销</span>
          </header>
          {trash.length === 0 ? (
            <div className="empty">
              <span className="empty__icon" aria-hidden="true">
                🗑
              </span>
              <p>回收站是空的。删除一律软删，随时可以从这里恢复。</p>
            </div>
          ) : (
            <ul className="trash-list">
              {trash.map((entry) => (
                <li key={entry.nodeId} className="trash-list__item">
                  <span className="tree-row__icon" aria-hidden="true">
                    ▤
                  </span>
                  <span className="trash-list__label" title={entry.node?.url ?? entry.nodeId}>
                    {entry.node?.display_label ?? entry.node?.url ?? entry.nodeId}
                  </span>
                  <span className="badge badge--muted">{entry.affectedNodes} 个节点</span>
                  <button type="button" className="btn btn--sm" onClick={() => void restore(entry.nodeId)} disabled={busy}>
                    恢复
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function countDescendants(rows: TreeRow[], row: TreeRow): number {
  const index = rows.findIndex((r) => r.node.id === row.node.id);
  let count = 0;
  for (let i = index + 1; i < rows.length; i++) {
    const next = rows[i];
    if (next === undefined || next.level <= row.level) break;
    count += 1;
  }
  return count;
}

function TreeRowView({
  row,
  height,
  selected,
  isDropTarget,
  dragging,
  onToggle,
  onSelect,
  onToggleSelect,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  row: TreeRow;
  height: number;
  selected: boolean;
  isDropTarget: boolean;
  dragging: boolean;
  onToggle: () => void;
  onSelect: (exclusive: boolean) => void;
  onToggleSelect: () => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
}): React.JSX.Element {
  const { node, level, expanded, loading, selected: multiSelected } = row;
  const hasChildren = node.child_count > 0;

  return (
    <div
      className={`tree-row${selected ? ' tree-row--selected' : ''}${isDropTarget ? ' tree-row--drop' : ''}${dragging ? ' tree-row--dragging' : ''}`}
      style={{ paddingLeft: 8 + level * 22, height }}
      title={node.url}
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      aria-level={level + 1}
      aria-selected={selected}
      draggable
      data-droppable="row"
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={(e) => onSelect(e.metaKey || e.ctrlKey)}
    >
      <input
        type="checkbox"
        className="tree-row__check"
        checked={multiSelected}
        aria-label={`选择 ${node.display_label ?? node.url}`}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggleSelect}
      />
      <button
        type="button"
        className="tree-row__toggle"
        aria-label={hasChildren ? (expanded ? '折叠' : '展开') : '无子节点'}
        disabled={!hasChildren}
        onClick={(e) => {
          e.stopPropagation();
          if (hasChildren) onToggle();
        }}
      >
        {loading ? '…' : hasChildren ? (expanded ? '▾' : '▸') : '·'}
      </button>
      <span className="tree-row__icon" aria-hidden="true">
        {node.alias !== null ? '✎' : '▤'}
      </span>
      <span className="tree-row__label">{node.display_label ?? node.url}</span>
      {node.has_override ? <span className="badge badge--need-human">已修改</span> : null}
      <span className="nav__spacer" />
      <span className="tree-row__children">{node.child_count > 0 ? `${node.child_count} 子` : ''}</span>
      <span className={statusClass(node.status)}>{statusLabel(node.status)}</span>
      <span className="tree-row__depth">d{node.depth}</span>
    </div>
  );
}

function NodeDetailPanel({
  detail,
  saving,
  error,
  onSave,
  onRevert,
  onDelete,
  onGoParent,
}: {
  detail: NonNullable<ReturnType<typeof useTreeStore.getState>['detail']>;
  saving: boolean;
  error: string | null;
  onSave: (patch: { alias?: string | null; title?: string | null; url?: string }) => void;
  onRevert: () => void;
  onDelete: () => void;
  onGoParent: (parentId: string) => void;
}): React.JSX.Element {
  const [alias, setAlias] = useState(detail.node.alias ?? '');
  const [title, setTitle] = useState(detail.node.title ?? '');
  const [url, setUrl] = useState(detail.node.url);
  const [editingUrl, setEditingUrl] = useState(false);

  useEffect(() => {
    setAlias(detail.node.alias ?? '');
    setTitle(detail.node.title ?? '');
    setUrl(detail.node.url);
    setEditingUrl(false);
  }, [detail.node.id, detail.node.alias, detail.node.title, detail.node.url]);

  const dirty =
    (detail.node.alias ?? '') !== alias ||
    (detail.node.title ?? '') !== title ||
    (editingUrl && detail.node.url !== url);

  return (
    <div className="tree-detail__body">
      <div className="field">
        <span className="field__label">地址（默认不显示在行内）</span>
        {editingUrl ? (
          <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} />
        ) : (
          <span className="mono tree-detail__url">{detail.node.url}</span>
        )}
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditingUrl((v) => !v)}>
          {editingUrl ? '取消修改地址' : '修改地址'}
        </button>
        {editingUrl ? (
          <span className="field__hint">
            改的是采集目标地址；旧值保留在修改历史里（identityKey 不变，避免同一资源分裂成两个节点）
          </span>
        ) : null}
      </div>

      <label className="field">
        <span className="field__label">别名（展示优先）</span>
        <input className="input" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="例如：产品文档" />
      </label>
      <label className="field">
        <span className="field__label">标题</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>

      <div className="tree-detail__actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={!dirty || saving}
          onClick={() =>
            onSave({
              alias: alias.length > 0 ? alias : null,
              title: title.length > 0 ? title : null,
              ...(editingUrl && url !== detail.node.url ? { url } : {}),
            })
          }
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={!dirty || saving}
          onClick={() => {
            setAlias(detail.node.alias ?? '');
            setTitle(detail.node.title ?? '');
            setUrl(detail.node.url);
          }}
        >
          重置
        </button>
        {detail.node.has_override ? (
          <button type="button" className="btn btn--sm" onClick={onRevert} disabled={saving} title="撤销该节点全部人工修正">
            还原为自动结果
          </button>
        ) : null}
        <button type="button" className="btn btn--sm btn--danger" onClick={onDelete} disabled={saving}>
          软删子树
        </button>
      </div>
      {error !== null ? (
        <div className="alert alert--error" role="alert">
          {error}
        </div>
      ) : null}

      <dl className="kv">
        <div className="kv__item">
          <dt>状态</dt>
          <dd>
            <span className={statusClass(detail.node.status)}>{statusLabel(detail.node.status)}</span>
          </dd>
        </div>
        <div className="kv__item">
          <dt>最小深度</dt>
          <dd>{detail.node.depth}</dd>
        </div>
        <div className="kv__item">
          <dt>入链 / 出链</dt>
          <dd>
            {detail.node.in_link_count} / {detail.node.out_link_count}
          </dd>
        </div>
        <div className="kv__item">
          <dt>HTTP 状态</dt>
          <dd>{detail.node.http_status ?? '—'}</dd>
        </div>
        <div className="kv__item">
          <dt>内容指纹</dt>
          <dd className="mono">
            {detail.node.content_hash === null ? '—' : `${detail.node.content_hash.slice(0, 12)}…`}
          </dd>
        </div>
      </dl>

      <h3 className="crawl-subhead">父节点列表（{detail.parents.length}）</h3>
      {detail.parents.length === 0 ? (
        <p className="field__hint">根节点没有入链。</p>
      ) : (
        <ul className="link-list">
          {detail.parents.map((parent, index) => (
            <li key={`${parent.from?.id ?? 'x'}-${index}`} className="link-list__item">
              {parent.from !== null ? (
                <button type="button" className="link-button" onClick={() => onGoParent(parent.from?.id ?? '')}>
                  {parent.from.display_label ?? parent.from.url}
                </button>
              ) : (
                <span>未知</span>
              )}
              {parent.edge.anchor_text !== null ? (
                <span className="link-list__anchor">“{parent.edge.anchor_text}”</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h3 className="crawl-subhead">修改历史（{detail.history.length}）</h3>
      {detail.history.length === 0 ? (
        <p className="field__hint">该节点还没有人工修改。</p>
      ) : (
        <ul className="history-list">
          {detail.history.map((entry) => (
            <li key={entry.id} className="history-list__item">
              <span className={`badge ${entry.undone === 1 ? 'badge--muted' : 'badge--ok'}`}>
                {entry.undone === 1 ? '已撤销' : '生效中'}
              </span>
              <span className="history-list__kind">{kindLabel(entry.field)}</span>
              <span className="history-list__value mono" title={`${entry.prev_value ?? ''} → ${entry.value ?? ''}`}>
                {entry.prev_value ?? '—'} → {entry.value ?? '—'}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="crawl-subhead">出链（{detail.children.length}）</h3>
      <ul className="link-list">
        {detail.children.slice(0, 20).map((child, index) => (
          <li key={`${child.to?.id ?? 'y'}-${index}`} className="link-list__item">
            <span title={child.to?.url ?? ''}>{child.to?.display_label ?? child.to?.url ?? '未知'}</span>
          </li>
        ))}
      </ul>
      {detail.children.length > 20 ? <p className="field__hint">仅显示前 20 条出链</p> : null}
    </div>
  );
}
