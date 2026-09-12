/**
 * 树模块 API 客户端（M2：含修正层操作：重挂 / 改地址 / 软删 / 撤销重做 / 回收站）
 */
import type {
  DeleteNodesResponse,
  NodeRecord,
  OverrideRecord,
  TreeResponse,
  TreeNodeRow,
  TrashResponse,
  UndoRedoResponse,
} from '@siteatlas/shared';

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
    res = await fetch(path, {
      ...init,
      // 仅在有 body 时声明 content-type：DELETE 等空 body 请求带上会被 Fastify 拒为 400
      headers: { ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    });
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

export interface NodeDetailPayload {
  node: TreeNodeRow & { has_override: boolean };
  parents: Array<{ edge: { anchor_text: string | null; selector: string | null }; from: NodeRecord | null }>;
  children: Array<{ edge: { order_in_page: number | null }; to: NodeRecord | null }>;
  history: OverrideRecord[];
  depths: { undoDepth: number; redoDepth: number };
}

export interface SearchHit {
  id: string;
  url: string;
  display_label: string | null;
  depth: number;
  status: string;
  alias: string | null;
  title: string | null;
}

export const treeApi = {
  children(siteId: string, parentId: string | null, offset = 0, limit = 200): Promise<TreeResponse> {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (parentId !== null) params.set('parentId', parentId);
    return request<TreeResponse>(`/api/sites/${encodeURIComponent(siteId)}/tree?${params.toString()}`);
  },
  trash(siteId: string): Promise<TrashResponse> {
    return request<TrashResponse>(`/api/sites/${encodeURIComponent(siteId)}/tree?trash=1`);
  },
  search(
    siteId: string,
    filter: { q?: string; depth?: number | null; status?: string | null; regex?: boolean; limit?: number },
  ): Promise<{ total: number; scanned: number; nodes: SearchHit[] }> {
    const params = new URLSearchParams();
    if (filter.q !== undefined && filter.q.length > 0) params.set('q', filter.q);
    if (filter.depth !== undefined && filter.depth !== null) params.set('depth', String(filter.depth));
    if (filter.status !== undefined && filter.status !== null) params.set('status', filter.status);
    if (filter.regex === true) params.set('regex', '1');
    params.set('limit', String(filter.limit ?? 100));
    return request(`/api/sites/${encodeURIComponent(siteId)}/search?${params.toString()}`);
  },
  node(nodeId: string): Promise<NodeDetailPayload> {
    return request<NodeDetailPayload>(`/api/nodes/${encodeURIComponent(nodeId)}`);
  },
  patch(
    nodeId: string,
    patch: { alias?: string | null; title?: string | null; url?: string },
  ): Promise<{ node: TreeNodeRow }> {
    return request(`/api/nodes/${encodeURIComponent(nodeId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },
  move(
    nodeId: string,
    newParentId: string | null,
    ids?: string[],
  ): Promise<{ opGroup: string; moved: number; nodes: TreeNodeRow[] }> {
    return request(`/api/nodes/${encodeURIComponent(nodeId)}/move`, {
      method: 'POST',
      body: JSON.stringify(ids !== undefined && ids.length > 0 ? { newParentId, ids } : { newParentId }),
    });
  },
  remove(nodeId: string, ids?: string[]): Promise<DeleteNodesResponse> {
    return request<DeleteNodesResponse>(`/api/nodes/${encodeURIComponent(nodeId)}`, {
      method: 'DELETE',
      ...(ids !== undefined && ids.length > 0 ? { body: JSON.stringify({ ids }) } : {}),
    });
  },
  revert(nodeId: string): Promise<{ node: TreeNodeRow; opGroup: string }> {
    return request(`/api/nodes/${encodeURIComponent(nodeId)}/revert`, { method: 'POST' });
  },
  undo(siteId: string): Promise<UndoRedoResponse> {
    return request<UndoRedoResponse>(`/api/sites/${encodeURIComponent(siteId)}/undo`, { method: 'POST' });
  },
  redo(siteId: string): Promise<UndoRedoResponse> {
    return request<UndoRedoResponse>(`/api/sites/${encodeURIComponent(siteId)}/redo`, { method: 'POST' });
  },
  restoreFromTrash(siteId: string, nodeId: string): Promise<{ restored: number }> {
    return request(`/api/sites/${encodeURIComponent(siteId)}/trash/${encodeURIComponent(nodeId)}/restore`, {
      method: 'POST',
    });
  },
};
