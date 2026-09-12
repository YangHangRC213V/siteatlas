/**
 * api/routes/tree.ts —— 树视图、节点详情与人工修正层（dev-spec §5.1 / §6.4）
 *
 * | GET    | /api/sites/:id/tree?parentId=&offset=&limit= | 懒加载子节点（默认根）                |
 * | GET    | /api/sites/:id/tree?trash=1                  | 回收站（被软删的子树根）              |
 * | GET    | /api/nodes/:id                               | 节点详情（有效值 + 父/子 + 修正历史） |
 * | PATCH  | /api/nodes/:id                               | 改别名/标题/地址（写 override）       |
 * | POST   | /api/nodes/:id/move                          | 重挂（支持批量 ids[]）                |
 * | DELETE | /api/nodes/:id                               | 软删该节点及其子树（返回影响面）      |
 * | POST   | /api/nodes/:id/revert                        | 还原为自动结果                        |
 * | POST   | /api/sites/:id/undo | /redo                   | 撤销 / 重做（按 op_group 原子）       |
 * | POST   | /api/sites/:id/trash/:nodeId/restore          | 从回收站恢复                          |
 * | GET    | /api/sites/:id/search                        | 过滤检索（q/depth/status/regex）      |
 *
 * 所有读路径都走「自动层 + 修正层」的有效投影：避免「树变了、详情没变」的不一致。
 */
import type { FastifyInstance } from 'fastify';
import type {
  DeleteNodesResponse,
  MoveNodesResponse,
  NodeDetailResponse,
  TreeNodeRow,
  TrashResponse,
  TreeResponse,
  UndoRedoResponse,
} from '@siteatlas/shared';
import type { CrawlRepo } from '../../core/store/repos/crawl.ts';
import type { EdgesRepo } from '../../core/store/repos/edges.ts';
import type { NodesRepo } from '../../core/store/repos/nodes.ts';
import type { SitesRepo } from '../../core/store/repos/sites.ts';
import type { OverridesService } from '../../core/override/overrides.ts';
import { SiteServiceError } from '../../core/sites/service.ts';

export interface TreeRouteDeps {
  sites: SitesRepo;
  nodes: NodesRepo;
  edges: EdgesRepo;
  crawl: CrawlRepo;
  overrides: OverridesService;
}

/**
 * 树接口的节点行 schema：v_nodes_effective 投影 + 修正标记 + 懒加载计数。
 * 用工厂函数构造（不用对象展开），保证传给 fast-json-stringify 的是全新普通对象。
 */
function makeTreeNodeSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
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
      has_override: { type: 'boolean' },
      child_count: { type: 'integer' },
    },
  };
}

function makeOverrideSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'integer' },
      site_id: { type: 'string' },
      node_id: { type: 'string' },
      field: { type: 'string' },
      value: { type: ['string', 'null'] },
      prev_value: { type: ['string', 'null'] },
      op_group: { type: ['string', 'null'] },
      seq: { type: 'integer' },
      undone: { type: 'integer' },
      created_at: { type: 'integer' },
    },
  };
}

