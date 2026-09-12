/**
 * 导出页 —— 路由 /sites/:id/export（requirements §4.6 / dev-spec §5.1 / §6.7）
 *
 * 布局：左侧 = 新建导出（格式 / 范围 / 子树节点）+ 历史任务列表；右侧 = 产物与 manifest。
 * 目标（§7 M4）：让人一眼看到「导出到哪了、manifest 在哪、下游该读什么」。
 */
import { useEffect, useState } from 'react';
import { navigate } from '../../router/useRoute.ts';
import { sitesApi } from '../sites/api.ts';
import { FORMAT_LABELS, SCOPE_LABELS } from './api.ts';
import { useExportStore } from './store.ts';
import { settingsApi } from '../settings/api.ts';
import { EXPORT_FORMATS, type ExportFormat, type ExportPreset, type ExportScope } from '@siteatlas/shared';
import './export.css';

export interface ExportPageProps {
  siteId: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(sec: number): string {
  return new Date(sec * 1000).toLocaleString('zh-CN');
}

export function ExportPage({ siteId }: ExportPageProps): React.JSX.Element {
  const [siteName, setSiteName] = useState<string | null>(null);
  const [rootUrl, setRootUrl] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>('json');
  const [scope, setScope] = useState<ExportScope>('site');
  const [nodeId, setNodeId] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  // 导出预设（§4.6「保存常用格式/字段/过滤条件，一键复用」）：在设置页管理，这里选用
  const [presets, setPresets] = useState<ExportPreset[]>([]);
  const [presetId, setPresetId] = useState('');
  const [presetName, setPresetName] = useState('');

  const records = useExportStore((s) => s.exports);
  const materials = useExportStore((s) => s.materials);
  const selectedId = useExportStore((s) => s.selectedId);
  const manifest = useExportStore((s) => s.selectedManifest);
  const files = useExportStore((s) => s.selectedFiles);
  const busy = useExportStore((s) => s.busy);
  const error = useExportStore((s) => s.error);
  const bind = useExportStore((s) => s.bind);
  const unbind = useExportStore((s) => s.unbind);
  const refresh = useExportStore((s) => s.refresh);
  const run = useExportStore((s) => s.run);
  const select = useExportStore((s) => s.select);
  const clearError = useExportStore((s) => s.clearError);

  useEffect(() => {
    void bind(siteId);
    return () => unbind();
  }, [bind, unbind, siteId]);

  const loadPresets = (): void => {
    settingsApi
      .listExportPresets()
      .then((payload) => {
        setPresets(payload.presets);
        setPresetId((current) => (current.length > 0 ? current : (payload.presets.find((p) => p.isDefault)?.id ?? '')));
      })
      .catch(() => setPresets([]));
  };

  useEffect(() => {
    loadPresets();
  }, []);

  useEffect(() => {
    let cancelled = false;
    sitesApi
      .get(siteId)
      .then((detail) => {
        if (cancelled) return;
        setSiteName(detail.site.name);
        setRootUrl(detail.site.root_url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  const copy = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(label),
      () => setCopied(null),
    );
  };

  const selected = records.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="page export-page">
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
        <span>导出</span>
        <button type="button" className="btn btn--sm" onClick={() => navigate(`/sites/${siteId}/tree`)}>
          看树视图 →
        </button>
      </nav>

      <header className="page__header">
        <div className="page__title-group">
          <h1>导出</h1>
          <p className="page__subtitle">
            结构层（节点 + 边）导出到 <code className="mono">data/sites/{siteId}/exports/&lt;导出 id&gt;/</code>，
            并生成 <code className="mono">manifest.json</code> —— 下游工具只凭它就能读到全部数据。
          </p>
        </div>
      </header>

      {error !== null && (
        <div className="banner banner--error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={clearError}>
            知道了
          </button>
        </div>
      )}

      <div className="export-layout">
        <section className="panel">
          <header className="crawl-panel__head">
            <h2>新建导出</h2>
            <span className="field__hint">本地同步完成，通常不到 1 秒</span>
          </header>

          <div className="export-form">
            <label className="field">
              <span>导出预设（可选）</span>
              <select
                className="input"
                data-testid="export-preset"
                value={presetId}
                onChange={(e) => {
                  const id = e.target.value;
                  setPresetId(id);
                  const preset = presets.find((p) => p.id === id);
                  if (preset === undefined) return;
                  setFormat(preset.payload.format);
                  setScope(preset.payload.scope);
                }}
              >
                <option value="">（不使用预设）</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name} —— {preset.payload.format} / {preset.payload.scope}
                    {preset.payload.includeDeleted ? ' / 含软删' : ''}
                  </option>
                ))}
              </select>
              <span className="field__hint">预设可在「设置」页管理与删除</span>
            </label>

