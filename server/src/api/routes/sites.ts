/**
 * 站点路由（dev-spec §5.1）
 *
 * | POST   | /api/sites       | 建站 {url, scope?, name?} → 校验可达性/HTML，返回 site + 根 node |
 * | GET    | /api/sites       | 站点卡片列表（含节点数/状态/更新时间）                          |
 * | GET    | /api/sites/:id   | 详情                                                          |
 * | PATCH  | /api/sites/:id   | 改名、范围、备注、归档                                         |
 * | DELETE | /api/sites/:id   | 软删除整站                                                     |
 */
import type { FastifyInstance } from 'fastify';
import type {
  CreateSiteResponse,
  DeleteSiteResponse,
  ListSitesResponse,
  SiteDetailResponse,
  SiteScope,
  UpdateSiteRequest,
} from '@siteatlas/shared';
import { SITE_SCOPES } from '@siteatlas/shared';
import type { SitesService } from '../../core/sites/service.ts';

interface IdParams {
  id: string;
}

const siteSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    root_url: { type: 'string' },
    root_host: { type: 'string' },
    scope: { type: 'string', enum: [...SITE_SCOPES] },
    allowlist_json: { type: 'string' },
    created_at: { type: 'integer' },
    updated_at: { type: 'integer' },
    archived: { type: 'integer' },
    note: { type: ['string', 'null'] },
  },
} as const;

const nodeSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    site_id: { type: 'string' },
    identity_key: { type: 'string' },
    url: { type: 'string' },
    depth: { type: 'integer' },
    status: { type: 'string' },
    display_label: { type: ['string', 'null'] },
  },
} as const;

const statsSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    nodeCount: { type: 'integer' },
    rootStatus: { type: ['string', 'null'] },
    okCount: { type: 'integer' },
    errorCount: { type: 'integer' },
    maxDepth: { type: 'integer' },
    lastFetchAt: { type: ['integer', 'null'] },
  },
} as const;

const siteCardSchema = {
  type: 'object',
  additionalProperties: true,
  properties: { site: siteSchema, stats: statsSchema },
} as const;

export async function registerSiteRoutes(app: FastifyInstance, service: SitesService): Promise<void> {
  app.post<{ Body: { url: string; scope?: SiteScope; name?: string; skipProbe?: boolean } }>(
    '/api/sites',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url'],
          additionalProperties: false,
          properties: {
            url: { type: 'string', minLength: 1 },
            scope: { type: 'string', enum: [...SITE_SCOPES] },
            name: { type: 'string' },
            skipProbe: { type: 'boolean' },
          },
        },
        response: {
          201: {
            type: 'object',
            additionalProperties: true,
            properties: {
              site: siteSchema,
              root: nodeSchema,
              probe: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const result: CreateSiteResponse = await service.createSite(request.body);
      reply.code(201);
      return result;
    },
  );

  app.get<{ Querystring: { includeArchived?: string; archived?: string } }>(
    '/api/sites',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            includeArchived: { type: 'string', enum: ['0', '1'] },
            archived: { type: 'string', enum: ['0', '1'] },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
            properties: { sites: { type: 'array', items: siteCardSchema } },
          },
        },
      },
    },
    async (request) => {
      const sites = service.listSites({
        includeArchived: request.query.includeArchived === '1' || request.query.archived === '1',
        archivedOnly: request.query.archived === '1',
      });
      const body: ListSitesResponse = { sites };
      return body;
    },
  );

  app.get<{ Params: IdParams }>(
    '/api/sites/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
            properties: { site: siteSchema, stats: statsSchema, root: { ...nodeSchema, type: ['object', 'null'] } },
          },
        },
      },
    },
    async (request) => {
      const body: SiteDetailResponse = service.getSite(request.params.id);
      return body;
    },
  );

  app.patch<{ Params: IdParams; Body: UpdateSiteRequest }>(
    '/api/sites/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1 },
            scope: { type: 'string', enum: [...SITE_SCOPES] },
            allowlist: { type: 'array', items: { type: 'string' } },
            archived: { type: 'boolean' },
            note: { type: ['string', 'null'] },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
            properties: { site: siteSchema, stats: statsSchema, root: { ...nodeSchema, type: ['object', 'null'] } },
          },
        },
      },
    },
    async (request) => {
      const body: SiteDetailResponse = service.updateSite(request.params.id, request.body);
      return body;
    },
  );

  app.delete<{ Params: IdParams }>(
    '/api/sites/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
            properties: {
              site: siteSchema,
              deleted: { type: 'boolean' },
              affectedNodes: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request) => {
      const body: DeleteSiteResponse = service.deleteSite(request.params.id);
      return body;
    },
  );

  app.post<{ Params: IdParams }>(
    '/api/sites/:id/restore',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
            properties: { site: siteSchema, stats: statsSchema, root: { ...nodeSchema, type: ['object', 'null'] } },
          },
        },
      },
    },
    async (request) => {
      const body: SiteDetailResponse = service.restoreSite(request.params.id);
      return body;
    },
  );
}
