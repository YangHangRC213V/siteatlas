/**
 * 站点模块主视图 —— 路由 /sites（requirements §4.1 卡片/文件夹视图）
 */
import { useCallback, useEffect } from 'react';
import { navigate } from '../../router/useRoute.ts';
import { CreateSiteForm } from './CreateSiteForm.tsx';
import { SiteCard } from './SiteCard.tsx';
import { useSitesStore } from './store.ts';
import './sites.css';

export function SitesPage(): React.JSX.Element {
  const cards = useSitesStore((s) => s.cards);
  const state = useSitesStore((s) => s.state);
  const error = useSitesStore((s) => s.error);
  const formOpen = useSitesStore((s) => s.formOpen);
  const submitting = useSitesStore((s) => s.submitting);
  const submitError = useSitesStore((s) => s.submitError);
  const showArchived = useSitesStore((s) => s.showArchived);
  const lastCreated = useSitesStore((s) => s.lastCreated);
  const load = useSitesStore((s) => s.load);
  const setFormOpen = useSitesStore((s) => s.setFormOpen);
  const setShowArchived = useSitesStore((s) => s.setShowArchived);
  const createSite = useSitesStore((s) => s.createSite);
  const deleteSite = useSitesStore((s) => s.deleteSite);
  const restoreSite = useSitesStore((s) => s.restoreSite);

  useEffect(() => {
    void load();
  }, [load]);

  const open = useCallback((id: string) => navigate(`/sites/${id}`), []);

  return (
    <div className="page">
      <header className="page__header">
        <div className="page__title-group">
          <h1>站点</h1>
          <p className="page__subtitle">
            一个根 URL = 一棵树 = 一个站点。卡片折叠存放，点开进入该树的结构与详情。
          </p>
        </div>
        <div className="sites-toolbar">
          <label className="field__hint" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            显示回收站
          </label>
          <button type="button" className="btn" onClick={() => void load()} disabled={state === 'loading'}>
            刷新
          </button>
          {!formOpen ? (
            <button type="button" className="btn btn--primary" onClick={() => setFormOpen(true)}>
              ＋ 新建站点
            </button>
          ) : null}
        </div>
      </header>

      {formOpen ? (
        <CreateSiteForm
          submitting={submitting}
          error={submitError}
          onSubmit={(values) => void createSite(values)}
          onCancel={() => setFormOpen(false)}
        />
      ) : null}

      {lastCreated !== null && !formOpen ? (
        <div className="alert alert--info" role="status" style={{ marginBottom: 'var(--sp-4)' }}>
          <span>
            已建站「{lastCreated.site.name}」，根节点 <span className="mono">{lastCreated.root.url}</span>（depth=
            {lastCreated.root.depth}，状态 {lastCreated.root.status}）。
            {lastCreated.probe.reachable
              ? ` 探测：HTTP ${lastCreated.probe.status ?? '—'} ${lastCreated.probe.contentType ?? ''}`
              : ` 探测未成功：${lastCreated.probe.error ?? '未知原因'}（已建站，节点标记为需重试）`}
          </span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => open(lastCreated.site.id)}>
            进入站点
          </button>
        </div>
      ) : null}

      {state === 'error' && error !== null ? (
        <div className="alert alert--error" role="alert" style={{ marginBottom: 'var(--sp-4)' }}>
          <span>加载站点列表失败：{error}</span>
          <button type="button" className="btn btn--sm" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      {state === 'loading' && cards.length === 0 ? (
        <div className="sites-grid" aria-busy="true" aria-label="加载中">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton skeleton-card" />
          ))}
        </div>
      ) : null}

      {state !== 'loading' && cards.length === 0 ? (
        <div className="empty">
          <span className="empty__icon" aria-hidden="true">
            ▤
          </span>
          <h2>还没有站点</h2>
          <p>
            输入一个入口 URL 开始：工具会校验协议、可达性与 HTML 类型，然后把当前页建成根节点（depth=0）。
          </p>
          {!formOpen ? (
            <button type="button" className="btn btn--primary" onClick={() => setFormOpen(true)}>
              ＋ 新建第一个站点
            </button>
          ) : null}
        </div>
      ) : null}

      {cards.length > 0 ? (
        <div className="sites-grid">
          {cards.map((card) => (
            <SiteCard
              key={card.site.id}
              card={card}
              onOpen={open}
              onDelete={(id) => void deleteSite(id)}
              onRestore={(id) => void restoreSite(id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
