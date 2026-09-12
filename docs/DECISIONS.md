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

## M1 决策（自动采集）

- [抓取][M1] 静态快路径用 `undici` 全局 `fetch` + `cheerio`（§2 选型），**逐跳手写重定向**（`redirect: 'manual'`）——理由：§6.2 要求记录完整重定向链，`fetch` 自动跟随会丢掉中间跳；上限 10 跳。
- [抓取][M1] 渲染回落判定（§8 风险对策）：`renderMode=auto` 时「静态链接数为 0」或「疑似 SPA（≥3 个 script 且有 `#root`/`#app`/`#__next` 挂载点且正文 < 200 字）」即回落 Playwright；`browser` 强制渲染，`http` 从不回落。
- [抓取][M1] 浏览器不可用（未安装 Chromium / 启动失败）时**不抛异常**，记 `lastLaunchError` 后沿用静态结果，任务继续——理由：M1 采集不该因为浏览器缺失而整体失败；`/api/health` 会暴露 `browserAvailable`。
- [抓取][M1] 浏览器池默认先试 Playwright 自带 Chromium，失败再试系统 Chrome（`channel:'chrome'`）——理由：本机自带 Chromium 下载常失败（见 M0 记录），回退到系统 Chrome 才能让回落路径真正可用。
- [抓取][M1] 素材类 URL（扩展名命中图片/PDF/音视频/压缩包/字体等）**只登记节点、不发请求**，状态 `skipped`——理由：§4.4「记录但不递归」，且 `downloadAssets` 默认 false；省掉一次必然失败的 GET。
- [护栏][M1] 访问上限 `visitLimit` 语义：每次尝试抓取该 identityKey 计一次访问，`visits > visitLimit` 时**跳过且不发请求**；访问计数在**未抓取（robots 禁止/素材/跳过）时也计**——理由：计数代表「我们碰过这个 URL」，这样重定向与被禁页也不会反复被探测。上限默认 3（§6.3）。
- [护栏][M1] 前缀 Trie 剪枝在**路径上任一前缀**命中超阈值即剪枝（不只最深那层）——理由：无限目录形如 `/a/1` … `/a/9999`，若只在最深节点计数，阈值永远追不上每页各不相同的末段。
- [护栏][M1] 分页探测把 `?page=n` 归一为「序列键 + 页号」，同序列累计超过 `paginationPageLimit` 即不入队——理由：§6.3 护栏 4；识别键为 `page|p|pn|pg|paged|offset|start` 与 `/page/n`。
- [护栏][M1] `maxPages` 触顶时把当前任务标记为 `stopped`（不是 failed），已入队项标 `skipped` 并状态 `skipped`——理由：达到硬上限是正常收敛而非错误，便于区分「跑飞」与「按配置收工」。
- [去重][M1] 内容指纹阈值：正文归一化（仅留字母数字与中日韩字符、小写）后**少于 64 字符不参与指纹去重**——理由：短页面（404、跳转壳）文本高度雷同，参与去重会把正常页面误判为重复。
- [去重][M1] 内容重复的节点**保留节点与边**（状态 `skipped`），只是不再递归——理由：树视图要能看到入链多父关系，若直接丢节点会破坏「不被错误归并」这条核心要求。
- [去重][M1] 边去重键 = `(from_id, to_id, fragment)`——理由：同一页多次纯链接同一目标只留 1 条；但指向同一页不同页内锚点（`#a`/`#b`）是不同链接，必须各留一条（否则丢失「板块级采集」的依据）。
- [重定向][M1] 重定向时**直接改写该节点的 URL 与 identity_key**（§6.2「不建独立节点，避免别名分裂」）；若最终 URL 的 identity 已被别的节点占用，则只改 `url` 保留原 identity——理由：不改 identity 会造成同一资源的两个节点，改错又会触发 UNIQUE 冲突，取折中并保留注解。
- [状态][M1] `need_human` 留给 M3 手动采集的未配对点击（§8），M1 自动采集不使用该状态——理由：M1 没有需要人工裁决的输入，滥用会让状态徽标失去含义。
- [接口][M1] `POST /api/sites/:id/crawl` 返回 **202**（任务已受理、后台跑），进度走 `GET .../crawl/status` 或 WS——理由：采集是长任务，同步等待会让 HTTP 超时。
- [接口][M1] 每站同时只允许 1 个活动任务，重复启动返回 409 `CRAWL_ALREADY_RUNNING`；已归档站点返回 409 `SITE_ARCHIVED`——理由：并发任务会争抢同一站点的 access_counts 与队列语义。
- [接口][M1] `POST .../crawl/stop` 会**等待任务收尾**后再返回（因此返回即 `busy=false`）——理由：避免「停止后立刻重启」时旧 worker 还在写库；暂停则不需要等待（worker 挂在 checkpoint）。
- [接口][M1] 续跑入口复用 `resume`：进程重启后 `running→paused` 复位，此时 `resume` 会用落库的 preset 重建调度器继续跑（§6.6）——理由：不为「崩溃恢复」单开一个接口，语义相同。
- [接口][M1] `PATCH /api/nodes/:id` 只允许改 `alias`/`title`（纯展示字段），改 `url` 返回 501——理由：§6.4 的「修改地址」是修正层操作（旧记录保留为历史别名 + 可选重抓），M2 与重挂/撤销一起做，避免出现「一半直写、一半叠层」的语义分裂。
- [WS][M1] 进度推送节流 400ms + 新增节点逐条推；`hello` 帧在握手完成后发送——理由：worker 循环里每个节点都推会让万级采集把前端淹掉；握手竞态会导致首帧丢失（已在测试中复现并修正）。
- [WS][M1] 前端 WS 断开后自动降级为 1.5s 轮询 `crawl/status`——理由：§8 风险对策；确保「实时进度」在代理/中间层掐断 WS 时依然可信。
- [前端][M1] 树视图 M1 交付「懒加载 + 分页 + 检索 + 属性抽屉 + 窗口化渲染（超过 200 行按 32px 行高切片）」；虚拟滚动库（TanStack Virtual）留到 M2 与拖拽一起引入——理由：M1 验收要求「树中出现多级节点且无重复」，先保证正确性；窗口化已能在千级节点下不卡。
- [前端][M1] 展开全部有 800 节点上限并给出提示——理由：万级树上误点「展开全部」会连续发上百个请求，属于必须防的误操作。
- [测试][M1] 采集内核测试用**本地 HTTP fixture 站点**（多级/多父/变体/404/robots/素材/SPA/分页）而不是公网站点——理由：验收项可复现且离线可跑；真实网络路径由 `scripts/e2e-m1-crawl.mjs` 与 curl 覆盖。
- [测试][M1] fixture 站点用 `startFakeSite()` 动态起、随机端口、路径去尾斜杠后查表——理由：固定端口在并行测试下会撞车；去尾斜杠是因为真实站点 `/about/` 与 `/about` 通常等价，而爬虫内部一律用规范化地址请求（踩过一次坑：`/about/` 返回 404 导致误以为去重失效）。
- [测试][M1] 暂停/续跑用例故意用「1 并发 + 1000ms 间隔」跑满 10 秒——理由：必须在队列里留下 pending 项才能验证「暂停期间不发请求」，快跑到底的站点测不出来。
- [脚本][M1] `scripts/demo-site.mjs` 是本机演示站（含内联脚本的纯 JS 渲染页）——理由：截图与验收需要展示 Playwright 回落，而外站不可控；用**内联**脚本而非外链 JS，避免依赖浏览器子资源加载。
- [兼容][M1] 所有前端/DELETE 请求只在有 body 时声明 `content-type: application/json`——理由：Fastify 对「声明 JSON 但 body 为空」的请求直接 400（`FST_ERR_CTP_EMPTY_JSON_BODY`），软删除接口因此踩过坑。
