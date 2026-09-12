/**
 * 抓取范围判定（dev-spec §0 决策：同域 + 子域 + 跨域白名单；§4 sites.scope）
 *
 * same_domain —— 仅根域完全相同的 host
 * same_site   —— 同域或其子域（默认策略）
 * allowlist   —— 命中 allowlist 中任一 pattern 的 host（`*.example.com` 通配子域）
 * all         —— 不限制
 */
import type { NormalizeOptions, SiteScope } from '@siteatlas/shared';
import { normalizeUrl } from './normalize.ts';

export interface ScopeRule {
  scope: SiteScope;
  /** 站点根 URL（绝对地址） */
  rootUrl: string;
  /** scope='allowlist' 时生效 */
  allowlist?: readonly string[];
}

/** 归一化 host：小写、去端口（端口不属于范围判定维度） */
function hostOf(url: string, options?: NormalizeOptions): string {
  return normalizeUrl(url, options).normalizedHost;
}

/** pattern 支持 `example.com`（精确）与 `*.example.com`（含所有子域，不含根域自身） */
export function matchAllowlist(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase().replace(/^\./, '');
  if (p.length === 0) return false;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return host !== base && host.endsWith(`.${base}`);
  }
  return host === p;
}

/** 同域 or 子域 */
function isSameSite(host: string, rootHost: string): boolean {
  return host === rootHost || host.endsWith(`.${rootHost}`);
}

/** 判定候选 URL 是否在站点采集范围内（候选本身必须先是合法 http/https URL） */
export function isInScope(candidateUrl: string, rule: ScopeRule, options?: NormalizeOptions): boolean {
  let host: string;
  let rootHost: string;
  try {
    host = hostOf(candidateUrl, options);
    rootHost = hostOf(rule.rootUrl, options);
  } catch {
    return false;
  }
  if (rule.scope === 'all') return true;
  switch (rule.scope) {
    case 'same_domain':
      return host === rootHost;
    case 'same_site':
      return isSameSite(host, rootHost);
    case 'allowlist':
      return isSameSite(host, rootHost) || (rule.allowlist ?? []).some((p) => matchAllowlist(p, host));
    default:
      return false;
  }
}
