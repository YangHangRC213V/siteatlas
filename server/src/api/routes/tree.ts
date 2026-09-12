/**
 * api/routes/tree.ts —— 树视图与节点详情（dev-spec §5.1）
 *
 * | GET   | /api/sites/:id/tree?parentId=&offset=&limit= | 懒加载子节点（默认根） |
 * | GET   | /api/nodes/:id                               | 节点详情（含 parents[]、入链出链、素材） |
 * | PATCH | /api/nodes/:id                               | 改别名/标题（地址修改与重挂属 M2 修正层） |
 *
 * 读的是 v_nodes_effective，因此 M2 的人工重挂会立即反映在树上。
 */
import type { FastifyInstance } from 'fastify';
import type { NodeDetailResponse, TreeResponse } from '@siteatlas/shared';
import type { CrawlRepo } from '../../core/store/repos/crawl.ts';
import type { EdgesRepo } from '../../core/store/repos/edges.ts';
import type { NodesRepo } from '../../core/store/repos/nodes.ts';
import type { SitesRepo } from '../../core/store/repos/sites.ts';
import { SiteServiceError } from '../../core/sites/service.ts';

export interface TreeRouteDeps {
  sites: SitesRepo;
  nodes: NodesRepo;
  edges: EdgesRepo;
  crawl: CrawlRepo;
}

const nodeRowSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    site_id: { type: 'string' },
    identity_key: { type: 'string' },
    url: { type: 'string' },
    alias: { type: ['string', 'null'] },
    display_label: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    http_status: { type: ['integer', 'null'] },
    content_type: { type: ['string', 'null'] },
    depth: { type: 'integer' },
    auto_parent_id: { type: ['string', 'null'] },
    effective_parent_id: { type: ['string', 'null'] },
    status: { type: 'string' },
    content_hash: { type: ['string', 'null'] },
    in_link_count: { type: 'integer' },
    out_link_count: { type: 'integer' },
    is_deleted: { type: 'integer' },
    first_seen_at: { type: 'integer' },
    last_fetch_at: { type: ['integer', 'null'] },
    has_override: { type: 'integer' },
    child_count: { type: 'integer' },
  },
} as const;

export async function registerTreeRoutes(app: FastifyInstance, deps: TreeRouteDeps): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { parentId?: string; offset?: string; limit?: string } }>(
    '/api/sites/:id/tree',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            parentId: { type: 'string' },
            offset: { type: 'string' },
            limit: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
            properties: {
              parentId: { type: ['string', 'null'] },
              total: { type: 'integer' },
              offset: { type: 'integer' },
              limit: { type: 'integer' },
              nodes: { type: 'array', items: nodeRowSchema },
            },
          },
        },
      },
    },
    async (request) => {
      const siteId = request.params.id;
      if (deps.sites.get(siteId) === null) {
        throw new SiteServiceError('SITE_NOT_FOUND', `站点不存在：${siteId}`, 404);
      }
      const parentId = request.query.parentId !== undefined && request.query.parentId !== '' ? request.query.parentId : null;
      const offset = Math.max(0, Number(request.query.offset ?? 0) || 0);
      const limit = Math.min(500, Math.max(1, Number(request.query.limit ?? 100) || 100));
      const page = deps.nodes.childrenPage(siteId, parentId, offset, limit);
      const body: TreeResponse = {
        parentId,
        total: page.total,
        offset,
        limit,
        nodes: page.nodes,
      };
      return body;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/nodes/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (request) => {
      const node = deps.nodes.get(request.params.id);
      if (node === null) throw new SiteServiceError('NODE_NOT_FOUND', `节点不存在：${request.params.id}`, 404);

      const incoming = deps.edges.incoming(node.id, 200);
      const outgoing = deps.edges.outgoing(node.id, 500);
      const enriched = deps.nodes.childrenPage(node.site_id, node.auto_parent_id, 0, 1);

      const body: NodeDetailResponse = {
        node: {
          ...node,
          effective_parent_id: node.auto_parent_id,
          has_override: 0,
          child_count: deps.nodes.countChildren(node.site_id, node.id),
        },
        parents: incoming.map((edge) => ({ edge, from: deps.nodes.get(edge.from_id) })),
        children: outgoing.map((edge) => ({ edge, to: deps.nodes.get(edge.to_id) })),
        materials: [],
      };
      void enriched;
      return body;
    },
  );

  app.patch<{ Params: { id: string }; Body: { alias?: string | null; title?: string | null; url?: string } }>(
    '/api/nodes/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            alias: { type: ['string', 'null'] },
            title: { type: ['string', 'null'] },
            url: { type: 'string' },
          },
        },
      },
    },
    async (request) => {
      const node = deps.nodes.get(request.params.id);
      if (node === null) throw new SiteServiceError('NODE_NOT_FOUND', `节点不存在：${request.params.id}`, 404);
      const { alias, title, url } = request.body ?? {};
      if (url !== undefined) {
        // 「修改地址」在 §6.8 需求澄清里定义为修正层操作（旧记录保留为历史别名 + 可选重抓）
        throw new SiteServiceError(
          'NOT_IMPLEMENTED',
          '修改地址属于人工修正层（node_overrides），将在 M2 树视图一并开放',
          501,
        );
      }
      // M1 只允许别名/标题这类纯展示字段直写；父节点/地址/删除等一律走修正层（M2）
      deps.nodes.updateDisplayFields(node.id, { alias, title });
      const updated = deps.nodes.get(node.id);
      return { node: updated, has_override: 0 };
    },
  );
}
