/**
 * 采集控制台 —— 路由 /sites/:id/crawl（requirements §4.4 / dev-spec §5.1）
 *
 * 左侧参数面板（可保存为预设的雏形）+ 右侧实时进度（WS 推送，断线自动降级轮询）
 * + 底部采集日志。控制条满足 requirements §4.4「暂停/继续/停止」。
 */
import { useEffect, useState } from 'react';
import { RENDER_MODES, SITE_SCOPES, type RenderMode, type SiteScope, type SiteDetailResponse } from '@siteatlas/shared';
import { navigate } from '../../router/useRoute.ts';
import { sitesApi } from '../sites/api.ts';
import { SCOPE_LABELS, formatTime } from '../sites/types.ts';
import { useCrawlStore } from './store.ts';
import './crawl.css';

export interface CrawlPageProps {
  siteId: string;
}

const STATUS_TEXT: Record<string, string> = {
  running: '采集中',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  stopped: '已停止',
};

export function CrawlPage({ siteId }: CrawlPageProps): React.JSX.Element {
  // 站点信息（面包屑 + 默认范围）由本页自己取，保持「模块页自治」
  const [site, setSite] = useState<SiteDetailResponse | null>(null);
  const form = useCrawlStore((s) => s.form);
  const setForm = useCrawlStore((s) => s.setForm);
  const resetForm = useCrawlStore((s) => s.resetForm);
  const task = useCrawlStore((s) => s.task);
  const progress = useCrawlStore((s) => s.progress);
  const stats = useCrawlStore((s) => s.stats);
  const logs = useCrawlStore((s) => s.logs);
  const socketState = useCrawlStore((s) => s.socketState);
  const wsSubscribers = useCrawlStore((s) => s.wsSubscribers);
  const error = useCrawlStore((s) => s.error);
  const actionError = useCrawlStore((s) => s.actionError);
  const loading = useCrawlStore((s) => s.loading);
  const bind = useCrawlStore((s) => s.bind);
  const unbind = useCrawlStore((s) => s.unbind);
  const start = useCrawlStore((s) => s.start);
  const pause = useCrawlStore((s) => s.pause);
  const resume = useCrawlStore((s) => s.resume);
  const stop = useCrawlStore((s) => s.stop);
  const refresh = useCrawlStore((s) => s.refresh);

  useEffect(() => {
    let cancelled = false;
    sitesApi
      .get(siteId)
      .then((detail) => {
        if (!cancelled) setSite(detail);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  useEffect(() => {
    let allowlist: string[] = [];
    try {
      allowlist = site === null ? [] : (JSON.parse(site.site.allowlist_json) as string[]);
    } catch {
      allowlist = [];
    }
    void bind(siteId, site?.site.scope ?? undefined, allowlist);
    return () => unbind();
  }, [bind, unbind, siteId, site]);

  // 任务运行中：1.5s 兜底刷新（WS 正常时数据由推送更新，刷新只补日志与统计）
  useEffect(() => {
    if (task?.status !== 'running') return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [task?.status, refresh]);

  const status = task?.status ?? 'idle';
  const running = status === 'running';
  const paused = status === 'paused';
  const percent =
    progress !== null && form.maxPages > 0 ? Math.min(100, Math.round((progress.pagesFetched / form.maxPages) * 100)) : 0;

  const depths = Object.entries(stats?.depthDistribution ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));

  return (
    <div className="page crawl-page">
      <nav className="breadcrumb" aria-label="面包屑">
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => navigate('/sites')}>
          ← 站点
        </button>
        <span className="breadcrumb__sep" aria-hidden="true">
          /
        </span>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => navigate(`/sites/${siteId}`)}>
          {site?.site.name ?? siteId}
        </button>
        <span className="breadcrumb__sep" aria-hidden="true">
          /
        </span>
        <span>采集</span>
      </nav>

      <header className="page__header">
        <div className="page__title-group">
          <h1>采集</h1>
          <p className="page__subtitle">
            自动遍历同域链接，产出可编辑的 URL 图。去重三层：规范化指纹 → 正文指纹 → 已抓直连复用。
          </p>
        </div>
        <div className="crawl-controlbar" role="toolbar" aria-label="采集控制">
          <span className={`crawl-status crawl-status--${status}`}>{running || paused || status !== 'idle' ? STATUS_TEXT[status] ?? status : '未开始'}</span>
          {running ? (
            <button type="button" className="btn" onClick={() => void pause()}>
              ⏸ 暂停
            </button>
          ) : (
            <button type="button" className="btn" disabled={paused === false && status !== 'idle' && status !== 'done' && status !== 'stopped' && status !== 'failed'} onClick={() => void resume()}>
              ▶ 继续
            </button>
          )}
          <button type="button" className="btn btn--danger" disabled={!running && !paused} onClick={() => void stop()}>
            ⏹ 停止
          </button>
          <button type="button" className="btn btn--primary" disabled={running || paused} onClick={() => void start()}>
            {status === 'idle' ? '开始采集' : '重新采集'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void refresh()} disabled={loading}>
            刷新
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => navigate(`/sites/${siteId}/tree`)}>
            看树视图 →
          </button>
          <button type="button" className="btn" onClick={() => navigate(`/sites/${siteId}/manual`)} title="引导式手动采集（M3）">
            🖱 手动采集
          </button>
        </div>
      </header>

      {error !== null ? (
        <div className="alert alert--error" role="alert">
          {error}
        </div>
      ) : null}
      {actionError !== null ? (
        <div className="alert alert--warning" role="alert">
          {actionError}
        </div>
      ) : null}

      <div className="crawl-layout">
        <section className="panel crawl-preset" aria-label="采集参数">
          <header className="crawl-panel__head">
            <h2>采集参数</h2>
            <button type="button" className="btn btn--sm btn--ghost" onClick={resetForm} disabled={running || paused}>
              恢复默认
            </button>
          </header>

          <div className="crawl-grid">
            <label className="field">
              <span className="field__label">最大深度</span>
              <input
                className="input"
                type="number"
                min={0}
                max={20}
                value={form.maxDepth}
                disabled={running || paused}
                onChange={(e) => setForm('maxDepth', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span className="field__label">最大页数</span>
              <input
                className="input"
                type="number"
                min={1}
                max={1000000}
                value={form.maxPages}
                disabled={running || paused}
                onChange={(e) => setForm('maxPages', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span className="field__label">并发数（1–32）</span>
              <input
                className="input"
                type="number"
                min={1}
                max={32}
                value={form.concurrency}
                disabled={running || paused}
                onChange={(e) => setForm('concurrency', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span className="field__label">每域并发</span>
              <input
                className="input"
                type="number"
                min={1}
                max={16}
                value={form.perHostConcurrency}
                disabled={running || paused}
                onChange={(e) => setForm('perHostConcurrency', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span className="field__label">请求间隔（ms）</span>
              <input
                className="input"
                type="number"
                min={0}
                step={100}
                value={form.minDelayMs}
                disabled={running || paused}
                onChange={(e) => setForm('minDelayMs', Number(e.target.value))}
              />
              <span className="field__hint">默认 1000ms，≥1s 更礼貌（§4.7）</span>
            </label>
            <label className="field">
              <span className="field__label">间隔抖动（ms）</span>
              <input
                className="input"
                type="number"
                min={0}
                step={50}
                value={form.jitterMs}
                disabled={running || paused}
                onChange={(e) => setForm('jitterMs', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span className="field__label">超时（ms）</span>
              <input
                className="input"
                type="number"
                min={1000}
                step={1000}
                value={form.timeoutMs}
                disabled={running || paused}
                onChange={(e) => setForm('timeoutMs', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span className="field__label">失败重试次数</span>
              <input
                className="input"
                type="number"
                min={0}
                max={10}
                value={form.maxRetries}
                disabled={running || paused}
                onChange={(e) => setForm('maxRetries', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span className="field__label">抓取范围</span>
              <select
                className="select"
                value={form.scope}
                disabled={running || paused}
                onChange={(e) => setForm('scope', e.target.value as SiteScope)}
              >
                {SITE_SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {SCOPE_LABELS[scope] ?? scope}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">渲染方式</span>
              <select
                className="select"
                value={form.renderMode}
                disabled={running || paused}
                onChange={(e) => setForm('renderMode', e.target.value as RenderMode)}
              >
                {RENDER_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode === 'auto' ? '自动（链接为 0 时回落浏览器）' : mode === 'http' ? '纯 HTTP' : '强制浏览器渲染'}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">同一 URL 访问上限</span>
              <input
                className="input"
                type="number"
                min={1}
                max={100}
                value={form.visitLimit}
                disabled={running || paused}
                onChange={(e) => setForm('visitLimit', Number(e.target.value))}
              />
              <span className="field__hint">循环护栏：超过即跳过（§6.3）</span>
            </label>
            <label className="field">
              <span className="field__label">分页自动页上限</span>
              <input
                className="input"
                type="number"
                min={1}
                max={10000}
                value={form.paginationPageLimit}
                disabled={running || paused}
                onChange={(e) => setForm('paginationPageLimit', Number(e.target.value))}
              />
              <span className="field__hint">识别 ?page=n 与 /page/n</span>
            </label>
            <label className="field crawl-grid__wide">
              <span className="field__label">User-Agent</span>
              <input
                className="input"
                type="text"
                value={form.userAgent}
                disabled={running || paused}
                onChange={(e) => setForm('userAgent', e.target.value)}
              />
            </label>
            <label className="field crawl-grid__check">
              <span className="field__label">
                <input
                  type="checkbox"
                  checked={form.respectRobots}
                  disabled={running || paused}
                  onChange={(e) => setForm('respectRobots', e.target.checked)}
                />{' '}
                遵守 robots.txt
              </span>
              <span className="field__hint">默认遵守；被禁止的 URL 标记为 blocked，不发请求</span>
            </label>
          </div>
        </section>

        <section className="panel crawl-progress" aria-label="实时进度">
          <header className="crawl-panel__head">
            <h2>实时进度</h2>
            <span className={`badge ${socketState === 'open' ? 'badge--ok' : 'badge--muted'}`}>
              {socketState === 'open' ? 'WS 已连接' : socketState === 'connecting' ? 'WS 连接中' : '轮询兜底'}
            </span>
            {wsSubscribers > 1 ? <span className="badge badge--muted">{wsSubscribers} 个观察者</span> : null}
          </header>

          <div className="crawl-metrics">
            <div className="metric">
              <span className="metric__value">{progress?.pagesFetched ?? 0}</span>
              <span className="metric__label">已抓页面</span>
            </div>
            <div className="metric">
              <span className="metric__value">{progress?.discovered ?? stats?.statusCounts['queued'] ?? 0}</span>
              <span className="metric__label">发现节点</span>
            </div>
            <div className="metric">
              <span className="metric__value">{progress?.queueLength ?? stats?.queued ?? 0}</span>
              <span className="metric__label">队列剩余</span>
            </div>
            <div className="metric">
              <span className="metric__value metric__value--ok">{stats?.ok ?? progress?.ok ?? 0}</span>
              <span className="metric__label">成功</span>
            </div>
            <div className="metric">
              <span className="metric__value metric__value--error">{stats?.failed ?? progress?.failed ?? 0}</span>
              <span className="metric__label">失败</span>
            </div>
            <div className="metric">
              <span className="metric__value">{stats?.skipped ?? progress?.skipped ?? 0}</span>
              <span className="metric__label">跳过</span>
            </div>
          </div>

          <div className="crawl-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="crawl-bar__fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="field__hint">
            {progress?.lastEvent ?? (task === null ? '尚未开始采集' : `任务 ${task.id} · ${STATUS_TEXT[task.status] ?? task.status}`)}
          </p>

          <h3 className="crawl-subhead">深度分布</h3>
          {depths.length === 0 ? (
            <p className="field__hint">暂无数据</p>
          ) : (
            <ul className="depth-list">
              {depths.map(([depth, count]) => (
                <li key={depth} className="depth-list__item">
                  <span className="depth-list__label">深度 {depth}</span>
                  <span className="depth-list__bar">
                    <span
                      className="depth-list__fill"
                      style={{ width: `${Math.min(100, (count / Math.max(...depths.map(([, c]) => c))) * 100)}%` }}
                    />
                  </span>
                  <span className="depth-list__count">{count}</span>
                </li>
              ))}
            </ul>
          )}

          <h3 className="crawl-subhead">任务信息</h3>
          <dl className="kv">
            <div className="kv__item">
              <dt>任务 ID</dt>
              <dd className="mono">{task?.id ?? '—'}</dd>
            </div>
            <div className="kv__item">
              <dt>开始时间</dt>
              <dd>{formatTime(task?.started_at ?? null)}</dd>
            </div>
            <div className="kv__item">
              <dt>结束时间</dt>
              <dd>{formatTime(task?.finished_at ?? null)}</dd>
            </div>
            <div className="kv__item">
              <dt>站点节点总数</dt>
              <dd>{stats === null ? '—' : Object.values(stats.statusCounts).reduce((a, b) => a + b, 0)}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="panel crawl-logs" aria-label="采集日志">
        <header className="crawl-panel__head">
          <h2>采集日志</h2>
          <span className="field__hint">最近 {logs.length} 条（fetch_logs）</span>
        </header>
        {logs.length === 0 ? (
          <div className="empty">
            <span className="empty__icon" aria-hidden="true">
              ⇣
            </span>
            <p>还没有请求记录。点击「开始采集」后这里会实时显示每一次抓取。</p>
          </div>
        ) : (
          <ul className="log-list">
            {logs.map((log, index) => (
              <li key={`${log.url}-${log.at}-${index}`} className={log.error !== null ? 'log-list__item log-list__item--error' : 'log-list__item'}>
                <span className="log-list__status">{log.http_status ?? '—'}</span>
                <span className="log-list__url mono" title={log.url}>
                  {log.url}
                </span>
                <span className="log-list__error">{log.error ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
