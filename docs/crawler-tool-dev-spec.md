# SiteAtlas 开发规格书 v1.0

> 依据 v0.1 需求规格 + 用户 5 项决策收敛。本文档可直接作为开发（含 AI 编码代理）的施工图。

## 0. 定稿决策

| 项 | 决策 | 影响 |
|---|---|---|
| 形态 | **本地 Web 服务**（单进程，浏览器打开 localhost） | 无桌面窗口 → 手动采集必须用 CDP 画面串流 + 输入回传（见 §6.5） |
| 浏览器载体 | **内嵌 Chromium**（Playwright 驱动，服务端启动） | 手动/JS 渲染共用同一浏览器池 |
| 抓取范围 | 同域 **+ 子域 + 跨域白名单**（默认策略可选） | 页面数易爆 → 必须有硬上限与收敛护栏（§6.3） |
| 素材 | **默认只存正文**；原始 HTML / 截图 / 附件 **开关控制** | `nodes` 素材字段按需写入，`materials` 表登记 |
| 规模 | **按最大量级：单站 10^5 节点（存储层预留 10^6）** | 裁决见 §1 |

## 1. 规模裁决（回答「是否有量级差别」）

**结论：按 10 万级设计，与千级方案是同一套技术栈与代码，不存在量级差异。**

理由：
- SQLite 单表 10^5–10^6 行 + 索引属常规负载；树查询用递归 CTE + `(site_id, auto_parent_id)` 索引即可。
- 前端树的虚拟滚动、懒加载子节点、分页查询，在千级方案里也需要（否则千级就卡）。
- 内存：10 万节点元数据 ≈ 50–100MB，本地服务可承受。
- 唯一真正的量级变量是**抓取时长**，不是代码：跨域 10 万页 @1s/请求 ≈ 27 小时 → 靠并发 + 按域限速 + 断点续爬解决，而不是靠换栈。

因此：**不引入分布式/消息队列，不换数据库**。只强制以下四条（廉价、但不可省）：
1. 树渲染必须虚拟滚动；
2. 子节点必须按 `parent_id` 懒加载 + 分页；
3. 高频查询字段必须建索引；
4. 抓取队列必须持久化，支持重启续跑。

## 2. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js 20+ / TypeScript | 与 Playwright、SQLite 生态一致，单语言贯穿前后端 |
| 服务端 | Fastify + `ws` | REST + WebSocket（进度、手动采集画面与输入） |
| 浏览器 | Playwright（Chromium / CDP） | 自动渲染 + 手动采集共用；浏览器池 |
| 静态抓取 | undici + cheerio | 快路径，链接数为 0 或判定为 SPA 时回落 Playwright |
| 存储 | SQLite（better-sqlite3, WAL） | 元数据 + 队列 + 修正层；素材走文件系统 |
| 前端 | React + Vite + Zustand + TanStack Virtual | 虚拟滚动、分栏布局 |
| 样式 | CSS 变量设计令牌（tokens.css） | 「清新淡雅」落地为可切换主题 |
| 打包 | 单命令启动（`npm start`），数据落在 `data/` | 无外部依赖服务 |

替代方案（如后续想换）：内核与界面通过契约解耦，内核可整体改为 Python/FastAPI 或 Rust/axum，接口不变。

## 3. 仓库结构与模块边界

```
siteatlas/
  server/src/
    core/url/       normalize.ts  identity.ts  scope.ts      # URL 规范化、指纹、范围判定
    core/fetch/     http-fetcher.ts  browser-fetcher.ts  pool.ts  robots.ts
    core/crawl/     scheduler.ts  frontier.ts  politeness.ts  retry.ts
    core/extract/   links.ts  content.ts  fingerprint.ts
    core/store/     db.ts  migrations/  repos/*.ts
    core/override/  overrides.ts  undo.ts                     # 人工修正层 + 撤销栈
    api/            routes/*.ts  ws.ts  open-api.ts
    manual/         session.ts  screencast.ts  input.ts  capture.ts
  web/src/
    modules/{sites,crawl,tree,data,rules,export,settings}/
    components/  styles/tokens.css
  shared/           schema.ts        # 类型契约（前后端共用，版本化）
  plugins/          exporters/  parsers/  postprocessors/
  data/sites/<siteId>/  raw/  parsed/  exports/  siteatlas.db
```

约束：`web/` 不直接读数据库，只走 API；`core/` 不依赖 `api/`。界面模块名 = 路由名 = 目录名。

