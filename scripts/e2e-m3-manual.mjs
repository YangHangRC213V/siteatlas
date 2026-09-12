/**
 * M3 端到端验收脚本（dev-spec §7 M3）
 *
 * 验收标准：手动点选能正确建边，回根后不重复建节点。
 *
 * 流程（对本机演示站 scripts/demo-site.mjs，服务端会启动真实 Chromium）：
 *   1. 建站（不自动采集，保持空树，只有根节点）
 *   2. 浏览器里打开手动采集页 → 开始会话 → 等首帧画到 canvas
 *   3. 在 canvas 上「点画面上真实链接的位置」→ 断言边与节点被写入（source=manual）
 *   4. 点浏览器回根 → 断言识别为已回根、节点数不增加（不重复建节点）
 *   5. 页内锚点点击 → 断言进待确认队列且不建节点
 *   6. 暂停/继续、结束会话
 *   7. 截图存 docs/screenshots/m3-*.png
 *
 * 用法：node scripts/e2e-m3-manual.mjs [baseUrl] [demoOrigin]
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

// ---------- 0) 建站（不采集：空树只有根节点）----------
// 先清掉上一轮遗留的手动会话：脚本中途失败会把服务端会话留在 running，
// 不清掉会污染「结束后无会话」这类断言
for (const stale of (await api('/api/manual/sessions')).sessions) {
  await api(`/api/manual/${stale.sessionId}/stop`, { method: 'POST' });
  console.log(`清理遗留手动会话 ${stale.sessionId}`);
}
for (const card of (await api('/api/sites?includeArchived=1')).sites) {
  if (card.site.root_url.startsWith(demoOrigin) && card.site.archived === 0) {
    await api(`/api/sites/${card.site.id}`, { method: 'DELETE' });
  }
}
const siteName = `M3 验收站 ${new Date().toISOString().slice(11, 19)}`;
const created = await api('/api/sites', { method: 'POST', body: JSON.stringify({ url: `${demoOrigin}/`, name: siteName }) });
const siteId = created.site.id;
console.log(`站点 ${siteName}（${siteId}）已创建，根节点 ${created.root.id}`);

const nodeCount = async () =>
  (await api(`/api/sites/${siteId}/tree?limit=1`)).total +
  (await api(`/api/sites/${siteId}/tree?parentId=${created.root.id}&limit=500`)).total;

// ---------- 浏览器：手动采集页 ----------
// 默认用 Playwright 自带 Chromium（v1243 已装）；PW_CHANNEL=chrome 可切系统 Chrome
const channel = process.env['PW_CHANNEL'];
const browser = await chromium.launch(channel === undefined || channel === '' ? {} : { channel });
const page = await browser.newPage({ viewport: { width: 1500, height: 960 } });
const shot = async (name) => {
  const file = resolve(outDir, name);
  await page.screenshot({ path: file });
  console.log(`截图 → ${file}`);
};

await page.goto(`${baseUrl}/sites/${siteId}/manual`, { waitUntil: 'networkidle' });
await page.waitForSelector('.manual-page');
check('手动采集页可打开（未开始时显示引导空状态）', (await page.locator('.manual-stage .empty').count()) === 1);

// 开始会话
await page.locator('.manual-controlbar .btn--primary').first().click();
let sessionId = null;
for (let i = 0; i < 60; i++) {
  const st = (await api(`/api/sites/${siteId}/manual`)).state;
  if (st !== null) {
    sessionId = st.sessionId;
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (sessionId === null) throw new Error('手动会话未在 30 秒内启动');
console.log(`手动会话 ${sessionId} 已启动`);
await page.waitForSelector('.remote-view__canvas', { timeout: 60000 });
// 等首帧画上 canvas：canvas 有实际像素尺寸即视为已解码
await page.waitForFunction(() => {
  const canvas = document.querySelector('canvas.remote-view__canvas');
  return canvas !== null && canvas.width > 100 && canvas.height > 100;
}, null, { timeout: 60000 });
const canvasSize = await page.evaluate(() => {
  const canvas = document.querySelector('canvas.remote-view__canvas');
  return canvas === null ? null : { w: canvas.width, h: canvas.height };
});
check('服务端 Chromium 画面已串流到 canvas', canvasSize !== null, `canvas ${canvasSize?.w}×${canvasSize?.h}`);
check('会话状态为采集中', (await page.locator('.manual-controlbar .crawl-status').innerText()).includes('采集中'));
await shot('m3-01-manual-session.png');

// ---------- 点画面里的真实链接 ----------
/**
 * 点画面里的真实元素：先用 /element 接口读远端元素坐标（页面视口坐标），
 * 再换算成 canvas 上的 CSS 坐标点击 —— 不靠"猜位置"。
 */
