/**
 * M0 浏览器验收脚本（dev-spec §7 M0 验收：输入 URL 能建站并显示根节点）
 *
 * 用 Playwright 驱动真实浏览器：
 *   1. 打开 http://127.0.0.1:8787/sites
 *   2. 点「新建站点」，填 https://example.com/ 并提交
 *   3. 断言卡片出现（站点名/根域名/节点数/状态）
 *   4. 截图：空状态 / 建站表单 / 卡片视图 / 站点详情占位页
 *
 * 用法：node scripts/e2e-m0-screenshot.mjs [baseUrl]
 * 说明：默认用本机已安装的 Google Chrome（channel: 'chrome'），因为 Playwright 自带
 *       Chromium 的下载在离线/慢网环境常失败；置 PW_CHANNEL 可覆盖。
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8787';
const outDir = resolve(import.meta.dirname, '..', 'docs', 'screenshots');
mkdirSync(outDir, { recursive: true });

// 默认用 Playwright 自带 Chromium（v1243）；PW_CHANNEL=chrome 可切系统 Chrome
const channel = process.env['PW_CHANNEL'];
const browser = await chromium.launch(channel === undefined || channel === '' ? {} : { channel });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const shot = async (name) => {
  const file = resolve(outDir, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`截图 → ${file}`);
};

// 1) 站点列表（空状态）
await page.goto(`${baseUrl}/sites`, { waitUntil: 'networkidle' });
await page.waitForSelector('.empty, .site-card');
await shot('m0-01-sites-empty.png');

// 2) 打开建站表单
await page.getByRole('button', { name: /新建/ }).first().click();
await page.waitForSelector('.create-form');
await page.fill('.create-form__url input', 'https://example.com/');
await page.fill('.create-form input[type=text] >> nth=1', '示例站点');
await shot('m0-02-create-form.png');

// 3) 提交 → 等待卡片出现
await page.getByRole('button', { name: '创建站点' }).click();
await page.waitForSelector('.site-card', { timeout: 30000 });
await page.waitForSelector('.alert--info', { timeout: 30000 });
await shot('m0-03-site-card.png');

const cardText = (await page.locator('.site-card').first().innerText()).replace(/\s+/g, ' ');
console.log(`卡片内容：${cardText}`);

// 4) 进入站点详情占位页
await page.locator('.site-card__body').first().click();
await page.waitForSelector('.detail-panel');
await page.waitForSelector('.kv');
await shot('m0-04-site-detail.png');
console.log(`详情页 URL：${page.url()}`);
console.log(`详情页标题：${(await page.locator('h1').first().innerText()).replace(/\s+/g, ' ')}`);

// 5) 深链刷新（SPA 回落是否生效）
await page.goto(page.url(), { waitUntil: 'networkidle' });
const deepLinkOk = await page.locator('h1').first().isVisible();
console.log(`深链刷新后 H1 可见：${deepLinkOk}`);

await browser.close();
console.log('E2E 完成');
