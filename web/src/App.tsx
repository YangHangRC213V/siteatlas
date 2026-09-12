/**
 * 路由装配：模块名 = 路由名 = 目录名（requirements §2 / §7）
 *
 *   /                         → 重定向 /sites
 *   /sites                    → 站点卡片视图（modules/sites）
 *   /sites/:id                → 站点详情（modules/sites）
 *   /sites/:id/crawl          → 采集控制台（modules/crawl，M1）
 *   /sites/:id/manual         → 手动引导采集（modules/manual，M3）
 *   /sites/:id/tree           → 树视图（modules/tree，M1 懒加载树；M2 加修正层）
 *   /sites/:id/export         → 导出（modules/export，M4）
 *   /sites/:id/{data,rules}   → 各模块占位页，标注所属里程碑
 *   /settings                 → 设置（modules/settings，全局默认与导出预设）
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
import { ManualPage } from './modules/manual/ManualPage.tsx';
import { ExportPage } from './modules/export/ExportPage.tsx';
import { SettingsPage } from './modules/settings/SettingsPage.tsx';

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
    if (sub === 'export') {
      return (
        <AppShell active="export" siteId={id}>
          <ExportPage siteId={id} />
        </AppShell>
      );
    }
    if (sub === 'manual') {
      return (
        <AppShell active="crawl" siteId={id}>
          <ManualPage siteId={id} />
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
        <SettingsPage />
      </AppShell>
    );
  }

  return (
    <AppShell active="sites" siteId={null}>
      <SitesPage />
    </AppShell>
  );
}
