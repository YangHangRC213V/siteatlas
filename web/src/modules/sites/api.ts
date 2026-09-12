/**
 * 站点模块 API 客户端（web 不直接读数据库，只走 API —— dev-spec §3 约束）
 */
import type {
  CreateSiteResponse,
  DeleteSiteResponse,
  ListSitesResponse,
  SiteCard,
  SiteDetailResponse,
  SiteScope,
  UpdateSiteRequest,
} from '@siteatlas/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (detail !== undefined) this.detail = detail;
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
    throw new ApiError(0, 'NETWORK_ERROR', `无法连接服务端：${(err as Error).message}`);
  }
  const text = await res.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string; detail?: unknown } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `HTTP ${res.status}`, e?.detail);
  }
  return body as T;
}

export const sitesApi = {
  list(options: { archived?: boolean } = {}): Promise<SiteCard[]> {
    const qs = options.archived ? '?archived=1' : '';
    return request<ListSitesResponse>(`/api/sites${qs}`).then((r) => r.sites);
  },
  create(input: { url: string; name?: string; scope?: SiteScope }): Promise<CreateSiteResponse> {
    return request<CreateSiteResponse>('/api/sites', { method: 'POST', body: JSON.stringify(input) });
  },
  get(id: string): Promise<SiteDetailResponse> {
    return request<SiteDetailResponse>(`/api/sites/${encodeURIComponent(id)}`);
  },
  update(id: string, patch: UpdateSiteRequest): Promise<SiteDetailResponse> {
    return request<SiteDetailResponse>(`/api/sites/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },
  remove(id: string): Promise<DeleteSiteResponse> {
    return request<DeleteSiteResponse>(`/api/sites/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  restore(id: string): Promise<SiteDetailResponse> {
    return request<SiteDetailResponse>(`/api/sites/${encodeURIComponent(id)}/restore`, { method: 'POST' });
  },
};
