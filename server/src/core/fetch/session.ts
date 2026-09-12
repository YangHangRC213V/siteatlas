/**
 * core/fetch/session.ts —— 可驱动的浏览器会话（M3 手动采集的载体）
 *
 * dev-spec §6.5：纯 Web 服务没有桌面窗口，因此手动采集必须「服务端 Chromium + 画面串流 + 输入回传」。
 * 这里把「一个可被远程驱动的页面」抽象成接口：
 *   · 真实实现 `ChromiumPageSession` 用 Playwright + CDP（Page.startScreencast / Input.*）
 *   · 测试用假实现（tests/fake-browser.ts）注入脚本化的帧与导航，避免测试依赖真实浏览器
 * 这样 manual/* 的业务逻辑（点击配对、回根识别、落库）可以完全离线测试。
 */
import type { BrowserLike, PageLike } from './pool.ts';

/** 极简 CDP 会话接口（只声明我们用到的方法，不引 devtools-protocol 类型包） */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: unknown) => void): void;
  off?(event: string, handler: (params: unknown) => void): void;
  detach?(): Promise<void>;
}

export interface NavigateResult {
  url: string;
  ok: boolean;
  error: string | null;
}

export interface PageSessionHandlers {
  /** 画面帧（JPEG base64） */
  onFrame?(frame: { data: string; sessionId: number; width: number; height: number }): void;
  /** 主框架导航完成 */
  onNavigated?(url: string): void;
  /** 页面内注入的点击捕获上报 */
  onCapture?(payload: unknown): void;
  /** 页面崩溃/关闭 */
  onClosed?(reason: string): void;
}

export type MouseEventType = 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
export type KeyEventType = 'keyDown' | 'keyUp' | 'char';

export interface MouseInput {
  type: MouseEventType;
  /** 视口坐标（CSS 像素） */
  x: number;
  y: number;
  button?: 'none' | 'left' | 'middle' | 'right';
  clickCount?: number;
  /** 仅 mouseWheel 使用 */
  deltaX?: number;
  deltaY?: number;
  modifiersBitmask?: number;
}

export interface KeyInput {
  type: KeyEventType;
  key: string;
  code?: string;
  text?: string;
  windowsVirtualKeyCode?: number;
  modifiersBitmask?: number;
}

/** 可驱动的页面会话 */
export interface PageSession {
  readonly id: string;
  readonly viewport: { width: number; height: number };
  /** 当前页面 URL（截至最近一次导航/上报） */
  currentUrl(): string;
  /** 无状态直接导航（§6.2：不使用前进/后退） */
  navigate(url: string, options?: { timeoutMs?: number }): Promise<NavigateResult>;
  /** 注入点击捕获脚本（每次导航后需重注入） */
  injectCapture(script: string): Promise<void>;
  startScreencast(options?: { quality?: number; maxWidth?: number; maxHeight?: number }): Promise<void>;
  stopScreencast(): Promise<void>;
  dispatchMouse(input: MouseInput): Promise<void>;
  /** 读取元素在页面视口中的位置（手动采集端到端验收需要知道"点哪里"） */
  elementBox(selector: string): Promise<{ x: number; y: number; width: number; height: number } | null>;
  dispatchKey(input: KeyInput): Promise<void>;
  screenshot(): Promise<{ data: string; contentType: string }>;
  close(): Promise<void>;
}

/** Playwright 的 page 上我们要用到的 CDP 入口（避免直接依赖具体类型） */
interface PageWithCdp extends PageLike {
  context?: () => { newCDPSession(page: unknown): Promise<CdpSession> };
  on(event: string, handler: (...args: unknown[]) => void): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
  isClosed?(): boolean;
}

const CLICK_CAPTURE_SCRIPT = `
(() => {
  if (window.__siteatlasCaptureInstalled) return 'already';
  window.__siteatlasCaptureInstalled = true;
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 12) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(part + '#' + node.id); break; }
      const cls = (node.getAttribute('class') || '').split(/\\s+/).filter(c => c && c.length < 24).slice(0, 2);
      if (cls.length) part += '.' + cls.join('.');
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter(c => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const domPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const parent = node.parentElement;
      const idx = parent ? [...parent.children].filter(c => c.tagName === node.tagName).indexOf(node) + 1 : 1;
      parts.unshift(node.tagName.toLowerCase() + '[' + idx + ']');
      node = parent;
    }
    return parts.join('/');
  };
  document.addEventListener('click', (event) => {
    const el = event.target;
    if (!el || el.nodeType !== 1) return;
    const anchor = el.closest ? el.closest('a[href]') : null;
    const payload = {
      kind: 'click',
      tag: el.tagName.toLowerCase(),
      anchorText: (el.textContent || '').trim().slice(0, 200),
      selector: cssPath(el),
      domPath: domPath(el),
      href: anchor ? anchor.href : null,
      rel: anchor ? anchor.getAttribute('rel') : null,
      target: anchor ? anchor.getAttribute('target') : null,
      button: event.button,
      ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey,
      x: event.clientX, y: event.clientY,
      at: Date.now(),
    };
    const send = (window.__siteatlasEmit || ((p) => { const b = window.__siteatlasBinding; if (typeof b === 'function') b(JSON.stringify(p)); }));
    send(payload);
    // 也把点击记进页面内队列，便于与「未导航」的情况对账
    (window.__siteatlasClicks = window.__siteatlasClicks || []).push(payload);
  }, true);
  return 'installed';
})();
`;

