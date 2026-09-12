/**
 * 树视图 —— 路由 /sites/:id/tree（requirements §4.5 / dev-spec §1）
 *
 * M1 交付范围（M2 再补）：
 *   ✅ 懒加载子节点 + 分页、行内显示展开箭头/图标/短标签/子节点数/状态徽标
 *   ✅ URL 不在行内显示（hover tooltip 给出全文）
 *   ✅ 检索过滤、节点属性抽屉（别名/标题可改，其余字段只读）
 *   ✅ 列表超过阈值时启用窗口化渲染（虚拟滚动的 M1 形态）
 *   ⛔ 拖拽重挂 / 撤销重做 / 修改地址 / 子树软删 → M2（写入修正层）
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { NODE_STATUSES } from '@siteatlas/shared';
import { navigate } from '../../router/useRoute.ts';
import { sitesApi } from '../sites/api.ts';
import { statusClass, statusLabel } from '../sites/types.ts';
import { useTreeStore, type TreeRow } from './store.ts';
import './tree.css';

export interface TreePageProps {
  siteId: string;
}

const ROW_HEIGHT = 32;
const WINDOW_SIZE = 200;
const OVERSCAN = 12;

export function TreePage({ siteId }: TreePageProps): React.JSX.Element {
  const [siteName, setSiteName] = useState<string | null>(null);
  const rows = useTreeStore((s) => s.rows);
  const loading = useTreeStore((s) => s.loading);
  const error = useTreeStore((s) => s.error);
  const query = useTreeStore((s) => s.query);
  const statusFilter = useTreeStore((s) => s.statusFilter);
  const detail = useTreeStore((s) => s.detail);
  const detailLoading = useTreeStore((s) => s.detailLoading);
  const detailError = useTreeStore((s) => s.detailError);
  const saving = useTreeStore((s) => s.saving);
  const bind = useTreeStore((s) => s.bind);
  const unbind = useTreeStore((s) => s.unbind);
  const toggle = useTreeStore((s) => s.toggle);
  const expandAll = useTreeStore((s) => s.expandAll);
  const collapseAll = useTreeStore((s) => s.collapseAll);
  const setQuery = useTreeStore((s) => s.setQuery);
  const setStatusFilter = useTreeStore((s) => s.setStatusFilter);
  const loadRoot = useTreeStore((s) => s.loadRoot);
  const select = useTreeStore((s) => s.select);
  const closeDetail = useTreeStore((s) => s.closeDetail);
  const saveDetail = useTreeStore((s) => s.saveDetail);

  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void bind(siteId);
    return () => unbind();
  }, [bind, unbind, siteId]);

  useEffect(() => {
    let cancelled = false;
    sitesApi
      .get(siteId)
      .then((detail) => {
        if (!cancelled) setSiteName(detail.site.name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== null && row.node.status !== statusFilter) return false;
      if (q.length === 0) return true;
      const haystack = `${row.node.display_label ?? ''} ${row.node.alias ?? ''} ${row.node.title ?? ''} ${row.node.url}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [rows, query, statusFilter]);

  const windowed = filtered.length > WINDOW_SIZE;
  const start = windowed ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const end = windowed ? Math.min(filtered.length, start + Math.ceil(600 / ROW_HEIGHT) + OVERSCAN * 2) : filtered.length;
  const visible = filtered.slice(start, end);

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
            树是 URL 图的生成树投影：父节点由「首次发现」的链接决定，同一 URL 只出现一个节点。
          </p>
        </div>
        <div className="crawl-controlbar">
          <button type="button" className="btn" onClick={() => void expandAll()} disabled={loading}>
            展开全部
          </button>
          <button type="button" className="btn btn--ghost" onClick={collapseAll}>
            折叠全部
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void loadRoot()} disabled={loading}>
            刷新
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

      <div className="tree-toolbar">
        <label className="field tree-toolbar__search">
          <span className="visually-hidden">检索</span>
          <input
            className="input"
            type="search"
            placeholder="按标题 / 别名 / URL 检索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="visually-hidden">状态过滤</span>
          <select className="select" value={statusFilter ?? ''} onChange={(e) => setStatusFilter(e.target.value === '' ? null : e.target.value)}>
            <option value="">全部状态</option>
            {NODE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {statusLabel(status)}
              </option>
            ))}
          </select>
        </label>
        <span className="field__hint">
          已加载 {rows.length} 行{query.length > 0 || statusFilter !== null ? ` · 命中 ${filtered.length} 行` : ''}
          {windowed ? ' · 已启用窗口化渲染' : ''}
        </span>
      </div>

      <div className="tree-layout">
        <div className="panel tree-panel">
          {loading && rows.length === 0 ? (
            <div className="tree-skeleton" aria-busy="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="skeleton" style={{ height: 22, marginBottom: 6 }} />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              <span className="empty__icon" aria-hidden="true">
                ⌥
              </span>
              {rows.length === 0 ? (
                <>
                  <p>这个站点还没有节点。先去采集控制台跑一次自动采集，树会长出来。</p>
                  <button type="button" className="btn btn--primary" onClick={() => navigate(`/sites/${siteId}/crawl`)}>
                    去采集
                  </button>
                </>
              ) : (
                <p>没有匹配「{query}」的节点。</p>
              )}
            </div>
          ) : (
            <div
              className="tree-viewport"
              ref={viewportRef}
              onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
            >
              <div className="tree-rows" style={windowed ? { height: filtered.length * ROW_HEIGHT } : undefined}>
                <div style={windowed ? { transform: `translateY(${start * ROW_HEIGHT}px)` } : undefined}>
                  {visible.map((row) => (
                    <TreeRowView
                      key={row.node.id}
                      row={row}
                      selected={detail?.node.id === row.node.id}
                      onToggle={() => void toggle(row.node.id)}
                      onSelect={() => void select(row.node.id)}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="panel tree-detail" aria-label="节点属性">
          <header className="crawl-panel__head">
            <h2>节点属性</h2>
            {detail !== null ? (
              <button type="button" className="btn btn--sm btn--ghost" onClick={closeDetail}>
                关闭
              </button>
            ) : null}
          </header>
          {detailLoading ? (
            <div className="skeleton" style={{ height: 160 }} />
          ) : detail === null ? (
            <p className="field__hint">点击左侧任意节点查看属性。双击（或单击）行即打开。</p>
          ) : (
            <NodeDetailPanel
              detail={detail}
              saving={saving}
              error={detailError}
              onSave={(patch) => void saveDetail(patch)}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function TreeRowView({
  row,
  selected,
  onToggle,
  onSelect,
}: {
  row: TreeRow;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
}): React.JSX.Element {
  const { node, level, expanded, loading } = row;
  const hasChildren = node.child_count > 0;

  return (
    <div
      className={`tree-row${selected ? ' tree-row--selected' : ''}`}
      style={{ paddingLeft: 8 + level * 18 }}
      title={node.url}
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      aria-level={level + 1}
      onClick={onSelect}
      onDoubleClick={onSelect}
    >
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
      {node.has_override === 1 ? <span className="badge badge--need-human">已修改</span> : null}
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
}: {
  detail: NonNullable<ReturnType<typeof useTreeStore.getState>['detail']>;
  saving: boolean;
  error: string | null;
  onSave: (patch: { alias?: string | null; title?: string | null }) => void;
}): React.JSX.Element {
  const [alias, setAlias] = useState(detail.node.alias ?? '');
  const [title, setTitle] = useState(detail.node.title ?? '');

  useEffect(() => {
    setAlias(detail.node.alias ?? '');
    setTitle(detail.node.title ?? '');
  }, [detail.node.id, detail.node.alias, detail.node.title]);

  const dirty = (detail.node.alias ?? '') !== alias || (detail.node.title ?? '') !== title;

  return (
    <div className="tree-detail__body">
      <div className="field">
        <span className="field__label">地址（默认不显示在行内）</span>
        <span className="mono tree-detail__url">{detail.node.url}</span>
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
          onClick={() => onSave({ alias: alias.length > 0 ? alias : null, title: title.length > 0 ? title : null })}
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
          }}
        >
          重置
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
          <dd className="mono">{detail.node.content_hash === null ? '—' : `${detail.node.content_hash.slice(0, 12)}…`}</dd>
        </div>
      </dl>

      <h3 className="crawl-subhead">父节点列表（{detail.parents.length}）</h3>
      {detail.parents.length === 0 ? (
        <p className="field__hint">根节点没有入链。</p>
      ) : (
        <ul className="link-list">
          {detail.parents.map((parent, index) => (
            <li key={`${parent.from?.id ?? 'x'}-${index}`} className="link-list__item">
              <span title={parent.from?.url ?? ''}>{parent.from?.display_label ?? parent.from?.url ?? '未知'}</span>
              {parent.anchor !== null ? <span className="link-list__anchor">“{parent.anchor}”</span> : null}
            </li>
          ))}
        </ul>
      )}

      <h3 className="crawl-subhead">出链（{detail.children.length}）</h3>
      <ul className="link-list">
        {detail.children.slice(0, 30).map((child, index) => (
          <li key={`${child.to?.id ?? 'y'}-${index}`} className="link-list__item">
            <span title={child.to?.url ?? ''}>{child.to?.display_label ?? child.to?.url ?? '未知'}</span>
          </li>
        ))}
      </ul>
      {detail.children.length > 30 ? <p className="field__hint">仅显示前 30 条出链</p> : null}
    </div>
  );
}
