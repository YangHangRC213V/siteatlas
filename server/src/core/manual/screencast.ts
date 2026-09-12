/**
 * manual/screencast.ts —— 画面串流（dev-spec §6.5）
 *
 * `Page.startScreencast` 的 JPEG 帧经服务端 WebSocket 推到前端 <canvas>。
 * 这里只做三件事，避免把会话状态搅在一起：
 *   1. 帧节流（默认 12fps）：CDP 可能推得比前端能画得更快；
 *   2. 只保留最新帧（画布只需要最新画面，中间帧丢弃是正确行为）；
 *   3. 统计（帧数/丢弃数/最近一帧大小），供状态栏与排障使用。
 */
export interface ScreencastFrame {
  data: string;
  width: number;
  height: number;
  /** 服务端收到该帧的时间 */
  at: number;
}

export interface ScreencastStats {
  received: number;
  delivered: number;
  dropped: number;
  lastFrameAt: number | null;
  lastFrameBytes: number;
}

export interface ScreencastOptions {
  /** 每秒最多向前端推多少帧 */
  maxFps?: number;
  now?: () => number;
}

export class ScreencastPump {
  private readonly maxFps: number;
  private readonly now: () => number;
  /** 负无穷 = 还没投递过任何帧（这样假时钟从 0 开始也能投出首帧） */
  private lastDeliveredAt = Number.NEGATIVE_INFINITY;
  private pendingFrame: ScreencastFrame | null = null;
  private received = 0;
  private delivered = 0;
  private dropped = 0;
  private lastFrameAt: number | null = null;
  private lastFrameBytes = 0;

  constructor(options: ScreencastOptions = {}) {
    this.maxFps = Math.max(1, options.maxFps ?? 12);
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 收帧。返回「是否应当立刻投递」，投递内容由 takeLatest() 取。
   * 调用方（会话）在允许投递时把 frame 推给 WS。
   */
  accept(frame: { data: string; width: number; height: number }): ScreencastFrame | null {
    const now = this.now();
    this.received += 1;
    const next: ScreencastFrame = { data: frame.data, width: frame.width, height: frame.height, at: now };
    this.lastFrameAt = now;
    this.lastFrameBytes = frame.data.length;

    const minInterval = 1000 / this.maxFps;
    if (now - this.lastDeliveredAt < minInterval) {
      // 节流窗口内：只留最新帧（画布不需要中间帧），由 flushFrame 取走
      if (this.pendingFrame !== null) this.dropped += 1;
      this.pendingFrame = next;
      return null;
    }
    // 窗口外：直接投递这一帧；若此前压着待投递帧，它被这一帧取代
    if (this.pendingFrame !== null) this.dropped += 1;
    this.pendingFrame = null;
    this.lastDeliveredAt = now;
    this.delivered += 1;
    return next;
  }

  /** 取当前待投递的最新帧（节流窗口结束后由定时器调用） */
  takeLatest(): ScreencastFrame | null {
    const frame = this.pendingFrame;
    if (frame === null) return null;
    this.pendingFrame = null;
    this.lastDeliveredAt = this.now();
    this.delivered += 1;
    return frame;
  }

  get hasPending(): boolean {
    return this.pendingFrame !== null;
  }

  stats(): ScreencastStats {
    return {
      received: this.received,
      delivered: this.delivered,
      dropped: this.dropped,
      lastFrameAt: this.lastFrameAt,
      lastFrameBytes: this.lastFrameBytes,
    };
  }

  reset(): void {
    this.pendingFrame = null;
    this.lastDeliveredAt = Number.NEGATIVE_INFINITY;
  }
}
