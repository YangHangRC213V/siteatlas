/**
 * api/routes/crawl.ts —— 采集控制（dev-spec §5.1）
 *
 * | POST | /api/sites/:id/crawl                     | 启动自动采集 {preset}         |
 * | POST | /api/sites/:id/crawl/{pause|resume|stop} | 任务控制                      |
 * | GET  | /api/sites/:id/crawl/status              | 进度：已抓/队列/失败/深度分布  |
 */
import type { FastifyInstance } from 'fastify';
import { RENDER_MODES, SITE_SCOPES, type CrawlPreset } from '@siteatlas/shared';
import type { CrawlService } from '../../core/crawl/service.ts';
import { CrawlError } from '../../core/crawl/service.ts';
import type { CrawlBroadcaster } from '../ws.ts';

interface SiteParams {
  id: string;
}

const presetSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxDepth: { type: 'integer', minimum: 0, maximum: 20 },
    maxPages: { type: 'integer', minimum: 1, maximum: 1000000 },
    scope: { type: 'string', enum: [...SITE_SCOPES] },
    allowlist: { type: 'array', items: { type: 'string' } },
    concurrency: { type: 'integer', minimum: 1, maximum: 32 },
    minDelayMs: { type: 'integer', minimum: 0, maximum: 60000 },
    jitterMs: { type: 'integer', minimum: 0, maximum: 10000 },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
    maxRetries: { type: 'integer', minimum: 0, maximum: 10 },
    retryBackoffMs: { type: 'integer', minimum: 0, maximum: 60000 },
    retryBackoffMaxMs: { type: 'integer', minimum: 0, maximum: 600000 },
    renderMode: { type: 'string', enum: [...RENDER_MODES] },
    respectRobots: { type: 'boolean' },
    perHostConcurrency: { type: 'integer', minimum: 1, maximum: 16 },
    userAgent: { type: 'string', minLength: 1 },
    visitLimit: { type: 'integer', minimum: 1, maximum: 100 },
    prefixPruneThreshold: { type: 'integer', minimum: 1, maximum: 10000 },
    paginationPageLimit: { type: 'integer', minimum: 1, maximum: 10000 },
    downloadAssets: { type: 'boolean' },
  },
} as const;

const taskSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    site_id: { type: 'string' },
    preset_json: { type: 'string' },
    status: { type: 'string' },
    stats_json: { type: ['string', 'null'] },
    started_at: { type: ['integer', 'null'] },
    finished_at: { type: ['integer', 'null'] },
  },
} as const;

export async function registerCrawlRoutes(
  app: FastifyInstance,
  service: CrawlService,
  broadcaster: CrawlBroadcaster,
): Promise<void> {
  app.post<{ Params: SiteParams; Body: { preset?: Partial<CrawlPreset> } }>(
    '/api/sites/:id/crawl',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { preset: presetSchema },
        },
        response: {
          202: {
            type: 'object',
            additionalProperties: true,
            properties: { task: taskSchema, preset: { type: 'object', additionalProperties: true } },
          },
        },
      },
    },
    async (request, reply) => {
      const { task, preset } = service.start(request.params.id, request.body?.preset, broadcaster.listenerFor(request.params.id));
      reply.code(202);
      return { task, preset };
    },
  );

  for (const action of ['pause', 'resume', 'stop'] as const) {
    app.post<{ Params: SiteParams }>(
      `/api/sites/:id/crawl/${action}`,
      {
        schema: {
          params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
          response: { 200: { type: 'object', additionalProperties: true, properties: { task: taskSchema } } },
        },
      },
      async (request) => {
        const task =
          action === 'pause'
            ? service.pause(request.params.id)
            : action === 'resume'
              ? service.resume(request.params.id)
              : await service.stop(request.params.id);
        broadcaster.broadcast(request.params.id, { type: 'task', status: task.status, taskId: task.id });
        return { task };
      },
    );
  }

  app.get<{ Params: SiteParams }>(
    '/api/sites/:id/crawl/status',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
            properties: {
              task: { ...taskSchema, type: ['object', 'null'] },
              progress: { type: ['object', 'null'], additionalProperties: true },
              stats: { type: ['object', 'null'], additionalProperties: true },
              recentLogs: { type: 'array', items: { type: 'object', additionalProperties: true } },
              wsSubscribers: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request) => {
      const siteId = request.params.id;
      const status = service.statusOf(siteId);
      return {
        ...status,
        recentLogs: service.recentLogs(siteId, 20),
        wsSubscribers: broadcaster.count(siteId),
      };
    },
  );

  // 任务历史（便于排查「上一次跑到哪」）
  app.get<{ Params: SiteParams }>('/api/sites/:id/crawl/tasks', async (request) => {
    return { tasks: service.listTasks(request.params.id) };
  });
}
