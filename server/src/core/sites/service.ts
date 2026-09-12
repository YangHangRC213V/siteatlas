/**
 * 站点用例层（dev-spec §5.1 /api/sites、§7 M0「建站与 URL 校验」）
 *
 * 职责：URL 校验（协议 / 可达性 / 是否 HTML）→ 规范化 → 建站 + 建根节点。
 * 不依赖 api/（dev-spec §3 约束：core/ 不依赖 api/）。
 */
import type {
  CreateSiteRequest,
  CreateSiteResponse,
  DeleteSiteResponse,
  NodeStatus,
  SiteCard,
  SiteDetailResponse,
  SiteRecord,
  SiteScope,
  UpdateSiteRequest,
  UrlProbeResult,
} from '@siteatlas/shared';
import { SITE_SCOPES } from '@siteatlas/shared';
import { probeUrl, type ProbeOptions } from '../fetch/probe.ts';
import { deriveDisplayLabel } from '../extract/content.ts';
import { normalizeUrl } from '../url/normalize.ts';
import { SitesRepo } from '../store/repos/sites.ts';
import { NodesRepo } from '../store/repos/nodes.ts';

/** 统一的用例层错误：api 层据此映射 HTTP 状态码 */
export class SiteServiceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: unknown;
  constructor(code: string, message: string, status: number, detail?: unknown) {
    super(message);
    this.name = 'SiteServiceError';
    this.code = code;
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

export interface SitesServiceDeps {
  sites: SitesRepo;
  nodes: NodesRepo;
  /** 探测超时等参数；测试可注入假探测函数 */
  probe?: (url: string, options?: ProbeOptions) => Promise<UrlProbeResult>;
  probeTimeoutMs?: number;
  /** 同根 URL 已存在时是否直接返回已有站点（默认 false → 409） */
  allowDuplicateRoot?: boolean;
}

const DEFAULT_PROBE_TIMEOUT_MS = Number(process.env['SITEATLAS_PROBE_TIMEOUT_MS'] ?? 5000);

function assertScope(value: unknown): SiteScope {
  if (value === undefined || value === null) return 'same_site';
  if (typeof value !== 'string' || !(SITE_SCOPES as readonly string[]).includes(value)) {
    throw new SiteServiceError(
      'INVALID_SCOPE',
      `scope 必须是 ${SITE_SCOPES.join('|')} 之一，收到 ${JSON.stringify(value)}`,
      400,
    );
  }
  return value as SiteScope;
}

/** 非 HTML 一律拒绝；无 Content-Type 时放行（很多老站点不返回该头） */
function classifyProbe(probe: UrlProbeResult): { accept: boolean; status: NodeStatus; note: string | null } {
  if (!probe.reachable) {
    return { accept: true, status: 'error', note: `建站时探测失败：${probe.error ?? '未知网络错误'}` };
  }
  if (probe.isHtml) {
    const ok = probe.status !== null && probe.status < 400;
    return ok
      ? { accept: true, status: 'ok', note: null }
      : { accept: true, status: 'error', note: `建站时探测返回 HTTP ${probe.status}` };
  }
  if (probe.contentType === null) {
    return { accept: true, status: 'queued', note: '响应缺少 Content-Type，未能确认是 HTML，标记待确认' };
  }
  return {
    accept: false,
    status: 'error',
    note: `响应非 HTML（Content-Type: ${probe.contentType}）`,
  };
}

export class SitesService {
  private readonly sites: SitesRepo;
  private readonly nodes: NodesRepo;
  private readonly probe: (url: string, options?: ProbeOptions) => Promise<UrlProbeResult>;
  private readonly probeTimeoutMs: number;
  private readonly allowDuplicateRoot: boolean;

  constructor(deps: SitesServiceDeps) {
    this.sites = deps.sites;
    this.nodes = deps.nodes;
    this.probe = deps.probe ?? probeUrl;
    this.probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.allowDuplicateRoot = deps.allowDuplicateRoot ?? false;
  }

  /** POST /api/sites */
  async createSite(input: CreateSiteRequest): Promise<CreateSiteResponse> {
    if (typeof input?.url !== 'string' || input.url.trim().length === 0) {
      throw new SiteServiceError('INVALID_URL', '请求体缺少 url 字段', 400);
    }

    let normalized;
    try {
      normalized = normalizeUrl(input.url, input.normalize ?? {});
    } catch (err) {
      throw new SiteServiceError('INVALID_URL', (err as Error).message, 400);
    }

    const existing = this.sites.list({ includeArchived: false }).find((card) => card.site.root_url === normalized.identityKey);
    if (existing !== undefined && !this.allowDuplicateRoot) {
      throw new SiteServiceError('SITE_EXISTS', `该根 URL 已存在于站点「${existing.site.name}」`, 409, {
        siteId: existing.site.id,
      });
    }

    const probe: UrlProbeResult = input.skipProbe
      ? {
          reachable: false,
          isHtml: false,
          status: null,
          contentType: null,
          finalUrl: null,
          redirectChain: [normalized.url],
          error: '已跳过探测（skipProbe）',
        }
      : await this.probe(normalized.url, { timeoutMs: this.probeTimeoutMs });

    const verdict = classifyProbe(probe);
    if (input.skipProbe) {
      verdict.status = 'queued';
      verdict.note = '已跳过可达性探测，节点状态保持 queued';
    }
    if (!verdict.accept) {
      throw new SiteServiceError('NOT_HTML', verdict.note ?? '目标不是 HTML 页面', 422, { probe });
    }

    const scope = assertScope(input.scope);
    const providedName = typeof input.name === 'string' ? input.name.trim() : '';
    const name = providedName.length > 0 ? providedName : normalized.normalizedHost;

    const site = this.sites.create({
      name,
      rootUrl: normalized.identityKey,
      rootHost: normalized.normalizedHost,
      scope,
      allowlist: [],
      note: verdict.note,
    });

    const root = this.nodes.createRoot({
      siteId: site.id,
      url: normalized.url,
      identityKey: normalized.identityKey,
      displayLabel: deriveDisplayLabel({ url: normalized.url }),
      status: verdict.status,
      httpStatus: probe.status,
      contentType: probe.contentType,
    });

    return { site, root, probe };
  }

  /** GET /api/sites */
  listSites(options: { includeArchived?: boolean; archivedOnly?: boolean } = {}): SiteCard[] {
    return this.sites.list(options);
  }

  /** GET /api/sites/:id */
  getSite(id: string): SiteDetailResponse {
    const site = this.sites.get(id);
    if (site === null) throw new SiteServiceError('SITE_NOT_FOUND', `站点不存在：${id}`, 404);
    return { site, stats: this.sites.stats(id), root: this.nodes.root(id) };
  }

  /** PATCH /api/sites/:id */
  updateSite(id: string, patch: UpdateSiteRequest): SiteDetailResponse {
    if (patch === null || typeof patch !== 'object') {
      throw new SiteServiceError('INVALID_BODY', '请求体必须是 JSON 对象', 400);
    }
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (name.length === 0) throw new SiteServiceError('INVALID_NAME', '站点名不能为空', 400);
      patch = { ...patch, name };
    }
    const scope = assertScope(patch.scope);
    if (patch.allowlist !== undefined && !Array.isArray(patch.allowlist)) {
      throw new SiteServiceError('INVALID_BODY', 'allowlist 必须是字符串数组', 400);
    }
    const updated = this.sites.update(id, { ...patch, scope });
    if (updated === null) throw new SiteServiceError('SITE_NOT_FOUND', `站点不存在：${id}`, 404);
    return { site: updated, stats: this.sites.stats(id), root: this.nodes.root(id) };
  }

  /** DELETE /api/sites/:id —— 软删整站 */
  deleteSite(id: string): DeleteSiteResponse {
    const result = this.sites.softDelete(id);
    if (result === null) throw new SiteServiceError('SITE_NOT_FOUND', `站点不存在：${id}`, 404);
    return { site: result.site, deleted: true, affectedNodes: result.affectedNodes };
  }

  /** 回收站恢复（requirements §3「软删除可恢复」） */
  restoreSite(id: string): SiteDetailResponse {
    const site = this.sites.restore(id);
    if (site === null) throw new SiteServiceError('SITE_NOT_FOUND', `站点不存在：${id}`, 404);
    return { site, stats: this.sites.stats(id), root: this.nodes.root(id) };
  }

  /** 站点记录 + 根节点（供内部复用） */
  getSiteRecord(id: string): SiteRecord {
    const site = this.sites.get(id);
    if (site === null) throw new SiteServiceError('SITE_NOT_FOUND', `站点不存在：${id}`, 404);
    return site;
  }
}
