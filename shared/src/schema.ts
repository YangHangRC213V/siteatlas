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
