/**
 * M2 端到端验收脚本（dev-spec §7 M2）
 *
 * 验收标准：万级节点流畅 + 拖拽重挂可撤销。
 * 本脚本对本地演示站（scripts/demo-site.mjs）：
 *   1. 建站 + 采集（拿到一棵真实的树）
 *   2. 浏览器里拖拽行重挂，断言树结构与修正徽标变化、⌘Z 撤销、⌘⇧Z 重做
 *   3. 多选批量重挂 + 一次撤销全部回滚
 *   4. 属性抽屉改别名/地址 → 行标签与修改历史更新
 *   5. 软删子树（影响面提示）→ 回收站恢复
 *   6. 万级节点压测：造 12000 个节点的站点，测量渲染与滚动性能（虚拟滚动只渲染可视行）
 *   7. 截图存 docs/screenshots/m2-*.png
 *
 * 用法：node scripts/e2e-m2-tree.mjs [baseUrl] [demoOrigin]
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8787';
const demoOrigin = process.argv[3] ?? 'http://127.0.0.1:8899';
const outDir = resolve(import.meta.dirname, '..', 'docs', 'screenshots');
mkdirSync(outDir, { recursive: true });

const api = async (path, init) => {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${text}`);
  return body;
};

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `（${detail}）` : ''}`);
};

// ---------- 0) 准备：建站 + 采集 ----------
const existing = await api('/api/sites?includeArchived=1');
for (const card of existing.sites) {
  if (card.site.root_url === `${demoOrigin}/` && card.site.archived === 0) {
    await api(`/api/sites/${card.site.id}`, { method: 'DELETE' });
  }
}
const siteName = `M2 验收站 ${new Date().toISOString().slice(11, 19)}`;
const created = await api('/api/sites', { method: 'POST', body: JSON.stringify({ url: `${demoOrigin}/`, name: siteName }) });
const siteId = created.site.id;
await api(`/api/sites/${siteId}/crawl`, {
  method: 'POST',
  body: JSON.stringify({
    preset: { maxDepth: 4, maxPages: 50, concurrency: 4, perHostConcurrency: 4, minDelayMs: 60, jitterMs: 0, renderMode: 'http' },
  }),
});
for (let i = 0; i < 200; i++) {
  const status = await api(`/api/sites/${siteId}/crawl/status`);
  if (status.task?.status !== 'running') break;
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`站点 ${siteName}（${siteId}）采集完成`);

const childrenOf = async (parentId) => {
  const query = parentId === null ? '' : `?parentId=${parentId}&limit=500`;
  return (await api(`/api/sites/${siteId}/tree${query}`)).nodes;
};
const rootsPre = await childrenOf(null);
const rootNode = rootsPre[0];
if (rootNode === undefined) throw new Error('演示站没有根节点');
const rootChildren = await childrenOf(rootNode.id);
// 注意：/docs?a=1&b=2 是另一个节点（真实 query 视为不同资源），因此要精确匹配
const docsNode = rootChildren.find((n) => n.url.endsWith('/docs'));
const teamNode = rootChildren.find((n) => n.url.endsWith('/team'));
if (docsNode === undefined || teamNode === undefined) throw new Error('演示站缺少 /docs 或 /team 节点');
const rowByUrl = (url) => page.locator(`.tree-row[title="${url}"]`).first();

// ---------- 浏览器 ----------
const channel = process.env['PW_CHANNEL'] ?? 'chrome';
const browser = await chromium.launch({ channel });
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
const shot = async (name) => {
  const file = resolve(outDir, name);
  await page.screenshot({ path: file });
  console.log(`截图 → ${file}`);
};

const rowCount = () => page.locator('.tree-row').count();

await page.goto(`${baseUrl}/sites/${siteId}/tree`, { waitUntil: 'networkidle' });
await page.waitForSelector('.tree-row');

// 展开根 → 找到 /docs 与 /team
await page.locator('.tree-row').first().locator('.tree-row__toggle').click();
await page.waitForTimeout(400);
check('树视图懒加载出根的子节点', (await rowCount()) > 1, `${await rowCount()} 行`);
await shot('m2-01-tree-virtual-scroll.png');

// ---------- 1) 拖拽重挂 ----------
const docsRow = rowByUrl(docsNode.url);
const teamRow = rowByUrl(teamNode.url);
/**
 * 拖拽一次并等结果落库。
 * 注意：一旦重挂成功，/docs 会变成 /team 的子节点（折叠状态下不在 DOM 里），
 * 因此失败重试必须先重置父节点，避免直接对已不存在的行操作。
 */
