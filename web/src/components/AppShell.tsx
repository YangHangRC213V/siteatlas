/**
 * 应用外壳（requirements §5 布局）
 * 左侧模块导航（可折叠）+ 中部主视图 + 底部状态栏。
 * 模块名 = 路由名 = 目录名：导航项直接由 router/modules.ts 渲染。
 */
import { useEffect, useState } from 'react';
import { MODULES, type ModuleDef } from '../router/modules.ts';
import { navigate } from '../router/useRoute.ts';
import './components.css';

export interface AppShellProps {
  /** 当前激活模块 key */
  active: string;
  /** 站点级模块需要选中的站点 */
  siteId: string | null;
  children: React.ReactNode;
}

export function AppShell({ active, siteId, children }: AppShellProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [health, setHealth] = useState<{ ok: boolean; schemaVersion: string } | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => setHealth(body as { ok: boolean; schemaVersion: string } | null))
      .catch(() => setHealth(null));
  }, []);

  const targetPath = (m: ModuleDef): string => {
    if (m.key === 'sites') return '/sites';
    // 站点级模块：有选中站点则进入该站点上下文，否则回站点列表选一个
    return siteId !== null ? `/sites/${siteId}/${m.key}` : '/sites';
  };

  return (
    <div className="app" data-nav-collapsed={collapsed}>
      <aside className="app__nav" aria-label="模块导航">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true" />
          {!collapsed ? (
            <span className="brand__text">
              <span className="brand__name">SiteAtlas</span>
              <span className="brand__sub">站点图谱采集器</span>
            </span>
          ) : null}
        </div>

        <nav className="nav">
          <span className="nav__group-label">{collapsed ? '—' : '模块'}</span>
          {MODULES.map((m) => {
            const isActive = m.key === active;
            const disabled = m.milestone !== 'M0';
            return (
              <button
                key={m.key}
                type="button"
                className="nav__item"
                aria-current={isActive ? 'page' : undefined}
                data-disabled={disabled}
                title={disabled ? `${m.label}（${m.milestone} 里程碑开放）` : m.label}
                onClick={() => {
                  if (disabled) {
                    window.alert(`「${m.label}」模块将在 ${m.milestone} 里程碑开放。`);
                    return;
                  }
                  navigate(targetPath(m));
                }}
              >
                <span className="nav__icon" aria-hidden="true">
                  {m.icon}
                </span>
                {!collapsed ? (
                  <>
                    <span className="nav__text">{m.label}</span>
                    <span className="nav__spacer" />
                    {disabled ? <span className="badge badge--muted">{m.milestone}</span> : null}
                  </>
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="nav__footer">
          <button type="button" className="nav__item" onClick={() => setCollapsed((v) => !v)}>
            <span className="nav__icon" aria-hidden="true">
              {collapsed ? '»' : '«'}
            </span>
            {!collapsed ? <span className="nav__text">折叠导航</span> : null}
          </button>
        </div>
      </aside>

      <main className="app__main">{children}</main>

      <footer className="app__statusbar">
        <span>{health === null ? '服务连接中…' : health.ok ? '服务正常' : '服务异常'}</span>
        <span aria-hidden="true">·</span>
        <span>契约 v{health?.schemaVersion ?? '—'}</span>
        <span aria-hidden="true">·</span>
        <span>M0 骨架（站点层可用；采集 / 结构 / 导出按里程碑开放）</span>
        <span className="nav__spacer" />
        <span>数据仅存本机 data/</span>
      </footer>
    </div>
  );
}
