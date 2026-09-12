/**
 * 设置模块状态：全局设置（唯一表单来源 = SETTING_FIELDS）+ 导出预设
 *
 * 表单不是手写的：字段、标签、范围、单位都来自服务端返回的 SETTING_FIELDS，
 * 加一个设置项只需要改 shared/schema.ts 一处（避免界面与后端各写一遍默认值）。
 */
import { create } from 'zustand';
import type { AppSettings, ExportPreset, ExportPresetPayload, SettingFieldDef } from '@siteatlas/shared';
import { SettingsApiError, settingsApi } from './api.ts';
import { applyMotion, applyTheme } from './theme.ts';

interface SettingsState {
  settings: AppSettings | null;
  fields: readonly SettingFieldDef[];
  presets: ExportPreset[];
  busy: boolean;
  saved: boolean;
  error: string | null;

  load(): Promise<void>;
  save(patch: Record<string, number | boolean | string | string[]>): Promise<boolean>;
  reset(): Promise<void>;
  saveExportPreset(input: { name: string; payload: ExportPresetPayload; isDefault?: boolean }): Promise<boolean>;
  deleteExportPreset(id: string): Promise<boolean>;
  clearError(): void;
}

function messageOf(err: unknown): string {
  if (err instanceof SettingsApiError) return `${err.message}（${err.code}）`;
  return String(err);
}

/** 外观项保存后立即作用到 DOM（不让用户为了看效果刷新页面） */
function applyAppearance(settings: AppSettings | null): void {
  if (settings === null) return;
  if (typeof settings['theme'] === 'string') applyTheme(settings['theme']);
  applyMotion(settings['reduceMotion'] !== true);
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: null,
  fields: [],
  presets: [],
  busy: false,
  saved: false,
  error: null,

  async load() {
    set({ busy: true });
    try {
      const [payload, presetList] = await Promise.all([settingsApi.get(), settingsApi.listExportPresets()]);
      set({ busy: false, settings: payload.settings, fields: payload.fields, presets: presetList.presets, error: null });
      applyAppearance(payload.settings);
    } catch (err) {
      set({ busy: false, error: messageOf(err) });
    }
  },

  async save(patch) {
    set({ busy: true, saved: false, error: null });
    try {
      const { settings } = await settingsApi.update(patch);
      set({ busy: false, settings, saved: true });
      applyAppearance(settings);
      return true;
    } catch (err) {
      set({ busy: false, error: messageOf(err) });
      return false;
    }
  },

  async reset() {
    set({ busy: true, saved: false, error: null });
    try {
      const { settings } = await settingsApi.reset();
      set({ busy: false, settings, saved: true });
      applyAppearance(settings);
    } catch (err) {
      set({ busy: false, error: messageOf(err) });
    }
  },

  async saveExportPreset(input) {
    set({ busy: true, error: null });
    try {
      await settingsApi.createExportPreset(input);
      const { presets } = await settingsApi.listExportPresets();
      set({ busy: false, presets });
      return true;
    } catch (err) {
      set({ busy: false, error: messageOf(err) });
      return false;
    }
  },

  async deleteExportPreset(id) {
    set({ busy: true, error: null });
    try {
      await settingsApi.deleteExportPreset(id);
      const { presets } = await settingsApi.listExportPresets();
      set({ busy: false, presets });
      return true;
    } catch (err) {
      set({ busy: false, error: messageOf(err) });
      return false;
    }
  },

  clearError() {
    set({ error: null });
  },
}));