## 4. 数据表结构

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE sites (
  id             TEXT PRIMARY KEY,            -- ULID
  name           TEXT NOT NULL,
  root_url       TEXT NOT NULL,               -- 绝对 URL
  root_host      TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'same_site', -- same_domain|same_site|allowlist|all
  allowlist_json TEXT NOT NULL DEFAULT '[]',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  archived       INTEGER NOT NULL DEFAULT 0,  -- 软删/归档
  note           TEXT
);

CREATE TABLE nodes (
  id              TEXT PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  identity_key    TEXT NOT NULL,              -- 规范化指纹（不含 fragment）
  url             TEXT NOT NULL,              -- 完整绝对 URL（可含 fragment）
  alias           TEXT,                       -- 用户别名（展示优先）
  display_label   TEXT,                       -- 缓存展示标签（见 §6.4）
  title           TEXT,
  http_status     INTEGER,
  content_type    TEXT,
  depth           INTEGER NOT NULL DEFAULT 0, -- 最小深度
  auto_parent_id  TEXT,                       -- 自动投影父节点（可空=根）
  status          TEXT NOT NULL DEFAULT 'queued',
                  -- queued|crawling|ok|error|skipped|blocked|need_human
  content_hash    TEXT,                       -- 正文指纹，用于内容去重
  in_link_count   INTEGER NOT NULL DEFAULT 0,
  out_link_count  INTEGER NOT NULL DEFAULT 0,
  is_deleted      INTEGER NOT NULL DEFAULT 0, -- 软删除
  first_seen_at   INTEGER NOT NULL,
  last_fetch_at   INTEGER,
  UNIQUE(site_id, identity_key)
);
CREATE INDEX idx_nodes_parent ON nodes(site_id, auto_parent_id);
CREATE INDEX idx_nodes_depth  ON nodes(site_id, depth);
CREATE INDEX idx_nodes_status ON nodes(site_id, status);
CREATE INDEX idx_nodes_hash   ON nodes(site_id, content_hash);

CREATE TABLE edges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id       TEXT NOT NULL,
  from_id       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  anchor_text   TEXT,
  selector      TEXT,          -- css 选择器（重放定位用）
  dom_path      TEXT,          -- 结构化 DOM 路径
  rel           TEXT,
  target        TEXT,
  is_nofollow   INTEGER NOT NULL DEFAULT 0,
  fragment      TEXT,
  source        TEXT NOT NULL, -- auto|manual|sitemap|redirect
  order_in_page INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_edges_from ON edges(from_id);
CREATE INDEX idx_edges_to   ON edges(to_id);
CREATE INDEX idx_edges_site ON edges(site_id);

-- 人工修正层：树的最终形态 = auto_parent_id 叠加最新 override
CREATE TABLE node_overrides (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  field      TEXT NOT NULL,   -- parent|url|alias|title|deleted|locked
  value      TEXT,
  prev_value TEXT,            -- 撤销用
  op_group   TEXT,            -- 同一次用户操作（批量重挂/删子树）
  seq        INTEGER NOT NULL,-- 单调递增，撤销/重做栈依据
  undone     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ov_node ON node_overrides(node_id, field, seq);
CREATE INDEX idx_ov_seq  ON node_overrides(site_id, seq);

-- 素材登记（仅当对应开关开启时产生记录）
CREATE TABLE materials (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,   -- body|html|screenshot|attachment
  rel_path   TEXT NOT NULL,   -- 相对 data/sites/<id>/ 的路径
  bytes      INTEGER,
  sha256     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mat_node ON materials(node_id, kind);

CREATE TABLE crawl_tasks (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL,
  preset_json TEXT NOT NULL,   -- 冻结的抓取参数
  status      TEXT NOT NULL,   -- running|paused|done|failed|stopped
  stats_json  TEXT,
  started_at  INTEGER,
  finished_at INTEGER
);

CREATE TABLE crawl_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL,
  site_id       TEXT NOT NULL,
  node_id       TEXT NOT NULL,
  depth         INTEGER NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed|skipped
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  UNIQUE(task_id, node_id)
);
CREATE INDEX idx_queue_pick ON crawl_queue(task_id, state, priority DESC, id);

CREATE TABLE fetch_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT, node_id TEXT, url TEXT, http_status INTEGER,
  duration_ms INTEGER, error TEXT, redirect_chain TEXT, at INTEGER
);

CREATE TABLE access_counts (            -- 循环护栏：按 identity 计数
  site_id TEXT NOT NULL, identity_key TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0, last_at INTEGER,
  PRIMARY KEY (site_id, identity_key)
);

CREATE TABLE presets (id TEXT PRIMARY KEY, kind TEXT, name TEXT,
  payload_json TEXT, is_default INTEGER NOT NULL DEFAULT 0);

