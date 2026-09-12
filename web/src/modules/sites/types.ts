/**
 * 站点模块类型（web 侧视图模型）
 *
 * 数据契约的唯一事实来源是 @siteatlas/shared；此文件只放「界面专用的派生形状」，
 * 不重复定义后端 DTO。
 */
export type { SiteCard, SiteRecord, SiteCardStats, NodeRecord, SiteScope } from '@siteatlas/shared';

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/** ``scope`` 的中文标签（界面展示用） */
export const SCOPE_LABELS: Record<string, string> = {
  same_domain: '仅同域',
  same_site: '同域 + 子域',
  allowlist: '白名单',
  all: '不限制',
};

export const STATUS_LABELS: Record<string, string> = {
  queued: '待采集',
  crawling: '采集中',
  ok: '已采集',
  error: '失败',
  skipped: '已跳过',
  blocked: '已阻断',
  need_human: '待人工确认',
};

export function statusLabel(status: string | null | undefined): string {
  if (status === null || status === undefined) return '未知';
  return STATUS_LABELS[status] ?? status;
}

export function statusClass(status: string | null | undefined): string {
  switch (status) {
    case 'ok':
      return 'badge badge--ok';
    case 'error':
      return 'badge badge--error';
    case 'need_human':
      return 'badge badge--need-human';
    default:
      return 'badge badge--queued';
  }
}

export function formatTime(sec: number | null): string {
  if (sec === null || sec === undefined) return '—';
  const d = new Date(sec * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 根域名（host 去 www）——卡片「根域名」栏 */
export function rootDomain(host: string): string {
  return host.replace(/^www\./, '');
}
