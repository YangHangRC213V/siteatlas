/**
 * core/export/service.ts —— 导出编排（dev-spec §5.1 / §6.7）
 *
 * 流程：建导出记录（pending）→ 建目录 → 构建数据集 → 各格式写出 → 算 sha256/bytes
 *      → 生成 manifest.json（**最后一步写**，因为 manifest 自己也要登记）→ 标记 done。
 *
 * 目录约定（§6.7）：`data/sites/<siteId>/exports/<exportId>/`
 *   · 结构层：graph.json / nodes.jsonl / nodes.csv / edges.csv / graph.mmd / siteatlas.db
 *   · 素材层：raw/ 与 parsed/（由采集时的素材归档产生，导出时按清单引用，不复制）
 *   · 索引：manifest.json（下游唯一入口）
 *
 * manifest 里同时登记 raw/parsed 层的**文件清单**（若存在），
 * 这样「仅凭 manifest 就能定位全部素材」（§7 M4 验收）。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, type ExportFormat, type ExportManifest, type ExportRecord, type ExportScope } from '@siteatlas/shared';
import { ulid } from '../store/ids.ts';
import { ExportsRepo } from '../store/repos/exports.ts';
import { buildDataset, type ExportDataset } from './dataset.ts';
import {
  edgesCsv,
  graphJson,
  materialsJson,
  mermaidTree,
  nodesCsv,
  nodesJsonl,
  sqliteSnapshot,
  writeEdgesCsvToFile,
  writeGraphJsonToFile,
  writeNodesJsonlToFile,
  type WrittenArtifact,
} from './writers.ts';

export class ExportError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.status = status;
  }
}

export interface ExportServiceDeps {
  db: DatabaseSync;
  /** 仓库根目录（data/ 的父目录） */
  rootDir: string;
  now?: () => number;
}

export interface StartExportInput {
  siteId: string;
  format: ExportFormat;
  scope?: ExportScope;
  nodeId?: string;
  presetId?: string;
  includeDeleted?: boolean;
}

export interface ExportOutcome {
  export: ExportRecord;
  manifest: ExportManifest;
}

const FORMATS: ExportFormat[] = ['json', 'jsonl', 'csv', 'sqlite', 'mermaid'];

/**
 * 超过这个节点数就改用流式写出（不把整份 JSON 拼在内存里）。
 * 50000 节点 + 20 万边的图大约 150MB 文本，拼字符串会明显吃内存；
 * 流式路径按行 append，内存占用与规模无关（见 DECISIONS.md M4）。
 */
const STREAMING_THRESHOLD = 50_000;

