/**
 * 路由装配：模块名 = 路由名 = 目录名（requirements §2 / §7）
 *
 *   /                         → 重定向 /sites
 *   /sites                    → 站点卡片视图（modules/sites）
 *   /sites/:id                → 站点详情（modules/sites）
 *   /sites/:id/crawl          → 采集控制台（modules/crawl，M1）
 *   /sites/:id/tree           → 树视图（modules/tree，M1 懒加载树；M2 加修正层）
 *   /sites/:id/{data,rules,export} → 各模块占位页，标注所属里程碑
 *   /settings                 → 设置占位页
 */
import { useEffect } from 'react';
import { AppShell } from './components/AppShell.tsx';
import { MODULES } from './router/modules.ts';
import { navigate, useRoute } from './router/useRoute.ts';
import { SiteDetailPage } from './modules/sites/SiteDetailPage.tsx';
import { SiteSubPage } from './modules/sites/SiteSubPage.tsx';
import { SitesPage } from './modules/sites/SitesPage.tsx';
import { CrawlPage } from './modules/crawl/CrawlPage.tsx';
import { TreePage } from './modules/tree/TreePage.tsx';

export function App(): React.JSX.Element {
  const route = useRoute();

  useEffect(() => {
    if (route.path === '/' || route.path === '') navigate('/sites', { replace: true });
  }, [route.path]);

  if (route.siteMatch !== null) {
    const { id } = route.siteMatch;
    const sub = route.siteSub;

    if (sub === 'crawl') {
      return (
        <AppShell active="crawl" siteId={id}>
          <CrawlPage siteId={id} />
        </AppShell>
      );
    }
    if (sub === 'tree') {
      return (
        <AppShell active="tree" siteId={id}>
          <TreePage siteId={id} />
        </AppShell>
      );
    }
    if (sub !== null) {
      const moduleDef = MODULES.find((m) => m.key === sub);
      return (
        <AppShell active={sub} siteId={id}>
          <SiteSubPage
            siteId={id}
            moduleKey={sub}
            moduleLabel={moduleDef?.label ?? sub}
            milestone={moduleDef?.milestone ?? 'M4'}
          />
        </AppShell>
      );
    }
    return (
      <AppShell active="sites" siteId={id}>
        <SiteDetailPage siteId={id} />
      </AppShell>
    );
  }

  if (route.path === '/settings') {
    return (
      <AppShell active="settings" siteId={null}>
        <SiteSubPage siteId={null} moduleKey="settings" moduleLabel="设置" milestone="M1" />
      </AppShell>
    );
  }

  return (
    <AppShell active="sites" siteId={null}>
      <SitesPage />
    </AppShell>
  );
}
