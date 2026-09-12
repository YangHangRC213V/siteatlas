# SiteAtlas（站点图谱采集器）

本地运行的「网站结构采集 + 素材归档」可视化工具。规格见：

- `docs/crawler-tool-requirements.md`（需求规格书 v0.1）
- `docs/crawler-tool-dev-spec.md`（开发规格书 v1.0）—— 施工图
- `docs/DECISIONS.md`（实现决策记录：规格未覆盖处的取舍与理由）

## 当前状态：M0–M4 全部交付 + 设置模块 + 拓扑多视图与原始网页视图

| 里程碑 | 状态 | 内容 |
|---|---|---|
| M0 骨架 | ✅ | 仓库结构、SQLite 迁移、URL 规范化与身份、`/api/sites` 五接口、站点卡片视图 |
| M1 自动采集 | ✅ | 抓取器（静态 + JS 回落）、持久化队列、三层去重、全部护栏、实时进度、懒加载树视图 |
| M2 树视图 | ✅ | 虚拟滚动、懒加载、属性面板、隐藏地址、软删、撤销重做、拖拽重挂、回收站 |
| M3 手动采集 | ✅ | CDP 画面串流 + 输入回传 + 点击捕获 + 回根识别 + 展开一层（验收 25 项断言全过） |
| M4 导出与开放 | ✅ | JSON/JSONL/CSV/SQLite/Mermaid 导出 + manifest + 对外只读 API（验收 28 项，含独立第三方脚本） |
| 设置模块 | ✅ | 全局默认（礼貌与合规 / 采集默认值 / 素材归档 / 外观）+ 导出预设管理 |
| 拓扑多视图 + 网页视图 | ✅ | 缩进列表 / 层级图 / 关系图（力导向）/ 径向图 + 树内嵌原始网页视图（点未收录链接自动入拓扑）（验收 56 项合并跑） |


M1 已实现的关键机制（详见 `docs/DECISIONS.md`）：

- **三层去重**：`identity_key` 规范化指纹（UNIQUE 约束）→ 正文指纹 `content_hash` → 已抓节点直连复用；
- **护栏**：深度/页数硬上限、同一 URL 访问上限（`access_counts`）、路径前缀 Trie 剪枝、分页序列上限、robots.txt 遵守；
- **礼貌**：默认 1s/请求 + 抖动、并发 5、按域并发 2、UA 可配；
- **可控**：暂停/继续/停止，队列与访问计数全部落库，进程重启后 `running → paused` 复位并可续跑；
- **进度**：WS `/ws/sites/:id` 推送（400ms 节流），断线自动降级为 1.5s 轮询。

结构视图（`/sites/:id/tree`）的多种看树方式：

- **五种展现形式**（同一份数据的五个视角，工具栏一键切换）：
  - 目录树：虚拟滚动 + 懒加载 + 拖拽重挂 + 撤销重做（万级站点用它）；
  - 缩进列表：整树铺开（最多 5000，超出提示），适合扫读与浏览器查找；
  - 层级图：按深度分层，适合看目录层级与同层规模；
  - 关系图：力导向（自研确定性布局，固定轮数 + 自适应铺满），适合看「谁连到谁、哪里扎堆」；
  - 径向图：根在圆心、按深度成环，适合看「几层、每层多少」。
- **原始网页视图**：选中任意节点 → 「🔗 查看原始网页」→ 右侧内嵌服务端 Chromium 的真实画面（复用 M3 会话，
  不另起浏览器）。在画面里点到**未收录的链接**会立即建边建节点，左侧拓扑自动刷新
  —— 也就是「一边看页面一边补图」。
- **画面放大**：面板里的画面太小不好操作，因此提供两级放大 ——
  **⤢ 最大化**（隐藏其它面板，画面铺满内容区，Esc 退出）与 **⛶ 全屏**（Fullscreen API，占满显示器）；
  两种模式都自动切换为「铺满」适配（保持远端视口宽高比、不裁切、不留黑边），
  缩放后会自动重画最近一帧（否则 Chromium 会把放大的 canvas 渲染成黑块，实测踩过）。手动采集页同样有这两个按钮。
- 前端不做图形库依赖：布局算法在 `web/src/modules/tree/layout.ts`（纯函数、可单测、**确定性**，图不会每次打开都跳），
  渲染用 SVG（层级图用父子折线连接，点节点选中、双击打开原始网页）。

