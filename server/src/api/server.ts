/**
 * Fastify 应用装配（dev-spec §2 服务端 / §3 目录结构 / §5.1 REST）
 *
 * - REST 前缀 `/api`（内部 UI 用）
 * - 一条命令启动：server 同时托管 web 构建产物（`web/dist`），SPA 路由回落 index.html
 *   因此 /sites/:id/crawl 这类前端路由刷新后仍可用
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { errorHandler, apiError } from './errors.ts';
import { registerSiteRoutes } from './routes/sites.ts';
import { NodesRepo } from '../core/store/repos/nodes.ts';
import { SitesRepo } from '../core/store/repos/sites.ts';
import { SitesService } from '../core/sites/service.ts';
import { SCHEMA_VERSION } from '@siteatlas/shared';

export interface BuildServerOptions {
  db: DatabaseSync;
  /** 项目根目录（默认从 server/src/api/ 上溯三级） */
  rootDir?: string;
  /** web 构建产物目录，默认 `<rootDir>/web/dist` */
  webDistDir?: string;
  logger?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  service: SitesService;
  webDistDir: string;
  webDistPresent: boolean;
}

export function buildServer(options: BuildServerOptions): BuiltServer {
  // 本文件位于 <root>/server/src/api/，上溯四级即项目根
  const rootDir = options.rootDir ?? resolve(import.meta.dirname, '..', '..', '..', '..');
  const webDistDir = options.webDistDir ?? resolve(rootDir, 'web', 'dist');
  const webDistPresent = existsSync(resolve(webDistDir, 'index.html'));

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : { level: process.env['SITEATLAS_LOG_LEVEL'] ?? 'info', transport: undefined },
    disableRequestLogging: false,
  });

  app.setErrorHandler(errorHandler);

  const sites = new SitesRepo(options.db);
  const nodes = new NodesRepo(options.db);
  const service = new SitesService({ sites, nodes });

  app.get('/api/health', async () => ({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    webDistPresent,
    now: Date.now(),
  }));

  app.register(async (instance) => {
    await registerSiteRoutes(instance, service);
  });

  if (webDistPresent) {
    app.register(fastifyStatic, { root: webDistDir, prefix: '/' });
  }

  // SPA 回落：非 /api 的 GET 一律返回 index.html（前端路由自解析）
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/')) {
      if (webDistPresent) return reply.sendFile('index.html');
      return reply
        .code(503)
        .type('text/html')
        .send(
          '<!doctype html><meta charset="utf-8"><h1>SiteAtlas</h1>' +
            '<p>前端产物缺失：请先执行 <code>npm run build</code>（或直接 <code>npm start</code>）。</p>',
        );
    }
    return reply.code(404).send(apiError('NOT_FOUND', `无此路由：${request.method} ${request.url}`));
  });

  return { app, service, webDistDir, webDistPresent };
}
