/**
 * api/routes/manual.ts —— 手动采集 REST（dev-spec §5.1/§6.5）
 *
 * | POST | /api/sites/:id/manual            | 开始手动会话 {url?, viewport?, mode?} |
 * | GET  | /api/sites/:id/manual            | 当前会话状态（无会话返回 null）        |
 * | GET  | /api/manual/:sessionId           | 会话状态与最近事件                     |
 * | POST | /api/manual/:sessionId/stop      | 结束会话                               |
 * | GET  | /api/manual/sessions             | 所有会话（排障用）                     |
 * | POST | /api/nodes/:id/manual-parent     | 把某节点的人工父节点指定回自动结果（预留） |
 */
import type { FastifyInstance } from 'fastify';
import type { ManualService } from '../../core/manual/service.ts';
import { ManualError } from '../../core/manual/service.ts';

interface SiteParams {
  id: string;
}

const stateSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    sessionId: { type: 'string' },
    siteId: { type: 'string' },
    status: { type: 'string' },
    guideEnabled: { type: 'boolean' },
    progressMode: { type: 'string' },
    nodesCreated: { type: 'integer' },
    edgesCreated: { type: 'integer' },
    pendingConfirmCount: { type: 'integer' },
    lastNavigatedUrl: { type: ['string', 'null'] },
  },
} as const;

export async function registerManualRoutes(app: FastifyInstance, service: ManualService): Promise<void> {
  app.post<{ Params: SiteParams; Body: { url?: string; mode?: 'record-only' | 'record-and-expand'; viewport?: { width: number; height: number }; startNodeId?: string } }>(
    '/api/sites/:id/manual',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string' },
            mode: { type: 'string', enum: ['record-only', 'record-and-expand'] },
            startNodeId: { type: 'string' },
            viewport: {
              type: 'object',
              additionalProperties: false,
              properties: { width: { type: 'integer', minimum: 320, maximum: 3840 }, height: { type: 'integer', minimum: 240, maximum: 2160 } },
            },
          },
        },
        response: { 201: { type: 'object', additionalProperties: true, properties: { state: stateSchema } } },
      },
    },
    async (request, reply) => {
      const started = await service.start({
        siteId: request.params.id,
        ...(request.body?.url !== undefined ? { url: request.body.url } : {}),
        ...(request.body?.mode !== undefined ? { progressMode: request.body.mode } : {}),
        ...(request.body?.viewport !== undefined ? { viewport: request.body.viewport } : {}),
        ...(request.body?.startNodeId !== undefined ? { startNodeId: request.body.startNodeId } : {}),
      });
      reply.code(201);
      return { state: started.state };
    },
  );

  app.get<{ Params: SiteParams }>('/api/sites/:id/manual', async (request) => {
    const state = service.activeForSite(request.params.id);
    return { state };
  });

  app.get('/api/manual/sessions', async () => ({ sessions: service.list() }));

  app.get<{ Params: { sessionId: string } }>(
    '/api/manual/:sessionId',
    {
      schema: {
        params: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
      },
    },
    async (request) => {
      const entry = service.require(request.params.sessionId);
      return {
        state: entry.session.state(),
        events: entry.session.recentEvents(100),
        pendingConfirm: entry.session.listPendingConfirm(),
      };
    },
  );

  app.post<{ Params: { sessionId: string } }>('/api/manual/:sessionId/stop', async (request) => {
    const state = await service.stop(request.params.sessionId);
    if (state === null) throw new ManualError('SESSION_NOT_FOUND', `手动会话不存在：${request.params.sessionId}`, 404);
    return { state };
  });
}