设置模块（导航「设置」）：

- **全局默认**：并发/单域并发/请求间隔/抖动/robots/UA、深度与页数护栏、渲染模式、超时与重试、前缀剪枝与分页上限、素材落盘开关、外观（深色/动效）—— 表单由 `SETTING_FIELDS` 一处定义生成（界面不重复写默认值）；
- **默认值与护栏分离**：设置只覆盖标记 `inPreset` 的字段，**护栏（maxPages/剪枝阈值等）仍取 §6.3 内置默认**，不会被设置悄悄放宽；
- **即时生效**：改完保存，下一次采集任务的预设即采用新默认（验收脚本里有断言）；
- **导出预设**（requirements §4.6）：保存常用的格式/范围组合，导出页一键复用，可设默认（唯一）；
- **真源单点**：设置在 §4 的 `settings(k,v)` 表，值是 JSON（避免 `"false"` 被读成真）；非法值整批拒绝、不写库（不允许半套设置生效）。

M4 已实现的关键机制：

- **导出**：五种格式（JSON 完整图 / JSONL 流式 / CSV 节点表+边表 / SQLite 快照 / Mermaid 树），产物落 `data/sites/<id>/exports/<exportId>/`，附 `README.md`；超过 5 万节点自动改走流式写出（内存与规模无关）；
- **manifest.json**：下游唯一入口 —— `schemaVersion`、计数、三档分层（structure / raw / parsed）、`files` 映射（每个产物的 sha256 + bytes + 行数 + 承载数据集）、`endpoints`（只读 API 地址）；
- **三档数据**：结构层在库里；采集时把原件写 `raw/<nodeId>.html`、解析结果写 `parsed/<nodeId>.json`（标题/描述/正文摘要/内容指纹），登记在 `materials` 表并按 nodeId 关联，导出时只引用不复制（原件层跟随预设 `downloadAssets` 开关）；
- **对外只读 API**：`/open/v1/sites/:id/{graph.json,nodes.jsonl,edges.csv,manifest.json}` 即时导出、`/open/v1/sites/:id/nodes/:nodeId` 单节点、`/open/v1/exports/:exportId/<文件名>` 原样取回产物（带目录穿越防护），全部只读；
- **导出页**：`/sites/:id/export` —— 选格式/范围（整站 / 子树 / 含软删）、看历史任务、看 manifest 文件清单与下游接入地址；
- **验收方式**：`scripts/e2e-m4-export.mjs` 会起一个**与仓库无关的独立 Node 进程**（写在系统临时目录、不 import 本仓库），只给它 manifest 地址，由它自己取回全部文件并逐文件校验 sha256 —— 这就是「第三方脚本仅凭 manifest 能读取全部数据」的证据。

M3 已实现的关键机制：

