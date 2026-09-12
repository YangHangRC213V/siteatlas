# SiteAtlas（站点图谱采集器）

本地运行的「网站结构采集 + 素材归档」可视化工具。规格见：

- `docs/crawler-tool-requirements.md`（需求规格书 v0.1）
- `docs/crawler-tool-dev-spec.md`（开发规格书 v1.0）—— 施工图
- `docs/DECISIONS.md`（实现决策记录：规格未覆盖处的取舍与理由）

## 当前状态：M0 骨架（dev-spec §7）

已完成：仓库结构、SQLite 迁移、URL 规范化与身份、`/api/sites` 五个接口、站点卡片视图与详情占位页。
**未实现**（按里程碑推进）：M1 自动采集、M2 树视图、M3 手动采集、M4 导出与开放 API。

## 环境要求

- Node.js ≥ 22.6（本机 v26.7.0）；数据库用内置 `node:sqlite`，**不需要**原生编译模块
- 首次安装：`npm install`

## 一条命令启动

```bash
npm start            # = 构建 shared + web，然后启动服务（server 同时托管前端产物）
```

打开 http://127.0.0.1:8787/sites

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SITEATLAS_PORT` / `PORT` | `8787` | 监听端口 |
| `SITEATLAS_HOST` / `HOST` | `127.0.0.1` | 监听地址（本地私有） |
| `SITEATLAS_DB` | `<root>/data/siteatlas.db` | SQLite 文件 |
| `SITEATLAS_ROOT` | 自动向上查找 | 仓库根目录 |
| `SITEATLAS_PROBE_TIMEOUT_MS` | `5000` | 建站时的可达性探测超时 |
| `SITEATLAS_LOG_LEVEL` | `info` | 日志级别 |

数据落在 `data/`（已 gitignore）：元数据在 `data/siteatlas.db`，
后续素材按 dev-spec §3 存 `data/sites/<siteId>/{raw,parsed,exports}`。

## 开发模式（前端热更新）

```bash
npm run dev          # server 用 tsx watch（:8787），web 用 vite（:5173，代理 /api）
```

## 校验

```bash
npm test             # node --test：URL 规范化/范围、迁移与 DDL、/api/sites 全流程
npm run typecheck    # shared + server + web 三处 tsc --noEmit
node scripts/e2e-m0-screenshot.mjs   # 浏览器端到端 + 截图到 docs/screenshots/
```

## 目录结构（dev-spec §3）

```
server/src/
  core/url/       normalize.ts identity.ts scope.ts        # M0 已实现
  core/fetch/     probe.ts                                 # M0 只做建站探测；http-fetcher/pool/robots 属 M1
  core/extract/   content.ts                               # display_label 推导（links/fingerprint 属 M1）
  core/store/     db.ts migrations/ repos/*.ts ids.ts paths.ts
  core/sites/     service.ts                               # 站点用例（建站校验编排）
  api/            server.ts routes/sites.ts errors.ts      # ws.ts / open-api.ts 属 M3/M4
web/src/
  modules/sites/  SitesPage  SiteDetailPage  SiteCard  CreateSiteForm  store  api  types
  components/     AppShell.tsx
  router/         modules.ts（模块名=路由名=目录名）  useRoute.ts
  styles/         tokens.css（§5 视觉规范落地）  base.css
shared/src/       schema.ts                                # 类型契约 v1.0
scripts/          e2e-m0-screenshot.mjs
```

约束：`web/` 不直接读数据库，只走 API；`core/` 不依赖 `api/`。
