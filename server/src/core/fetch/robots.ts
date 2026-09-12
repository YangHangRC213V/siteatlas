/**
 * core/fetch/robots.ts —— robots.txt 解析与遵守（requirements §4.7「默认遵守 robots.txt」）
 *
 * 自实现解析而非引依赖：只需「最长匹配优先 + Allow 胜平手 + Crawl-delay」这几条，
 * 且能避免再引入 `url` 等传递依赖。失败一律按「允许 + 无 delay」处理（不因 robots 拉取失败停摆）。
 */
import { fetchStatic } from './http-fetcher.ts';

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelayMs: number | null;
}

export interface RobotsRules {
  origin: string;
  /** 命中的分组为 null 表示 robots.txt 不存在/无匹配分组 → 全部允许 */
  fetched: boolean;
  allowAll: boolean;
  rules: RobotsRule[];
  crawlDelayMs: number | null;
  /** 解析出的全部 Sitemap 地址（M1 仅记录，种子补充留给后续） */
  sitemaps: string[];
}

const ALLOW_ALL: RobotsRules = {
  origin: '',
  fetched: false,
  allowAll: true,
  rules: [],
  crawlDelayMs: null,
  sitemaps: [],
};

/** 去掉注释与空白 */
function clean(line: string): string {
  const hash = line.indexOf('#');
  return (hash >= 0 ? line.slice(0, hash) : line).trim();
}

export function parseRobotsTxt(text: string, userAgent: string, origin: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let expectingAgent = false;
  const sitemaps: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = clean(rawLine);
    if (line.length === 0) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      if (current === null || !expectingAgent) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      expectingAgent = true;
      continue;
    }
    if (current === null) continue;
    expectingAgent = false;
    if (field === 'disallow') {
      if (value.length > 0) current.rules.push({ allow: false, path: value });
      continue;
    }
    if (field === 'allow') {
      if (value.length > 0) current.rules.push({ allow: true, path: value });
      continue;
    }
    if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelayMs = Math.round(seconds * 1000);
    }
  }

  const ua = userAgent.toLowerCase();
  // 选择最具体（agent 串最长）的匹配分组；'*' 作为兜底
  let best: RobotsGroup | null = null;
  let bestLen = -1;
  for (const group of groups) {
    for (const agent of group.agents) {
      const matched = agent === '*' || ua.includes(agent);
      if (!matched) continue;
      const specificity = agent === '*' ? 0 : agent.length;
      if (specificity > bestLen) {
        best = group;
        bestLen = specificity;
      }
    }
  }

  if (best === null) {
    return { ...ALLOW_ALL, origin, fetched: true, sitemaps };
  }
  return {
    origin,
    fetched: true,
    allowAll: false,
    rules: best.rules,
    crawlDelayMs: best.crawlDelayMs,
    sitemaps,
  };
}

/** 路径前缀匹配（* 通配与 $ 结尾，够用且可预测） */
function ruleMatches(path: string, rulePath: string): boolean {
  if (rulePath === '/') return true;
  const anchored = rulePath.endsWith('$');
  const pattern = anchored ? rulePath.slice(0, -1) : rulePath;
  if (!pattern.includes('*')) {
    return anchored ? path === pattern : path.startsWith(pattern);
  }
  const escaped = pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

/** 判定 URL 是否允许抓取：最长匹配优先，Allow 与 Disallow 等长时 Allow 胜 */
export function isAllowedByRobots(rules: RobotsRules, url: string): boolean {
  if (rules.allowAll) return true;
  let path: string;
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    return true;
  }
  let bestLen = -1;
  let bestAllow = true;
  for (const rule of rules.rules) {
    if (!ruleMatches(path, rule.path)) continue;
    const len = rule.path.replace(/[*$]/g, '').length;
    if (len > bestLen || (len === bestLen && rule.allow)) {
      bestLen = len;
      bestAllow = rule.allow;
    }
  }
  return bestLen === -1 ? true : bestAllow;
}

const robotsCache = new Map<string, RobotsRules>();

export function clearRobotsCache(): void {
  robotsCache.clear();
}

export interface RobotsFetchOptions {
  userAgent: string;
  timeoutMs: number;
}

/** 取（并缓存）某 origin 的 robots 规则 */
export async function loadRobots(origin: string, options: RobotsFetchOptions): Promise<RobotsRules> {
  const cached = robotsCache.get(origin);
  if (cached !== undefined) return cached;
  const url = `${origin}/robots.txt`;
  const res = await fetchStatic(url, {
    userAgent: options.userAgent,
    timeoutMs: Math.min(options.timeoutMs, 5000),
    maxBytes: 512_000,
  });
  const rules =
    res.ok && res.html !== null && res.html.length > 0
      ? parseRobotsTxt(res.html, options.userAgent, origin)
      : { ...ALLOW_ALL, origin };
  robotsCache.set(origin, rules);
  return rules;
}