- **画面**：服务端 Chromium 用 CDP `Page.startScreencast` 推 JPEG 帧，经 `ScreencastPump` 节流（只保最新帧）送到前端 canvas；
- **输入**：画面上的鼠标/键盘/滚轮折成 CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent` 回传，等于「在浏览器里手动点」；
- **点击捕获**：`Runtime.addBinding` + 捕获阶段 click 监听，点击先进「点击↔导航」配对队列，只有真的发生导航才建边建节点；未触发导航的点击进**待确认队列**（界面实时显示，确认后才入树）；
- **身份与回根**：一律按 `identityKey` 判身份，回到根/已知节点**只补边不重复建节点**；回根/回父用绝对 URL 导航，不用浏览器后退；越界导航被范围校验拒绝；
- **人工纠正**：「以当前页为根」「置为父节点」直写并留 `manual_overrides` 痕迹；防环校验沿祖先链；
- **展开一层**（§4.3 工具条）：为「链接被 JS 拦截 / 用户想按自己意图继续深入」提供一个明确的推进动作 ——
  在当前页下建一个占位子节点（派生地址 `<当前路径>/siteatlas-expand/<n>`，标 `need_human`）并导航过去，
  之后可在树视图用「修改地址」改成真实地址。

M2 已实现的关键机制：

- **修正层**：树的最终形态 = 自动投影叠加 `node_overrides`（重挂 / 改地址 / 别名 / 标题 / 软删子树），原数据不动，**读路径统一套用同一段有效投影**；
- **撤销/重做**：`node_override_ops` 时间线 + 前缀不变式（LIFO），批量操作按 `op_group` 原子撤销，⌘Z / ⌘⇧Z；
- **还原与回收站**：单节点「还原为自动结果」、整棵子树软删进回收站并可恢复，两者本身都可撤销；
- **万级树**：`@tanstack/react-virtual` 虚拟滚动 + 按 `parent_id` 惰性分页（实测 12001 节点：DOM 仅 31 行、滚动 15.8ms/帧、打开只拉 101 个节点）。

## 许可

MIT，见 `LICENSE`。

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
npm test             # node --test：server 全部 + web 的图形布局（123 项：URL 规范化/迁移与 DDL/采集内核/WS/手动会话/导出与只读 API/设置与预设/拓扑布局）
npm run typecheck    # shared + server + web 三处 tsc --noEmit

node scripts/demo-site.mjs 8899      # 起本地演示站（多级/多父/变体/404/robots/素材/SPA/分页）
                                     # e2e 脚本默认用自带 Chromium；PW_CHANNEL=chrome 可切系统 Chrome
node scripts/e2e-m0-screenshot.mjs   # M0 端到端 + 截图
node scripts/e2e-m1-crawl.mjs        # M1 端到端：建站→订阅 WS→采集→树→自检→截图（14 项断言）
node scripts/e2e-m2-tree.mjs         # M2 端到端：拖拽重挂/撤销重做/批量/属性/回收站/12k 节点压测（18 项断言）
node scripts/e2e-m3-manual.mjs       # M3 端到端：真实 Chromium 手动点选建边/回根不重复建节点/展开一层/待确认确认与丢弃（25 项断言）
node scripts/e2e-m4-export.mjs       # M4 端到端：导出/manifest/只读 API/第三方脚本/设置/拓扑多视图/网页视图/画面放大（61 项断言）
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
  core/export/    dataset.ts writers.ts service.ts         # 导出：数据集投影 / 各格式写出器 / 编排与 manifest（M4）
  core/materials/ archive.ts hash.ts                       # 素材归档：raw 原件 + parsed 解析结果（M4）
  core/settings/  service.ts                               # 全局设置与导出预设（设置模块）
  core/sites/     service.ts                               # 站点用例（建站校验编排）
  core/manual/    session.ts capture.ts screencast.ts service.ts   # 手动会话：配对/待确认/串流节流
  api/            server.ts errors.ts ws.ts ws-manual.ts routes/{sites,crawl,tree,manual,export,settings}.ts open-api.ts
  tests/          fixture-site.ts  fake-browser.ts          # 本地 fixture 站点 + 可注入的假页面会话
web/src/
  modules/sites/  SitesPage  SiteDetailPage  SiteSubPage  SiteCard  CreateSiteForm  store  api  types
  modules/crawl/  CrawlPage  store  api  crawl.css           # 采集控制台（M1）
  modules/tree/   TreePage  store  api  tree.css             # 虚拟滚动树视图 + 修正层交互（M2）
                  IndentedView.tsx  TopoView.tsx  layout.ts  # 缩进列表 / 层级图 / 关系图 / 径向图 + 布局算法
  components/     RemoteBrowserView.tsx                      # 服务端 Chromium 画面（手动采集页与树视图共用）
  modules/manual/ ManualPage  RemoteBrowserView  store  api  manual.css   # 手动采集控制台（M3）
  modules/export/ ExportPage  store  api  export.css        # 导出控制台 + manifest 展示（M4）
  modules/settings/ SettingsPage  store  api  theme.ts  settings.css   # 全局设置与预设（表单由契约生成）
  components/     AppShell.tsx
  router/         modules.ts（模块名=路由名=目录名）  useRoute.ts
  styles/         tokens.css（§5 视觉规范落地）  base.css
shared/src/       schema.ts                                # 类型契约 v1.0
scripts/          demo-site.mjs  e2e-m0-screenshot.mjs  e2e-m1-crawl.mjs  e2e-m2-tree.mjs  e2e-m3-manual.mjs  e2e-m4-export.mjs
```

约束：`web/` 不直接读数据库，只走 API；`core/` 不依赖 `api/`。
