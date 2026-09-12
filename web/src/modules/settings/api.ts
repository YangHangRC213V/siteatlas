/**
 * 设置模块 API 客户端（导航「设置」：全局默认 + 导出预设）
 */
import type { AppSettings, ExportPreset, ExportPresetPayload, SettingFieldDef } from '@siteatlas/shared';

export class SettingsApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SettingsApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      // 仅在有 body 时声明 content-type：空 body + JSON 头会被 Fastify 判为 400
      headers: { ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new SettingsApiError(0, 'NETWORK_ERROR', `无法连接服务端：${(err as Error).message}`);
  }
  const text = await res.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new SettingsApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const settingsApi = {
  get(): Promise<{ settings: AppSettings; fields: readonly SettingFieldDef[] }> {
    return request('/api/settings');
  },
  update(settings: Record<string, number | boolean | string | string[]>): Promise<{ settings: AppSettings }> {
    return request('/api/settings', { method: 'PUT', body: JSON.stringify({ settings }) });
  },
  reset(): Promise<{ settings: AppSettings }> {
    return request('/api/settings/reset', { method: 'POST' });
  },
  listExportPresets(): Promise<{ presets: ExportPreset[] }> {
    return request('/api/presets/export');
  },
  createExportPreset(input: { name: string; payload: ExportPresetPayload; isDefault?: boolean }): Promise<{ preset: ExportPreset }> {
    return request('/api/presets/export', { method: 'POST', body: JSON.stringify(input) });
  },
  deleteExportPreset(id: string): Promise<{ deleted: boolean }> {
    return request(`/api/presets/export/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};

/** 设置分组的中文标题与说明（界面标题；分组键来自 SETTING_FIELDS） */
export const SETTING_GROUPS: Array<{ key: SettingFieldDef['group']; title: string; hint: string }> = [
  { key: 'politeness', title: '礼貌与合规', hint: '默认遵守 robots.txt、默认限速 ≥1s/请求（requirements §4.7）' },
  { key: 'defaults', title: '采集默认值', hint: '新建采集任务时的默认参数；单个任务仍可在采集页覆盖' },
  { key: 'materials', title: '素材归档', hint: '三档数据（结构 / 原件 / 解析）的落盘开关（dev-spec §6.7）' },
  { key: 'appearance', title: '外观', hint: '深色模式与动效（requirements §5）' },
];