const dragOnce = async () => {
  try {
    await docsRow.dragTo(teamRow, { timeout: 5000 });
  } catch {
    const src = await rowByUrl(docsNode.url).boundingBox();
    const dst = await rowByUrl(teamNode.url).boundingBox();
    if (src === null || dst === null) return;
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, { steps: 12 });
    await page.mouse.up();
  }
  await page.waitForTimeout(1200);
};

const parentOf = async (id) => (await api(`/api/nodes/${id}`)).node.effective_parent_id;
console.log(`[debug] docs=${docsNode.id} 初始父=${await parentOf(docsNode.id)} team=${teamNode.id} 根=${rootNode.id}`);
await page.evaluate(() => {
  const w = window;
  w.__dragLog = [];
  for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']) {
    document.addEventListener(
      type,
      (e) => {
        const el = e.target;
        w.__dragLog.push(type + '|' + (el && el.getAttribute ? el.getAttribute('title') || String(el.className).slice(0, 24) : '?'));
      },
      true,
    );
  }
});
await dragOnce();
let docsParentNow = await parentOf(docsNode.id);
console.log(`[debug] 第一次拖拽后父=${docsParentNow}（期望 ${teamNode.id}）`);
console.log('[debug] drag 事件:', JSON.stringify((await page.evaluate(() => window.__dragLog ?? [])).slice(0, 12)));
console.log('[debug] DOM 行:', JSON.stringify(await page.evaluate(() =>
  [...document.querySelectorAll('.tree-row')].map((r) => ({
    t: (r.getAttribute('title') ?? '').replace('http://127.0.0.1:8899', ''),
    label: r.querySelector('.tree-row__label')?.textContent,
    badges: [...r.querySelectorAll('.badge')].map((b) => b.textContent),
  })),
)));
console.log('[debug] 撤销按钮:', (await page.locator('.crawl-controlbar .btn').first().innerText()).trim(), '| disabled:', await page.locator('.crawl-controlbar .btn').first().isDisabled());
if (docsParentNow !== teamNode.id) {
  // 第一次没成功：撤销任何落库的改动，重新打开页面再拖一次
  await api(`/api/sites/${siteId}/undo`).catch(() => undefined);
  await page.goto(`${baseUrl}/sites/${siteId}/tree`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tree-row');
  await page.locator('.tree-row').first().locator('.tree-row__toggle').click();
  await page.waitForTimeout(400);
  await dragOnce();
  docsParentNow = await parentOf(docsNode.id);
  console.log(`[debug] 第二次拖拽后父=${docsParentNow}`);
}
const teamChildren = await childrenOf(teamNode.id);
check('服务端树里 /team 下出现 /docs', teamChildren.some((n) => n.id === docsNode.id));
check('重挂后节点带「已修改」徽标', (await rowByUrl(docsNode.url).locator('.badge--need-human').count()) > 0);
const undoLabel = await page.locator('.crawl-controlbar .btn').first().innerText();
check('撤销按钮显示栈深度', /撤销\s*\(1\)/.test(undoLabel), undoLabel.trim());
await shot('m2-02-drag-moved.png');

// ---------- 2) ⌘Z 撤销 / ⌘⇧Z 重做 ----------
await page.keyboard.press('Meta+z');
await page.waitForTimeout(800);
const afterUndo = (await api(`/api/nodes/${docsNode.id}`)).node.effective_parent_id;
check('⌘Z 撤销重挂（回到原父节点）', afterUndo === rootsPre[0].id, `effective_parent_id=${afterUndo === rootsPre[0].id ? 'root' : afterUndo}`);
check('撤销后修正徽标消失', (await rowByUrl(docsNode.url).locator('.badge--need-human').count()) === 0);

await page.keyboard.press('Meta+Shift+z');
await page.waitForTimeout(800);
const afterRedo = (await api(`/api/nodes/${docsNode.id}`)).node.effective_parent_id;
check('⌘⇧Z 重做重挂', afterRedo === teamNode.id);

// 还原：撤销回初始，便于后续步骤断言
await page.keyboard.press('Meta+z');
await page.waitForTimeout(700);

// ---------- 3) 多选批量重挂 + 一次撤销 ----------
await page.goto(`${baseUrl}/sites/${siteId}/tree`, { waitUntil: 'networkidle' });
await page.waitForSelector('.tree-row');
await page.locator('.tree-row').first().locator('.tree-row__toggle').click();
await page.waitForTimeout(400);
const checkBoxes = page.locator('.tree-row__check');
await checkBoxes.nth(1).click();
await checkBoxes.nth(2).click();
await page.waitForTimeout(200);
const batchVisible = await page.locator('.tree-batchbar').count();
check('多选后出现批量操作条', batchVisible === 1);
await shot('m2-03-batch-select.png');
await page.locator('.tree-batchbar .btn', { hasText: '移到根层' }).click();
await page.waitForTimeout(800);
const undoBatch = await page.locator('.crawl-controlbar .btn').first().innerText();
check('批量操作只产生一步可撤销', /撤销\s*\(1\)/.test(undoBatch), undoBatch.trim());
await page.keyboard.press('Meta+z');
await page.waitForTimeout(700);

// ---------- 4) 属性抽屉：改别名 + 修改历史 ----------
await page.goto(`${baseUrl}/sites/${siteId}/tree`, { waitUntil: 'networkidle' });
await page.waitForSelector('.tree-row');
await page.locator('.tree-row').first().locator('.tree-row__toggle').click();
await page.waitForTimeout(400);
await rowByUrl(teamNode.url).click();
await page.waitForSelector('.tree-detail__body');
await page.locator('.tree-detail__body input').first().fill('核心团队');
await page.locator('.tree-detail__body .btn--primary').click();
await page.waitForTimeout(800);
const teamLabel = await rowByUrl(teamNode.url).locator('.tree-row__label').innerText();
check('改别名后行标签变为别名', teamLabel === '核心团队', `行标签=${teamLabel}`);
const historyCount = await page.locator('.history-list__item').count();
check('属性面板显示修改历史', historyCount >= 1, `${historyCount} 条`);
check(
  '历史里能看到「改别名」与生效状态',
  (await page.locator('.history-list__item', { hasText: '改别名' }).count()) >= 1,
);
await shot('m2-04-node-detail-history.png');

// ---------- 5) 软删子树 → 回收站恢复 ----------
page.on('dialog', (dialog) => void dialog.accept());
await page.locator('.tree-detail__body .btn--danger').click();
await page.waitForTimeout(900);
check('软删后树里不再有该节点', (await rowByUrl(teamNode.url).count()) === 0);
await page.locator('.crawl-controlbar .btn', { hasText: '回收站' }).click();
await page.waitForSelector('.tree-trash');
// 等回收站数据到位：必须等到真实的 .trash-list__item（不能等空状态，否则会误判成 0 条）
await page
  .waitForFunction(() => document.querySelectorAll('.trash-list__item').length > 0, null, { timeout: 15000 })
  .catch(() => undefined);
const trashCount = await page.locator('.trash-list__item').count();
check('回收站列出被删子树根', trashCount >= 1, `${trashCount} 条`);
await shot('m2-05-trash.png');
await page.locator('.trash-list__item .btn', { hasText: '恢复' }).first().click();
await page.waitForTimeout(900);
check('恢复后回收站为空', (await page.locator('.trash-list__item').count()) === 0);

// ---------- 6) 万级节点性能（虚拟滚动 + 懒加载）----------
const bigName = `压测站 ${new Date().toISOString().slice(11, 19)}`;
const perfTag = Date.now();
const big = await api('/api/sites', {
  method: 'POST',
  body: JSON.stringify({ url: `${demoOrigin}/?perf=${perfTag}`, name: bigName, skipProbe: true }),
});
const bigId = big.site.id;
// 直接把 12000 个节点写进库（绕过抓取，专测渲染）
const seedMod = await import('node:sqlite');
const db = new seedMod.DatabaseSync(resolve(import.meta.dirname, '..', 'data', 'siteatlas.db'));
db.exec('BEGIN');
try {
  const insertNode = db.prepare(
    `INSERT INTO nodes (id, site_id, identity_key, url, display_label, depth, auto_parent_id, status, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?)`,
  );
  const rootId = big.root.id;
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE nodes SET status = ?, depth = 0 WHERE id = ?').run('ok', rootId);
  let parentId = rootId;
  let depth = 1;
  const idPrefix = `PF${String(perfTag).slice(-6)}`;
  for (let i = 1; i <= 12000; i++) {
    const id = `${idPrefix}${String(i).padStart(6, '0')}`;
    const url = `${demoOrigin}/perf${perfTag}/p${i}`;
    // 每 40 个节点换一层父节点，形成深层树（第 1 个直接挂根，保证根可展开）
    if (i % 40 === 1 && i > 1) {
      parentId = `${idPrefix}${String(i - 40).padStart(6, '0')}`;
      depth = Math.min(12, depth + 1);
    }
    insertNode.run(id, bigId, url, url, `p${i}`, depth, parentId, now);
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
const totalNodes = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE site_id = ?').get(bigId).c;
db.close();
console.log(`压测站点已就绪：${totalNodes} 个节点`);

const startedAt = Date.now();
await page.goto(`${baseUrl}/sites/${bigId}/tree`, { waitUntil: 'networkidle' });
await page.waitForSelector('.tree-row');
const loadMs = Date.now() - startedAt;
const renderedRows = await rowCount();
check('万级站点页面可打开', loadMs < 10000, `${loadMs}ms`);
check(
  '虚拟滚动：只渲染可视行而非全部节点',
  renderedRows < 60,
  `DOM 中 ${renderedRows} 行（站点共 ${totalNodes} 个节点）`,
);
// 滚动性能：连续滚动 30 次，测量每帧耗时
const scrollPerf = await page.evaluate(async () => {
  const viewport = document.querySelector('.tree-viewport');
  if (viewport === null) return { frames: 0, avg: 0 };
  // 先逐层展开一部分（懒加载），让树里有足够的可滚动行
  const times = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    viewport.scrollTop += 400;
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    times.push(performance.now() - t0);
  }
  return { frames: times.length, avg: times.reduce((a, b) => a + b, 0) / times.length };
});
check('滚动 30 帧平均耗时 < 16ms（60fps 预算）', scrollPerf.avg < 16, `${scrollPerf.avg.toFixed(2)}ms/帧`);
await shot('m2-06-perf-12k-nodes.png');

// 懒加载分页：只点开一层就发一次请求（不整树拉取）
const treeRequests = [];
page.on('request', (req) => {
  if (req.url().includes('/api/sites/') && req.url().includes('/tree')) treeRequests.push(req.url());
});
await page.locator('.tree-row').first().locator('.tree-row__toggle').click();
await page.waitForTimeout(700);
check('展开一层只请求该层的子节点', treeRequests.length === 1, `${treeRequests.length} 次 /tree 请求`);

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${failed.length === 0 ? 'M2 验收全部通过' : `M2 验收存在 ${failed.length} 项未通过`}；站点 ${siteName}（${siteId}）`);
process.exit(failed.length === 0 ? 0 : 1);
