/**
 * 路由装配：模块名 = 路由名 = 目录名
 *
 * M0 可访问路由：
 *   /             → 重定向 /sites
 *   /sites        → 站点卡片视图
 *   /sites/:id    → 站点详情（占位页，树视图 M2）
 */
import { useEffect } from 'react';
import { AppShell } from './components/AppShell.tsx';
import { navigate, useRoute } from './router/useRoute.ts';
import { SitesPage } from './modules/sites/SitesPage.tsx';
import { SiteDetailPage } from './modules/sites/SiteDetailPage.tsx';

export function App(): React.JSX.Element {
  const route = useRoute();

  useEffect(() => {
    if (route.path === '/' || route.path === '') navigate('/sites', { replace: true });
  }, [route.path]);

  const active = route.siteMatch !== null ? (route.siteSub ?? 'sites') : 'sites';

  return (
    <AppShell active={active} siteId={route.siteMatch?.id ?? null}>
      {route.siteMatch !== null ? <SiteDetailPage siteId={route.siteMatch.id} /> : <SitesPage />}
    </AppShell>
  );
}
