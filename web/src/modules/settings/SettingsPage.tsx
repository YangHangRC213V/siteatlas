/**
 * 设置页 —— 路由 /settings（导航「设置」）
 *
 * 内容：
 *   1. 全局默认（礼貌与合规 / 采集默认值 / 素材归档 / 外观）—— 表单由 SETTING_FIELDS 生成；
 *   2. 导出预设（requirements §4.6「保存常用格式/字段/过滤条件，一键复用」）—— 在导出页选用；
 *   3. 环境信息（版本、数据库路径、浏览器可用性）—— 排查问题时最常被问到的三项。
 */
import { useEffect, useState } from 'react';
import type { SettingFieldDef } from '@siteatlas/shared';
import { navigate } from '../../router/useRoute.ts';
import { SETTING_GROUPS } from './api.ts';
import { useSettingsStore } from './store.ts';
import './settings.css';

type SettingValue = number | boolean | string | string[];

export function SettingsPage(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings);
  const fields = useSettingsStore((s) => s.fields);
  const presets = useSettingsStore((s) => s.presets);
  const busy = useSettingsStore((s) => s.busy);
  const saved = useSettingsStore((s) => s.saved);
  const error = useSettingsStore((s) => s.error);
  const load = useSettingsStore((s) => s.load);
  const save = useSettingsStore((s) => s.save);
  const reset = useSettingsStore((s) => s.reset);
  const saveExportPreset = useSettingsStore((s) => s.saveExportPreset);
  const deleteExportPreset = useSettingsStore((s) => s.deleteExportPreset);
  const clearError = useSettingsStore((s) => s.clearError);

  const [draft, setDraft] = useState<Record<string, SettingValue>>({});
  const [presetName, setPresetName] = useState('');

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (settings !== null) setDraft(settings as Record<string, SettingValue>);
  }, [settings]);

  const dirty =
    settings !== null && Object.keys(draft).some((key) => JSON.stringify(draft[key]) !== JSON.stringify((settings as Record<string, SettingValue>)[key]));

  const update = (key: string, value: SettingValue) => setDraft((current) => ({ ...current, [key]: value }));

  const saveAll = async (): Promise<void> => {
    if (settings === null) return;
    const patch: Record<string, SettingValue> = {};
    for (const key of Object.keys(draft)) {
      const next = draft[key];
      if (next !== undefined && JSON.stringify(next) !== JSON.stringify((settings as Record<string, SettingValue>)[key])) patch[key] = next;
    }
    if (Object.keys(patch).length === 0) return;
    await save(patch);
  };

  const renderField = (field: SettingFieldDef): React.JSX.Element => {
    const value = draft[field.key];
    const disabled = busy || value === undefined;
    if (field.kind === 'bool') {
      return (
        <label className="settings-field settings-field--check" key={field.key}>
          <input
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(e) => update(field.key, e.target.checked)}
          />
          <span>
            <span className="settings-field__label">{field.label}</span>
            <span className="field__hint">{field.hint}</span>
          </span>
        </label>
      );
    }
    if (field.kind === 'enum') {
      return (
        <label className="settings-field" key={field.key}>
          <span className="settings-field__label">{field.label}</span>
          <select
            className="input"
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(e) => update(field.key, e.target.value)}
          >
            {(field.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <span className="field__hint">{field.hint}</span>
        </label>
      );
    }
    if (field.kind === 'int') {
      return (
        <label className="settings-field" key={field.key}>
          <span className="settings-field__label">{field.label}</span>
          <span className="settings-field__row">
            <input
              className="input"
              type="number"
              value={typeof value === 'number' ? value : ''}
              min={field.min}
              max={field.max}
              step={field.step ?? 1}
              disabled={disabled}
              onChange={(e) => update(field.key, Number(e.target.value))}
            />
            {field.unit !== undefined && <span className="field__hint">{field.unit}</span>}
            <span className="field__hint">
              范围 {field.min ?? '—'}–{field.max ?? '—'}
            </span>
          </span>
          <span className="field__hint">{field.hint}</span>
        </label>
      );
    }
    return (
      <label className="settings-field" key={field.key}>
        <span className="settings-field__label">{field.label}</span>
        <input
          className="input mono"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => update(field.key, e.target.value)}
        />
        <span className="field__hint">{field.hint}</span>
      </label>
    );
  };

  return (
    <div className="page settings-page">
      <nav className="breadcrumb" aria-label="面包屑">
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => navigate('/sites')}>
          ← 站点
        </button>
        <span className="breadcrumb__sep" aria-hidden="true">
          /
        </span>
        <span>设置</span>
      </nav>

      <header className="page__header">
        <div className="page__title-group">
          <h1>设置</h1>
          <p className="page__subtitle">
            全局默认：礼貌与合规、采集默认值、素材归档、外观。这里改的是**默认值**，单个采集任务仍可在采集页覆盖。
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

      {settings === null ? (
        <div className="skeleton" style={{ height: 240 }} />
      ) : (
        <div className="settings-layout">
          <section className="panel">
            <header className="crawl-panel__head">
              <h2>全局默认</h2>
              <span className="field__hint">{busy ? '保存中…' : dirty ? '有未保存的修改' : saved ? '已保存' : '与服务端一致'}</span>
            </header>

            {SETTING_GROUPS.map((group) => {
              const groupFields = fields.filter((f) => f.group === group.key);
              if (groupFields.length === 0) return null;
              return (
                <div className="settings-group" key={group.key}>
                  <h3 className="settings-group__title">{group.title}</h3>
                  <p className="field__hint">{group.hint}</p>
                  <div className="settings-group__fields">{groupFields.map((field) => renderField(field))}</div>
                </div>
              );
            })}

            <div className="settings-actions">
              <button type="button" className="btn btn--primary" disabled={busy || !dirty} onClick={() => void saveAll()}>
                保存设置
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('把所有设置恢复为默认值？（不会影响已采集的数据）')) void reset();
                }}
              >
                恢复默认
              </button>
              <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void load()}>
                重新读取
              </button>
            </div>
          </section>

          <section className="panel">
            <header className="crawl-panel__head">
              <h2>导出预设（{presets.length}）</h2>
              <span className="field__hint">在导出页一键复用</span>
            </header>

            {presets.length === 0 ? (
              <p className="field__hint">还没有预设。保存一个后，导出页的「导出预设」下拉里就能直接选中。</p>
            ) : (
              <ul className="settings-presets">
                {presets.map((preset) => (
                  <li key={preset.id} className="settings-presets__item">
                    <span className="badge">{preset.payload.format}</span>
                    <span>{preset.name}</span>
                    <span className="field__hint">
                      {preset.payload.scope}
                      {preset.payload.includeDeleted ? ' · 含软删' : ''}
                    </span>
                    {preset.isDefault && <span className="badge badge--muted">默认</span>}
                    <span className="nav__spacer" />
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      disabled={busy}
                      onClick={() => void deleteExportPreset(preset.id)}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="settings-preset-form">
              <label className="field">
                <span>预设名字</span>
                <input
                  className="input"
                  placeholder="例如：CSV 全站给运营"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn"
                disabled={busy || presetName.trim().length === 0}
                onClick={() => {
                  void saveExportPreset({
                    name: presetName.trim(),
                    payload: { format: 'csv', scope: 'site', includeDeleted: false },
                  }).then((ok) => {
                    if (ok) setPresetName('');
                  });
                }}
                title="按当前默认（CSV / 整站 / 不含软删）保存一个预设；更细的格式可在导出页保存"
              >
                保存为预设
              </button>
            </div>

            <h3 className="settings-group__title">环境信息</h3>
            <dl className="kv">
              <div className="kv__item">
                <dt>契约版本</dt>
                <dd className="mono">v1.0</dd>
              </div>
              <div className="kv__item">
                <dt>数据目录</dt>
                <dd className="mono">data/（本机私有，不入库控）</dd>
              </div>
              <div className="kv__item">
                <dt>素材与导出</dt>
                <dd className="mono">{'data/sites/<siteId>/{raw,parsed,exports}'}</dd>
              </div>
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}
