/**
 * 导出模块 API 客户端（M4：dev-spec §5.1 / §5.3 / §6.7）
 *
 * 只做三件事：建导出任务、读任务与产物清单、读素材清单。
 * 对外只读 API（/open/v1/...）不在这里封装 —— 那是给第三方脚本用的，
 * 前端只展示它的地址，避免界面代码依赖对外契约。
 */
import type { ExportFormat, ExportManifest, ExportRecord, ExportScope, MaterialRecord } from '@siteatlas/shared';

export class ExportApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ExportApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      // 仅在有 body 时声明 content-type：空 body + JSON 头会被 Fastify 判为 400
      headers: { ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new ExportApiError(0, 'NETWORK_ERROR', `无法连接服务端：${(err as Error).message}`);
  }
  const text = await res.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ExportApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export interface RunExportInput {
  format: ExportFormat;
  scope?: ExportScope;
  nodeId?: string;
  includeDeleted?: boolean;
}

export interface ExportFileEntry {
  name: string;
  bytes: number;
  mtime: number;
}

export const exportApi = {
  run(siteId: string, input: RunExportInput): Promise<{ export: ExportRecord; manifest: ExportManifest }> {
    return request(`/api/sites/${encodeURIComponent(siteId)}/export`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  list(siteId: string): Promise<{ exports: ExportRecord[] }> {
    return request(`/api/sites/${encodeURIComponent(siteId)}/export`);
  },
  status(exportId: string): Promise<{ export: ExportRecord; manifest: ExportManifest | null; files?: ExportFileEntry[] }> {
    return request(`/api/exports/${encodeURIComponent(exportId)}`);
  },
  files(exportId: string): Promise<{ files: ExportFileEntry[] }> {
    return request(`/api/exports/${encodeURIComponent(exportId)}/files`);
  },
  materials(siteId: string, options: { nodeId?: string; kind?: string } = {}): Promise<{ total: number; materials: MaterialRecord[] }> {
    const params = new URLSearchParams();
    if (options.nodeId !== undefined) params.set('nodeId', options.nodeId);
    if (options.kind !== undefined) params.set('kind', options.kind);
    const query = params.toString();
    return request(`/api/sites/${encodeURIComponent(siteId)}/materials${query.length > 0 ? `?${query}` : ''}`);
  },
};

/** 格式的中文说明（界面用；顺序与 dev-spec §6.7 的 layers 一致） */
export const FORMAT_LABELS: Record<ExportFormat, { label: string; hint: string }> = {
  json: { label: 'JSON', hint: '完整图（nodes + edges），人类可读，适合小站与调试' },
  jsonl: { label: 'JSONL', hint: '一行一个节点，首行是 meta，适合流式/大站' },
  csv: { label: 'CSV', hint: '节点表 + 边表（RFC4180），Excel/表格工具可直接打开' },
  sqlite: { label: 'SQLite', hint: '可直接查询的快照（含 manifest 与查询示例表）' },
  mermaid: { label: 'Mermaid', hint: 'flowchart 树图，贴进 Markdown 即可渲染（超 800 节点截断）' },
};

export const SCOPE_LABELS: Record<ExportScope, string> = {
  site: '整站（默认）',
  subtree: '某一棵子树（需要填节点 id）',
  all: '整站（含已软删节点）',
};
