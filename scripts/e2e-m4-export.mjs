/**
 * M4 端到端验收（dev-spec §7 M4）
 *
 * 验收标准原文：**第三方脚本仅凭 manifest 能读取全部数据**。
 * 因此这个脚本的验收分两半：
 *   1. 走 UI/接口把五种格式各导一遍，检查产物、manifest、只读 API；
 *   2. 起一个**与仓库无关的独立 Node 进程**（文件放在系统临时目录、不 import 仓库任何模块），
 *      只给它 manifest 地址，让它自己把全部数据读出来并逐文件校验 sha256 ——
 *      这就是「第三方脚本」的验收证据。
 *
 * 同时覆盖「设置」模块（全局默认 + 导出预设）：设置改了要能立刻影响下一次采集，
 * 预设要在导出页能一键复用 —— 这两条是「设置页不是摆设」的验收依据。
 *
 * 用法：node scripts/e2e-m4-export.mjs [baseUrl] [demoOrigin]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

/** 第三方脚本：只用 HTTP + node 内置能力，不 import 仓库任何模块 */
const THIRD_PARTY_SCRIPT = `
/**
 * 第三方消费脚本（模拟下游工具）：输入 manifest.json 的 URL，
 * 输出 JSON 报告：读到了什么、每个文件校验和是否匹配、哪些约束成立。
 * 只用 HTTP + node 内置模块，不 import 本站仓库的任何东西。
 */
async function main() {
const manifestUrl = process.argv[2];
const res = await fetch(manifestUrl);
if (!res.ok) throw new Error('取 manifest 失败：' + res.status);
const manifest = await res.json();
const base = manifestUrl.split('/').slice(0, -1).join('/');

const report = { schemaVersion: manifest.schemaVersion, filesChecked: 0, badChecksums: [], counts: manifest.counts, nodes: 0, edges: 0, nodeIds: [], parentsOk: true, layers: manifest.layers };

for (const [name, info] of Object.entries(manifest.files)) {
  const r = await fetch(base + '/' + name);
  if (!r.ok) { report.badChecksums.push(name + ':HTTP' + r.status); continue; }
  const buf = Buffer.from(await r.arrayBuffer());
  const sha = (await import('node:crypto')).createHash('sha256').update(buf).digest('hex');
  if (sha !== info.sha256 || buf.byteLength !== info.bytes) report.badChecksums.push(name);
  report.filesChecked += 1;
  if (name === 'graph.json') {
    const graph = JSON.parse(buf.toString('utf8'));
    report.nodes = graph.nodes.length;
    report.edges = graph.edges.length;
    report.nodeIds = graph.nodes.map((n) => n.id);
    const ids = new Set(report.nodeIds);
    // 自洽性：所有非空父节点都必须在导出集合里
    report.parentsOk = graph.nodes.every((n) => n.parent_id === null || ids.has(n.parent_id));
    report.metaOk = graph.meta && graph.meta.projection === 'effective' && graph.meta.counts.nodes === graph.nodes.length;
  }
  if (name === 'nodes.jsonl') {
    const lines = buf.toString('utf8').trimEnd().split('\\n');
    report.jsonlLines = lines.length;
    report.jsonlMetaOk = JSON.parse(lines[0]).meta.schemaVersion === manifest.schemaVersion;
  }
  if (name === 'edges.csv') {
    report.csvRows = buf.toString('utf8').trimEnd().split('\\r\\n').length - 1;
  }
}
console.log(JSON.stringify(report));
}

await main();
`;

