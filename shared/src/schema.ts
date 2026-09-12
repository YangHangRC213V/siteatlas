/**
 * SiteAtlas 类型契约 v1.0
 *
 * 前后端共用（dev-spec §3 `shared/schema.ts`）。字段命名与 dev-spec §4 数据表列名
 * **逐字保持一致**，避免「数据库叫 A、接口叫 B」的二次映射与漂移。
 *
 * 破坏性变更必须提升 SCHEMA_VERSION 并附迁移说明（requirements §6 可扩展）。
 */

/** 契约版本（导出 manifest 里同样使用，dev-spec §6.7） */
export const SCHEMA_VERSION = '1.0';

/** 采集范围策略（dev-spec §4 sites.scope） */
export const SITE_SCOPES = ['same_domain', 'same_site', 'allowlist', 'all'] as const;
export type SiteScope = (typeof SITE_SCOPES)[number];

/** 节点状态（dev-spec §4 nodes.status） */
export const NODE_STATUSES = [
  'queued',
  'crawling',
  'ok',
  'error',
  'skipped',
  'blocked',
  'need_human',
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/**
 * 修正层字段（dev-spec §4 node_overrides.field）。
 * §4 的注释以 `-- parent|url|alias|title|deleted|locked` 给出取值集合，顺序沿用；
 * 追加 `revert`：M2 的「还原为自动结果」需要一条记录来让还原动作本身也可撤销
 * （撤销还原 = 恢复被清掉的旧修正），语义与上述六者不同，故单独成值（见 DECISIONS.md）。
 */
export const OVERRIDE_FIELDS = ['parent', 'url', 'alias', 'title', 'deleted', 'locked', 'revert'] as const;
export type OverrideField = (typeof OVERRIDE_FIELDS)[number];

/** 边来源（dev-spec §4 edges.source） */
export const EDGE_SOURCES = ['auto', 'manual', 'sitemap', 'redirect'] as const;
export type EdgeSource = (typeof EDGE_SOURCES)[number];

/** 素材种类（dev-spec §4 materials.kind） */
export const MATERIAL_KINDS = ['body', 'html', 'screenshot', 'attachment'] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

/** URL 规范化开关（dev-spec §6.1） */
export interface NormalizeOptions {
  /** 去 `www.`（可配），默认 true */
  dropWww?: boolean;
  /** `http → https` 归一，默认 false（端口/协议语义可能不同，默认不动） */
  forceHttps?: boolean;
  /** 额外剔除的 query 参数名（大小写不敏感），叠加在内置黑名单之上 */
  trackingBlacklist?: readonly string[];
}

/** 规范化结果：`url` 保留含 fragment 的完整绝对地址，`identityKey` 去 fragment */
export interface NormalizedUrl {
  /** 完整绝对 URL（含 fragment），入 `nodes.url` */
  url: string;
  /** 规范化指纹（不含 fragment），入 `nodes.identity_key` */
  identityKey: string;
  origin: string;
  host: string;
  /** 规范化后的 host（小写、去 www、含非默认端口） */
  normalizedHost: string;
  protocol: string;
  /** 显式或补齐的端口，无端口为 null */
  port: string | null;
  pathname: string;
  /** 排序并剔除跟踪参数后的 query 串（不含 `?`） */
  search: string;
  /** 去 `#` 的 fragment，无则为 null */
  fragment: string | null;
  scope: 'http' | 'https';
}

/** 建站请求（POST /api/sites） */
export interface CreateSiteRequest {
  url: string;
  scope?: SiteScope;
  name?: string;
  /** 跳过可达性探测（离网/测试用）；跳过时根节点 status 记 queued */
  skipProbe?: boolean;
  normalize?: NormalizeOptions;
}

/** PATCH /api/sites/:id 请求体，字段全部可选 */
export interface UpdateSiteRequest {
  name?: string;
  scope?: SiteScope;
  allowlist?: string[];
  archived?: boolean;
  note?: string | null;
}

/** 站点记录（对应 sites 表列名） */
export interface SiteRecord {
  id: string;
  name: string;
  root_url: string;
  root_host: string;
  scope: SiteScope;
  allowlist_json: string;
  created_at: number;
  updated_at: number;
  archived: number;
  note: string | null;
}

/** 节点记录（对应 nodes 表列名） */
export interface NodeRecord {
  id: string;
  site_id: string;
  identity_key: string;
  url: string;
  alias: string | null;
  display_label: string | null;
  title: string | null;
  http_status: number | null;
  content_type: string | null;
  depth: number;
  auto_parent_id: string | null;
  status: NodeStatus;
  content_hash: string | null;
  in_link_count: number;
  out_link_count: number;
  is_deleted: number;
  first_seen_at: number;
  last_fetch_at: number | null;
}

/** 卡片视图需要的聚合统计（GET /api/sites） */
export interface SiteCardStats {
  /** 未软删节点数 */
  nodeCount: number;
  /** 根节点 status */
  rootStatus: NodeStatus | null;
  /** 已抓取（status='ok'）节点数，M1 起有实际意义 */
  okCount: number;
  /** 失败节点数 */
  errorCount: number;
  /** 最大深度 */
  maxDepth: number;
  /** 最近抓取时间 */
  lastFetchAt: number | null;
}

export interface SiteCard {
  site: SiteRecord;
  stats: SiteCardStats;
}

/** 探测结论（URL 校验） */
export interface UrlProbeResult {
  reachable: boolean;
  isHtml: boolean;
  status: number | null;
  contentType: string | null;
  finalUrl: string | null;
  redirectChain: string[];
  error: string | null;
}

/** 建站响应 */
export interface CreateSiteResponse {
  site: SiteRecord;
  root: NodeRecord;
  probe: UrlProbeResult;
}

export interface SiteDetailResponse {
  site: SiteRecord;
  stats: SiteCardStats;
  root: NodeRecord | null;
}

export interface ListSitesResponse {
  sites: SiteCard[];
}

export interface DeleteSiteResponse {
  site: SiteRecord;
  deleted: true;
  /** 软删影响的节点数 */
  affectedNodes: number;
}

/** 统一 API 错误体 */
export interface ApiError {
  error: {
    code: string;
    message: string;
    detail?: unknown;
  };
}

/* ------------------------------------------------------------------ *
 * M1 采集（dev-spec §6.3 护栏 / §4 crawl_tasks·crawl_queue·fetch_logs）
 * ------------------------------------------------------------------ */

/** 渲染方式（requirements §4.4「渲染方式」） */
export const RENDER_MODES = ['auto', 'http', 'browser'] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

export const CRAWL_TASK_STATUSES = ['running', 'paused', 'done', 'failed', 'stopped'] as const;
export type CrawlTaskStatus = (typeof CRAWL_TASK_STATUSES)[number];

export const QUEUE_STATES = ['pending', 'running', 'done', 'failed', 'skipped'] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/**
 * 抓取参数（冻结后写入 `crawl_tasks.preset_json`）
 * 默认值取自 requirements §4.4 与 dev-spec §6.3。
 */
export interface CrawlPreset {
  /** 最大深度，默认 5（§6.3 硬上限） */
  maxDepth: number;
  /** 最大页数，默认 100000（§6.3 硬上限） */
  maxPages: number;
  /** 范围策略：同域 / 同域+子域 / 跨域白名单 / 不限制（dev-spec §0） */
  scope: SiteScope;
  /** scope='allowlist' 时生效 */
  allowlist: string[];
  /** 并发数 1–32，默认 5（requirements §4.7） */
  concurrency: number;
  /** 每请求最小间隔（ms），默认 1000（§4.7 ≥1s/请求） */
  minDelayMs: number;
  /** 间隔抖动上限（ms），默认 250 */
  jitterMs: number;
  /** 单请求超时（ms），默认 15000 */
  timeoutMs: number;
  /** 失败重试次数，默认 2 */
  maxRetries: number;
  /** 重试退避基数（ms），默认 1000 */
  retryBackoffMs: number;
  /** 重试退避上限（ms），默认 30000 */
  retryBackoffMaxMs: number;
  /** 渲染方式：auto=静态取链接为 0 或判定 SPA 时回落 Playwright */
  renderMode: RenderMode;
  /** 遵守 robots.txt（§4.7 默认遵守） */
  respectRobots: boolean;
  /** 每域并发上限，默认 2（防压站） */
  perHostConcurrency: number;
  /** 自定义 UA；默认标识为工具名（§4.7） */
  userAgent: string;
  /** 同一 URL 访问上限，默认 3（§6.3 护栏 2） */
  visitLimit: number;
  /** 路径前缀连续命中阈值 → 剪枝，默认 20（§6.3 护栏 3） */
  prefixPruneThreshold: number;
  /** 分页模式自动页上限，默认 50（§6.3 护栏 4） */
  paginationPageLimit: number;
  /** 是否下载素材（图片/PDF/音视频记录但不递归；默认只存正文） */
  downloadAssets: boolean;
}

export const DEFAULT_CRAWL_PRESET: CrawlPreset = {
  maxDepth: 5,
  maxPages: 100000,
  scope: 'same_site',
  allowlist: [],
  concurrency: 5,
  minDelayMs: 1000,
  jitterMs: 250,
  timeoutMs: 15000,
  maxRetries: 2,
  retryBackoffMs: 1000,
  retryBackoffMaxMs: 30000,
  renderMode: 'auto',
  respectRobots: true,
  perHostConcurrency: 2,
  userAgent: 'SiteAtlas/0.1 (+local crawling tool)',
  visitLimit: 3,
  prefixPruneThreshold: 20,
  paginationPageLimit: 50,
  downloadAssets: false,
};

export interface CrawlTaskRecord {
  id: string;
  site_id: string;
  preset_json: string;
  status: CrawlTaskStatus;
  stats_json: string | null;
  started_at: number | null;
  finished_at: number | null;
}

/** 进度与分布（GET /api/sites/:id/crawl/status） */
export interface CrawlStats {
  /** 已抓取完成（含失败终判） */
  fetched: number;
  /** 抓取成功 */
  ok: number;
  /** 抓取失败 */
  failed: number;
  /** 因护栏/范围/非 HTML 跳过 */
  skipped: number;
  /** 队列剩余（pending + running） */
  queued: number;
  /** 待重试 */
  retrying: number;
  /** 深度分布 */
  depthDistribution: Record<string, number>;
  /** 状态分布 */
  statusCounts: Record<string, number>;
}

export interface CrawlProgress {
  siteId: string;
  taskId: string;
  status: CrawlTaskStatus;
  /** 本次任务累计抓取数 */
  pagesFetched: number;
  /** 新发现 URL 数 */
  discovered: number;
  /** 当前队列长度 */
  queueLength: number;
  ok: number;
  failed: number;
  skipped: number;
  /** 最新事件说明（用于状态栏日志） */
  lastEvent: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  now: number;
}

export interface StartCrawlRequest {
  preset?: Partial<CrawlPreset>;
}

/** WS `/ws/sites/:id` 下行消息 */
export type CrawlSocketMessage =
  | { type: 'hello'; siteId: string; schemaVersion: string }
  | { type: 'progress'; progress: CrawlProgress }
  | { type: 'node'; node: Pick<NodeRecord, 'id' | 'url' | 'depth' | 'status' | 'display_label'> }
  | { type: 'task'; status: CrawlTaskStatus; taskId: string }
  | { type: 'error'; message: string };

/* ---------------- 树视图（M1 只做懒加载，M2 加虚拟滚动与修正层） ---------------- */

/** GET /api/sites/:id/tree 的一行（来自 v_nodes_effective，含修正标记） */
export interface TreeNodeRow extends NodeRecord {
  effective_parent_id: string | null;
  /** 是否存在未撤销的人工修正（§6.4 修正徽标） */
  has_override: boolean;
  /** 直接子节点数（懒加载用） */
  child_count: number;
}

export interface TreeResponse {
  parentId: string | null;
  total: number;
  offset: number;
  limit: number;
  nodes: TreeNodeRow[];
  /** 撤销/重做栈深度（前端按钮禁用态与计数展示） */
  depths?: { undoDepth: number; redoDepth: number };
}

/** 修正层记录（dev-spec §4 node_overrides） */
export interface OverrideRecord {
  id: number;
  site_id: string;
  node_id: string;
  field: OverrideField;
  value: string | null;
  prev_value: string | null;
  /** 同一次用户操作（批量重挂/删子树），原子撤销依据 */
  op_group: string | null;
  /** 单调递增，撤销/重做栈依据 */
  seq: number;
  undone: number;
  created_at: number;
}

/* ---------------- M2 修正层请求/响应 ---------------- */

export interface MoveNodesRequest {
  /** 单节点：newParentId；批量：ids[] + newParentId */
  newParentId: string | null;
  ids?: string[];
}

export interface MoveNodesResponse {
  opGroup: string;
  moved: number;
  nodes: TreeNodeRow[];
}

export interface DeleteNodesResponse {
  opGroup: string;
  affectedNodes: number;
  nodeIds: string[];
}

export interface UndoRedoResponse {
  action: 'undo' | 'redo';
  /** 本次撤销/重做的操作类型（parent/url/alias/title/deleted/reverted） */
  kind: string;
  /** 本次影响的 override 行数 */
  affected: number;
  rows: OverrideRecord[];
  nodeIds: string[];
  undoDepth: number;
  redoDepth: number;
}

export interface TrashEntry {
  nodeId: string;
  opGroup: string | null;
  /** 被软删的子树根节点（有效形态） */
  node: NodeRecord | null;
  /** 该子树包含的节点数（含自身） */
  affectedNodes: number;
}

export interface TrashResponse {
  entries: TrashEntry[];
  depths?: { undoDepth: number; redoDepth: number };
}

/** 节点详情（GET /api/nodes/:id） */
export interface NodeDetailResponse {
  node: TreeNodeRow & { has_override: boolean };
  /** 修改历史（§6.4 属性面板） */
  history: OverrideRecord[];
  /** 撤销栈深度提示 */
  depths: { undoDepth: number; redoDepth: number };
  /** 入链（作为 to_id 的边） */
  parents: Array<{ edge: EdgeRecord; from: NodeRecord | null }>;
  /** 出链（作为 from_id 的边） */
  children: Array<{ edge: EdgeRecord; to: NodeRecord | null }>;
  materials: MaterialRecord[];
}

export interface MaterialRecord {
  id: number;
  site_id: string;
  node_id: string;
  kind: MaterialKind;
  rel_path: string;
  bytes: number | null;
  sha256: string | null;
  created_at: number;
}

/** 边记录（M1 开始写入） */
export interface EdgeRecord {
  id: number;
  site_id: string;
  from_id: string;
  to_id: string;
  anchor_text: string | null;
  selector: string | null;
  dom_path: string | null;
  rel: string | null;
  target: string | null;
  is_nofollow: number;
  fragment: string | null;
  source: EdgeSource;
  order_in_page: number | null;
  created_at: number;
}

/* ---------------- M3 手动（引导式）采集 ---------------- */

export const MANUAL_STATUSES = ['idle', 'running', 'paused', 'ended'] as const;
export type ManualSessionStatus = (typeof MANUAL_STATUSES)[number];

export type ManualProgressMode = 'record-only' | 'record-and-expand';

/** 当前页面身份（由 identityKey 匹配已知节点得出） */
export interface ManualIdentity {
  nodeId: string;
  url: string;
  identityKey: string;
  /** 该节点在树中的有效父节点 */
  parentId: string | null;
  depth: number;
  displayLabel: string | null;
  /** 是否为本次会话新建 */
  fresh: boolean;
}

export interface ManualClickStats {
  total: number;
  /** 与随后的导航配对成功（真实跳转） */
  paired: number;
  /** 窗口内没有导航：页内锚点 / JS 行为 / 新标签 */
  unpaired: number;
  /** 目标已存在、只补边不建节点 */
  skippedDuplicate: number;
}

export interface ManualScreencastStats {
  received: number;
  delivered: number;
  dropped: number;
  lastFrameAt: number | null;
  lastFrameBytes: number;
}

export interface ManualSessionState {
  sessionId: string;
  siteId: string;
  status: ManualSessionStatus;
  /** 是否已绑定浏览器页面（画面可用） */
  guideEnabled: boolean;
  progressMode: ManualProgressMode;
  current: ManualIdentity | null;
  rootNodeId: string;
  rootUrl: string;
  clicks: ManualClickStats;
  nodesCreated: number;
  edgesCreated: number;
  pendingConfirmCount: number;
  screencast: ManualScreencastStats;
  lastNavigatedUrl: string | null;
  lastError: string | null;
}

/** 页面内被点元素的快照（dev-spec §6.5 点击捕获） */
export interface ClickCapturePayload {
  kind: 'click';
  tag: string;
  anchorText: string;
  selector: string;
  domPath: string;
  href: string | null;
  rel: string | null;
  target: string | null;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  x: number;
  y: number;
  at: number;
}

/** 待确认项：未与导航配对的点击 */
export interface PendingConfirm {
  id: string;
  payload: ClickCapturePayload;
  fromNodeId: string;
  fromUrl: string;
  /** 可能的目标（href 的规范化身份） */
  candidateUrl: string | null;
  reason: string;
  at: number;
}

export interface ManualEventRecord {
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/* ---------------- M4 导出与对外只读 API（dev-spec §5.1 / §5.3 / §6.7） ---------------- */

/** 导出格式：§6.7 的 structure 层（raw/parsed 层由素材目录承载，随导出一起打包） */
export const EXPORT_FORMATS = ['json', 'jsonl', 'csv', 'sqlite', 'mermaid'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** 导出范围：整站 / 某节点子树 / 仅未删（默认） */
export const EXPORT_SCOPES = ['site', 'subtree', 'all'] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];

export type ExportStatus = 'pending' | 'running' | 'done' | 'failed';

/** dev-spec §4 exports 表 */
export interface ExportRecord {
  id: string;
  site_id: string | null;
  format: string;
  scope_json: string | null;
  dir: string | null;
  status: string;
  manifest_path: string | null;
  created_at: number;
  /** 以下为 M4 追加的实现字段（见 DECISIONS.md） */
  site_name: string | null;
  root_url: string | null;
  preset_id: string | null;
  counts_json: string | null;
  error: string | null;
  finished_at: number | null;
}

export interface ExportRequest {
  format: ExportFormat;
  scope?: ExportScope;
  /** 子树导出的根节点（scope='subtree' 时必填） */
  nodeId?: string;
  presetId?: string;
  /** 是否包含已软删节点（默认否，软删只在回收站里） */
  includeDeleted?: boolean;
}

/** manifest.json 里单个文件的登记（§6.7 files 映射） */
export interface ExportFileEntry {
  sha256: string;
  bytes: number;
  /** 该文件承载的数据集：nodes | edges | graph | materials */
  dataset: string;
  rows?: number;
}

export interface ExportCounts {
  nodes: number;
  edges: number;
  materials: number;
  deleted: number;
}

/** manifest.json —— 下游工具唯一的入口，字段齐全即可不读库 */
export interface ExportManifest {
  schemaVersion: string;
  exportId: string;
  siteId: string;
  siteName: string;
  rootUrl: string;
  generatedAt: number;
  format: ExportFormat;
  scope: ExportScope;
  counts: ExportCounts;
  /** §6.7 三档数据分层 */
  layers: {
    structure: string[];
    raw: string[];
    parsed: string[];
  };
  files: Record<string, ExportFileEntry>;
  /** 只读 API 的等价入口（下游也可走 HTTP） */
  endpoints: {
    graph: string;
    nodes: string;
    edges: string;
    manifest: string;
    sqlite: string;
    node: string;
  };
}

export interface ExportStatusResponse {
  export: ExportRecord;
  manifest: ExportManifest | null;
}

export interface MaterialRecordApi {
  id: number;
  kind: MaterialKind;
  rel_path: string;
  bytes: number | null;
  sha256: string | null;
  created_at: number;
}

/* ---------------- 设置与预设（requirements §4.7 / §4.6；导航「设置」模块） ---------------- */

/** 设置项类型：界面据此决定用哪种控件 */
export type SettingKind = 'int' | 'bool' | 'string' | 'enum' | 'stringList';

export interface SettingFieldDef {
  key: string;
  group: 'politeness' | 'defaults' | 'materials' | 'appearance';
  label: string;
  hint: string;
  kind: SettingKind;
  /** 落到 CrawlPreset 的字段名（缺省 = 与 key 同名） */
  presetKey?: keyof CrawlPreset;
  default: number | boolean | string | string[];
  min?: number;
  max?: number;
  /** 界面步长与单位 */
  step?: number;
  unit?: string;
  options?: readonly string[];
  /** 该设置是否对应采集预设（决定「是否参与默认 preset」） */
  inPreset: boolean;
}

/**
 * 全局设置的**唯一真源**：界面表单、服务端校验、抓取默认值都从这张表派生。
 * 加一个设置项 = 这里加一行；不允许各处各写一遍默认值与范围。
 */
export const SETTING_FIELDS: readonly SettingFieldDef[] = [
  { key: 'concurrency', group: 'politeness', label: '总并发', hint: '同时抓取的页面数上限（§4.7 默认 5）', kind: 'int', default: 5, min: 1, max: 32, inPreset: true },
  { key: 'perHostConcurrency', group: 'politeness', label: '单域并发', hint: '同一个域名同时抓取的页面数（防压站）', kind: 'int', default: 2, min: 1, max: 16, inPreset: true },
  { key: 'minDelayMs', group: 'politeness', label: '请求间隔', hint: '同一域名两次请求之间的最小间隔（§4.7 要求 ≥1s 可调）', kind: 'int', default: 1000, min: 0, max: 60000, step: 100, unit: 'ms', inPreset: true },
  { key: 'jitterMs', group: 'politeness', label: '间隔抖动', hint: '在请求间隔上叠加的随机抖动，避免规律性压站', kind: 'int', default: 400, min: 0, max: 10000, step: 50, unit: 'ms', inPreset: true },
  { key: 'respectRobots', group: 'politeness', label: '遵守 robots.txt', hint: '关闭后不再读取 robots.txt（请自行确认目标站条款）', kind: 'bool', default: true, inPreset: true },
  { key: 'userAgent', group: 'politeness', label: 'User-Agent', hint: '默认标识为工具名；改前请确认目标站允许', kind: 'string', default: 'SiteAtlas/0.1 (+local crawler)', inPreset: true },

  { key: 'maxDepth', group: 'defaults', label: '最大深度', hint: '从根算起的最大层数（硬上限）', kind: 'int', default: 5, min: 0, max: 20, inPreset: true },
  { key: 'maxPages', group: 'defaults', label: '最大页数', hint: '单站抓取页数硬上限', kind: 'int', default: 100000, min: 1, max: 1000000, step: 1000, inPreset: true },
  { key: 'visitLimit', group: 'defaults', label: '同一 URL 访问上限', hint: '超过后跳过不再请求（循环护栏）', kind: 'int', default: 3, min: 1, max: 100, inPreset: true },
  { key: 'renderMode', group: 'defaults', label: '渲染模式', hint: 'auto = 静态优先、链接不足时回落 Playwright', kind: 'enum', default: 'auto', options: RENDER_MODES, inPreset: true },
  { key: 'timeoutMs', group: 'defaults', label: '单请求超时', hint: '单页抓取超时时间', kind: 'int', default: 15000, min: 1000, max: 120000, step: 1000, unit: 'ms', inPreset: true },
  { key: 'maxRetries', group: 'defaults', label: '失败重试次数', hint: '可重试错误（超时/5xx）的重试上限', kind: 'int', default: 2, min: 0, max: 10, inPreset: true },
  { key: 'prefixPruneThreshold', group: 'defaults', label: '前缀剪枝阈值', hint: '同一路径前缀连续命中超过该值即剪枝（对付无限目录）', kind: 'int', default: 20, min: 1, max: 10000, inPreset: true },
  { key: 'paginationPageLimit', group: 'defaults', label: '分页自动页上限', hint: '识别为分页序列时最多抓多少页', kind: 'int', default: 50, min: 1, max: 10000, inPreset: true },

  { key: 'downloadAssets', group: 'materials', label: '留 HTML 原件', hint: '开启后把每页原件写到 data/sites/<id>/raw/（默认只留解析结果，避免大站占满磁盘）', kind: 'bool', default: false, inPreset: true },
  { key: 'archiveMaterials', group: 'materials', label: '归档解析结果', hint: '把标题/描述/正文摘要/内容指纹写到 parsed/ 并登记 materials 表', kind: 'bool', default: true, inPreset: false },

  { key: 'theme', group: 'appearance', label: '外观', hint: '浅色 / 深色 / 跟随系统', kind: 'enum', default: 'system', options: ['system', 'light', 'dark'], inPreset: false },
  { key: 'reduceMotion', group: 'appearance', label: '减少动效', hint: '关闭界面过渡动画（requirements §5 动效 ≤200ms 且可关）', kind: 'bool', default: false, inPreset: false },
];

export type AppSettings = Record<string, number | boolean | string | string[]>;

export interface SettingsResponse {
  settings: AppSettings;
  /** 界面用来渲染表单的元数据（标签/范围/默认值/单位） */
  fields: readonly SettingFieldDef[];
}

export interface UpdateSettingsRequest {
  settings: Record<string, number | boolean | string | string[]>;
}

/** 导出预设（requirements §4.6「保存常用格式/字段/过滤条件，一键复用」；§4 presets 表） */
export interface ExportPresetPayload {
  format: ExportFormat;
  scope: ExportScope;
  includeDeleted: boolean;
}

export interface ExportPreset {
  id: string;
  name: string;
  payload: ExportPresetPayload;
  isDefault: boolean;
  createdAt: number | null;
}

export interface ExportPresetsResponse {
  presets: ExportPreset[];
}

export interface CreateExportPresetRequest {
  name: string;
  payload: ExportPresetPayload;
  isDefault?: boolean;
}
