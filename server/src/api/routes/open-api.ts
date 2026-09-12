/**
 * api/routes/open-api.ts —— 对外只读 API（dev-spec §5.3）
 *
 * 设计目标（§7 M4 验收）：**第三方脚本仅凭 manifest.json 就能读取全部数据**。因此：
 *   · `manifest.json` 是入口，`files` 给出每个产物的名字/sha256/bytes/承载数据集与行数；
 *   · 产物通过 `GET /open/v1/exports/:exportId/<文件名>` 原样取回（与本地文件字节一致），
 *     第三方脚本不需要了解站点的任何内部结构；
 *   · 另有站点级「即时导出」入口（无需先建导出任务）与单节点查询 `nodes/:nodeId`（§5.3 要求）。
 *
 * 只读：这里没有任何写路由；`nodeId` 是主键，跨导出、跨版本不变（§5.3）。
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { SCHEMA_VERSION, type ExportManifest } from '@siteatlas/shared';
import { effectiveProjection, hasOverrideExpr } from '../../core/store/effective.ts';
import { edgesCsv, graphJson, nodesJsonl } from '../../core/export/writers.ts';
import type { ExportService } from '../../core/export/service.ts';

interface SiteParams {
  id: string;
}

export interface OpenApiDeps {
  exports: ExportService;
}

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mmd': 'text/plain; charset=utf-8',
  '.db': 'application/vnd.sqlite3',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

function sha256Hex(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

function notFound(reply: FastifyReply, code: string, message: string): unknown {
  return reply.code(404).send({ error: { code, message } });
}

export async function registerOpenApiRoutes(app: FastifyInstance, deps: OpenApiDeps): Promise<void> {
  const service = deps.exports;

  /* ---------------- 站点级即时导出 ---------------- */

  app.get<{ Params: SiteParams }>('/open/v1/sites/:id/graph.json', async (request, reply) => {
    const dataset = service.dataset(request.params.id);
    if (dataset === null) return notFound(reply, 'SITE_NOT_FOUND', `站点不存在：${request.params.id}`);
    reply.header('content-type', 'application/json; charset=utf-8');
    return graphJson(dataset).content;
  });

  app.get<{ Params: SiteParams }>('/open/v1/sites/:id/nodes.jsonl', async (request, reply) => {
    const dataset = service.dataset(request.params.id);
    if (dataset === null) return notFound(reply, 'SITE_NOT_FOUND', `站点不存在：${request.params.id}`);
    reply.header('content-type', 'application/x-ndjson; charset=utf-8');
    return nodesJsonl(dataset).content;
  });

  app.get<{ Params: SiteParams }>('/open/v1/sites/:id/edges.csv', async (request, reply) => {
    const dataset = service.dataset(request.params.id);
    if (dataset === null) return notFound(reply, 'SITE_NOT_FOUND', `站点不存在：${request.params.id}`);
    reply.header('content-type', 'text/csv; charset=utf-8');
    return edgesCsv(dataset.edges).content;
  });

  /** 站点级 manifest：没有导出任务时也给出等价的即时清单（含每个文件的 sha256 与大小） */
  app.get<{ Params: SiteParams }>('/open/v1/sites/:id/manifest.json', async (request, reply) => {
    const dataset = service.dataset(request.params.id);
    if (dataset === null) return notFound(reply, 'SITE_NOT_FOUND', `站点不存在：${request.params.id}`);
    const base = `/open/v1/sites/${dataset.site.id}`;
    const files: ExportManifest['files'] = {};
    for (const artifact of [graphJson(dataset), nodesJsonl(dataset), edgesCsv(dataset.edges)]) {
      const content = artifact.content ?? '';
      files[artifact.name] = {
        sha256: sha256Hex(content),
        bytes: Buffer.byteLength(content, 'utf8'),
        dataset: artifact.dataset,
        ...(artifact.rows === undefined ? {} : { rows: artifact.rows }),
      };
    }
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      exportId: 'live',
      siteId: dataset.site.id,
      siteName: dataset.site.name,
      rootUrl: dataset.site.rootUrl,
      generatedAt: dataset.generatedAt,
      format: 'json',
      scope: 'site',
      counts: dataset.counts,
      layers: { structure: Object.keys(files), raw: [], parsed: [] },
      files,
      endpoints: {
        graph: `${base}/graph.json`,
        nodes: `${base}/nodes.jsonl`,
        edges: `${base}/edges.csv`,
        manifest: `${base}/manifest.json`,
        sqlite: `${base}/siteatlas.db`,
        node: `${base}/nodes/{nodeId}`,
      },
      /** 该站已有的导出任务（含各自的 manifest 入口） */
      exports: service.listForSite(dataset.site.id, 20).map((record) => ({
        exportId: record.id,
        format: record.format,
        status: record.status,
        createdAt: record.created_at,
        manifest: `/open/v1/exports/${record.id}/manifest.json`,
      })),
    };
    reply.header('content-type', 'application/json; charset=utf-8');
    return `${JSON.stringify(manifest, null, 2)}\n`;
  });

  /** 单节点查询（§5.3）：节点 + 关联边 + 素材，父节点是有效父节点 */
  app.get<{ Params: { id: string; nodeId: string } }>('/open/v1/sites/:id/nodes/:nodeId', async (request, reply) => {
    // 与导出数据集同一套投影，并把列名统一成 parent_id（下游只认一个名字）
    const row = service.database
      .prepare(
        `SELECT ${effectiveProjection('v')}, ${hasOverrideExpr('v')} AS has_override
         FROM v_nodes_effective v WHERE v.site_id = ? AND v.id = ?`,
      )
      .get(request.params.id, request.params.nodeId) as Record<string, unknown> | undefined;
    if (row !== undefined) {
      row['parent_id'] = row['effective_parent_id'] ?? null;
    }
    if (row === undefined) return notFound(reply, 'NODE_NOT_FOUND', `节点不存在：${request.params.nodeId}`);
    const edges = service.database
      .prepare('SELECT * FROM edges WHERE from_id = ? OR to_id = ? ORDER BY id')
      .all(request.params.nodeId, request.params.nodeId);
    const materials = service.database
      .prepare('SELECT kind, rel_path, bytes, sha256 FROM materials WHERE node_id = ? ORDER BY kind, rel_path')
      .all(request.params.nodeId);
    reply.header('content-type', 'application/json; charset=utf-8');
    return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, node: row, edges, materials }, null, 2)}\n`;
  });

  /* ---------------- 导出产物（第三方凭 manifest 直接取文件） ---------------- */

  app.get<{ Params: { exportId: string } }>('/open/v1/exports/:exportId', async (request, reply) => {
    const dir = service.dirOf(request.params.exportId);
    if (dir === null) return notFound(reply, 'EXPORT_NOT_FOUND', `导出不存在：${request.params.exportId}`);
    const manifestPath = join(dir, 'manifest.json');
    reply.header('content-type', 'application/json; charset=utf-8');
    return `${JSON.stringify(
      {
        exportId: request.params.exportId,
        files: service.artifacts(request.params.exportId),
        manifest: existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown) : null,
      },
      null,
      2,
    )}\n`;
  });

  app.get<{ Params: { exportId: string; file: string } }>('/open/v1/exports/:exportId/:file', async (request, reply) => {
    const dir = service.dirOf(request.params.exportId);
    if (dir === null) return notFound(reply, 'EXPORT_NOT_FOUND', `导出不存在：${request.params.exportId}`);
    const base = resolve(dir);
    const target = resolve(base, request.params.file);
    // 目录穿越防护：解析后必须仍在导出目录内
    if (target !== base && !target.startsWith(base + sep)) {
      return reply.code(400).send({ error: { code: 'INVALID_PATH', message: '非法路径' } });
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      return notFound(reply, 'FILE_NOT_FOUND', `产物不存在：${request.params.file}`);
    }
    reply.header('content-type', CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream');
    reply.header('x-siteatlas-export', request.params.exportId);
    return reply.send(createReadStream(target));
  });
}