CREATE TABLE exports (id TEXT PRIMARY KEY, site_id TEXT, format TEXT,
  scope_json TEXT, dir TEXT, status TEXT, manifest_path TEXT, created_at INTEGER);

CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT);
```

**有效父节点查询**（不用闭包表，重挂子树成本 = 1 行）：
```sql
CREATE VIEW v_nodes_effective AS
SELECT n.*,
  COALESCE((SELECT o.value FROM node_overrides o
            WHERE o.node_id = n.id AND o.field='parent' AND o.undone=0
            ORDER BY o.seq DESC LIMIT 1), n.auto_parent_id) AS effective_parent_id
FROM nodes n;
```
- 子树移动：只写 1 条 `field='parent'` 的 override。
- 子树查询：对 `v_nodes_effective` 用递归 CTE（`WITH RECURSIVE`）自上而下展开。
- 删除子树：写 `field='deleted'` override（批量 `op_group`），原数据不动，可整体撤销。

## 5. 接口定义

### 5.1 REST（内部 UI 用）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/sites` | 建站 `{url, scope?, name?}` → 校验可达性/HTML，返回 site + 根 node |
| GET | `/api/sites` | 站点卡片列表（含节点数/状态/更新时间） |
| GET/PATCH | `/api/sites/:id` | 详情 / 改名、范围、备注、归档 |
| DELETE | `/api/sites/:id` | 软删除整站（二次确认） |
| POST | `/api/sites/:id/crawl` | 启动自动采集 `{preset}` |
| POST | `/api/sites/:id/crawl/{pause\|resume\|stop}` | 任务控制 |
| GET | `/api/sites/:id/crawl/status` | 进度：已抓/队列/失败/深度分布 |
| GET | `/api/sites/:id/tree?parentId=&offset=&limit=` | 懒加载子节点（默认根） |
| GET | `/api/nodes/:id` | 节点详情（含 parents[]、入链出链、素材） |
| PATCH | `/api/nodes/:id` | 改别名/标题/地址（写 override，返回修正标记） |
| POST | `/api/nodes/:id/move` | `{newParentId}` 重挂（支持批量：`{ids[], newParentId}`） |
| DELETE | `/api/nodes/:id` | 软删该节点及其子树，返回影响节点数 |
| POST | `/api/sites/:id/undo` \| `/redo` | 撤销/重做修正层操作 |
| GET | `/api/sites/:id/search?q=&depth=&status=&regex=` | 过滤检索 |
| POST | `/api/sites/:id/export` | `{format, scope, presetId}` → 导出任务 |
| GET | `/api/exports/:id` | 导出状态与产物路径 |
| GET | `/api/sites/:id/materials?nodeId=&kind=` | 素材清单 |

### 5.2 WebSocket

| 通道 | 方向 | 用途 |
|---|---|---|
| `/ws/sites/:id` | 服务端→前端 | 抓取进度、节点新增、状态变更 |
| `/ws/manual/:sessionId` | 双向 | 手动采集：画面帧下行（JPEG base64）+ 鼠标/键盘事件上行 |

### 5.3 对外只读 API（供下游工具引用）

`/open/v1/sites/:id/` 下提供：
- `graph.json`（完整节点+边）、`nodes.jsonl`（流式）、`edges.csv`
- `manifest.json`（`schemaVersion`、节点数、生成时间、文件映射）
- `siteatlas.db` 只读路径（SQLite 直接打开）
- 另有 `GET /open/v1/sites/:id/nodes/:nodeId` 单节点查询

`nodeId` 永久稳定，跨导出、跨版本不变。

## 6. 关键机制设计

### 6.1 URL 规范化与身份
`identityKey` = 小写 host + 补默认端口 + 去 `www.`（可配）+ 去尾 `/` + query 排序 + 剔除跟踪参数（`utm_*`/`sessionid`/`_ga`，黑名单可配）+ **去 fragment**。
`url` 字段保留完整绝对地址（含 fragment）。同一资源不同跟踪参数 → 同一 `identityKey` → 同一节点。

### 6.2 导航策略
- 全部抓取用**绝对 URL 直接导航**，不使用浏览器前进/后退；「回根/回父」按钮 = 一次绝对 URL 导航。
- 记录完整重定向链；最终 URL 建节点，原 URL 记为该节点的历史别名（不建独立节点，避免别名分裂）。
- 内部引用一律绝对值，禁止依赖相对路径（`<base href>`、CDN、http↔https 都会破坏相对语义）。

