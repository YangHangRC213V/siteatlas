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

  // 远端元素位置（手动采集的自动化验收/调试用：拿到坐标就能在 canvas 上点准）
  app.get<{ Params: { sessionId: string }; Querystring: { selector?: string } }>(
    '/api/manual/:sessionId/element',
    async (request) => {
      const entry = service.require(request.params.sessionId);
      const selector = request.query.selector ?? 'a[href]';
      const box = await entry.session.elementBox(selector);
      return { selector, box };
    },
  );

  /**
   * 让当前会话打开某个**已在树里的节点**（树视图的「查看原始网页」按钮走这里）。
   *
   * 与 `/navigate`（WS 上行，手动输入地址）的区别：
   *   · 这里只接受**已存在的节点 id**，URL 由服务端从节点取，前端不给地址；
   *   · 这样「查看原始网页」永远不会把会话带到一个图外的地址上，
   *     也就不会因为手输地址而破坏「点击 → 建边」的可信度。
   */
  app.post<{ Params: { sessionId: string }; Body: { nodeId: string } }>(
    '/api/manual/:sessionId/open-node',
    {
      schema: {
        params: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
        body: { type: 'object', required: ['nodeId'], additionalProperties: false, properties: { nodeId: { type: 'string' } } },
      },
    },
    async (request) => {
      const entry = service.require(request.params.sessionId);
      const node = entry.session.nodeUrl(request.body.nodeId);
      if (node === null) throw new ManualError('NODE_NOT_FOUND', `该会话所属站点没有这个节点：${request.body.nodeId}`, 404);
      const result = await entry.session.navigate(node.url);
      return { ok: result.ok, url: result.url, error: result.error, node };
    },
  );

  app.post<{ Params: { sessionId: string } }>('/api/manual/:sessionId/stop', async (request) => {
    const state = await service.stop(request.params.sessionId);
    if (state === null) throw new ManualError('SESSION_NOT_FOUND', `手动会话不存在：${request.params.sessionId}`, 404);
    return { state };
  });
}
