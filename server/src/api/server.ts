/**
 * Fastify 应用装配（dev-spec §2 服务端 / §3 目录结构 / §5.1 REST / §5.2 WS）
 *
 * - REST 前缀 `/api`（内部 UI 用）
 * - WS `/ws/sites/:id`：采集进度推送（@fastify/websocket，底层即 `ws`）
 * - 一条命令启动：server 同时托管 web 构建产物（`web/dist`），SPA 路由回落 index.html
 *   因此 /sites/:id/crawl、/sites/:id/tree 这类前端路由刷新后仍可用
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '@siteatlas/shared';
import { errorHandler, apiError } from './errors.ts';
import { registerSiteRoutes } from './routes/sites.ts';
import { registerCrawlRoutes } from './routes/crawl.ts';
import { registerTreeRoutes } from './routes/tree.ts';
import { registerManualRoutes } from './routes/manual.ts';
import { registerExportRoutes } from './routes/export.ts';
import { registerOpenApiRoutes } from './routes/open-api.ts';
import { CrawlBroadcaster, registerWsRoutes } from './ws.ts';
import { registerManualWsRoutes } from './ws-manual.ts';
import { ManualService } from '../core/manual/service.ts';
import { Scheduler } from '../core/crawl/scheduler.ts';
import { CrawlService } from '../core/crawl/service.ts';
import { BrowserPool } from '../core/fetch/pool.ts';
import { OverridesService } from '../core/override/overrides.ts';
import { CrawlRepo } from '../core/store/repos/crawl.ts';
import { OverridesRepo } from '../core/store/repos/overrides.ts';
import { EdgesRepo } from '../core/store/repos/edges.ts';
import { NodesRepo } from '../core/store/repos/nodes.ts';
import { SitesRepo } from '../core/store/repos/sites.ts';
import { MaterialsRepo } from '../core/store/repos/materials.ts';
import { ExportService } from '../core/export/service.ts';
import { MaterialsArchiver } from '../core/materials/archive.ts';
import { findProjectRoot } from '../core/store/paths.ts';
import { SitesService } from '../core/sites/service.ts';

export interface BuildServerOptions {
  db: DatabaseSync;
  /** 项目根目录（默认自动向上查找 workspaces 根） */
  rootDir?: string;
  /** web 构建产物目录，默认 `<rootDir>/web/dist` */
  webDistDir?: string;
  logger?: boolean;
  /** 注入浏览器池（测试用；默认惰性启动 Playwright） */
  pool?: BrowserPool;
  /** 注入调度器（测试用；默认真实 Scheduler） */
  schedulerFactory?: (options: ConstructorParameters<typeof Scheduler>[0]) => Scheduler;
}

export interface BuiltServer {
  app: FastifyInstance;
  service: SitesService;
  crawlService: CrawlService;
  overridesService: OverridesService;
  manualService: ManualService;
  exportService: ExportService;
  materials: MaterialsRepo;
  broadcaster: CrawlBroadcaster;
  pool: BrowserPool;
  webDistDir: string;
  webDistPresent: boolean;
}

export function buildServer(options: BuildServerOptions): BuiltServer {
  // 默认从本文件位置向上找 npm workspaces 根（不依赖调用方 cwd）
  const rootDir = options.rootDir ?? findProjectRoot(import.meta.dirname);
  const webDistDir = options.webDistDir ?? resolve(rootDir, 'web', 'dist');
  const webDistPresent = existsSync(resolve(webDistDir, 'index.html'));

  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env['SITEATLAS_LOG_LEVEL'] ?? 'info' },
  });

  app.setErrorHandler(errorHandler);

  const sites = new SitesRepo(options.db);
  const nodes = new NodesRepo(options.db);
  const edges = new EdgesRepo(options.db);
  const crawl = new CrawlRepo(options.db);
  const overrides = new OverridesService({ db: options.db, nodes, sites, overrides: new OverridesRepo(options.db) });
  const pool = options.pool ?? new BrowserPool();
  const service = new SitesService({ sites, nodes });
  const broadcaster = new CrawlBroadcaster();
  const materials = new MaterialsRepo(options.db);
  const archiver = new MaterialsArchiver({ rootDir, materials });
  const crawlService = new CrawlService({ db: options.db, sites, nodes, edges, crawl, pool, archiver });
  const manualService = new ManualService({ db: options.db, sites, nodes, edges, pool });
  const exportService = new ExportService({ db: options.db, rootDir });

  // 进程启动即复位上次遗留的 running 队列（dev-spec §6.6 断点续爬）
  const recovered = crawlService.recover();
  if (recovered > 0) {
    app.log.info(`断点续爬：${recovered} 个中断的队列项已复位为 pending`);
  }

  app.get('/api/health', async () => ({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    webDistPresent,
    browserAvailable: await pool.available(),
    browserError: pool.lastLaunchError,
    now: Date.now(),
  }));

  app.register(async (instance) => {
    await registerSiteRoutes(instance, service);
    await registerCrawlRoutes(instance, crawlService, broadcaster);
    await registerTreeRoutes(instance, { sites, nodes, edges, crawl, overrides, materials });
    await registerManualRoutes(instance, manualService);
    await registerExportRoutes(instance, { exports: exportService, materials });
    await registerOpenApiRoutes(instance, { exports: exportService });
  });

  app.register(async (instance) => {
    await instance.register(fastifyWebsocket);
    await registerWsRoutes(instance, broadcaster);
    await registerManualWsRoutes(instance, manualService);
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

  app.addHook('onClose', async () => {
    await manualService.stopAll();
    await crawlService.stopAll();
    await pool.close();
  });

  return {
    app,
    service,
    crawlService,
    overridesService: overrides,
    manualService,
    exportService,
    materials,
    broadcaster,
    pool,
    webDistDir,
    webDistPresent,
  };
}