### 6.3 循环与收敛护栏
1. 三层去重：`identityKey` 去重 → `content_hash` 内容去重 → 已抓节点直连复用；
2. `access_counts.visits` 超过阈值（默认 3）→ 跳过该 URL；
3. 路径前缀 Trie：同一前缀模式连续命中超阈值 → 剪枝该前缀（对付无限目录）；
4. 分页模式探测（`?page=n`、`/page/n`）→ 自动页上限；
5. 硬上限：`maxDepth`（默认 5）、`maxPages`（默认 100000）、越界即停并汇报。

### 6.4 树视图显示与修正
- 行标签 `display_label` 优先级：用户别名 > 页面标题 > 路径末段；**URL 不在行内显示**，仅 hover tooltip 或在属性面板点「修改地址」后才出现输入框。
- 修正标记：节点带 `has_override` 徽标，可单点「还原为自动结果」。
- 撤销/重做：`node_overrides` 按 `seq` 排列；撤销 = 标记 `undone=1` 并从栈中取出反向操作，重做为逆过程。批量操作以 `op_group` 原子撤销。
- 删除一律软删，进回收站。

### 6.5 手动（引导式）采集 —— Web 服务形态的实现
关键在于**纯 Web 服务没有桌面窗口**，因此：
- 服务端 Playwright 启动 Chromium；
- `Page.startScreencast` 把画面以 JPEG 帧推到前端 `<canvas>`，前端把鼠标/键盘事件折成 CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent` 回传 → 「整个工具就是一个网页」；
- 点击捕获用 `Runtime.addBinding` 注入捕获阶段监听，记录被点元素与 `selector`/`dom_path`/`anchor_text`，**与随后的导航事件配对**：若配对窗口内发生导航 → 该 Edge 的 `to` 是导航目标；若未导航（页内锚点 / JS 行为 / 新标签）→ 单独标记，不污染树；
- 页面身份识别 = 当前页 `identityKey` 与已知节点比对 → 自动识别「已回到根/某已知节点」，恢复为该节点下的新分支记录；
- 兜底：识别失败时提供「置为根 / 置为父节点」人工指定，并打「人工指定」标记。
- 保真度不足时的备选（方案 B）：启动 headed Chromium 独立窗口，工具网页只做操作面板与树视图。默认方案 A，重交互站点可切 B。

### 6.6 断点续爬与恢复
队列状态、`access_counts`、override 层全部落库；进程重启后按 `crawl_queue.state='running'` 复位为 `pending` 续跑。

### 6.7 导出
产物目录 `data/sites/<siteId>/exports/<exportId>/`，含 `manifest.json`：
```json
{
  "schemaVersion": "1.0",
  "siteId": "01J...", "rootUrl": "https://example.com/",
  "generatedAt": 1757660000,
  "counts": { "nodes": 10234, "edges": 38711, "materials": 10234 },
  "layers": { "structure": ["graph.json","nodes.jsonl","edges.csv"],
              "raw": ["raw/"], "parsed": ["parsed/"] },
  "files": { "graph.json": { "sha256": "...", "bytes": 2100000 } }
}
```
三档数据分开存、按 `nodeId` 关联；下游工具读 `manifest.json` 即可定位全部素材。

## 7. 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| M0 骨架 | 服务启动、SQLite 迁移、建站与 URL 校验、站点卡片视图 | 输入 URL 能建站并显示根节点 |
| M1 自动采集 | 抓取器（静态+JS 回落）、队列、去重、护栏、实时进度 | 采集一个真实站点，树中出现多级节点且无重复 |
| M2 树视图 | 虚拟滚动、懒加载、属性面板、隐藏地址、软删、撤销重做 | 万级节点流畅；拖拽重挂可撤销 |
| M3 手动采集 | CDP 画面串流 + 输入回传 + 点击捕获 + 回根识别 | 手动点选能正确建边，回根后不重复建节点 |
| M4 导出与开放 | JSON/JSONL/CSV/SQLite/Mermaid 导出 + manifest + 只读 API | 第三方脚本仅凭 manifest 能读取全部数据 |

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 跨域放开后页面数失控 | 硬上限 + 前缀剪枝 + 按域限速；范围可随时收紧并重跑 |
| CDP 画面串流延迟/保真度 | 默认方案 A，重交互站点切方案 B（headed 窗口） |
| 点击与导航竞态导致建边错误 | 绑定注入 + 导航配对窗口；未配对的不入树，进待确认队列 |
| 十万级树渲染卡顿 | 虚拟滚动 + 懒加载 + 索引，已在架构中强制 |
| JS 站点采不到链接 | 链接数为 0 即回落 Playwright 渲染，节点标 `need_human` 待确认 |
