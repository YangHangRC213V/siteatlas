# DECISIONS —— SiteAtlas 实现决策记录

> 规格（`crawler-tool-requirements.md` / `crawler-tool-dev-spec.md`）是唯一事实来源；
> 规格未覆盖处的取舍记录在此，一行一条并附理由。**不改**规格已定的表名/字段名/模块名/路由名。
> 格式：`[范围][M0] 决策 —— 理由`

## 与规格书的差异（需要你确认，未擅自改动规格文本）

- [存储][M0] `dev-spec §2` 写 `better-sqlite3, WAL`，实现改用 Node 26 内置 `node:sqlite`（DatabaseSync）——理由：任务书明确禁止需要本地编译的原生模块，`node:sqlite` API 同族（exec/prepare/run/all），WAL 与 `foreign_keys=ON` 照旧；表名、字段名、视图名一字未变。**这是唯一一处偏离规格选型的实现，需你确认是否接受。**
- [迁移][M0] `dev-spec §4` 顶部两条 `PRAGMA journal_mode=WAL` / `PRAGMA foreign_keys=ON` 未放进迁移脚本，改在 `core/store/db.ts` 建连接时执行——理由：它们是连接级设置（WAL 是库级），放迁移里只对当次连接生效，语义上属于连接初始化而不是 schema 变更；DDL 与索引、视图部分与 §4 逐字一致。

## 任务书内允许的自由选择