export interface ChromiumPageSessionOptions {
  id: string;
  page: PageWithCdp;
  viewport: { width: number; height: number };
  /** 注入到页面的 binding 名称（默认 __siteatlasBinding） */
  bindingName?: string;
  /** 页面内上报入口名（默认 __siteatlasEmit），预留给「由注入脚本直接调用」的场景 */
  emitterName?: string;
  handlers?: PageSessionHandlers;
}

/**
 * Playwright + CDP 实现。
 * 画面：`Page.startScreencast`（JPEG 帧）→ 帧事件 → ack（不 ack 只会推一帧）
 * 输入：`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`
 * 点击：`Runtime.addBinding` 注入捕获脚本，页面里调用 binding 上报
 */
export class ChromiumPageSession implements PageSession {
  readonly id: string;
  readonly viewport: { width: number; height: number };
  private readonly page: PageWithCdp;
  private readonly bindingName: string;
  private readonly emitterName: string;
  private readonly handlers: PageSessionHandlers;
  private cdp: CdpSession | null = null;
  private url = 'about:blank';
  private screencasting = false;
  private closed = false;
  private readonly onCdpFrame = (params: unknown): void => {
    // 页面/会话正在关闭时 CDP 仍可能送出一帧：ack 必须以「失败就算了」的方式发，
    // 否则会从事件回调里抛出未捕获的 rejection，把整个进程带崩（验收时真的崩过一次）
    if (this.closed) return;
    const frame = params as { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } };
    void this.cdp?.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
    this.handlers.onFrame?.({
      data: frame.data,
      sessionId: frame.sessionId,
      width: frame.metadata?.deviceWidth ?? this.viewport.width,
      height: frame.metadata?.deviceHeight ?? this.viewport.height,
    });
  };

  constructor(options: ChromiumPageSessionOptions) {
    this.id = options.id;
    this.page = options.page;
    this.viewport = options.viewport;
    this.bindingName = options.bindingName ?? '__siteatlasBinding';
    this.emitterName = options.emitterName ?? '__siteatlasEmit';
    this.handlers = options.handlers ?? {};
  }

  async ready(): Promise<void> {
    const context = this.page.context;
    if (typeof context !== 'function') throw new Error('页面不支持 CDP（未暴露 context().newCDPSession）');
    this.cdp = await context.call(this.page).newCDPSession(this.page);
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    // 点击捕获：把页面里的调用转成绑定回调 → 交给上层
    await this.cdp.send('Runtime.addBinding', { name: this.bindingName });
    this.cdp.on('Runtime.bindingCalled', (params) => {
      const payload = params as { name?: string; payload?: string };
      if (payload.name !== this.bindingName || payload.payload === undefined) return;
      try {
        this.handlers.onCapture?.(JSON.parse(payload.payload));
      } catch {
        this.handlers.onCapture?.({ kind: 'unparsed', raw: payload.payload });
      }
    });
    this.cdp.on('Page.screencastFrame', this.onCdpFrame);
    this.cdp.on('Page.frameNavigated', (params) => {
      const frame = params as { frame?: { url?: string; parentId?: string } };
      if (frame.frame?.parentId !== undefined) return; // 只关心主框架
      if (frame.frame?.url !== undefined) {
        this.url = frame.frame.url;
        this.handlers.onNavigated?.(frame.frame.url);
      }
    });
    this.page.on('load', (...args: unknown[]) => {
      const maybeUrl = typeof args[0] === 'string' ? (args[0] as string) : null;
      if (maybeUrl !== null) this.url = maybeUrl;
      this.handlers.onNavigated?.(maybeUrl ?? this.url);
    });
    this.page.on('crash', () => this.handlers.onClosed?.('页面崩溃'));
    this.page.on('close', () => this.handlers.onClosed?.('页面已关闭'));
  }

  currentUrl(): string {
    return this.url;
  }

  async navigate(url: string, options: { timeoutMs?: number } = {}): Promise<NavigateResult> {
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs ?? 15000 });
      const finalUrl = typeof this.page.url === 'function' ? this.page.url() : url;
      this.url = finalUrl === '' ? url : finalUrl;
      await this.injectCapture(CLICK_CAPTURE_SCRIPT);
      return { url: this.url, ok: true, error: null };
    } catch (err) {
      return { url: this.url, ok: false, error: (err as Error).message.split('\n')[0] ?? '导航失败' };
    }
  }

  /** 统一包装：会话已关闭/页面已销毁时的 CDP 失败不该变成未捕获异常 */
  private async safeSend(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.cdp === null || this.closed) return null;
    try {
      return await this.cdp.send(method, params);
    } catch (err) {
      if (this.closed) return null;
      throw err;
    }
  }

  async injectCapture(script: string): Promise<void> {
    if (this.cdp === null) return;
    // 页面内提供 emitter 出口，注入脚本既可调用 binding 也可调用它
    await this.safeSend('Runtime.evaluate', {
      expression: `window.${this.emitterName} = (p) => window.${this.bindingName}(typeof p === 'string' ? p : JSON.stringify(p));`,
    });
    await this.safeSend('Runtime.evaluate', { expression: script });
  }

  async startScreencast(options: { quality?: number; maxWidth?: number; maxHeight?: number } = {}): Promise<void> {
    if (this.cdp === null) throw new Error('会话未就绪');
    if (this.screencasting) return;
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: options.quality ?? 60,
      maxWidth: options.maxWidth ?? this.viewport.width,
      maxHeight: options.maxHeight ?? this.viewport.height,
      everyNthFrame: 1,
    });
    this.screencasting = true;
  }

  async stopScreencast(): Promise<void> {
    if (this.cdp === null || !this.screencasting) return;
    await this.cdp.send('Page.stopScreencast');
    this.screencasting = false;
  }

  async elementBox(selector: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
    if (this.cdp === null) return null;
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
    })()`;
    const result = (await this.safeSend('Runtime.evaluate', { expression, returnByValue: true })) as {
      result?: { value?: unknown };
    };
    const value = result.result?.value;
    if (value === null || typeof value !== 'object') return null;
    const box = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    if (typeof box.x !== 'number' || typeof box.y !== 'number') return null;
    return {
      x: box.x,
      y: box.y,
      width: typeof box.width === 'number' ? box.width : 0,
      height: typeof box.height === 'number' ? box.height : 0,
    };
  }

  async dispatchMouse(input: MouseInput): Promise<void> {
    if (this.cdp === null) return;
    const params: Record<string, unknown> = {
      type: input.type,
      x: input.x,
      y: input.y,
      button: input.button ?? 'left',
      clickCount: input.clickCount ?? (input.type === 'mouseMoved' ? 0 : 1),
      modifiers: input.modifiersBitmask ?? 0,
    };
    if (input.type === 'mouseWheel') {
      params['deltaX'] = input.deltaX ?? 0;
      params['deltaY'] = input.deltaY ?? 0;
    }
    if (input.type === 'mouseMoved') {
      params['button'] = 'none';
      params['buttons'] = 0;
    } else if (input.type === 'mousePressed') {
      params['buttons'] = 1;
    }
    await this.safeSend('Input.dispatchMouseEvent', params);
  }

  async dispatchKey(input: KeyInput): Promise<void> {
    if (this.cdp === null) return;
    const type = input.type === 'char' ? 'char' : input.type === 'keyUp' ? 'keyUp' : 'keyDown';
    await this.safeSend('Input.dispatchKeyEvent', {
      type,
      key: input.key,
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.windowsVirtualKeyCode !== undefined ? { windowsVirtualKeyCode: input.windowsVirtualKeyCode } : {}),
      ...(input.modifiersBitmask !== undefined ? { modifiers: input.modifiersBitmask } : {}),
    });
  }

  async screenshot(): Promise<{ data: string; contentType: string }> {
    if (this.cdp !== null) {
      const result = (await this.safeSend('Page.captureScreenshot', { format: 'jpeg', quality: 70 })) as { data?: string };
      if (typeof result.data === 'string') return { data: result.data, contentType: 'image/jpeg' };
    }
    return { data: '', contentType: 'image/jpeg' };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stopScreencast().catch(() => undefined);
    await this.page.close().catch(() => undefined);
    await this.cdp?.detach?.().catch(() => undefined);
    this.cdp = null;
  }
}

export { CLICK_CAPTURE_SCRIPT };

/** 打开一个真实浏览器页面会话（浏览器不可用时抛错，由上层转成 503） */
export async function openChromiumSession(options: {
  id: string;
  browser: BrowserLike;
  viewport: { width: number; height: number };
  handlers?: PageSessionHandlers;
}): Promise<ChromiumPageSession> {
  const page = (await options.browser.newPage()) as PageWithCdp;
  const session = new ChromiumPageSession({
    id: options.id,
    page,
    viewport: options.viewport,
    ...(options.handlers !== undefined ? { handlers: options.handlers } : {}),
  });
  await session.ready();
  return session;
}
