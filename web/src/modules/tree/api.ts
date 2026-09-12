/**
 * 树模块 API 客户端 + 虚拟滚动所需的扁平化状态
 */
import type { NodeRecord, TreeResponse, TreeNodeRow } from '@siteatlas/shared';

export class TreeApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'TreeApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  } catch (err) {
    throw new TreeApiError(0, 'NETWORK_ERROR', `无法连接服务端：${(err as Error).message}`);
  }
  const text = await res.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new TreeApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const treeApi = {
  children(siteId: string, parentId: string | null, offset = 0, limit = 200): Promise<TreeResponse> {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (parentId !== null) params.set('parentId', parentId);
    return request<TreeResponse>(`/api/sites/${encodeURIComponent(siteId)}/tree?${params.toString()}`);
  },
  node(nodeId: string): Promise<{ node: TreeNodeRow; parents: Array<{ edge: { anchor_text: string | null }; from: NodeRecord | null }>; children: Array<{ edge: { order_in_page: number | null }; to: NodeRecord | null }> }> {
    return request(`/api/nodes/${encodeURIComponent(nodeId)}`);
  },
  patch(nodeId: string, patch: { alias?: string | null; title?: string | null }): Promise<{ node: TreeNodeRow }> {
    return request(`/api/nodes/${encodeURIComponent(nodeId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },
};
