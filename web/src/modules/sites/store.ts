/**
 * 站点模块状态（Zustand）
 *
 * 只持有视图状态与服务端数据快照；不做任何 SQL 或文件访问（web 只走 API）。
 */
import { create } from 'zustand';
import type { CreateSiteResponse, SiteCard } from '@siteatlas/shared';
import { ApiError, sitesApi } from './api.ts';
import type { LoadState } from './types.ts';

export interface SiteFormValues {
  url: string;
  name: string;
  scope: 'same_site' | 'same_domain' | 'allowlist' | 'all';
}

export interface SitesState {
  cards: SiteCard[];
  state: LoadState;
  error: string | null;
  /** 建站请求进行中（含可达性探测，可能持续数秒） */
  submitting: boolean;
  submitError: string | null;
  /** 刚建好的站点，用于成功后跳转/高亮 */
  lastCreated: CreateSiteResponse | null;
  /** 显示回收站（archived=1） */
  showArchived: boolean;
  formOpen: boolean;

  load: () => Promise<void>;
  setShowArchived: (value: boolean) => void;
  setFormOpen: (value: boolean) => void;
  createSite: (values: SiteFormValues) => Promise<CreateSiteResponse | null>;
  deleteSite: (id: string) => Promise<void>;
  restoreSite: (id: string) => Promise<void>;
  clearSubmitError: () => void;
}

export const useSitesStore = create<SitesState>((set, get) => ({
  cards: [],
  state: 'idle',
  error: null,
  submitting: false,
  submitError: null,
  lastCreated: null,
  showArchived: false,
  formOpen: false,

  async load() {
    set({ state: 'loading', error: null });
    try {
      const cards = await sitesApi.list({ archived: get().showArchived });
      set({ cards, state: 'ready' });
    } catch (err) {
      set({ state: 'error', error: err instanceof ApiError ? err.message : String(err) });
    }
  },

  setShowArchived(value) {
    set({ showArchived: value });
    void get().load();
  },

  setFormOpen(value) {
    set({ formOpen: value, submitError: null });
  },

  clearSubmitError() {
    set({ submitError: null });
  },

  async createSite(values) {
    set({ submitting: true, submitError: null });
    try {
      const created = await sitesApi.create({
        url: values.url.trim(),
        ...(values.name.trim().length > 0 ? { name: values.name.trim() } : {}),
        scope: values.scope,
      });
      set({ submitting: false, lastCreated: created, formOpen: false });
      await get().load();
      return created;
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `${err.message}${err.status === 0 ? '' : `（${err.code}）`}`
          : err instanceof Error
            ? err.message
            : String(err);
      set({ submitting: false, submitError: message });
      return null;
    }
  },

  async deleteSite(id) {
    try {
      await sitesApi.remove(id);
      await get().load();
    } catch (err) {
      set({ error: err instanceof ApiError ? err.message : String(err) });
    }
  },

  async restoreSite(id) {
    try {
      await sitesApi.restore(id);
      await get().load();
    } catch (err) {
      set({ error: err instanceof ApiError ? err.message : String(err) });
    }
  },
}));
