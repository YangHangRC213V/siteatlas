/**
 * 导出模块状态（M4）
 *
 * 与其它模块一致：只用 zustand，不引入数据请求库。
 * 导出是同步完成的（POST 返回即 done），因此没有轮询逻辑 —— 只在需要时重新拉列表。
 */
import { create } from 'zustand';
import type { ExportFormat, ExportManifest, ExportRecord, ExportScope, MaterialRecord } from '@siteatlas/shared';
import { ExportApiError, exportApi, type ExportFileEntry } from './api.ts';

interface ExportState {
  siteId: string | null;
  exports: ExportRecord[];
  materials: MaterialRecord[];
  selectedId: string | null;
  selectedManifest: ExportManifest | null;
  selectedFiles: ExportFileEntry[];
  busy: boolean;
  error: string | null;

  bind(siteId: string): Promise<void>;
  unbind(): void;
  refresh(): Promise<void>;
  run(input: { format: ExportFormat; scope: ExportScope; nodeId?: string; includeDeleted?: boolean }): Promise<void>;
  select(exportId: string): Promise<void>;
  clearError(): void;
}

function messageOf(err: unknown): string {
  if (err instanceof ExportApiError) return `${err.message}（${err.code}）`;
  return String(err);
}

export const useExportStore = create<ExportState>()((set, get) => ({
  siteId: null,
  exports: [],
  materials: [],
  selectedId: null,
  selectedManifest: null,
  selectedFiles: [],
  busy: false,
  error: null,

  async bind(siteId) {
    set({ siteId, exports: [], materials: [], selectedId: null, selectedManifest: null, selectedFiles: [], error: null });
    await get().refresh();
  },

  unbind() {
    set({ siteId: null, exports: [], materials: [], selectedId: null, selectedManifest: null, selectedFiles: [], busy: false, error: null });
  },

  async refresh() {
    const siteId = get().siteId;
    if (siteId === null) return;
    set({ busy: true });
    try {
      const [list, mats] = await Promise.all([exportApi.list(siteId), exportApi.materials(siteId, {})]);
      set({ busy: false, exports: list.exports, materials: mats.materials, error: null });
      const selected = get().selectedId;
      if (selected !== null && !list.exports.some((e) => e.id === selected)) {
        set({ selectedId: null, selectedManifest: null, selectedFiles: [] });
      }
    } catch (err) {
      set({ busy: false, error: messageOf(err) });
    }
  },

  async run(input) {
    const siteId = get().siteId;
    if (siteId === null) return;
    set({ busy: true, error: null });
    try {
      const outcome = await exportApi.run(siteId, {
        format: input.format,
        scope: input.scope,
        ...(input.nodeId !== undefined && input.nodeId.length > 0 ? { nodeId: input.nodeId } : {}),
      });
      set({
        busy: false,
        selectedId: outcome.export.id,
        selectedManifest: outcome.manifest,
        selectedFiles: [],
      });
      await get().refresh();
      await get().select(outcome.export.id);
    } catch (err) {
      set({ busy: false, error: messageOf(err) });
    }
  },

  async select(exportId) {
    set({ busy: true, selectedId: exportId });
    try {
      const [detail, files] = await Promise.all([exportApi.status(exportId), exportApi.files(exportId)]);
      set({ busy: false, selectedManifest: detail.manifest, selectedFiles: files.files, error: null });
    } catch (err) {
      set({ busy: false, error: messageOf(err) });
    }
  },

  clearError() {
    set({ error: null });
  },
}));