const clickElement = async (selector) => {
  // 导航是异步的：元素可能还没出现，轮询等待（最多 20 秒）
  let box = null;
  for (let i = 0; i < 40; i++) {
    const res = await api(`/api/manual/${sessionId}/element?selector=${encodeURIComponent(selector)}`);
    box = res.box;
    if (box !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (box === null) {
    const detail = await api(`/api/manual/${sessionId}`);
    console.log(`[debug] 找不到 ${selector}；当前 URL=${detail.state.current?.url} lastNavigated=${detail.state.lastNavigatedUrl}`);
    console.log(`[debug] 最近事件：${JSON.stringify(detail.events.slice(-4).map((e) => e.message))}`);
  }
  if (box === null) throw new Error(`远端页面找不到元素：${selector}`);
  const canvasBox = await page.locator('canvas.remote-view__canvas').boundingBox();
  const viewport = await page.evaluate(() => {
    const hud = document.querySelector('.remote-view__hud');
    const text = hud === null ? '' : (hud.textContent ?? '');
    const match = /视口\s+(\d+)×(\d+)/.exec(text);
    return match === null ? { width: 1280, height: 800 } : { width: Number(match[1]), height: Number(match[2]) };
  });
  const scaleX = canvasBox.width / viewport.width;
  const scaleY = canvasBox.height / viewport.height;
  await page.mouse.click(canvasBox.x + box.x * scaleX, canvasBox.y + box.y * scaleY);
  return box;
};

const before = await nodeCount();
const aboutBox = await clickElement('a[href="/about"]');
console.log(`点击 /about（远端页面坐标 ${aboutBox.x.toFixed(0)},${aboutBox.y.toFixed(0)}）`);
await page.waitForTimeout(3000);
const afterNav = await nodeCount();
const stateAfterNav = (await api(`/api/sites/${siteId}/manual`)).state;
check('手动点击后新建了节点（写在自动投影层）', afterNav > before, `${before} → ${afterNav}`);
check('会话统计出现「配对成功」的点击', (stateAfterNav?.clicks.paired ?? 0) >= 1, `paired=${stateAfterNav?.clicks.paired ?? 0}`);
const manualEdges = await api(`/api/sites/${siteId}/tree?parentId=${created.root.id}&limit=500`);
check('树里根节点出现子节点（边已写入）', manualEdges.total >= 1, `根的子节点 ${manualEdges.total} 个`);
const edges = await api(`/api/nodes/${created.root.id}`);
const manualEdge = (edges.children ?? []).find((child) => child.edge?.source === 'manual');
check('边带 source=manual 标记', manualEdge !== undefined, manualEdge?.edge?.source ?? '未找到');
await shot('m3-02-after-click.png');

// ---------- 回根：不重复建节点 ----------
const beforeBack = await nodeCount();
await page.locator('.manual-controlbar .btn', { hasText: '回根' }).click();
await page.waitForTimeout(2500);
const afterBack = await nodeCount();
const stateAfterBack = (await api(`/api/sites/${siteId}/manual`)).state;
check('回根后节点数不增加（回根识别生效）', afterBack === beforeBack, `${beforeBack} → ${afterBack}`);
check(
  '回根后当前身份 = 会话根节点',
  stateAfterBack?.current?.nodeId === created.root.id,
  `${stateAfterBack?.current?.url ?? '未知'}`,
);
await shot('m3-03-back-to-root.png');

// ---------- 页内锚点 → 待确认队列 ----------
await page.locator('.manual-controlbar .btn', { hasText: '回根' }).click();
await page.waitForTimeout(1200);
// 点页面标题（非链接），应落入待确认（被点元素不是链接）
await clickElement('h1');
await page.waitForTimeout(2000);
const stateAfterPending = (await api(`/api/sites/${siteId}/manual`)).state;
check(
  '非链接点击进入待确认队列且不建节点',
  (stateAfterPending?.pendingConfirmCount ?? 0) >= 1,
  `pending=${stateAfterPending?.pendingConfirmCount ?? 0}`,
);
await page.waitForTimeout(800);
const pendingList = await page.locator('.pending-list__item').count();
check('界面上显示待确认项', pendingList >= 1, `${pendingList} 条`);

// ---------- 确认待确认项 → 边入树（不新建节点）----------
// 目标选「刚才点 /about 建出来的那个节点」：把待确认点击记成一条指向它的 manual 边
const aboutChild = (await api(`/api/sites/${siteId}/tree?parentId=${created.root.id}&limit=500`)).nodes.find(
  (row) => row.url === `${demoOrigin}/about`,
);
check('待确认的目标节点存在（/about 已入树）', aboutChild !== undefined, aboutChild?.id ?? '未找到');
await page.locator('.manual-page input.mono').last().fill(aboutChild.id);
const beforeConfirm = await nodeCount();
await page.locator('[data-testid="pending-confirm"]').first().click();
await page.waitForTimeout(1500);
const stateAfterConfirm = (await api(`/api/sites/${siteId}/manual`)).state;
const afterConfirm = await nodeCount();
check('确认后待确认队列清空', (stateAfterConfirm?.pendingConfirmCount ?? -1) === 0, `pending=${stateAfterConfirm?.pendingConfirmCount}`);
check('确认不新建节点（只补一条边）', afterConfirm === beforeConfirm, `${beforeConfirm} → ${afterConfirm}`);
// 边从根节点的出链里查（节点详情返回 children[] = 出链）
const rootDetail = await api(`/api/nodes/${created.root.id}`);
const confirmedEdge = (rootDetail.children ?? []).find((child) => child.to?.id === aboutChild.id);
check(
  '确认写成 root → 目标节点 的 manual 边',
  confirmedEdge?.edge?.source === 'manual' && confirmedEdge?.edge?.from_id === created.root.id,
  `${confirmedEdge?.edge?.source ?? '无'} / from=${confirmedEdge?.edge?.from_id ?? '无'}`,
);
await shot('m3-04-pending-confirmed.png');

// ---------- 丢弃待确认项 → 队列出队且不建边 ----------
await clickElement('h1');
await page.waitForTimeout(2000);
const pendingAgain = await page.locator('.pending-list__item').count();
// 「根的子节点数」= 根发出的边数：确认补了一条边，丢弃就不该再增
const edgesBeforeDiscard = (await api(`/api/sites/${siteId}/tree?parentId=${created.root.id}&limit=500`)).total;
await page.locator('[data-testid="pending-discard"]').first().click();
await page.waitForTimeout(1200);
const edgesAfterDiscard = (await api(`/api/sites/${siteId}/tree?parentId=${created.root.id}&limit=500`)).total;
check('丢弃后待确认项从界面消失', (await page.locator('.pending-list__item').count()) === 0, `丢弃前 ${pendingAgain} 条`);
check('丢弃不建边（根的子节点数不变）', edgesAfterDiscard === edgesBeforeDiscard, `${edgesBeforeDiscard} → ${edgesAfterDiscard}`);

// ---------- 展开一层（§4.3 工具条）----------
const beforeExpand = await nodeCount();
await page.locator('.manual-controlbar .btn', { hasText: '展开一层' }).click();
await page.waitForTimeout(2000);
const afterExpand = await nodeCount();
const expandState = (await api(`/api/sites/${siteId}/manual`)).state;
check('展开一层：新建占位节点并导航过去', afterExpand === beforeExpand + 1, `${beforeExpand} → ${afterExpand}`);
check(
  '展开一层的当前页 = 新的占位地址',
  (expandState?.current?.url ?? '').includes('/siteatlas-expand/'),
  expandState?.current?.url ?? '未知',
);
const expandNode = await api(`/api/nodes/${expandState.current.nodeId}`);
check('占位节点标记为 need_human（提醒改成真实地址）', expandNode.node.status === 'need_human', expandNode.node.status);

// ---------- 暂停 / 继续 / 结束 ----------
await page.locator('.manual-controlbar .btn', { hasText: '暂停' }).click();
await page.waitForTimeout(600);
check('暂停后状态为已暂停', (await api(`/api/sites/${siteId}/manual`)).state?.status === 'paused');
await shot('m3-05-pending-and-paused.png');
await page.locator('.manual-controlbar .btn', { hasText: '继续' }).click();
await page.waitForTimeout(600);
check('继续后状态为采集中', (await api(`/api/sites/${siteId}/manual`)).state?.status === 'running');

await page.locator('.manual-controlbar .btn', { hasText: '结束并保存' }).click();
await page.waitForTimeout(2000);
check('结束后会话清空', (await api(`/api/sites/${siteId}/manual`)).state === null);
check('结束后浏览器页面已关闭', (await api('/api/manual/sessions')).sessions.length === 0);

// ---------- 手动写入的树在树视图里可见 ----------
await page.goto(`${baseUrl}/sites/${siteId}/tree`, { waitUntil: 'networkidle' });
await page.waitForSelector('.tree-row');
await page.waitForFunction(() => document.querySelectorAll('.tree-row').length >= 1, null, { timeout: 15000 });
// 根会自动展开，等懒加载完成
await page
  .waitForFunction(() => document.querySelectorAll('.tree-row').length > 1, null, { timeout: 8000 })
  .catch(() => undefined);
const treeRows = await page.locator('.tree-row').count();
check('手动采集的结果出现在树视图', treeRows >= 2, `${treeRows} 行`);
await shot('m3-06-manual-tree.png');

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${failed.length === 0 ? 'M3 验收全部通过' : `M3 验收存在 ${failed.length} 项未通过`}；站点 ${siteName}（${siteId}）`);
process.exit(failed.length === 0 ? 0 : 1);