function runThirdParty(manifestUrl) {
  const dir = join(tmpdir(), `siteatlas-thirdparty-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'consumer.mjs');
  writeFileSync(file, THIRD_PARTY_SCRIPT, 'utf8');
  const keep = process.env['SITEATLAS_KEEP_THIRDPARTY'] === '1';
  try {
    const out = execFileSync(process.execPath, [file, manifestUrl], { encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').at(-1));
  } catch (err) {
    console.error(`第三方脚本执行失败；脚本副本：${file}`);
    throw err;
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------- 0) 建站 + 采集（素材归档打开） ---------------- */
for (const stale of (await api('/api/manual/sessions')).sessions) {
  await api(`/api/manual/${stale.sessionId}/stop`, { method: 'POST' });
}
for (const card of (await api('/api/sites?includeArchived=1')).sites) {
  if (card.site.root_url.startsWith(demoOrigin) && card.site.archived === 0) {
    await api(`/api/sites/${card.site.id}`, { method: 'DELETE' });
  }
}
const siteName = `M4 验收站 ${new Date().toISOString().slice(11, 19)}`;
const created = await api('/api/sites', { method: 'POST', body: JSON.stringify({ url: `${demoOrigin}/`, name: siteName }) });
const siteId = created.site.id;
console.log(`站点 ${siteName}（${siteId}）已创建`);

await api(`/api/sites/${siteId}/crawl`, {
  method: 'POST',
  body: JSON.stringify({ preset: { concurrency: 4, minDelayMs: 0, jitterMs: 0, maxDepth: 3, renderMode: 'auto', downloadAssets: true } }),
});
for (let i = 0; i < 120; i++) {
  const status = await api(`/api/sites/${siteId}/crawl/status`);
  if (status.task?.status !== 'running') break;
  await new Promise((r) => setTimeout(r, 500));
}
// 整站节点数用站点卡片统计（/tree 的 total 是「当前父层下的子节点数」）
const siteStats = await api(`/api/sites/${siteId}`);
const tree = await api(`/api/sites/${siteId}/tree?limit=200`);
check(
  '采集完成且树中有多级节点',
  siteStats.stats.nodeCount >= 3 && siteStats.stats.maxDepth >= 2,
  `${siteStats.stats.nodeCount} 个节点，最大深度 ${siteStats.stats.maxDepth}`,
);

const materials = await api(`/api/sites/${siteId}/materials`);
check(
  '采集时归档素材（raw 原件 + parsed 解析结果）',
  materials.materials.some((m) => m.kind === 'html') && materials.materials.some((m) => m.kind === 'body'),
  `${materials.total} 条素材`,
);

/* ---------------- 1.5) 设置模块（纯 API 部分）：全局默认 + 导出预设 ---------------- */
// 先把设置恢复默认：上一次验收可能留下了改动，断言必须可复现
await api('/api/settings/reset', { method: 'POST' });
const original = (await api('/api/settings')).settings;
check(
  '设置接口返回字段元数据与默认值（§4.7 默认并发 5 / 间隔 1000ms）',
  original.concurrency === 5 && original.minDelayMs === 1000 && original.theme === 'system',
  `concurrency=${original.concurrency} minDelayMs=${original.minDelayMs} theme=${original.theme}`,
);
const fieldsCount = (await api('/api/settings')).fields.length;
check('设置项元数据齐备（界面表单由它生成）', fieldsCount >= 15, `${fieldsCount} 个设置项`);

const updated = (
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ settings: { concurrency: 6, minDelayMs: 1300, theme: 'dark' } }),
  })
).settings;
check(
  '设置可保存并读回（含外观项）',
  updated.concurrency === 6 && updated.minDelayMs === 1300 && updated.theme === 'dark',
  `concurrency=${updated.concurrency} minDelayMs=${updated.minDelayMs} theme=${updated.theme}`,
);

const badRes = await fetch(`${baseUrl}/api/settings`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ settings: { concurrency: 999 } }),
});
const badBody = await badRes.json();
check('非法设置被拒绝且不写库', badRes.status === 400 && badBody.error.code === 'INVALID_SETTING', `HTTP ${badRes.status} ${badBody.error.code}`);

// 设置 → 下一次采集的默认值（护栏不能被设置悄悄放宽）
const probeBody = await api(`/api/sites/${siteId}/crawl`, { method: 'POST', body: JSON.stringify({}) });
check(
  '设置立刻影响下一次采集的默认预设（护栏仍取内置默认）',
  probeBody.preset?.concurrency === 6 && probeBody.preset?.minDelayMs === 1300 && probeBody.preset?.maxPages === 100000 && probeBody.preset?.prefixPruneThreshold === 20,
  `concurrency=${probeBody.preset?.concurrency} minDelayMs=${probeBody.preset?.minDelayMs} maxPages=${probeBody.preset?.maxPages}`,
);
await fetch(`${baseUrl}/api/sites/${siteId}/crawl/stop`, { method: 'POST' }).catch(() => undefined);
const resetBody = (await api('/api/settings/reset', { method: 'POST' })).settings;
check(
  '恢复默认把所有设置还原',
  resetBody.concurrency === original.concurrency && resetBody.theme === original.theme,
  `concurrency=${resetBody.concurrency} theme=${resetBody.theme}`,
);

// 导出预设（§4.6 一键复用）
const presetRes = await fetch(`${baseUrl}/api/presets/export`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: `验收预设 ${Date.now() % 100000}`, payload: { format: 'csv', scope: 'site', includeDeleted: false }, isDefault: true }),
});
const presetBody = await presetRes.json();
check(
  '导出预设可保存（§4.6 一键复用）',
  presetRes.status === 201 && typeof presetBody.preset?.id === 'string' && presetBody.preset.payload.format === 'csv',
  presetBody.preset?.name ?? '保存失败',
);
const presetList = await api('/api/presets/export');
check(
  '预设列表里恰好一个默认预设',
  presetList.presets.filter((p) => p.isDefault).length === 1 && presetList.presets[0]?.id === presetBody.preset.id,
  `${presetList.presets.length} 个预设`,
);

/* ---------------- 1) 五种格式各导一遍 ---------------- */
const formats = ['json', 'jsonl', 'csv', 'sqlite', 'mermaid'];
const results = {};
for (const format of formats) {
  const outcome = await api(`/api/sites/${siteId}/export`, { method: 'POST', body: JSON.stringify({ format }) });
  results[format] = outcome;
  const exportDir = outcome.export.dir;
  const manifest = outcome.manifest;
  const expectedFiles = ['graph.json', 'nodes.jsonl', 'edges.csv'];
  if (format === 'csv') expectedFiles.push('nodes.csv');
  if (format === 'mermaid') expectedFiles.push('graph.mmd');
  if (format === 'sqlite') expectedFiles.push('siteatlas.db');

  let ok = outcome.export.status === 'done' && existsSync(join(exportDir, 'manifest.json'));
  const bad = [];
  for (const name of expectedFiles) {
    if (!manifest.files[name]) {
      ok = false;
      bad.push(`${name} 未登记`);
      continue;
    }
    const data = readFileSync(join(exportDir, name));
    const sha = createHash('sha256').update(data).digest('hex');
    if (sha !== manifest.files[name].sha256 || data.byteLength !== manifest.files[name].bytes) {
      ok = false;
      bad.push(`${name} 校验和不符`);
    }
  }
  check(`导出 ${format}：产物齐备且 sha256/bytes 与文件一致`, ok, bad.length > 0 ? bad.join('；') : expectedFiles.join(' '));
}

/* ---------------- 2) manifest 内容与范围语义 ---------------- */
const jsonManifest = results['json'].manifest;
check(
  'manifest 含 schemaVersion/计数/三档分层/文件映射',
  jsonManifest.schemaVersion === '1.0' &&
    typeof jsonManifest.counts.nodes === 'number' &&
    Array.isArray(jsonManifest.layers.structure) &&
    Object.keys(jsonManifest.files).length >= 3,
  `nodes=${jsonManifest.counts.nodes} edges=${jsonManifest.counts.edges} materials=${jsonManifest.counts.materials}`,
);
check(
  'manifest 登记 raw/parsed 素材分层（按 nodeId 关联）',
  jsonManifest.layers.raw.length > 0 && jsonManifest.layers.parsed.length > 0,
  `raw=${jsonManifest.layers.raw.length} parsed=${jsonManifest.layers.parsed.length}`,
);

// SQLite 快照能被第三方工具直接查询
const sqliteDir = results['sqlite'].export.dir;
const snapshot = new DatabaseSync(join(sqliteDir, 'siteatlas.db'), { readOnly: true });
const snapNodes = snapshot.prepare('SELECT COUNT(*) AS c FROM nodes').get();
const snapEdges = snapshot.prepare('SELECT COUNT(*) AS c FROM edges').get();
const snapExamples = snapshot.prepare('SELECT COUNT(*) AS c FROM query_examples').get();
const snapMeta = snapshot.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get();
snapshot.close();
check(
  'SQLite 快照可被第三方直接查询（含查询示例与 meta）',
  Number(snapNodes.c) === jsonManifest.counts.nodes && Number(snapEdges.c) === jsonManifest.counts.edges && Number(snapExamples.c) >= 5,
  `nodes=${snapNodes.c} edges=${snapEdges.c} schema=${snapMeta.v}`,
);

// Mermaid 图能被渲染（文本层面检查语法要素）
const mmd = readFileSync(join(results['mermaid'].export.dir, 'graph.mmd'), 'utf8');
check(
  'Mermaid 产物是合法 flowchart（含节点声明与父子箭头）',
  mmd.startsWith('flowchart TD') && /-->/.test(mmd) && (mmd.match(/\["/g) ?? []).length >= 3,
  `${mmd.split('\n').length} 行`,
);

// 子树导出：范围收窄且边被裁剪
const childRow = tree.nodes.find((n) => n.parent_id === null || n.effective_parent_id !== null) ?? tree.nodes[0];
const subtree = await api(`/api/sites/${siteId}/export`, {
  method: 'POST',
  body: JSON.stringify({ format: 'json', scope: 'subtree', nodeId: childRow.id }),
});
check(
  '子树导出：范围只含该子树',
  subtree.manifest.scope === 'subtree' && subtree.manifest.counts.nodes <= jsonManifest.counts.nodes,
  `subtree nodes=${subtree.manifest.counts.nodes} / 全站 ${jsonManifest.counts.nodes}`,
);

// 软删节点默认不导出：挑一个**叶子**软删（软删是整棵子树，选错会清空整站）
const findLeaf = async (parentId) => {
  const rows = (await api(`/api/sites/${siteId}/tree?parentId=${parentId}&limit=200`)).nodes;
  for (const row of rows) {
    if (row.child_count === 0) return row;
    const leaf = await findLeaf(row.id);
    if (leaf !== null) return leaf;
  }
  return null;
};
const victim = (await findLeaf(created.root.id)) ?? childRow;
const deleteResult = await api(`/api/nodes/${victim.id}`, { method: 'DELETE' });
check(
  '软删目标是叶子节点（影响面为 1）',
  deleteResult.affectedNodes === 1,
  `影响 ${deleteResult.affectedNodes} 个节点`,
);
const afterDelete = await api(`/api/sites/${siteId}/export`, { method: 'POST', body: JSON.stringify({ format: 'json' }) });
check(
  '软删节点默认不进导出，但计数进 deleted',
  afterDelete.manifest.counts.deleted >= 1 && afterDelete.manifest.counts.nodes < jsonManifest.counts.nodes,
  `deleted=${afterDelete.manifest.counts.deleted} nodes ${jsonManifest.counts.nodes} → ${afterDelete.manifest.counts.nodes}`,
);
const withDeleted = await api(`/api/sites/${siteId}/export`, {
  method: 'POST',
  body: JSON.stringify({ format: 'json', scope: 'all', includeDeleted: true }),
});
check(
  'includeDeleted=true 时把软删节点也导出',
  withDeleted.manifest.counts.nodes >= jsonManifest.counts.nodes,
  `${withDeleted.manifest.counts.nodes} 个节点`,
);

/* ---------------- 3) 对外只读 API ---------------- */
const liveManifestRes = await fetch(`${baseUrl}/open/v1/sites/${siteId}/manifest.json`);
const liveManifest = await liveManifestRes.json();
check(
  '只读 API：站点级 manifest 可直接读（无需先建导出任务）',
  liveManifestRes.ok && liveManifest.exportId === 'live' && liveManifest.exports.length >= 1,
  `${liveManifest.exports.length} 个导出任务`,
);
for (const path of ['graph.json', 'nodes.jsonl', 'edges.csv']) {
  const res = await fetch(`${baseUrl}/open/v1/sites/${siteId}/${path}`);
  check(`只读 API：/open/v1/sites/:id/${path} 可读`, res.ok, `HTTP ${res.status}`);
}
const nodeRes = await fetch(`${baseUrl}/open/v1/sites/${siteId}/nodes/${created.root.id}`);
const nodeBody = await nodeRes.json();
check(
  '只读 API：单节点查询返回节点 + 关联边 + 素材',
  nodeRes.ok && nodeBody.node.id === created.root.id && Array.isArray(nodeBody.edges),
  `edges=${nodeBody.edges.length} materials=${nodeBody.materials.length}`,
);

// 目录穿越防护
const evil = await fetch(`${baseUrl}/open/v1/exports/${results['json'].export.id}/..%2F..%2F..%2Fmanifest.json`);
check('只读 API：目录穿越被拒绝（不能读到导出目录之外）', evil.status === 400, `HTTP ${evil.status}`);

/* ---------------- 4) 第三方脚本：仅凭 manifest 读取全部数据 ---------------- */
const manifestUrl = `${baseUrl}/open/v1/exports/${results['json'].export.id}/manifest.json`;
const report = runThirdParty(manifestUrl);
check(
  '第三方脚本（独立进程、不 import 本仓库）仅凭 manifest 取回全部文件',
  report.badChecksums.length === 0 && report.filesChecked >= 3,
  `校验 ${report.filesChecked} 个文件，坏校验和 ${report.badChecksums.length}`,
);
check(
  '第三方脚本读到的节点/边数与 manifest 计数一致',
  report.nodes === jsonManifest.counts.nodes && report.edges === jsonManifest.counts.edges,
  `nodes=${report.nodes}/${jsonManifest.counts.nodes} edges=${report.edges}/${jsonManifest.counts.edges}`,
);
check(
  '第三方脚本能据 graph.json 还原完整树（父节点都在集合内，投影标记为 effective）',
  report.parentsOk === true && report.metaOk === true,
  `节点 ${report.nodeIds.length} 个`,
);
check(
  '第三方脚本能读 JSONL（首行 meta）与 CSV（行数=边数）',
  report.jsonlMetaOk === true && report.jsonlLines === jsonManifest.counts.nodes + 1 && report.csvRows === jsonManifest.counts.edges,
  `jsonl=${report.jsonlLines} 行（含 meta）csv=${report.csvRows} 行`,
);

/* ---------------- 5) 界面：导出页可用 ---------------- */
const channel = process.env['PW_CHANNEL'];
const browser = await chromium.launch(channel === undefined || channel === '' ? {} : { channel });
const page = await browser.newPage({ viewport: { width: 1500, height: 960 } });
const shot = async (name) => {
  const file = resolve(outDir, name);
  await page.screenshot({ path: file });
  console.log(`截图 → ${file}`);
};

await page.goto(`${baseUrl}/sites/${siteId}/export`, { waitUntil: 'networkidle' });
await page.waitForSelector('.export-page');
check('导出页可打开且列出历史导出', (await page.locator('.export-list__item').count()) >= 5, `${await page.locator('.export-list__item').count()} 条`);

// 从界面新建一次导出（CSV）—— 用 data-testid 定位，避免与「导出预设」下拉混淆
await page.selectOption('[data-testid="export-format"]', 'csv');
await page.locator('.export-form .btn--primary').click();
await page.waitForFunction(() => document.querySelectorAll('.export-list__item').length >= 6, null, { timeout: 15000 });
await page.waitForSelector('.export-detail .table');
const rows = await page.locator('.export-detail .table tbody tr').count();
check('界面上发起导出后能看到 manifest 文件清单', rows >= 4, `${rows} 行文件`);
await shot('m4-01-export-page.png');

const openLink = await page.locator('.export-endpoints a').first().getAttribute('href');
check('界面上给出只读 API 地址', openLink !== null && openLink.startsWith('/open/v1/'), openLink ?? '未找到');


/* ---------------- 5.4) 拓扑展现形式 + 原始网页视图（自动化增量） ---------------- */
// 换一种展现形式看同一棵树
await page.goto(`${baseUrl}/sites/${siteId}/tree`, { waitUntil: 'networkidle' });
await page.waitForSelector('.tree-row');
for (const [kind, selector, label] of [
  ['indent', '.indent-row', '缩进列表'],
  ['layered', '.topo-view[data-layout="layered"]', '层级图'],
  ['force', '.topo-view[data-layout="force"]', '关系图'],
  ['radial', '.topo-view[data-layout="radial"]', '径向图'],
]) {
  await page.selectOption('[data-testid="tree-view-kind"]', kind);
  await page.waitForTimeout(900);
  const count = await page.locator(selector).count();
  check(`拓扑展现形式可用：${label}`, count > 0, `${count} 个元素`);
  if (kind === 'force') await shot('m5-04-tree-force.png');
}
await page.selectOption('[data-testid="tree-view-kind"]', 'outline');
await page.waitForTimeout(500);

// 网页视图：走真实界面路径 —— 在目录树里点中一个节点，再点「查看原始网页」
const flatBefore = await api(`/api/sites/${siteId}/tree/flat`);
const paged3 = flatBefore.nodes.find((node) => node.url.endsWith('/paged?page=3')) ?? flatBefore.nodes[0];
const sessionsBefore = (await api('/api/manual/sessions')).sessions.length;

// 用缩进列表定位到该节点（整树铺开、带 data-node-id，最稳），点行选中 → 回目录树 → 点「查看原始网页」
await page.selectOption('[data-testid="tree-view-kind"]', 'indent');
await page.waitForSelector('.indent-row', { timeout: 15000 });
const indentRow = page.locator(`.indent-row[data-node-id="${paged3.id}"]`);
check('缩进列表能定位到指定节点', (await indentRow.count()) === 1, paged3.url);
await indentRow.locator('.indent-row__label').click();
await page.selectOption('[data-testid="tree-view-kind"]', 'outline');
await page.waitForTimeout(600);
await page.waitForSelector('[data-testid="open-web-view"]', { timeout: 10000 });
check('节点属性面板提供「查看原始网页」入口', true, '按钮可见');
await page.locator('[data-testid="open-web-view"]').click();
await page.waitForSelector('[data-testid="tree-web-view"] canvas', { timeout: 60000 });
await page.waitForFunction(
  () => {
    const canvas = document.querySelector('[data-testid="tree-web-view"] canvas');
    return canvas !== null && canvas.width > 100 && canvas.height > 100;
  },
  null,
  { timeout: 60000 },
);
check('网页视图：点「查看原始网页」后画面串流到树视图内', true, 'canvas 已出画面');
await page.screenshot({ path: resolve(outDir, 'm5-05-tree-web-view.png') });
console.log('截图 → m5-05-tree-web-view.png');
const sessionState = (await api(`/api/sites/${siteId}/manual`)).state;
check(
  '网页视图：当前页 = 所选节点的 URL',
  sessionState?.current?.url === paged3.url,
  `${sessionState?.current?.url ?? '无'}`,
);
check('网页视图：会话已就绪（未重复起会话）', (await api('/api/manual/sessions')).sessions.length === Math.max(1, sessionsBefore), `${(await api('/api/manual/sessions')).sessions.length} 个会话`);

// 核心：在画面里点一个**未收录**的链接 → 自动建节点进拓扑
const nodesBeforeClick = (await api(`/api/sites/${siteId}/tree/flat`)).total;
const unrecorded = flatBefore.nodes.some((node) => node.url.endsWith('/paged?page=4')) === false;
check('前置条件：/paged?page=4 尚未收录', unrecorded, `${nodesBeforeClick} 个节点`);
const linkBox = await api(`/api/manual/${sessionState.sessionId}/element?selector=${encodeURIComponent('a[href="/paged?page=4"]')}`);
check('远端页面里能定位到未收录链接的坐标', linkBox.box !== null, JSON.stringify(linkBox.box));

// 用真实的输入回传点击（和人工在画面里点是一样的路径）
await page.evaluate(
  async ({ sessionId, box }) => {
    const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/ws/manual/${sessionId}`);
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = reject;
    });
    const send = (message) => ws.send(JSON.stringify(message));
    send({ type: 'mouse', mouse: { type: 'mouseMoved', x: box.x, y: box.y } });
    send({ type: 'mouse', mouse: { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 } });
    send({ type: 'mouse', mouse: { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 } });
    await new Promise((r) => setTimeout(r, 1200));
    ws.close();
  },
  { sessionId: sessionState.sessionId, box: linkBox.box },
);
await page.waitForTimeout(2500);
const flatAfter = await api(`/api/sites/${siteId}/tree/flat`);
const createdNode = flatAfter.nodes.find((node) => node.url.endsWith('/paged?page=4'));
check(
  '点击画面里未收录的链接 → 自动新增节点（拓扑增量）',
  createdNode !== undefined && flatAfter.total === nodesBeforeClick + 1,
  `${nodesBeforeClick} → ${flatAfter.total}`,
);
check(
  '新增节点的父节点 = 点击时所在页（边也建对了）',
  createdNode?.effective_parent_id === paged3.id,
  `parent=${createdNode?.effective_parent_id ?? '无'}`,
);
const sessionAfterClick = (await api(`/api/sites/${siteId}/manual`)).state;
check(
  '会话统计记到这次配对（paired +1）',
  (sessionAfterClick?.clicks.paired ?? 0) >= 1,
  `paired=${sessionAfterClick?.clicks.paired ?? 0}`,
);
// 图形视图能看到新节点
await page.selectOption('[data-testid="tree-view-kind"]', 'indent');
await page.waitForTimeout(1200);
const indentRows = await page.locator('.indent-row').count();
check('切换视图后能看到新节点（图形视图已刷新）', indentRows >= flatAfter.total, `${indentRows} 行 / ${flatAfter.total} 个节点`);
await page.selectOption('[data-testid="tree-view-kind"]', 'outline');
await page.waitForTimeout(600);
await shot('m5-03-tree-auto-added-node.png');
await api(`/api/manual/${sessionState.sessionId}/stop`, { method: 'POST' }).catch(() => undefined);