function sha256Of(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 站点素材目录：data/sites/<siteId>/{raw,parsed,exports}（§3 / §6.7） */
export function siteDataDir(rootDir: string, siteId: string): string {
  return join(rootDir, 'data', 'sites', siteId);
}

export class ExportService {
  private readonly db: DatabaseSync;
  private readonly rootDir: string;
  private readonly now: () => number;
  readonly exports: ExportsRepo;

  constructor(deps: ExportServiceDeps) {
    this.db = deps.db;
    this.rootDir = deps.rootDir;
    this.now = deps.now ?? (() => Date.now());
    this.exports = new ExportsRepo(deps.db);
  }

  /** 同步导出：写完才返回（万级节点在本地是亚秒级；不引入任务队列，见 DECISIONS.md） */
  run(input: StartExportInput): ExportOutcome {
    if (!FORMATS.includes(input.format)) {
      throw new ExportError('INVALID_FORMAT', `不支持的导出格式：${String(input.format)}`, 400);
    }
    const site = this.db.prepare('SELECT id, name, root_url FROM sites WHERE id = ?').get(input.siteId) as
      | Record<string, unknown>
      | undefined;
    if (site === undefined) throw new ExportError('SITE_NOT_FOUND', `站点不存在：${input.siteId}`, 404);

    const scope: ExportScope = input.scope ?? 'site';
    if (scope === 'subtree') {
      if (input.nodeId === undefined) throw new ExportError('NODE_ID_REQUIRED', '子树导出需要 nodeId', 400);
      const node = this.db.prepare('SELECT id, site_id FROM nodes WHERE id = ?').get(input.nodeId) as Record<string, unknown> | undefined;
      if (node === undefined) throw new ExportError('NODE_NOT_FOUND', `节点不存在：${input.nodeId}`, 404);
      if (String(node['site_id']) !== input.siteId) throw new ExportError('NODE_OTHER_SITE', '该节点不属于该站点', 409);
    }

    const exportId = ulid();
    const dirName = join(siteDataDir(this.rootDir, input.siteId), 'exports', exportId);
    const dir = resolve(dirName);
    const record = this.exports.create({
      id: exportId,
      siteId: input.siteId,
      siteName: String(site['name']),
      rootUrl: String(site['root_url']),
      format: input.format,
      scopeJson: JSON.stringify({ kind: scope, nodeId: input.nodeId ?? null, includeDeleted: input.includeDeleted ?? false, presetId: input.presetId ?? null }),
      presetId: input.presetId ?? null,
      dir,
    });
    this.exports.markRunning(exportId);

    try {
      mkdirSync(dir, { recursive: true });
      const dataset = buildDataset({
        db: this.db,
        siteId: input.siteId,
        subtreeRootId: scope === 'subtree' ? (input.nodeId as string) : null,
        includeDeleted: input.includeDeleted ?? false,
        now: this.now,
      });
      const manifest = this.writeArtifacts(record, dataset, dir);
      this.exports.markDone(exportId, {
        manifestPath: join(dir, 'manifest.json'),
        countsJson: JSON.stringify(manifest.counts),
      });
      return { export: this.exports.get(exportId) as ExportRecord, manifest };
    } catch (err) {
      this.exports.markFailed(exportId, (err as Error).message);
      throw err;
    }
  }

  /** 按格式写出产物并生成 manifest（manifest 覆盖所有格式的公共结构层 + 该格式的专属文件） */
  private writeArtifacts(record: ExportRecord, dataset: ExportDataset, dir: string): ExportManifest {
    const artifacts: WrittenArtifact[] = [];
    const streamingNames = new Set<string>();
    const format = record.format as ExportFormat;

    // 大站走流式写出（内存与站点规模无关）；小站走内存版（便于测试与复用）
    if (dataset.nodes.length >= STREAMING_THRESHOLD) {
      const graphPath = join(dir, 'graph.json');
      const nodesPath = join(dir, 'nodes.jsonl');
      const edgesPath = join(dir, 'edges.csv');
      writeGraphJsonToFile(dataset, graphPath);
      writeNodesJsonlToFile(dataset, nodesPath);
      writeEdgesCsvToFile(dataset, edgesPath);
      for (const name of ['graph.json', 'nodes.jsonl', 'edges.csv']) streamingNames.add(name);
    } else {
      // 结构层公共部分：graph.json + nodes.jsonl + edges.csv 是「不看 manifest 也能读」的兜底
      artifacts.push(graphJson(dataset));
      artifacts.push(nodesJsonl(dataset));
      artifacts.push(edgesCsv(dataset.edges));
    }
    const materials = materialsJson(dataset);
    if (materials !== null) artifacts.push(materials);

    if (format === 'csv') artifacts.push(nodesCsv(dataset.nodes));
    if (format === 'mermaid') artifacts.push(mermaidTree(dataset));

    for (const artifact of artifacts) {
      if (artifact.content === null) continue;
      writeFileSync(join(dir, artifact.name), artifact.content, 'utf8');
    }

    const files: ExportManifest['files'] = {};
    for (const artifact of artifacts) {
      if (artifact.content === null) continue;
      const buffer = Buffer.from(artifact.content, 'utf8');
      files[artifact.name] = {
        sha256: sha256Of(buffer),
        bytes: buffer.byteLength,
        dataset: artifact.dataset,
        ...(artifact.rows === undefined ? {} : { rows: artifact.rows }),
      };
    }

    // 流式写出的文件：从磁盘读回算校验和（内存里没有全文）
    const datasetOf: Record<string, string> = { 'graph.json': 'graph', 'nodes.jsonl': 'nodes', 'edges.csv': 'edges' };
    const rowsOf: Record<string, number> = { 'graph.json': dataset.nodes.length, 'nodes.jsonl': dataset.nodes.length, 'edges.csv': dataset.edges.length };
    for (const name of streamingNames) {
      const buffer = readFileSync(join(dir, name));
      files[name] = {
        sha256: sha256Of(buffer),
        bytes: buffer.byteLength,
        dataset: datasetOf[name] ?? 'nodes',
        rows: rowsOf[name] ?? 0,
      };
    }

    const raw = this.listMaterialFiles(dir, dataset, 'raw');
    const parsed = this.listMaterialFiles(dir, dataset, 'parsed');

    const baseUrl = `/open/v1/sites/${dataset.site.id}`;
    const manifest: ExportManifest = {
      schemaVersion: SCHEMA_VERSION,
      exportId: record.id,
      siteId: dataset.site.id,
      siteName: dataset.site.name,
      rootUrl: dataset.site.rootUrl,
      generatedAt: dataset.generatedAt,
      format,
      scope: dataset.scope.kind,
      counts: dataset.counts,
      layers: {
        structure: Object.keys(files),
        raw,
        parsed,
      },
      files,
      endpoints: {
        graph: `${baseUrl}/graph.json`,
        nodes: `${baseUrl}/nodes.jsonl`,
        edges: `${baseUrl}/edges.csv`,
        manifest: `${baseUrl}/manifest.json`,
        sqlite: `${baseUrl}/siteatlas.db`,
        node: `${baseUrl}/nodes/{nodeId}`,
      },
    };

    if (format === 'sqlite') {
      const snapshot = sqliteSnapshot(dataset, { exportId: record.id, manifest });
      copyFileSync(snapshot.fromFile as string, join(dir, 'siteatlas.db'));
      rmSync(snapshot.fromFile as string, { force: true, recursive: true });
      const buffer = readFileSync(join(dir, 'siteatlas.db'));
      const entry = { sha256: sha256Of(buffer), bytes: buffer.byteLength, dataset: 'sqlite', rows: dataset.nodes.length };
      files['siteatlas.db'] = entry;
      manifest.layers.structure.push('siteatlas.db');
      manifest.files = files;
    }

    // README：给人看的下游接入说明（不进 files 映射，避免下游把它当数据）
    writeFileSync(
      join(dir, 'README.md'),
      [
        `# SiteAtlas 导出 ${record.id}`,
        '',
        `- 站点：${dataset.site.name}（${dataset.site.rootUrl}）`,
        `- 格式：${format}，范围：${dataset.scope.kind}${dataset.scope.nodeId === null ? '' : `（根 ${dataset.scope.nodeId}）`}`,
        `- 计数：节点 ${dataset.counts.nodes} / 边 ${dataset.counts.edges} / 素材 ${dataset.counts.materials}（软删未导出 ${dataset.counts.deleted}）`,
        `- schemaVersion：${SCHEMA_VERSION}，生成时间：${new Date(dataset.generatedAt).toISOString()}`,
        '',
        '下游请**先读 `manifest.json`**：`files` 映射给出每个文件的 sha256/bytes/承载数据集，`layers` 给出三档数据分层。',
        '',
        '| 文件 | 内容 |',
        '|---|---|',
        '| graph.json | 完整图：{ meta, nodes[], edges[] } |',
        '| nodes.jsonl | 一行一个节点（首行 meta），适合流式处理 |',
        '| edges.csv / nodes.csv | RFC4180，含表头 |',
        '| graph.mmd | Mermaid flowchart（超过 800 节点截断） |',
        '| siteatlas.db | 可直接查询的 SQLite 快照（含 manifest / query_examples 表） |',
        '| raw/ · parsed/ | 素材原件与解析结果（按 nodeId 关联） |',
        '',
        '所有节点的 `parent_id` 都是**有效父节点**（已叠加人工修正）。',
        '',
      ].join('\n'),
      'utf8',
    );

    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
  }

  /** 扫描素材目录，返回相对 data/sites/<id>/ 的路径清单（§6.7 layers.raw / layers.parsed） */
  private listMaterialFiles(dir: string, dataset: ExportDataset, layer: 'raw' | 'parsed'): string[] {
    const siteDir = siteDataDir(this.rootDir, dataset.site.id);
    const layerDir = join(siteDir, layer);
    if (!existsSync(layerDir)) return [];
    const wanted = new Set<string>();
    for (const node of dataset.nodes) {
      for (const material of node.materials) {
        if (material.rel_path.startsWith(`${layer}/`)) wanted.add(material.rel_path);
      }
    }
    const out: string[] = [];
    for (const rel of [...wanted].sort()) {
      if (existsSync(join(siteDir, rel))) out.push(rel);
    }
    void dir;
    return out;
  }

  /** 站点级即时数据集（对外只读 API 用；不落磁盘） */
  dataset(siteId: string): ExportDataset | null {
    const site = this.db.prepare('SELECT id FROM sites WHERE id = ?').get(siteId) as Record<string, unknown> | undefined;
    if (site === undefined) return null;
    return buildDataset({ db: this.db, siteId, now: this.now });
  }

  /** 只读 SQL 句柄（对外只读 API 的单节点查询用） */
  get database(): DatabaseSync {
    return this.db;
  }

  /** 导出详情（含 manifest 内容） */
  status(exportId: string): { export: ExportRecord; manifest: ExportManifest | null } {
    const record = this.exports.get(exportId);
    if (record === null) throw new ExportError('EXPORT_NOT_FOUND', `导出不存在：${exportId}`, 404);
    if (record.manifest_path === null || !existsSync(record.manifest_path)) return { export: record, manifest: null };
    try {
      return { export: record, manifest: JSON.parse(readFileSync(record.manifest_path, 'utf8')) as ExportManifest };
    } catch {
      return { export: record, manifest: null };
    }
  }

  listForSite(siteId: string, limit = 50): ExportRecord[] {
    return this.exports.list(siteId, limit);
  }

  /** 导出目录（只读 API 提供产物文件用） */
  dirOf(exportId: string): string | null {
    const record = this.exports.get(exportId);
    if (record === null || record.dir === null) return null;
    return record.dir;
  }

  /** 产物目录下的文件清单（大小/时间），前端展示用 */
  artifacts(exportId: string): Array<{ name: string; bytes: number; mtime: number }> {
    const dir = this.dirOf(exportId);
    if (dir === null || !existsSync(dir)) return [];
    return readdirSync(dir)
      .map((name) => {
        const stat = statSync(join(dir, name));
        return { name, bytes: stat.size, mtime: Math.floor(stat.mtimeMs) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
