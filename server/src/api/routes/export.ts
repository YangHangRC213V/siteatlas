/**
 * api/routes/export.ts —— 导出与素材清单（dev-spec §5.1）
 *
 * | POST /api/sites/:id/export   | {format, scope, nodeId, presetId} → 导出任务（§6.7 目录 + manifest） |
 * | GET  /api/exports/:id        | 导出状态、产物路径、manifest（下游可直接用） |
 * | GET  /api/sites/:id/export   | 该站历史导出列表（M4 追加，规格未列但列表页需要） |
 * | GET  /api/exports/:id/files  | 产物文件清单（名字/大小/时间） |
 * | GET  /api/sites/:id/materials| 素材清单（nodeId / kind 过滤） |
 *
 * 导出是同步完成的（本地 SQLite + 文件系统，万级节点亚秒级），
 * 因此 POST 直接返回 201 + 已完成状态，前端不必轮询（见 DECISIONS.md M4）。
 */
import type { FastifyInstance } from 'fastify';
import type { ExportFormat, ExportScope, MaterialKind } from '@siteatlas/shared';
import { EXPORT_FORMATS, EXPORT_SCOPES, MATERIAL_KINDS } from '@siteatlas/shared';
import { ExportError, type ExportService } from '../../core/export/service.ts';
import { MaterialsRepo } from '../../core/store/repos/materials.ts';

interface SiteParams {
  id: string;
}

export interface ExportRouteDeps {
  exports: ExportService;
  materials: MaterialsRepo;
}

export async function registerExportRoutes(app: FastifyInstance, deps: ExportRouteDeps): Promise<void> {
  const { exports: exportService, materials } = deps;

  app.post<{ Params: SiteParams; Body: { format: ExportFormat; scope?: ExportScope; nodeId?: string; presetId?: string; includeDeleted?: boolean } }>(
    '/api/sites/:id/export',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['format'],
          additionalProperties: false,
          properties: {
            format: { type: 'string', enum: [...EXPORT_FORMATS] },
            scope: { type: 'string', enum: [...EXPORT_SCOPES] },
            nodeId: { type: 'string' },
            presetId: { type: 'string' },
            includeDeleted: { type: 'boolean' },
          },
        },
        response: { 201: { type: 'object', additionalProperties: true, properties: { export: { type: 'object', additionalProperties: true }, manifest: { type: 'object', additionalProperties: true } } } },
      },
    },
    async (request, reply) => {
      const outcome = exportService.run({
        siteId: request.params.id,
        format: request.body.format,
        ...(request.body.scope !== undefined ? { scope: request.body.scope } : {}),
        ...(request.body.nodeId !== undefined ? { nodeId: request.body.nodeId } : {}),
        ...(request.body.presetId !== undefined ? { presetId: request.body.presetId } : {}),
        ...(request.body.includeDeleted !== undefined ? { includeDeleted: request.body.includeDeleted } : {}),
      });
      reply.code(201);
      return { export: outcome.export, manifest: outcome.manifest };
    },
  );

  app.get<{ Params: SiteParams }>('/api/sites/:id/export', async (request) => {
    return { exports: exportService.listForSite(request.params.id) };
  });

  app.get<{ Params: { exportId: string } }>('/api/exports/:exportId', async (request) => {
    return exportService.status(request.params.exportId);
  });

  app.get<{ Params: { exportId: string } }>('/api/exports/:exportId/files', async (request) => {
    // 先确认导出存在（否则 404 而不是空数组）
    exportService.status(request.params.exportId);
    return { files: exportService.artifacts(request.params.exportId) };
  });

  app.get<{ Params: SiteParams; Querystring: { nodeId?: string; kind?: MaterialKind; limit?: number } }>(
    '/api/sites/:id/materials',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            nodeId: { type: 'string' },
            kind: { type: 'string', enum: [...MATERIAL_KINDS] },
            limit: { type: 'integer', minimum: 1, maximum: 5000 },
          },
        },
      },
    },
    async (request) => {
      const rows = materials.list(request.params.id, {
        ...(request.query.nodeId !== undefined ? { nodeId: request.query.nodeId } : {}),
        ...(request.query.kind !== undefined ? { kind: request.query.kind } : {}),
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      });
      return { siteId: request.params.id, total: rows.length, materials: rows };
    },
  );
}

/** errors.ts 用：把 ExportError 映射成 HTTP（未使用时的类型锚点） */
export type { ExportError };
