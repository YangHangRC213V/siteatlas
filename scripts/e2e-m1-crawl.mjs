/**
 * M1 端到端验收脚本（dev-spec §7 M1）
 *
 * 流程（对本地演示站 scripts/demo-site.mjs，不依赖外网）：
 *   1. 建站 → 2. 订阅 /ws/sites/:id → 3. 启动自动采集 → 4. 收集 WS 进度消息
 *   → 5. 轮询到任务结束 → 6. 逐层懒加载树并打印 → 7. 自检：无重复节点 / 护栏生效
 *   → 8. 截图：采集控制台（运行中 + 完成）、树视图、节点属性抽屉
 *
 * 用法：node scripts/e2e-m1-crawl.mjs [baseUrl] [demoOrigin]
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8787';
const demoOrigin = process.argv[3] ?? 'http://127.0.0.1:8899';
const outDir = resolve(import.meta.dirname, '..', 'docs', 'screenshots');
mkdirSync(outDir, { recursive: true });

const api = async (path, init) => {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    // 只有带 body 时才声明 content-type：Fastify 对「声明 JSON 但 body 为空」的请求返回 400
    headers: { ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${text}`);
  return body;
};

// 0) 同名根 URL 的旧站点先软删（重复建站会被 409 拒绝，属预期行为）
const existing = await api('/api/sites?includeArchived=1');
for (const card of existing.sites) {
  if (card.site.root_url === `${demoOrigin}/` && card.site.archived === 0) {
    await api(`/api/sites/${card.site.id}`, { method: 'DELETE' });
    console.log(`已软删旧站点 ${card.site.id}（${card.site.name}）`);
  }
}

// 1) 建站
const siteName = `M1 验收站 ${new Date().toISOString().slice(11, 19)}`;
const created = await api('/api/sites', { method: 'POST', body: JSON.stringify({ url: `${demoOrigin}/`, name: siteName }) });
const siteId = created.site.id;
console.log(`建站：${siteId}（${created.site.name}）根节点 ${created.root.status}`);

// 2) 订阅进度（先订阅再启动，确保能收到完整进度流）
const wsMessages = [];
const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/sites/${siteId}`);
socket.on('message', (data) => wsMessages.push(JSON.parse(String(data))));
await new Promise((resolve_, reject) => {
  socket.on('open', resolve_);
  socket.on('error', reject);
});

// 3) 启动采集
const started = await api(`/api/sites/${siteId}/crawl`, {
  method: 'POST',
  body: JSON.stringify({
    preset: {
      maxDepth: 4,
      maxPages: 50,
      concurrency: 3,
      perHostConcurrency: 2,
      minDelayMs: 250,
      jitterMs: 50,
      renderMode: 'auto',
      respectRobots: true,
    },
  }),
});
console.log(`任务启动：${started.task.id}`);

// 4) 浏览器：打开采集控制台，截「运行中」画面
// 默认用 Playwright 自带 Chromium（v1243）；PW_CHANNEL=chrome 可切系统 Chrome
const channel = process.env['PW_CHANNEL'];
const browser = await chromium.launch(channel === undefined || channel === '' ? {} : { channel });
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
await page.goto(`${baseUrl}/sites/${siteId}/crawl`, { waitUntil: 'networkidle' });
await page.waitForSelector('.crawl-metrics');
await page.waitForFunction(() => document.querySelector('.metric__value')?.textContent !== '0', null, { timeout: 20000 });
const runningShot = resolve(outDir, 'm1-01-crawl-running.png');
await page.screenshot({ path: runningShot });
console.log(`截图 → ${runningShot}`);

// 5) 轮询到结束
let final = null;
for (let i = 0; i < 120; i++) {
  const status = await api(`/api/sites/${siteId}/crawl/status`);
  final = status;
  if (status.task.status !== 'running' && status.task.status !== 'paused') break;
  await new Promise((r) => setTimeout(r, 500));
}
await new Promise((r) => setTimeout(r, 800));
socket.close();

console.log(`任务状态：${final.task.status}`);
console.log(`统计：${JSON.stringify(final.stats)}`);
console.log(
  `WS 消息：hello=${wsMessages.filter((m) => m.type === 'hello').length} progress=${wsMessages.filter((m) => m.type === 'progress').length} node=${wsMessages.filter((m) => m.type === 'node').length} task=${wsMessages.filter((m) => m.type === 'task').length}`,
);
console.log(`最后一条进度：${JSON.stringify(wsMessages.filter((m) => m.type === 'progress').at(-1)?.progress ?? null)}`);

// 控制台完成态截图
await page.goto(`${baseUrl}/sites/${siteId}/crawl`, { waitUntil: 'networkidle' });
await page.waitForSelector('.log-list__item');
const doneShot = resolve(outDir, 'm1-02-crawl-done.png');
await page.screenshot({ path: doneShot });
console.log(`截图 → ${doneShot}`);

// 6) 逐层懒加载树（走 REST，等价于界面里的懒加载）
const tree = [];
const walk = async (parentId, level) => {
  const query = parentId === null ? '&limit=200' : `&parentId=${parentId}&limit=200`;
  const page_ = await api(`/api/sites/${siteId}/tree?${query}`);
  for (const node of page_.nodes) {
    tree.push({ level, ...node });
    if (node.child_count > 0 && level < 6) await walk(node.id, level + 1);
  }
};
await walk(null, 0);
console.log('\n=== 树（懒加载展开）===');
for (const node of tree) {
  console.log(
    `${'  '.repeat(node.level)}d${node.depth} [${node.status}] ${node.display_label ?? node.url} · 子=${node.child_count} 入链=${node.in_link_count} · ${node.url}`,
  );
}

// 7) 自检
const identityKeys = tree.map((n) => n.identity_key);
const uniqueKeys = new Set(identityKeys);
const ids = new Set(tree.map((n) => n.id));
const byUrl = (needle) => tree.find((n) => n.url.endsWith(needle));
const checks = [
  ['节点数 >= 10', tree.length >= 10, `实际 ${tree.length}`],
  ['identity_key 全部唯一（无重复节点）', uniqueKeys.size === identityKeys.length, `唯一 ${uniqueKeys.size} / 共 ${identityKeys.length}`],
  ['树中节点 id 不重复', ids.size === tree.length, `唯一 ${ids.size} / 共 ${tree.length}`],
  ['出现 0/1/2/3 级多级节点', [0, 1, 2, 3].every((d) => tree.some((n) => n.depth === d)), [...new Set(tree.map((n) => n.depth))].join(',')],
  ['根节点 depth=0 且状态 ok', tree[0]?.depth === 0 && tree[0]?.status === 'ok', `${tree[0]?.depth}/${tree[0]?.status}`],
  ['跟踪参数/尾斜杠/fragment 变体归并为一个节点', tree.filter((n) => n.identity_key.endsWith('/docs/guide')).length === 1, ''],
  ['robots 禁止页标记 blocked', byUrl('/blocked/secret')?.status === 'blocked', String(byUrl('/blocked/secret')?.status)],
  ['404 页面标记 error', byUrl('/missing')?.status === 'error', String(byUrl('/missing')?.status)],
  ['素材只登记不递归', byUrl('/assets/logo.png')?.status === 'skipped' && byUrl('/assets/logo.png')?.child_count === 0, ''],
  ['分页护栏：?page=n 未无限翻页', tree.filter((n) => n.url.includes('/paged')).length <= 50, `${tree.filter((n) => n.url.includes('/paged')).length} 页`],
  ['Playwright 回落：JS 渲染出的子页入树', byUrl('/js-rendered-child') !== undefined, String(byUrl('/js-rendered-child')?.url ?? '未发现')],
  ['入链多父：/team 入链 >= 2', (byUrl('/team')?.in_link_count ?? 0) >= 2, String(byUrl('/team')?.in_link_count)],
  ['WS 收到 progress 推送', wsMessages.filter((m) => m.type === 'progress').length >= 2, `${wsMessages.filter((m) => m.type === 'progress').length} 条`],
  ['WS 收到 node 推送', wsMessages.some((m) => m.type === 'node'), `${wsMessages.filter((m) => m.type === 'node').length} 条`],
];
console.log('\n=== 自检 ===');
let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `（${detail}）` : ''}`);
}

// 8) 树视图截图（展开到 3 级）
await page.goto(`${baseUrl}/sites/${siteId}/tree`, { waitUntil: 'networkidle' });
await page.waitForSelector('.tree-row');
// 依次展开节点：每次都重新定位（展开会插入新行，缓存的 locator 会失效）
for (let round = 0; round < 30; round++) {
  const toggle = page.locator('.tree-row:not([aria-expanded="true"]) .tree-row__toggle:not([disabled])').first();
  if ((await toggle.count()) === 0) break;
  try {
    await toggle.click({ timeout: 3000 });
  } catch {
    break;
  }
  await page.waitForTimeout(250);
  if ((await page.locator('.tree-row').count()) > 120) break;
}
const treeShot = resolve(outDir, 'm1-03-tree-view.png');
await page.screenshot({ path: treeShot });
console.log(`截图 → ${treeShot}`);

// 打开一个节点属性（含入链锚文本）
const teamRow = page.locator('.tree-row', { hasText: '团队' }).first();
if ((await teamRow.count()) > 0) {
  await teamRow.click();
  await page.waitForSelector('.tree-detail__url');
  await page.screenshot({ path: resolve(outDir, 'm1-04-node-detail.png') });
  console.log(`截图 → ${resolve(outDir, 'm1-04-node-detail.png')}`);
}

await browser.close();
console.log(`\n${failed === 0 ? 'M1 验收全部通过' : `M1 验收存在 ${failed} 项未通过`}；站点 ${siteName}（${siteId}）`);
process.exit(failed === 0 ? 0 : 1);