/* ---------------- 5.5) 设置页界面：改了要能落库、外观要立即生效 ---------------- */
await page.goto(`${baseUrl}/settings`, { waitUntil: 'networkidle' });
await page.waitForSelector('.settings-page');
const groupTitles = await page.locator('.settings-group__title').allInnerTexts();
const fieldCount = await page.locator('.settings-field').count();
check('设置页可打开且按分组渲染全部设置项', groupTitles.length >= 4 && fieldCount >= 15, `${groupTitles.length} 组 / ${fieldCount} 项`);
check('导航里「设置」已可选（不再是未开放）', (await page.locator('.nav__item[data-disabled="false"]', { hasText: '设置' }).count()) === 1);

await page.locator('.settings-field', { hasText: '总并发' }).locator('input').fill('8');
await page.locator('.settings-actions .btn--primary').click();
await page.waitForTimeout(900);
const afterUiSave = await api('/api/settings');
check('界面上改设置能落库', afterUiSave.settings.concurrency === 8, `服务端 concurrency=${afterUiSave.settings.concurrency}`);

await page.locator('.settings-field', { hasText: '外观' }).locator('select').selectOption('dark');
await page.locator('.settings-actions .btn--primary').click();
await page.waitForTimeout(700);
const themeAttr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
check('外观改深色立即作用到界面（无需刷新）', themeAttr === 'dark', `data-theme=${themeAttr}`);
await shot('m5-01-settings.png');

await page.goto(`${baseUrl}/sites/${siteId}/export`, { waitUntil: 'networkidle' });
await page.waitForSelector('.export-page');
const presetOptions = await page.locator('[data-testid="export-preset"] option').allInnerTexts();
check('导出页能选到已保存的预设', presetOptions.some((text) => text.startsWith('验收预设')), `${presetOptions.length} 个选项`);
await shot('m5-02-export-preset.png');

// 收尾：清掉本次设置与预设，避免影响下一轮
await api('/api/settings/reset', { method: 'POST' });
await api(`/api/presets/export/${presetBody.preset.id}`, { method: 'DELETE' }).catch(() => undefined);

await browser.close();

/* ---------------- 汇总 ---------------- */
const failed = checks.filter((c) => !c.ok);
console.log('');
if (failed.length === 0) {
  console.log(`M4 验收全部通过（${checks.length} 项）；站点 ${siteName}（${siteId}）`);
} else {
  console.log(`M4 验收存在 ${failed.length} 项未通过；站点 ${siteName}（${siteId}）`);
  for (const f of failed) console.log(`  ✖ ${f.name}（${f.detail}）`);
}
process.exit(failed.length === 0 ? 0 : 1);
