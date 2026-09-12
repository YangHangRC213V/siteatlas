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
    if (m.key === 'settings') return '/settings';
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
            const disabled = !m.ready;
            // 站点级模块在列表页点了会「没反应」（targetPath 回 /sites）——明确告诉用户原因
            const needsSite = m.perSite && siteId === null;
            return (
              <button
                key={m.key}
                type="button"
                className="nav__item"
                aria-current={isActive ? 'page' : undefined}
                data-disabled={disabled}
                title={disabled ? (m.unavailableHint ?? `${m.label}：尚未开放`) : needsSite ? `${m.label}（先进入一个站点）` : m.label}
                onClick={() => {
                  if (disabled) {
                    window.alert(m.unavailableHint ?? `「${m.label}」模块尚未开放。`);
                    return;
                  }
                  if (needsSite) {
                    window.alert(`「${m.label}」是站点级模块：请先在「站点」里打开一个站点，再从这里进入。`);
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
                    {disabled ? <span className="badge badge--muted">未开放</span> : null}
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
        <span>M4 进行中（站点 / 采集 / 手动 / 结构 / 导出可用；规则 / 数据 / 设置按里程碑开放）</span>
        <span className="nav__spacer" />
        <span>数据仅存本机 data/</span>
      </footer>
    </div>
  );
}