- [运行时][M0] 服务端不预编译：`tsx src/index.ts` 直接跑 TypeScript，测试用 `node --test`（Node 26 原生类型剥离）——理由：M0 无需构建产物，单命令启动链路更短（`npm start` 只构建 shared + web）；因此全仓禁用 TS「参数属性」等不可擦除语法，保持原生可跑。
- [类型][M0] `shared` 走 tsc 构建产物（`dist/index.js` + `.d.ts`），server/web 只 `import type`——理由：运行时不依赖构建顺序，测试不因 shared 未构建而红，仍保留单一契约源。
- [时间戳][M0] 所有 `*_at INTEGER` 列统一存**秒级** Unix 时间戳——理由：规格未规定精度，秒级足够站点/节点粒度，且便于人工读库。
- [时间戳][M0] `sites.root_url` 与 `nodes.identity_key` 存**规范化后**的绝对 URL——理由：§6.1 规定 identityKey 去 fragment 去尾斜杠去跟踪参数；若 root_url 存原始串，后续同站判定要反复规范化，易漂移。
- [规范化][M0] `dropWww` 默认 **true**、`forceHttps` 默认 **false**——理由：§6.1「去 `www.`（可配）」用在默认路径、http→https 写为「可选归一」，故默认不动协议（自定义端口下强制改协议会改变语义）。
- [规范化][M0] query 排序为「先键后值」的字典序，同键多值保持原相对顺序——理由：比 `URLSearchParams.sort()`（按键稳定排序）更确定，能让 `?a=1&a=2` 与 `?a=2&a=1` 区分（值顺序对服务端可能有意义）。
- [规范化][M0] 跟踪参数黑名单 = `utm_*` 前缀 + `sessionid` + `_ga`，全部大小写不敏感——理由：§6.1 字面要求；大小写不敏感是因为实际站点常见 `UTM_Source`。
- [验证][M0] 建站校验顺序：协议非法 → 400；非 HTML 且带 Content-Type → 422；**探测失败仍建站**，根节点标 `error` 并把原因写进 `sites.note`；无 Content-Type 时放行并把节点标 `queued`——理由：§7 M0 要求「输入 URL 能建站」，若目标暂时不可达就拒绝建站会让用户无法先在离网/内网环境建结构；标 error + 备注既保留可观测性也不丢用户意图。
- [验证][M0] 同根 URL 重复建站返回 409 `SITE_EXISTS`（附已有 siteId）——理由：规格未提重复建站；静默产生两个同根站点会让后续 identityKey 唯一性失效，报错并给 id 比隐式合并可预期。
- [接口][M0] `POST /api/sites` 成功返回 **201**，其余成功返回 200 ——理由：201 对「创建资源」更准确；前端统一按 `res.ok` 与错误体分支，不受影响。
- [接口][M0] 错误体统一 `{error:{code,message,detail?}}`，code 用 `INVALID_URL` / `NOT_HTML` / `SITE_EXISTS` / `SITE_NOT_FOUND` / `INVALID_BODY` / `NOT_FOUND`——理由：规格 5.1 未定错误形状；code 稳定便于前端分支与测试断言。
- [接口][M0] 每站最多一个根节点，`auto_parent_id IS NULL` 且 `is_deleted=0` 即为根——理由：§4 注释「可空=根」，M0 只建一个根；不做 `depth=0` 约束（重挂后根可能变化，M2 再定）。
- [接口][M0] `DELETE /api/sites/:id` 返回 200 + `{site, deleted:true, affectedNodes}`（不是 204）——理由：M0 验收要看到软删结果与影响面（requirements §4.5 影响面提示），空响应体做不到。
- [接口][M0] 额外提供 `POST /api/sites/:id/restore`——理由：requirements §3「软删除（进回收站，可恢复）」需要恢复入口，否则回收站只进不出。
- [接口][M0] 额外提供 `GET /api/health`——理由：前端状态栏与运维自检需要，且不引入新契约概念。
- [接口][M0] 请求体字段用 camelCase（`skipProbe`）而响应沿用 DB 列名 snake_case ——理由：响应与库表同名便于排查；`skipProbe` 是 M0 测试便利项、不是数据字段，不污染契约命名。
- [ID][M0] 自实现 ULID（Crockford Base32、单调递增）而非引依赖——理由：§4 只要求 `id TEXT PRIMARY KEY -- ULID`；40 行实现即可满足，同时避免再引入依赖。
- [ULID][M0] 生成器不做跨毫秒严格单调保证（同毫秒递增随机位）——理由：站点/节点创建速率远低于同毫秒溢出风险；全局单调留给需要时再加。
- [前端][M0] 不用 react-router，自写 30 行 history 路由 ——理由：M0 只有 `/sites` 与 `/sites/:id` 两跳；路由表已是 `router/modules.ts` 的投影，等 M2 需要树深链/查询参数时再评估引入（本决策需在 M2 复核）。
- [前端][M0] 建站探测是同步请求（最长 5s），表单按钮进入「建站中…」并禁用——理由：M0 无任务队列（队列是 M1 的 `crawl_queue`），同步最简单，UI 已给出等待反馈。
- [前端][M0] 未实现的模块在左侧导航里显示但标 M1–M4，点击弹提示不进路由——理由：requirements §2 的模块表要一眼可见，避免「界面叫 X、代码叫 Y」的漂移。
- [前端][M0] `display_label` 在 M0 写作「路径末段」（`/` → 根域名）——理由：§6.4 优先级是「别名 > 标题 > 路径末段」，M0 尚无 title，落到第三档；M1 抓到标题后同一函数自动升级。
- [前端][M0] 卡片视图用 CSS Grid `auto-fill minmax(264px,1fr)`，未做虚拟滚动——理由：§1 强制虚拟滚动的是**树视图**（M2）；站点卡片量级是几十到几百。
- [前端][M0] 深色模式跟随系统 + 预留 `[data-theme]` 覆盖，未做设置页开关——理由：§5 要求「可切换」，tokens 层已就绪，开关属于设置模块（M1）。
- [测试][M0] 接口测试注入假探测函数、不依赖外网——理由：CI/离线可跑；真实网络路径由 `scripts/e2e-m0-screenshot.mjs` 与 curl 验收覆盖。
- [测试][M0] 数据库测试用 `:memory:`——理由：不污染 `data/siteatlas.db`，且每个用例独立 schema。
- [E2E][M0] Playwright 驱动本机已安装的 Google Chrome（`channel:'chrome'`），不用自带 Chromium——理由：本机 `npx playwright install chromium` 下载卡死（10 分钟无输出），而系统 Chrome 可正常 launch；浏览器下载与版本（playwright 1.63 期望 build 1243，缓存里是 1234）不一致。
- [脚本][M0] 截图脚本留在 `scripts/e2e-m0-screenshot.mjs` 并入库——理由：验收证据可复现，M1 起可扩展为回归用例。
- [结构][M0] `plugins/exporters|parsers|postprocessors` 与 `web/src/modules/{crawl,tree,data,rules,export,settings}` 目录**暂不创建**（M0 无内容）——理由：§3 是目标结构，空目录会让「已实现」与「占位」混淆；各模块目录在其里程碑落地。`core/fetch/pool.ts`、`core/crawl/*`、`core/override/*`、`api/ws.ts`、`manual/*` 同理留到 M1–M3。
- [合规][M0] 未加「首次运行合规提示」——理由：requirements §4.7 的提示与限速/robots 属于**抓取**行为，M0 只做一次可达性探测，M1 必须补。
- [配置][M0] 端口默认 `8787`（可用 `SITEATLAS_PORT`/`PORT` 覆盖），监听 `127.0.0.1`——理由：规格未定端口；绑定回环符合 requirements §4.7「本地私有」。
- [配置][M0] 仓库根目录通过「向上查找带 `workspaces` 的 package.json」确定——理由：`import.meta.dirname` 在 `tsx` 下曾解析到仓库外，导致 `data/` 与 `web/dist` 指错位置（已修）。