export async function registerTreeRoutes(app: FastifyInstance, deps: TreeRouteDeps): Promise<void> {
  const { sites, nodes, edges, crawl, overrides } = deps;

  /** 组装树行（补 effective_parent_id / child_count） */
  const toRow = (nodeId: string): TreeNodeRow | null => {
    const effective = overrides.effectiveNode(nodeId);
    if (effective === null) return null;
    return {
      ...effective,
      effective_parent_id: overrides.effectiveParentOf(nodeId),
      child_count: nodes.countChildren(effective.site_id, nodeId),
    };
  };

  /* ---------------- 树 / 回收站 ---------------- */

  app.get<{
    Params: { id: string };
    Querystring: { parentId?: string; offset?: string; limit?: string; trash?: string };
  }>(
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
            trash: { type: 'string' },
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
              nodes: { type: 'array', items: makeTreeNodeSchema() },
              entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
        },
      },
    },
    async (request) => {
      const siteId = request.params.id;
      if (sites.get(siteId) === null) {
        throw new SiteServiceError('SITE_NOT_FOUND', `站点不存在：${siteId}`, 404);
      }

      if (request.query.trash === '1') {
        const body: TrashResponse & { nodes: TreeNodeRow[] } = { entries: overrides.trash(siteId), nodes: [] };
        return body;
      }

      const parentId =
        request.query.parentId !== undefined && request.query.parentId !== '' ? request.query.parentId : null;
      const offset = Math.max(0, Number(request.query.offset ?? 0) || 0);
      const limit = Math.min(500, Math.max(1, Number(request.query.limit ?? 100) || 100));
      const page = nodes.childrenPage(siteId, parentId, offset, limit);
      const body: TreeResponse = { parentId, total: page.total, offset, limit, nodes: page.nodes };
      return body;
    },
  );

  /* ---------------- 节点详情（含修正历史） ---------------- */

  app.get<{ Params: { id: string } }>(
    '/api/nodes/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (request) => {
      const row = toRow(request.params.id);
      if (row === null) {
        throw new SiteServiceError('NODE_NOT_FOUND', `节点不存在：${request.params.id}`, 404);
      }
      const incoming = edges.incoming(row.id, 200);
      const outgoing = edges.outgoing(row.id, 500);

      const body: NodeDetailResponse = {
        node: { ...row, has_override: row.has_override },
        parents: incoming.map((edge) => ({ edge, from: overrides.effectiveNode(edge.from_id) })),
        children: outgoing.map((edge) => ({ edge, to: overrides.effectiveNode(edge.to_id) })),
        materials: [],
        history: overrides.history(row.id, 50),
        depths: overrides.depths(row.site_id),
      };
      return body;
    },
  );

  /* ---------------- 修改：别名 / 标题 / 地址 ---------------- */

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
            url: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request) => {
      const effective = overrides.effectiveNode(request.params.id);
      if (effective === null) {
        throw new SiteServiceError('NODE_NOT_FOUND', `节点不存在：${request.params.id}`, 404);
      }
      const { alias, title, url } = request.body ?? {};
      let opGroup: string | null = null;
      let node = effective;

      if (url !== undefined) {
        // §6.8 语义：改的是采集目标地址，旧值保留在 prev_value（历史别名），仍可撤销
        const result = overrides.updateUrl(effective.site_id, effective.id, url);
        opGroup = result.opGroup;
        node = result.node;
      }
      if (alias !== undefined || title !== undefined) {
        const result = overrides.updateDisplay(effective.site_id, effective.id, { alias, title });
        opGroup = result.opGroup ?? opGroup;
        node = result.node;
      }
      return { node: { ...node, effective_parent_id: overrides.effectiveParentOf(node.id) }, opGroup, depths: overrides.depths(effective.site_id) };
    },
  );

  /* ---------------- 重挂（批量） ---------------- */

  app.post<{ Params: { id: string }; Body: { newParentId: string | null; ids?: string[] } }>(
    '/api/nodes/:id/move',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['newParentId'],
          additionalProperties: false,
          properties: {
            newParentId: { type: ['string', 'null'] },
            ids: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    async (request) => {
      const anchor = overrides.effectiveNode(request.params.id);
      if (anchor === null) {
        throw new SiteServiceError('NODE_NOT_FOUND', `节点不存在：${request.params.id}`, 404);
      }
      const ids = request.body.ids !== undefined && request.body.ids.length > 0 ? request.body.ids : [anchor.id];
      const result = overrides.move(anchor.site_id, ids, request.body.newParentId);
      const body: MoveNodesResponse & { depths: { undoDepth: number; redoDepth: number } } = {
        opGroup: result.opGroup,
        moved: result.moved,
        nodes: result.nodes as TreeNodeRow[],
        depths: overrides.depths(anchor.site_id),
      };
      return body;
    },
  );

  /* ---------------- 软删子树 ---------------- */

  app.delete<{ Params: { id: string }; Body?: { ids?: string[] } }>(
    '/api/nodes/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { ids: { type: 'array', items: { type: 'string' } } },
        },
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (request) => {
      const anchor = overrides.effectiveNode(request.params.id);
      if (anchor === null) {
        throw new SiteServiceError('NODE_NOT_FOUND', `节点不存在：${request.params.id}`, 404);
      }
      const ids = request.body?.ids !== undefined && request.body.ids.length > 0 ? request.body.ids : [anchor.id];
      const result = overrides.deleteSubtrees(anchor.site_id, ids);
      const body: DeleteNodesResponse & { depths: { undoDepth: number; redoDepth: number } } = {
        opGroup: result.opGroup,
        affectedNodes: result.affectedNodes,
        nodeIds: result.nodeIds,
        depths: overrides.depths(anchor.site_id),
      };
      return body;
    },
  );

  /* ---------------- 还原为自动结果 ---------------- */

  app.post<{ Params: { id: string } }>(
    '/api/nodes/:id/revert',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (request) => {
      const effective = overrides.effectiveNode(request.params.id);
      if (effective === null) {
        throw new SiteServiceError('NODE_NOT_FOUND', `节点不存在：${request.params.id}`, 404);
      }
      const result = overrides.revertNode(effective.site_id, effective.id);
      return {
        node: { ...result.node, effective_parent_id: overrides.effectiveParentOf(result.node.id) },
        opGroup: result.opGroup,
        depths: overrides.depths(effective.site_id),
      };
    },
  );

  /* ---------------- 撤销 / 重做 / 回收站恢复 ---------------- */

  for (const action of ['undo', 'redo'] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/sites/:id/${action}`,
      {
        schema: {
          params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
          response: { 200: { type: 'object', additionalProperties: true } },
        },
      },
      async (request) => {
        const result = action === 'undo' ? overrides.undo(request.params.id) : overrides.redo(request.params.id);
        const body: UndoRedoResponse = {
          action: result.action,
          affected: result.rows.length,
          rows: result.rows,
          nodeIds: result.nodeIds,
          undoDepth: result.undoDepth,
          redoDepth: result.redoDepth,
        };
        return body;
      },
    );
  }

  app.post<{ Params: { id: string; nodeId: string } }>(
    '/api/sites/:id/trash/:nodeId/restore',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'nodeId'],
          properties: { id: { type: 'string' }, nodeId: { type: 'string' } },
        },
      },
    },
    async (request) => {
      const result = overrides.restoreFromTrash(request.params.id, request.params.nodeId);
      return { ...result, depths: overrides.depths(request.params.id) };
    },
  );

  /* ---------------- 检索（§5.1 GET /search） ---------------- */

  app.get<{
    Params: { id: string };
    Querystring: { q?: string; depth?: string; status?: string; regex?: string; limit?: string };
  }>(
    '/api/sites/:id/search',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string' },
            depth: { type: 'string' },
            status: { type: 'string' },
            regex: { type: 'string', enum: ['0', '1'] },
            limit: { type: 'string' },
          },
        },
      },
    },
    async (request) => {
      const siteId = request.params.id;
      if (sites.get(siteId) === null) {
        throw new SiteServiceError('SITE_NOT_FOUND', `站点不存在：${siteId}`, 404);
      }
      const q = request.query.q ?? '';
      const useRegex = request.query.regex === '1';
      const limit = Math.min(500, Math.max(1, Number(request.query.limit ?? 100) || 100));
      const depth = request.query.depth !== undefined && request.query.depth !== '' ? Number(request.query.depth) : null;
      const status = request.query.status !== undefined && request.query.status !== '' ? request.query.status : null;

      // SQL 侧先按 depth/status 过滤（大站不必把整棵树拉进内存），再做文本/正则匹配
      const candidates = crawl.searchNodes(siteId, { depth, status, limit: 5000 });

      let matcher: (node: { url: string; display_label: string | null; title: string | null; alias: string | null }) => boolean;
      if (q.length === 0) {
        matcher = () => true;
      } else if (useRegex) {
        let re: RegExp;
        try {
          re = new RegExp(q, 'i');
        } catch (err) {
          throw new SiteServiceError('INVALID_REGEX', `正则不合法：${(err as Error).message}`, 400);
        }
        matcher = (node) =>
          re.test(node.url) ||
          re.test(node.display_label ?? '') ||
          re.test(node.title ?? '') ||
          re.test(node.alias ?? '');
      } else {
        const needle = q.toLowerCase();
        matcher = (node) =>
          node.url.toLowerCase().includes(needle) ||
          (node.display_label ?? '').toLowerCase().includes(needle) ||
          (node.title ?? '').toLowerCase().includes(needle) ||
          (node.alias ?? '').toLowerCase().includes(needle);
      }

      const matched = candidates.filter((node) => matcher(node)).slice(0, limit);
      return { total: matched.length, scanned: candidates.length, nodes: matched };
    },
  );
}
