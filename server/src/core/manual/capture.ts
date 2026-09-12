/**
 * manual/capture.ts —— 点击捕获与「点击 ↔ 导航」配对（dev-spec §6.5）
 *
 * 页面里注入的脚本会在捕获阶段上报被点元素的 selector / dom_path / anchor_text / href；
 * 服务端拿到上报后并不能立刻建边 —— 必须等一小段「配对窗口」，看是否紧随其后发生导航：
 *   · 窗口内发生导航 → 这条 Edge 的 to 是导航目标（真实跳转）
 *   · 窗口内没有导航 → 该点击是页内锚点 / JS 行为 / 新标签，单独标记，不污染树
 */
import type { EdgeSource } from '@siteatlas/shared';

export interface ClickCapturePayload {
  kind: 'click';
  tag: string;
  anchorText: string;
  selector: string;
  domPath: string;
  href: string | null;
  rel: string | null;
  target: string | null;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  x: number;
  y: number;
  at: number;
}

export type ClickOutcome =
  /** 与随后的导航配对成功（真实跳转） */
  | 'paired'
  /** 窗口内没有导航：页内锚点 / JS 行为 / 新标签 / 下载 */
  | 'unpaired'
  /** 上报格式不对 */
  | 'invalid';

export interface PendingClick {
  id: string;
  payload: ClickCapturePayload;
  fromNodeId: string;
  fromUrl: string;
  /** 该点击发生时的页面深度，用于给新建节点定 depth */
  fromDepth: number;
  /** 同页序号（orderInPage） */
  orderInPage: number;
  receivedAt: number;
  /** 配对截止时间 */
  expiresAt: number;
}

export interface PendingQueueStats {
  pending: number;
  paired: number;
  unpaired: number;
}

/** 解析页面上报的原始 JSON（容错：字段缺失/类型不对都归一化） */
export function parseCapture(raw: unknown): ClickCapturePayload | null {
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (record['kind'] !== 'click') return null;
  const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
  const bool = (value: unknown): boolean => value === true;
  const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  return {
    kind: 'click',
    tag: str(record['tag'], 'unknown'),
    anchorText: str(record['anchorText']),
    selector: str(record['selector']),
    domPath: str(record['domPath']),
    href: typeof record['href'] === 'string' ? record['href'] : null,
    rel: typeof record['rel'] === 'string' ? record['rel'] : null,
    target: typeof record['target'] === 'string' ? record['target'] : null,
    button: num(record['button']),
    ctrlKey: bool(record['ctrlKey']),
    metaKey: bool(record['metaKey']),
    shiftKey: bool(record['shiftKey']),
    altKey: bool(record['altKey']),
    x: num(record['x']),
    y: num(record['y']),
    at: num(record['at'], Date.now()),
  };
}

/** 该点击是否「不可能/不该被当成跳转」：新标签、下载、无 href */
export function isNonNavigatingClick(payload: ClickCapturePayload): boolean {
  if (payload.target !== null && payload.target.toLowerCase() === '_blank') return true;
  if (payload.ctrlKey || payload.metaKey || payload.shiftKey) return true; // 新窗口/新标签习惯键
  if (payload.tag === 'button' || payload.tag === 'input') return true;
  return false;
}

export interface PendingClickQueueOptions {
  /** 点击与导航的配对窗口（ms） */
  pairingWindowMs?: number;
  now?: () => number;
  makeId?: () => string;
}

/**
 * 待配对点击队列：FIFO，过期后落到「待确认」。
 * 只保留最近若干条，防止用户狂点时无限增长。
 */
export class PendingClickQueue {
  private readonly items: PendingClick[] = [];
  private readonly pairingWindowMs: number;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private pairedCount = 0;
  private unpairedCount = 0;
  private orderCounter = 0;
  private readonly maxItems: number;

  constructor(options: PendingClickQueueOptions & { maxItems?: number } = {}) {
    this.pairingWindowMs = options.pairingWindowMs ?? 4000;
    this.now = options.now ?? (() => Date.now());
    this.makeId = options.makeId ?? (() => `c${this.orderCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    this.maxItems = options.maxItems ?? 200;
  }

  /** 记录一次点击（返回排队项）；页面身份与深度由会话提供 */
  push(input: { payload: ClickCapturePayload; fromNodeId: string; fromUrl: string; fromDepth: number }): PendingClick {
    const now = this.now();
    this.orderCounter += 1;
    const item: PendingClick = {
      id: this.makeId(),
      payload: input.payload,
      fromNodeId: input.fromNodeId,
      fromUrl: input.fromUrl,
      fromDepth: input.fromDepth,
      orderInPage: this.orderCounter,
      receivedAt: now,
      expiresAt: now + this.pairingWindowMs,
    };
    this.items.push(item);
    while (this.items.length > this.maxItems) {
      this.items.shift();
      this.unpairedCount += 1;
    }
    return item;
  }

  /** 导航发生后取走「最可能与本次导航配对」的点击（最早的、尚未过期的） */
  takeForNavigation(at: number = this.now()): PendingClick | null {
    this.sweep(at);
    const candidate = this.items.shift();
    if (candidate === undefined) return null;
    // 新标签/下载类点击不该被算作导航来源：跳过它继续找
    while (isNonNavigatingClick(candidate.payload)) {
      this.unpairedCount += 1;
      const next = this.items.shift();
      if (next === undefined) return null;
      return this.takeFrom(next, at);
    }
    this.pairedCount += 1;
    return candidate;
  }

  private takeFrom(item: PendingClick, at: number): PendingClick | null {
    if (item.expiresAt < at) {
      this.unpairedCount += 1;
      return null;
    }
    this.pairedCount += 1;
    return item;
  }

  /** 把已过期的点击挪出队列（记为未配对） */
  sweep(at: number = this.now()): PendingClick[] {
    const expired: PendingClick[] = [];
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i] as PendingClick;
      if (item.expiresAt < at) {
        this.items.splice(i, 1);
        expired.push(item);
        this.unpairedCount += 1;
      }
    }
    return expired;
  }

  get pending(): PendingClick[] {
    return [...this.items];
  }

  stats(): PendingQueueStats {
    this.sweep();
    return { pending: this.items.length, paired: this.pairedCount, unpaired: this.unpairedCount };
  }
}

/** 边的来源标记：手动采集写入的边 source='manual'（§4 edges.source） */
export const MANUAL_EDGE_SOURCE: EdgeSource = 'manual';
