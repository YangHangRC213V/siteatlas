# SiteAtlas（站点图谱采集器）

本地运行的「网站结构采集 + 素材归档」可视化工具。规格见：

- `docs/crawler-tool-requirements.md`（需求规格书 v0.1）
- `docs/crawler-tool-dev-spec.md`（开发规格书 v1.0）—— 施工图
- `docs/DECISIONS.md`（实现决策记录：规格未覆盖处的取舍与理由）

## 当前状态：M3 手动引导采集（dev-spec §7）

| 里程碑 | 状态 | 内容 |
|---|---|---|
| M0 骨架 | ✅ | 仓库结构、SQLite 迁移、URL 规范化与身份、`/api/sites` 五接口、站点卡片视图 |
| M1 自动采集 | ✅ | 抓取器（静态 + JS 回落）、持久化队列、三层去重、全部护栏、实时进度、懒加载树视图 |
| M2 树视图 | ✅ | 虚拟滚动、懒加载、属性面板、隐藏地址、软删、撤销重做、拖拽重挂、回收站 |
| M3 手动采集 | ✅ | CDP 画面串流 + 输入回传 + 点击捕获 + 回根识别（验收 22 项断言全过） |
| M4 导出与开放 | ⏳ | JSON/JSONL/CSV/SQLite/Mermaid + manifest + 只读 API |

M1 已实现的关键机制（详见 `docs/DECISIONS.md`）：

- **三层去重**：`identity_key` 规范化指纹（UNIQUE 约束）→ 正文指纹 `content_hash` → 已抓节点直连复用；
- **护栏**：深度/页数硬上限、同一 URL 访问上限（`access_counts`）、路径前缀 Trie 剪枝、分页序列上限、robots.txt 遵守；
- **礼貌**：默认 1s/请求 + 抖动、并发 5、按域并发 2、UA 可配；
- **可控**：暂停/继续/停止，队列与访问计数全部落库，进程重启后 `running → paused` 复位并可续跑；
- **进度**：WS `/ws/sites/:id` 推送（400ms 节流），断线自动降级为 1.5s 轮询。

M3 已实现的关键机制：

- **画面**：服务端 Chromium 用 CDP `Page.startScreencast` 推 JPEG 帧，经 `ScreencastPump` 节流（只保最新帧）送到前端 canvas；
- **输入**：画面上的鼠标/键盘/滚轮折成 CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent` 回传，等于「在浏览器里手动点」；
- **点击捕获**：`Runtime.addBinding` + 捕获阶段 click 监听，点击先进「点击↔导航」配对队列，只有真的发生导航才建边建节点；未触发导航的点击进**待确认队列**（界面实时显示，确认后才入树）；
- **身份与回根**：一律按 `identityKey` 判身份，回到根/已知节点**只补边不重复建节点**；回根/回父用绝对 URL 导航，不用浏览器后退；越界导航被范围校验拒绝；
- **人工纠正**：「以当前页为根」「置为父节点」直写并留 `manual_overrides` 痕迹；防环校验沿祖先链。

M2 已实现的关键机制：

- **修正层**：树的最终形态 = 自动投影叠加 `node_overrides`（重挂 / 改地址 / 别名 / 标题 / 软删子树），原数据不动，**读路径统一套用同一段有效投影**；
- **撤销/重做**：`node_override_ops` 时间线 + 前缀不变式（LIFO），批量操作按 `op_group` 原子撤销，⌘Z / ⌘⇧Z；
- **还原与回收站**：单节点「还原为自动结果」、整棵子树软删进回收站并可恢复，两者本身都可撤销；
- **万级树**：`@tanstack/react-virtual` 虚拟滚动 + 按 `parent_id` 惰性分页（实测 12001 节点：DOM 仅 31 行、滚动 15.8ms/帧、打开只拉 101 个节点）。

## 环境要求

- Node.js ≥ 22.6（本机 v26.7.0）；数据库用内置 `node:sqlite`，**不需要**原生编译模块
- 首次安装：`npm install`
- 浏览器（JS 渲染回落 + 手动采集需要）：`npx playwright install chromium`
  —— 本机实测直连 `playwright.azureedge.net` 会挂，走镜像即可：
  `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium`
  （装到 `~/Library/Caches/ms-playwright/chromium-1243`）。浏览器池默认用这个自带 Chromium，
  启动失败才回落系统 Chrome（`channel: 'chrome'`），两者都没有时自动渲染降级为静态抓取

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
npm test             # node --test：URL 规范化/范围、迁移与 DDL、/api/sites、采集内核与接口、WS、手动会话（97 项）
npm run typecheck    # shared + server + web 三处 tsc --noEmit

node scripts/demo-site.mjs 8899      # 起本地演示站（多级/多父/变体/404/robots/素材/SPA/分页）
                                     # e2e 脚本默认用自带 Chromium；PW_CHANNEL=chrome 可切系统 Chrome
node scripts/e2e-m0-screenshot.mjs   # M0 端到端 + 截图
node scripts/e2e-m1-crawl.mjs        # M1 端到端：建站→订阅 WS→采集→树→自检→截图（14 项断言）
node scripts/e2e-m2-tree.mjs         # M2 端到端：拖拽重挂/撤销重做/批量/属性/回收站/12k 节点压测（18 项断言）
node scripts/e2e-m3-manual.mjs       # M3 端到端：真实 Chromium 手动点选建边/回根不重复建节点/待确认确认与丢弃（22 项断言）
```

## 目录结构（dev-spec §3）

```
server/src/
  core/url/       normalize.ts identity.ts scope.ts
  core/fetch/     probe.ts http-fetcher.ts browser-fetcher.ts pool.ts robots.ts
  core/crawl/     scheduler.ts frontier.ts politeness.ts retry.ts pagination.ts prefix.ts control.ts service.ts
  core/extract/   links.ts content.ts
  core/store/     db.ts migrations/ effective.ts repos/{sites,nodes,edges,crawl,overrides}.ts ids.ts paths.ts
  core/override/  overrides.ts                             # 修正层用例（重挂/改地址/软删/撤销重做/回收站）
  core/sites/     service.ts                               # 站点用例（建站校验编排）
  core/manual/    session.ts capture.ts screencast.ts service.ts   # 手动会话：配对/待确认/串流节流
  api/            server.ts errors.ts ws.ts ws-manual.ts routes/{sites,crawl,tree,manual}.ts   # open-api.ts 属 M4
  tests/          fixture-site.ts  fake-browser.ts          # 本地 fixture 站点 + 可注入的假页面会话
web/src/
  modules/sites/  SitesPage  SiteDetailPage  SiteSubPage  SiteCard  CreateSiteForm  store  api  types
  modules/crawl/  CrawlPage  store  api  crawl.css           # 采集控制台（M1）
  modules/tree/   TreePage  store  api  tree.css             # 虚拟滚动树视图 + 修正层交互（M2）
  modules/manual/ ManualPage  RemoteBrowserView  store  api  manual.css   # 手动采集控制台（M3）
  components/     AppShell.tsx
  router/         modules.ts（模块名=路由名=目录名）  useRoute.ts
  styles/         tokens.css（§5 视觉规范落地）  base.css
shared/src/       schema.ts                                # 类型契约 v1.0
scripts/          demo-site.mjs  e2e-m0-screenshot.mjs  e2e-m1-crawl.mjs  e2e-m2-tree.mjs  e2e-m3-manual.mjs
```

约束：`web/` 不直接读数据库，只走 API；`core/` 不依赖 `api/`。
