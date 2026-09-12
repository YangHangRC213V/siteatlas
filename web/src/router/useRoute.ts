/**
 * 极简 history 路由（M0 只需「站点列表 → 站点详情」两跳）
 *
 * 刻意不引入 react-router：requirements §2 的路由表本身是模块注册表（modules.ts）的投影，
 * 真正需要路由库的是 M2 的树深链与查询参数，届时再评估替换成本（已记入 DECISIONS.md）。
 */
import { useEffect, useState } from 'react';

export interface RouteMatch {
  path: string;
  /** /sites/:id */
  siteMatch: { id: string } | null;
  /** 站点级子路由：/sites/:id/<sub> */
  siteSub: string | null;
}

export function matchRoute(pathname: string): RouteMatch {
  const path = pathname.replace(/\/+$/, '') || '/';
  const siteMatch = /^\/sites\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (siteMatch !== null) {
    return {
      path,
      siteMatch: { id: decodeURIComponent(siteMatch[1] as string) },
      siteSub: siteMatch[2] ?? null,
    };
  }
  return { path, siteMatch: null, siteSub: null };
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState({}, '', to);
  else window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): RouteMatch {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const onChange = (): void => setPathname(window.location.pathname);
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, []);
  return matchRoute(pathname);
}
