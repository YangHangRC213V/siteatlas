/**
 * 采集模块 API 客户端（web 只走 API，不碰数据库 —— dev-spec §3 约束）
 */
import type { CrawlPreset, CrawlProgress, CrawlStats, CrawlTaskRecord } from '@siteatlas/shared';

export class CrawlApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CrawlApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      // 仅在有 body 时声明 content-type：DELETE 等空 body 请求带该头会被 Fastify 拒为 400
      headers: { ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new CrawlApiError(0, 'NETWORK_ERROR', `无法连接服务端：${(err as Error).message}`);
  }
  const text = await res.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new CrawlApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export interface CrawlStatusResponse {
  task: CrawlTaskRecord | null;
  progress: CrawlProgress | null;
  stats: CrawlStats | null;
  recentLogs: Array<{ url: string; http_status: number | null; error: string | null; at: number }>;
  wsSubscribers: number;
}

export const crawlApi = {
  start(siteId: string, preset: Partial<CrawlPreset>): Promise<{ task: CrawlTaskRecord; preset: CrawlPreset }> {
    return request(`/api/sites/${encodeURIComponent(siteId)}/crawl`, {
      method: 'POST',
      body: JSON.stringify({ preset }),
    });
  },
  control(siteId: string, action: 'pause' | 'resume' | 'stop'): Promise<{ task: CrawlTaskRecord }> {
    return request(`/api/sites/${encodeURIComponent(siteId)}/crawl/${action}`, { method: 'POST' });
  },
  status(siteId: string): Promise<CrawlStatusResponse> {
    return request(`/api/sites/${encodeURIComponent(siteId)}/crawl/status`);
  },
  tasks(siteId: string): Promise<{ tasks: CrawlTaskRecord[] }> {
    return request(`/api/sites/${encodeURIComponent(siteId)}/crawl/tasks`);
  },
};