            <label className="field">
              <span>格式</span>
              <select
                className="input"
                data-testid="export-format"
                value={format}
                onChange={(e) => setFormat(e.target.value as ExportFormat)}
              >
                {EXPORT_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABELS[f].label} —— {FORMAT_LABELS[f].hint}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>范围</span>
              <select className="input" data-testid="export-scope" value={scope} onChange={(e) => setScope(e.target.value as ExportScope)}>
                {(Object.keys(SCOPE_LABELS) as ExportScope[]).map((s) => (
                  <option key={s} value={s}>
                    {SCOPE_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>

            {scope === 'subtree' && (
              <label className="field">
                <span>子树根节点 id</span>
                <input
                  className="input mono"
                  placeholder="在树视图里复制节点 id"
                  value={nodeId}
                  onChange={(e) => setNodeId(e.target.value)}
                />
              </label>
            )}

            <div className="export-form__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || (scope === 'subtree' && nodeId.trim().length === 0)}
                onClick={() => void run({ format, scope, nodeId })}
              >
                {busy ? '导出中…' : '开始导出'}
              </button>
              <input
                className="input export-form__preset-name"
                placeholder="预设名（保存当前格式/范围）"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                disabled={busy || presetName.trim().length === 0}
                onClick={() => {
                  void settingsApi
                    .createExportPreset({
                      name: presetName.trim(),
                      payload: { format, scope, includeDeleted: scope === 'all' },
                    })
                    .then(() => {
                      setPresetName('');
                      loadPresets();
                    })
                    .catch(() => undefined);
                }}
                title="把当前格式与范围保存为预设，下次一键复用"
              >
                保存为预设
              </button>
            </div>
          </div>

          <header className="crawl-panel__head">
            <h2>历史导出（{records.length}）</h2>
            <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void refresh()}>
              刷新
            </button>
          </header>
          {records.length === 0 ? (
            <p className="field__hint">还没有导出记录 —— 选好格式点「开始导出」。</p>
          ) : (
            <ul className="export-list">
              {records.map((record) => (
                <li key={record.id} className={`export-list__item${record.id === selectedId ? ' export-list__item--active' : ''}`}>
                  <button type="button" className="export-list__pick" onClick={() => void select(record.id)}>
                    <span className="badge">{record.format}</span>
                    <span className="mono export-list__id">{record.id}</span>
                    <span className={`crawl-status crawl-status--${record.status === 'done' ? 'done' : record.status === 'failed' ? 'failed' : 'running'}`}>
                      {record.status === 'done' ? '已完成' : record.status === 'failed' ? '失败' : '进行中'}
                    </span>
                    <span className="field__hint">{formatTime(record.created_at)}</span>
                  </button>
                  {record.counts_json !== null && (
                    <span className="field__hint mono">{record.counts_json}</span>
                  )}
                  {record.error !== null && <span className="export-list__error">{record.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <header className="crawl-panel__head">
            <h2>产物与清单</h2>
            {selected !== null && <span className="field__hint mono">{selected.id}</span>}
          </header>

          {selected === null || manifest === null ? (
            <p className="field__hint">选中一条导出记录，这里显示产物文件、manifest 与下游接入地址。</p>
          ) : (
            <div className="export-detail">
              <dl className="kv">
                <div className="kv__item">
                  <dt>站点</dt>
                  <dd>{manifest.siteName}</dd>
                </div>
                <div className="kv__item">
                  <dt>根地址</dt>
                  <dd className="mono">{manifest.rootUrl}</dd>
                </div>
                <div className="kv__item">
                  <dt>计数</dt>
                  <dd className="mono">
                    节点 {manifest.counts.nodes} / 边 {manifest.counts.edges} / 素材 {manifest.counts.materials}
                    {manifest.counts.deleted > 0 ? `（软删未导出 ${manifest.counts.deleted}）` : ''}
                  </dd>
                </div>
                <div className="kv__item">
                  <dt>schemaVersion</dt>
                  <dd className="mono">{manifest.schemaVersion}</dd>
                </div>
                <div className="kv__item">
                  <dt>产物目录</dt>
                  <dd className="mono export-detail__path">{selected.dir}</dd>
                </div>
              </dl>

              <div className="export-actions">
                <button type="button" className="btn btn--sm" onClick={() => copy(selected.dir ?? '', 'dir')}>
                  {copied === 'dir' ? '已复制路径' : '复制产物目录'}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => copy(`${window.location.origin}/open/v1/exports/${selected.id}/manifest.json`, 'manifest')}
                >
                  {copied === 'manifest' ? '已复制地址' : '复制 manifest 地址'}
                </button>
                <a className="btn btn--sm" href={`/open/v1/exports/${selected.id}/manifest.json`} target="_blank" rel="noreferrer">
                  打开 manifest
                </a>
              </div>

              <h3 className="export-subhead">manifest.json 登记的文件</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>文件</th>
                    <th>数据集</th>
                    <th>行数</th>
                    <th>大小</th>
                    <th>sha256</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(manifest.files).map(([name, entry]) => (
                    <tr key={name}>
                      <td className="mono">{name}</td>
                      <td>{entry.dataset}</td>
                      <td>{entry.rows ?? '—'}</td>
                      <td>{formatBytes(entry.bytes)}</td>
                      <td className="mono export-detail__sha" title={entry.sha256}>
                        {entry.sha256.slice(0, 12)}…
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {(manifest.layers.raw.length > 0 || manifest.layers.parsed.length > 0) && (
                <>
                  <h3 className="export-subhead">素材分层（按 nodeId 关联）</h3>
                  <p className="field__hint">
                    原件 {manifest.layers.raw.length} 个（<code className="mono">raw/</code>）·
                    解析结果 {manifest.layers.parsed.length} 个（<code className="mono">parsed/</code>）
                    {materials.length > 0 ? ` · 素材登记共 ${materials.length} 条` : ''}
                  </p>
                </>
              )}

              <h3 className="export-subhead">下游接入（只读 API）</h3>
              <ul className="export-endpoints">
                {Object.entries(manifest.endpoints).map(([key, url]) => (
                  <li key={key}>
                    <span className="badge badge--muted">{key}</span>
                    <a className="mono" href={url} target="_blank" rel="noreferrer">
                      {url}
                    </a>
                  </li>
                ))}
              </ul>

              {files.length > 0 && (
                <>
                  <h3 className="export-subhead">磁盘上的文件</h3>
                  <ul className="export-files">
                    {files.map((file) => (
                      <li key={file.name}>
                        <span className="mono">{file.name}</span>
                        <span className="field__hint">{formatBytes(file.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
