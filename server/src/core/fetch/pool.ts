/**
 * core/fetch/pool.ts —— Playwright 浏览器池（dev-spec §3 / §2「自动渲染 + 手动采集共用；浏览器池」）
 *
 * M1 只服务自动渲染回落；M3 手动采集复用同一池（届时加 context 级隔离）。
 * 浏览器不可用时（未安装）不抛异常，返回 available=false，调用方按静态结果降级。
 */
export interface BrowserLauncher {
  launch(options: { channel?: string; headless: boolean }): Promise<BrowserLike>;
}

export interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  version(): string;
  isConnected(): boolean;
}

export interface PageLike {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  url(): string;
  close(): Promise<void>;
  setDefaultTimeout?(ms: number): void;
}

export interface BrowserPoolOptions {
  /** 优先使用的浏览器通道（'chrome' 用系统 Chrome；缺省用 Playwright 自带 Chromium） */
  channel?: string;
  headless?: boolean;
  launcher?: BrowserLauncher;
}

export class BrowserPool {
  private readonly options: BrowserPoolOptions;
  private browser: BrowserLike | null = null;
  private launching: Promise<BrowserLike | null> | null = null;
  private lastError: string | null = null;

  constructor(options: BrowserPoolOptions = {}) {
    this.options = options;
  }

  get lastLaunchError(): string | null {
    return this.lastError;
  }

  async available(): Promise<boolean> {
    return (await this.acquire()) !== null;
  }

  /** 惰性启动浏览器；失败返回 null 并记录原因（不抛） */
  async acquire(): Promise<BrowserLike | null> {
    if (this.browser !== null && this.browser.isConnected()) return this.browser;
    if (this.launching !== null) return await this.launching;

    this.launching = (async (): Promise<BrowserLike | null> => {
      const candidates: Array<string | undefined> =
        this.options.channel !== undefined
          ? [this.options.channel]
          : // 本机 Playwright 自带 Chromium 常因下载失败而缺失，退一步试系统 Chrome
            [undefined, 'chrome'];
      for (const channel of candidates) {
        try {
          const launcher = await this.resolveLauncher();
          const browser = await launcher.launch({
            ...(channel !== undefined ? { channel } : {}),
            headless: this.options.headless ?? true,
          });
          this.browser = browser;
          this.lastError = null;
          return browser;
        } catch (err) {
          this.lastError = `${channel ?? 'chromium'}: ${(err as Error).message.split('\n')[0]}`;
        }
      }
      this.browser = null;
      return null;
    })();

    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private async resolveLauncher(): Promise<BrowserLauncher> {
    if (this.options.launcher !== undefined) return this.options.launcher;
    const mod = (await import('playwright')) as unknown as { chromium: BrowserLauncher };
    return mod.chromium;
  }

  /**
   * 渲染一个页面并返回最终 HTML。失败返回 error 字符串。
   * 每个 URL 用独立 context（无状态直接导航，§6.2），无浏览器时抛错由调用方降级。
   */
  async render(url: string, timeoutMs: number): Promise<{ html: string; finalUrl: string } | { error: string }> {
    const browser = await this.acquire();
    if (browser === null) return { error: `浏览器不可用（${this.lastError ?? '未安装'}）` };
    let page: PageLike | null = null;
    try {
      page = await browser.newPage();
      page.setDefaultTimeout?.(timeoutMs);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      // 给 SPA 一点水合时间；页面无网络活动则立即返回
      await new Promise((r) => setTimeout(r, 300));
      const html = await page.content();
      return { html, finalUrl: page.url() };
    } catch (err) {
      return { error: (err as Error).message.split('\n')[0] ?? '渲染失败' };
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (browser !== null) await browser.close().catch(() => undefined);
  }
}
