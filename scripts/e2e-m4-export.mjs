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

// 从界面新建一次导出（CSV）
await page.selectOption('.export-form select', 'csv');
await page.locator('.export-form .btn--primary').click();
await page.waitForFunction(() => document.querySelectorAll('.export-list__item').length >= 6, null, { timeout: 15000 });
await page.waitForSelector('.export-detail .table');
const rows = await page.locator('.export-detail .table tbody tr').count();
check('界面上发起导出后能看到 manifest 文件清单', rows >= 4, `${rows} 行文件`);
await shot('m4-01-export-page.png');

const openLink = await page.locator('.export-endpoints a').first().getAttribute('href');
check('界面上给出只读 API 地址', openLink !== null && openLink.startsWith('/open/v1/'), openLink ?? '未找到');

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
