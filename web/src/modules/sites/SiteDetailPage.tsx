/**
 * 站点详情占位页 —— 路由 /sites/:id
 *
 * M0 交付范围：显示站点与根节点信息，并给出各模块入口占位；
 * 真正的内容由后续里程碑填充：crawl=M1、tree=M2、data/export=M4（dev-spec §7）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { SiteDetailResponse } from '@siteatlas/shared';
import { MODULES } from '../../router/modules.ts';
import { navigate } from '../../router/useRoute.ts';
import { ApiError, sitesApi } from './api.ts';
import { SCOPE_LABELS, formatTime, statusClass, statusLabel } from './types.ts';
import './sites.css';

export interface SiteDetailPageProps {
  siteId: string;
}

export function SiteDetailPage({ siteId }: SiteDetailPageProps): React.JSX.Element {
  const [detail, setDetail] = useState<SiteDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeModule, setActiveModule] = useState<string>('sites');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await sitesApi.get(siteId));
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}（${err.code}）` : String(err));
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="page">
        <div className="skeleton" style={{ height: 120, marginBottom: 'var(--sp-4)' }} />
        <div className="skeleton" style={{ height: 220 }} />
      </div>
    );
  }

  if (error !== null || detail === null) {
    return (
      <div className="page">
        <div className="alert alert--error" role="alert">
          <span>站点加载失败：{error ?? '未知错误'}</span>
          <button type="button" className="btn btn--sm" onClick={() => void load()}>
            重试
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => navigate('/sites')}>
            返回站点列表
          </button>
        </div>
      </div>
    );
  }

  const { site, stats, root } = detail;
  const siteModules = MODULES.filter((m) => m.perSite);

  return (
    <div className="page">
      <nav className="breadcrumb" aria-label="面包屑">
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => navigate('/sites')}>
          ← 站点
        </button>
        <span className="breadcrumb__sep" aria-hidden="true">
          /
        </span>
        <span>{site.name}</span>
      </nav>

      <header className="page__header">
        <div className="page__title-group">
          <h1>
            {site.name}{' '}
            <span className={statusClass(stats.rootStatus)}>{statusLabel(stats.rootStatus)}</span>
          </h1>
          <p className="page__subtitle mono">{site.root_url}</p>
        </div>
        <div className="sites-toolbar">
          <span className="badge badge--muted">{SCOPE_LABELS[site.scope] ?? site.scope}</span>
          <button type="button" className="btn" onClick={() => void load()}>
            刷新
          </button>
        </div>
      </header>

      <section className="panel detail-panel">
        <h2>站点信息</h2>
        <dl className="kv">
          <div className="kv__item">
            <dt>站点 ID</dt>
            <dd className="mono">{site.id}</dd>
          </div>
          <div className="kv__item">
            <dt>根域名</dt>
            <dd className="mono">{site.root_host}</dd>
          </div>
          <div className="kv__item">
            <dt>节点数</dt>
            <dd>{stats.nodeCount}</dd>
          </div>
          <div className="kv__item">
            <dt>最大深度</dt>
            <dd>{stats.maxDepth}</dd>
          </div>
          <div className="kv__item">
            <dt>创建时间</dt>
            <dd>{formatTime(site.created_at)}</dd>
          </div>
          <div className="kv__item">
            <dt>更新时间</dt>
            <dd>{formatTime(site.updated_at)}</dd>
          </div>
          <div className="kv__item">
            <dt>归档</dt>
            <dd>{site.archived === 1 ? '已软删除' : '正常'}</dd>
          </div>
          <div className="kv__item">
            <dt>备注</dt>
            <dd>{site.note ?? '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="panel detail-panel">
        <h2>根节点（depth=0）</h2>
        {root === null ? (
          <div className="alert alert--warning">未找到根节点记录。</div>
        ) : (
          <dl className="kv">
            <div className="kv__item">
              <dt>节点 ID</dt>
              <dd className="mono">{root.id}</dd>
            </div>
            <div className="kv__item">
              <dt>URL（含 fragment）</dt>
              <dd className="mono">{root.url}</dd>
            </div>
            <div className="kv__item">
              <dt>identityKey</dt>
              <dd className="mono">{root.identity_key}</dd>
            </div>
            <div className="kv__item">
              <dt>展示标签</dt>
              <dd>{root.display_label ?? '—'}</dd>
            </div>
            <div className="kv__item">
              <dt>状态</dt>
              <dd>
                <span className={statusClass(root.status)}>{statusLabel(root.status)}</span>
              </dd>
            </div>
            <div className="kv__item">
              <dt>HTTP 状态</dt>
              <dd>{root.http_status ?? '—'}</dd>
            </div>
            <div className="kv__item">
              <dt>Content-Type</dt>
              <dd className="mono">{root.content_type ?? '—'}</dd>
            </div>
            <div className="kv__item">
              <dt>首次发现</dt>
              <dd>{formatTime(root.first_seen_at)}</dd>
            </div>
          </dl>
        )}
      </section>

      <section className="panel detail-panel">
        <h2>模块入口</h2>
        <p className="field__hint">M0 只交付站点层；其余模块按里程碑开放，此处为路由占位（模块名 = 路由名 = 目录名）。</p>
        <div className="module-tabs" role="tablist" aria-label="站点模块">
          {siteModules.map((m) => (
            <button
              key={m.key}
              type="button"
              role="tab"
              aria-selected={activeModule === m.key}
              className={`module-tab${activeModule === m.key ? ' module-tab--active' : ''}`}
              onClick={() => setActiveModule(m.key)}
            >
              <span aria-hidden="true">{m.icon}</span>
              <span>{m.label}</span>
              <span className="badge badge--muted">{m.milestone}</span>
            </button>
          ))}
        </div>
        <div className="placeholder">
          {activeModule === 'sites' ? (
            <p>
              站点层已就绪：建站、卡片视图、软删除均可用。下一个里程碑（M1 采集）会把{' '}
              <span className="mono">/sites/{site.id}/crawl</span> 变成可视化采集控制台。
            </p>
          ) : (
            <p>
              「{MODULES.find((m) => m.key === activeModule)?.label}」模块尚未实现（{MODULES.find((m) => m.key === activeModule)?.milestone}
              ）。对应路由 <span className="mono">/sites/{site.id}/{activeModule}</span> 已预留。
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
