/**
 * 服务入口（dev-spec §7 M0「服务启动」）
 *
 * 一条命令：`npm start`（根 package.json → 构建 shared/web → 本文件）
 * 环境变量：
 *   PORT / SITEATLAS_PORT  监听端口，默认 8787
 *   HOST / SITEATLAS_HOST  监听地址，默认 127.0.0.1（本地私有，requirements §4.7）
 *   SITEATLAS_DB           数据库文件，默认 <root>/data/siteatlas.db
 */
import { resolve } from 'node:path';
import { buildServer } from './api/server.ts';
import { openDb } from './core/store/db.ts';

// 本文件位于 <root>/server/src/，上溯三级即项目根
const rootDir = resolve(import.meta.dirname, '..', '..', '..');
const port = Number(process.env['SITEATLAS_PORT'] ?? process.env['PORT'] ?? 8787);
const host = process.env['SITEATLAS_HOST'] ?? process.env['HOST'] ?? '127.0.0.1';

const handle = openDb({ rootDir, file: process.env['SITEATLAS_DB'] });
const { app, webDistDir, webDistPresent } = buildServer({ db: handle.db, rootDir });

app.addHook('onClose', async () => {
  handle.close();
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info(`收到 ${signal}，关闭中…`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  const applied = handle.migrations?.applied ?? [];
  const skipped = handle.migrations?.skipped ?? [];
  app.log.info(
    `SQLite: ${handle.file} | 迁移 新应用=${applied.length ? applied.join(',') : '无'} 已存在=${skipped.length}`,
  );
  await app.listen({ port, host });
  app.log.info(`SiteAtlas 已启动：http://${host}:${port}`);
  app.log.info(
    webDistPresent
      ? `已托管前端产物：${webDistDir}`
      : `未找到前端产物（${webDistDir}），仅提供 /api。先跑 npm run build`,
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
