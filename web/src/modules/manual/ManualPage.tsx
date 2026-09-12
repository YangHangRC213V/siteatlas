/**
 * 手动采集页 —— 路由 /sites/:id/manual（requirements §4.3 / dev-spec §6.5）
 *
 * 布局：左侧画面（canvas）+ 采集控制条；右侧从上到下 = 当前页面身份 / 待确认队列 / 事件日志。
 * 控制条满足 requirements §4.3：开始-暂停-暂停后继续-回根-展开一层-结束并保存，
 * 外加「回父节点」「以当前页为根」「置为父节点」（§6.5 的兜底）。
 */
import { useEffect, useState } from 'react';
import { navigate } from '../../router/useRoute.ts';
import { sitesApi } from '../sites/api.ts';
import { RemoteBrowserView } from './RemoteBrowserView.tsx';
import { useManualStore } from './store.ts';
import { MANUAL_STATUS_LABELS } from './types.ts';
import './manual.css';

export interface ManualPageProps {
  siteId: string;
}

export function ManualPage({ siteId }: ManualPageProps): React.JSX.Element {
  const [siteName, setSiteName] = useState<string | null>(null);
  const [rootUrl, setRootUrl] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [targetSelect, setTargetSelect] = useState('');

  const state = useManualStore((s) => s.state);
  const sessionId = useManualStore((s) => s.sessionId);
  const socketState = useManualStore((s) => s.socketState);
  const viewport = useManualStore((s) => s.viewport);
  const logs = useManualStore((s) => s.logs);
  const pending = useManualStore((s) => s.pending);
  const error = useManualStore((s) => s.error);
  const actionError = useManualStore((s) => s.actionError);
  const busy = useManualStore((s) => s.busy);
  const bind = useManualStore((s) => s.bind);
  const unbind = useManualStore((s) => s.unbind);
  const start = useManualStore((s) => s.start);
  const stop = useManualStore((s) => s.stop);
  const send = useManualStore((s) => s.send);
  const clearErrors = useManualStore((s) => s.clearErrors);

  useEffect(() => {
    void bind(siteId);
    return () => unbind();
  }, [bind, unbind, siteId]);

  useEffect(() => {
    let cancelled = false;
    sitesApi
      .get(siteId)
      .then((detail) => {
        if (cancelled) return;
        setSiteName(detail.site.name);
        setRootUrl(detail.site.root_url);
        setUrlInput((current) => (current.length > 0 ? current : detail.site.root_url));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  const status = state?.status ?? 'idle';
  const interactive = status === 'running';
  const current = state?.current ?? null;

  // 开始会话必须把「地址栏里的 URL」一起送过去：不带 url 时服务端页面停在 about:blank，
  // 表现为画面空白 + 点不到任何元素（踩过的坑，见 DECISIONS.md M3）。
  const startSession = () => {
    const url = urlInput.trim().length > 0 ? urlInput.trim() : (rootUrl ?? undefined);
    void start(url === undefined ? {} : { url });
  };

  return (
    <div className="page manual-page">
      <nav className="breadcrumb" aria-label="面包屑">
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => navigate('/sites')}>
          ← 站点
        </button>
        <span className="breadcrumb__sep" aria-hidden="true">
          /
        </span>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => navigate(`/sites/${siteId}`)}>
          {siteName ?? siteId}
        </button>
        <span className="breadcrumb__sep" aria-hidden="true">
          /
        </span>
        <span>手动采集</span>
      </nav>

      <header className="page__header">
        <div className="page__title-group">
          <h1>手动采集</h1>
          <p className="page__subtitle">
            服务端 Chromium 画面串流到此处；你在画面里点击，工具按 identityKey 判定节点身份 —— 回到根或已知节点不会新建重复节点。
          </p>
        </div>
        <div className="manual-controlbar" role="toolbar" aria-label="采集控制">
          <span className={`crawl-status crawl-status--${status === 'running' ? 'running' : status === 'paused' ? 'paused' : 'done'}`}>
            {MANUAL_STATUS_LABELS[status] ?? status}
          </span>
          {sessionId === null ? (
            <button type="button" className="btn btn--primary" disabled={busy} onClick={startSession}>
              开始手动采集
            </button>
          ) : (
            <>
              {status === 'running' ? (
                <button type="button" className="btn" onClick={() => send({ type: 'pause' })}>
                  ⏸ 暂停
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => send({ type: 'resume' })} disabled={status === 'ended'}>
                  ▶ 继续
                </button>
              )}
              <button type="button" className="btn" onClick={() => send({ type: 'back-root' })} title="绝对 URL 导航回根（不使用浏览器后退）">
                ⌂ 回根
              </button>
              <button type="button" className="btn" onClick={() => send({ type: 'back-parent' })}>
                ↰ 回父节点
              </button>
              <button type="button" className="btn" onClick={() => send({ type: 'set-root' })} title="把当前页面设为本次会话的根">
                以当前页为根
              </button>
              <button
                type="button"
                className={state?.progressMode === 'record-and-expand' ? 'btn btn--primary' : 'btn'}
                onClick={() =>
                  send({ type: 'mode', mode: state?.progressMode === 'record-and-expand' ? 'record-only' : 'record-and-expand' })
                }
                title="仅记录 / 记录并展开一层"
              >
                {state?.progressMode === 'record-and-expand' ? '记录并展开一层' : '仅记录'}
              </button>
              <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void stop()}>
                ⏹ 结束并保存
              </button>
            </>
          )}
          <button type="button" className="btn btn--ghost" onClick={() => navigate(`/sites/${siteId}/tree`)}>
            看树视图 →
          </button>
        </div>
      </header>

      {error !== null ? (
        <div className="alert alert--error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={clearErrors}>
            知道了
          </button>
        </div>
      ) : null}
      {actionError !== null ? (
        <div className="alert alert--warning" role="alert">
          <span>{actionError}</span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={clearErrors}>
            知道了
          </button>
        </div>
      ) : null}
      {sessionId !== null && socketState !== 'open' ? (
        <div className="alert alert--warning" role="status">
          画面通道未连接（{socketState}）—— 若刚启动请稍等；持续如此说明 WS 被中间层拦了。
        </div>
      ) : null}

      <div className="manual-layout">
        <section className="panel manual-stage" aria-label="远端浏览器">
          {sessionId === null ? (
            <div className="empty">
              <span className="empty__icon" aria-hidden="true">
                🖱
              </span>
              <h2>手动采集未开始</h2>
              <p>
                开始后服务端会启动一个 Chromium 并把画面串到这里；你的点击会被捕获并写入 URL 图（`edges.source='manual'`）。
              </p>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={startSession}>
                开始手动采集
              </button>
            </div>
          ) : (
            <>
              <div className="manual-addressbar">
                <label className="field manual-addressbar__field">
                  <span className="visually-hidden">导航地址</span>
                  <input
                    className="input mono"
                    value={urlInput}
                    placeholder={rootUrl ?? 'https://example.com/'}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') send({ type: 'navigate', url: urlInput });
                    }}
                  />
                </label>
                <button type="button" className="btn" onClick={() => send({ type: 'navigate', url: urlInput })}>
                  前往
                </button>
              </div>
              <RemoteBrowserView viewport={viewport} interactive={interactive} />
            </>
          )}
        </section>

        <aside className="manual-side">
          <section className="panel" aria-label="当前页面身份">
            <header className="crawl-panel__head">
              <h2>当前页面</h2>
              {current?.fresh === true ? <span className="badge badge--need-human">本次新建</span> : null}
            </header>
            {current === null ? (
              <p className="field__hint">尚未识别到页面身份。</p>
            ) : (
              <div className="manual-identity">
                <span className="manual-identity__label">{current.displayLabel ?? current.url}</span>
                <span className="mono manual-identity__url" title={current.url}>
                  {current.url}
                </span>
                <dl className="kv">
                  <div className="kv__item">
                    <dt>深度</dt>
                    <dd>{current.depth}</dd>
                  </div>
                  <div className="kv__item">
                    <dt>identityKey</dt>
                    <dd className="mono" title={current.identityKey}>
                      {current.identityKey.slice(0, 42)}
                      {current.identityKey.length > 42 ? '…' : ''}
                    </dd>
                  </div>
                </dl>
                <div className="manual-identity__actions">
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={!interactive}
                    onClick={() => send({ type: 'set-parent', nodeId: current.nodeId })}
                    title="把当前页人工指定为选中节点的父节点"
                  >
                    置为选中节点的父
                  </button>
                  <label className="field__hint">目标节点 id</label>
                  <input
                    className="input mono"
                    placeholder="在树视图里复制节点 id"
                    value={targetSelect}
                    onChange={(e) => setTargetSelect(e.target.value)}
                  />
                </div>
              </div>
            )}
            <dl className="kv">
              <div className="kv__item">
                <dt>点击（配对/未配对）</dt>
                <dd>
                  {state?.clicks.paired ?? 0} / {state?.clicks.unpaired ?? 0}
                </dd>
              </div>
              <div className="kv__item">
                <dt>新建节点 / 边</dt>
                <dd>
                  {state?.nodesCreated ?? 0} / {state?.edgesCreated ?? 0}
                </dd>
              </div>
              <div className="kv__item">
                <dt>重复目标（只补边）</dt>
                <dd>{state?.clicks.skippedDuplicate ?? 0}</dd>
              </div>
              <div className="kv__item">
                <dt>画面帧（收/投/丢）</dt>
                <dd>
                  {state?.screencast.received ?? 0} / {state?.screencast.delivered ?? 0} / {state?.screencast.dropped ?? 0}
                </dd>
              </div>
            </dl>
          </section>

          <section className="panel" aria-label="待确认队列">
            <header className="crawl-panel__head">
              <h2>待确认（{pending.length}）</h2>
              <span className="field__hint">未触发导航的点击</span>
            </header>
            {pending.length === 0 ? (
              <p className="field__hint">
                页内锚点、JS 行为、新标签打开的点击会落在这里，确认后再入树，不会污染结构。
              </p>
            ) : (
              <ul className="pending-list">
                {pending.map((item) => (
                  <li key={item.id} className="pending-list__item">
                    <div className="pending-list__head">
                      <span className="pending-list__text" title={item.payload.anchorText}>
                        {item.payload.anchorText.length > 0 ? item.payload.anchorText : item.payload.tag}
                      </span>
                      <span className="badge badge--muted">{item.reason}</span>
                    </div>
                    <div className="pending-list__meta mono" title={item.payload.href ?? ''}>
                      {item.payload.selector}
                    </div>
                    <div className="pending-list__actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        data-testid="pending-confirm"
                        disabled={targetSelect.length === 0}
                        onClick={() => send({ type: 'confirm-click', confirmId: item.id, nodeId: targetSelect })}
                      >
                        确认到目标节点
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        data-testid="pending-discard"
                        onClick={() => send({ type: 'discard-click', confirmId: item.id })}
                      >
                        丢弃
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-label="事件日志">
            <header className="crawl-panel__head">
              <h2>事件日志</h2>
              <span className="field__hint">最近 {logs.length} 条</span>
            </header>
            {logs.length === 0 ? (
              <p className="field__hint">开始后这里实时显示识别与配对结果。</p>
            ) : (
              <ul className="manual-log">
                {logs
                  .slice()
                  .reverse()
                  .map((line, index) => (
                    <li key={`${line.at}-${index}`} className={`manual-log__item manual-log__item--${line.level}`}>
                      <span className="manual-log__time">{new Date(line.at).toLocaleTimeString('zh-CN')}</span>
                      <span className="manual-log__text">{line.message}</span>
                    </li>
                  ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
