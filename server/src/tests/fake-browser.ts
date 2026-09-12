/**
 * tests/fake-browser.ts —— 可脚本化的假页面会话（M3 测试用）
 *
 * 手动采集的核心逻辑（点击配对、回根识别、落库）不应该依赖真实 Chromium：
 * 这里给一个「按脚本说话」的假会话 —— 可以主动推帧、报告导航、上报点击，
 * 并记录所有回传的输入事件，供断言检查。
 */
import type { KeyInput, MouseInput, NavigateResult, PageSession, PageSessionHandlers } from '../core/fetch/session.ts';

export interface FakePageSessionOptions {
  id?: string;
  viewport?: { width: number; height: number };
  handlers?: PageSessionHandlers;
  /** 页面内点击的时间戳来源（默认 Date.now；测试用假时钟时必须一起注入） */
  now?: () => number;
  /** 导航失败清单（URL → 错误信息） */
  failures?: Record<string, string>;
  /** 每次导航后的实际 URL（用于模拟重定向），默认等于请求 URL */
  redirects?: Record<string, string>;
}

export class FakePageSession implements PageSession {
  readonly id: string;
  readonly viewport: { width: number; height: number };
  /** 回传的所有输入事件（断言用） */
  readonly mouseEvents: MouseInput[] = [];
  readonly keyEvents: KeyInput[] = [];
  readonly navigationHistory: string[] = [];
  readonly injectedScripts: string[] = [];
  screencastStarted = false;
  closed = false;

  private readonly handlers: PageSessionHandlers;
  private readonly failures: Record<string, string>;
  private readonly redirects: Record<string, string>;
  private readonly now: () => number;
  private currentUrlValue = 'about:blank';

  constructor(options: FakePageSessionOptions = {}) {
    this.id = options.id ?? 'fake-session';
    this.viewport = options.viewport ?? { width: 1280, height: 800 };
    this.handlers = options.handlers ?? {};
    this.failures = options.failures ?? {};
    this.redirects = options.redirects ?? {};
    this.now = options.now ?? (() => Date.now());
  }

  currentUrl(): string {
    return this.currentUrlValue;
  }

  async navigate(url: string): Promise<NavigateResult> {
    this.navigationHistory.push(url);
    const failure = this.failures[url];
    if (failure !== undefined) {
      this.handlers.onNavigated?.(this.currentUrlValue);
      return { url, ok: false, error: failure };
    }
    const finalUrl = this.redirects[url] ?? url;
    this.currentUrlValue = finalUrl;
    await this.injectCapture('');
    this.handlers.onNavigated?.(finalUrl);
    return { url: finalUrl, ok: true, error: null };
  }

  async injectCapture(script: string): Promise<void> {
    this.injectedScripts.push(script);
  }

  async startScreencast(): Promise<void> {
    this.screencastStarted = true;
  }

  async stopScreencast(): Promise<void> {
    this.screencastStarted = false;
  }

  async dispatchMouse(input: MouseInput): Promise<void> {
    this.mouseEvents.push(input);
  }

  async dispatchKey(input: KeyInput): Promise<void> {
    this.keyEvents.push(input);
  }

  async screenshot(): Promise<{ data: string; contentType: string }> {
    return { data: Buffer.from('fake-jpeg').toString('base64'), contentType: 'image/jpeg' };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.onClosed?.('fake closed');
  }

  /* -------- 测试驱动入口 -------- */

  /** 推一帧画面（模拟 CDP screencast） */
  pushFrame(data = 'ZmFrZQ==', size: { width: number; height: number } = this.viewport): void {
    this.handlers.onFrame?.({ data, width: size.width, height: size.height, sessionId: 1 });
  }

  /** 上报一次点击（模拟页面内注入脚本调用 binding） */
  pushClick(payload: Record<string, unknown>): void {
    this.handlers.onCapture?.({
      kind: 'click',
      tag: 'a',
      anchorText: '链接',
      selector: 'a',
      domPath: 'body[1]/a[1]',
      href: null,
      rel: null,
      target: null,
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      x: 0,
      y: 0,
      at: this.now(),
      ...payload,
    });
  }

  /** 报告一次导航（模拟真实跳转，不含点击配对信息） */
  pushNavigation(url: string): void {
    this.currentUrlValue = url;
    this.handlers.onNavigated?.(url);
  }
}
