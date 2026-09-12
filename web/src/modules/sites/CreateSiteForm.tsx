/**
 * 建站表单（requirements §4.1：输入 URL → 校验可达性/协议/是否 HTML → 创建 Site，当前页即根节点）
 * 按钮层级按 requirements §5：primary 每区域 1 个。
 */
import { useState } from 'react';
import type { SiteFormValues } from './store.ts';
import { SCOPE_LABELS } from './types.ts';
import './sites.css';

export interface CreateSiteFormProps {
  submitting: boolean;
  error: string | null;
  onSubmit: (values: SiteFormValues) => void;
  onCancel: () => void;
}

const EMPTY: SiteFormValues = { url: '', name: '', scope: 'same_site' };

export function CreateSiteForm({ submitting, error, onSubmit, onCancel }: CreateSiteFormProps): React.JSX.Element {
  const [values, setValues] = useState<SiteFormValues>(EMPTY);
  const [touched, setTouched] = useState(false);

  const urlEmpty = values.url.trim().length === 0;

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (urlEmpty || submitting) return;
    onSubmit(values);
  };

  return (
    <form className="panel create-form" onSubmit={submit} aria-label="新建站点">
      <div className="create-form__grid">
        <label className="field create-form__url">
          <span className="field__label">入口 URL（当前页即根节点，depth=0）</span>
          <input
            className="input"
            type="text"
            inputMode="url"
            autoFocus
            placeholder="https://example.com/docs"
            value={values.url}
            disabled={submitting}
            onChange={(e) => setValues({ ...values, url: e.target.value })}
            aria-invalid={touched && urlEmpty}
          />
          <span className="field__hint">
            校验协议（仅 http/https）、可达性与是否 HTML；同一资源的不同跟踪参数会归一为同一节点。
          </span>
        </label>

        <label className="field">
          <span className="field__label">站点名（可选）</span>
          <input
            className="input"
            type="text"
            placeholder="留空则取根域名"
            value={values.name}
            disabled={submitting}
            onChange={(e) => setValues({ ...values, name: e.target.value })}
          />
        </label>

        <label className="field">
          <span className="field__label">抓取范围</span>
          <select
            className="select"
            value={values.scope}
            disabled={submitting}
            onChange={(e) => setValues({ ...values, scope: e.target.value as SiteFormValues['scope'] })}
          >
            {Object.entries(SCOPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error !== null ? (
        <div className="alert alert--error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="create-form__actions">
        <span className="field__hint">
          {submitting ? '正在校验可达性与 HTML 类型…' : '提交后会立即探测目标站点（超时 5s）'}
        </span>
        <div className="create-form__buttons">
          <button type="button" className="btn" onClick={onCancel} disabled={submitting}>
            取消
          </button>
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? '建站中…' : '创建站点'}
          </button>
        </div>
      </div>
    </form>
  );
}
