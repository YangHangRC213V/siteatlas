/**
 * 站点级子模块占位页（尚未实现的模块统一走这里，标注所属里程碑）
 * 目的：路由与目录先对齐（界面模块名 = 路由名 = 目录名），避免「界面有入口、代码没位置」。
 */
import { navigate } from '../../router/useRoute.ts';

export interface SiteSubPageProps {
  siteId: string | null;
  moduleKey: string;
  moduleLabel: string;
  milestone: string;
}

export function SiteSubPage({ siteId, moduleKey, moduleLabel, milestone }: SiteSubPageProps): React.JSX.Element {
  const route = siteId === null ? `/${moduleKey}` : `/sites/${siteId}/${moduleKey}`;
  return (
    <div className="page">
      <nav className="breadcrumb" aria-label="面包屑">
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => navigate('/sites')}>
          ← 站点
        </button>
        <span className="breadcrumb__sep" aria-hidden="true">
          /
        </span>
        <span>{moduleLabel}</span>
      </nav>
      <header className="page__header">
        <div className="page__title-group">
          <h1>{moduleLabel}</h1>
          <p className="page__subtitle">
            该模块将在 <strong>{milestone}</strong> 里程碑交付，路由 <span className="mono">{route}</span> 已预留。
          </p>
        </div>
      </header>
      <section className="panel">
        <div className="placeholder">
          <p>
            已交付的模块：站点（M0，卡片视图）、采集（M1，自动采集控制台）、结构（M1 起，懒加载树视图）。
          </p>
          {siteId !== null ? (
            <p style={{ marginTop: 'var(--sp-3)' }}>
              <button type="button" className="btn btn--sm" onClick={() => navigate(`/sites/${siteId}/crawl`)}>
                去采集控制台
              </button>{' '}
              <button type="button" className="btn btn--sm" onClick={() => navigate(`/sites/${siteId}/tree`)}>
                去树视图
              </button>
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
