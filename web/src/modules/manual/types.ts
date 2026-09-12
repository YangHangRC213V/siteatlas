/**
 * 手动采集模块类型：直接复用 shared 契约（界面不重复定义后端 DTO）
 */
export type {
  ManualSessionState,
  ManualIdentity,
  ManualClickStats,
  ManualScreencastStats,
  ManualProgressMode,
  ManualSessionStatus,
  ClickCapturePayload,
  PendingConfirm,
  ManualEventRecord,
} from '@siteatlas/shared';

export { MANUAL_STATUSES } from '@siteatlas/shared';

/** 界面状态里额外维护的「事件日志」行内视图模型 */
export interface ManualLogLine {
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export const MANUAL_STATUS_LABELS: Record<string, string> = {
  idle: '未开始',
  running: '采集中',
  paused: '已暂停',
  ended: '已结束',
};
