/**
 * core/materials/archive.ts —— 素材归档（dev-spec §4 materials / §6.7 三档数据）
 *
 * 三档数据落地位置（`data/sites/<siteId>/`，`materials.rel_path` 相对该目录）：
 *   · `raw/<...>.html`  —— 原件：抓到的 HTML（渲染回落时是渲染后的 DOM 快照）
 *   · `parsed/<...>.json` —— 解析结果：标题、描述、正文文本、长度、内容指纹
 *
 * 与 §6.7 的 exports 的关系：导出目录里的 manifest 通过 `layers.raw` / `layers.parsed`
 * 引用这些文件（按 nodeId 关联，不复制），所以「三档分开存」在磁盘上是真的分开的。
 *
 * 幂等：文件名按 nodeId 派生（`raw/<nodeId>.html`），断点续爬重抓同一页只覆盖同一个文件，
 * 素材清单也不会因此膨胀。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MaterialsRepo } from '../store/repos/materials.ts';
import { siteDataDir } from '../export/service.ts';
import { contentFingerprint, extractContent } from '../extract/content.ts';
import { sha256Hex } from './hash.ts';

export interface ArchivePageInput {
  siteId: string;
  nodeId: string;
  url: string;
  html: string;
  /**
   * 是否留 HTML 原件（raw/）。
   * 由抓取预设的 `downloadAssets` 驱动（§6.7 三档数据的开关）：
   * 关闭时只留解析结果（parsed/），避免大站把磁盘写满（见 DECISIONS.md M4）。
   */
  storeRaw?: boolean;
  /** 是否渲染回落得到的 HTML（记录在 parsed 里，便于下游区分） */
  rendered?: boolean;
  httpStatus?: number | null;
  contentType?: string | null;
  /** 抓取时间（秒），默认取当前时间 */
  fetchedAt?: number;
}

export interface ArchivedMaterials {
  raw: { relPath: string; bytes: number; sha256: string } | null;
  parsed: { relPath: string; bytes: number; sha256: string } | null;
}

export interface MaterialsArchiverOptions {
  rootDir: string;
  materials: MaterialsRepo;
  now?: () => number;
}

export class MaterialsArchiver {
  private readonly rootDir: string;
  private readonly materials: MaterialsRepo;
  private readonly now: () => number;

  constructor(options: MaterialsArchiverOptions) {
    this.rootDir = options.rootDir;
    this.materials = options.materials;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 归档一次成功抓取：写 raw 原件 + parsed 解析结果，并登记两行 materials。
   * 只做文件写入与登记，不做任何网络动作（快路径，不拖慢采集）。
   */
  archivePage(input: ArchivePageInput): ArchivedMaterials {
    const siteDir = siteDataDir(this.rootDir, input.siteId);
    const rawDir = join(siteDir, 'raw');
    const parsedDir = join(siteDir, 'parsed');
    mkdirSync(rawDir, { recursive: true });
    mkdirSync(parsedDir, { recursive: true });

    const storeRaw = input.storeRaw ?? true;
    let raw: ArchivedMaterials['raw'] = null;
    if (storeRaw) {
      const rawRel = `raw/${input.nodeId}.html`;
      const rawBuffer = Buffer.from(input.html, 'utf8');
      writeFileSync(join(siteDir, rawRel), rawBuffer);
      const rawSha = sha256Hex(rawBuffer);
      this.materials.upsert({
        siteId: input.siteId,
        nodeId: input.nodeId,
        kind: 'html',
        relPath: rawRel,
        bytes: rawBuffer.byteLength,
        sha256: rawSha,
      });
      raw = { relPath: rawRel, bytes: rawBuffer.byteLength, sha256: rawSha };
    }

    const content = extractContent(input.html);
    const parsedRel = `parsed/${input.nodeId}.json`;
    const parsedPayload = {
      schemaVersion: '1.0',
      nodeId: input.nodeId,
      url: input.url,
      fetchedAt: Math.floor((input.fetchedAt ?? this.now()) / 1000),
      httpStatus: input.httpStatus ?? null,
      contentType: input.contentType ?? null,
      rendered: input.rendered === true,
      title: content.title,
      description: content.description,
      textLength: content.textLength,
      /** 正文指纹：与 §6.3 二层去重同一套算法，下游可据此判断「同内容不同 URL」 */
      contentHash: contentFingerprint(content.text),
      /** 正文按 4KB 截断存进解析档，避免导出体积失控（完整正文在 raw 原件里） */
      textExcerpt: content.text.slice(0, 4096),
      rawRelPath: raw?.relPath ?? null,
      rawSha256: raw?.sha256 ?? null,
    };
    const parsedBuffer = Buffer.from(`${JSON.stringify(parsedPayload, null, 2)}\n`, 'utf8');
    writeFileSync(join(siteDir, parsedRel), parsedBuffer);
    const parsedSha = sha256Hex(parsedBuffer);
    this.materials.upsert({
      siteId: input.siteId,
      nodeId: input.nodeId,
      kind: 'body',
      relPath: parsedRel,
      bytes: parsedBuffer.byteLength,
      sha256: parsedSha,
    });

    return {
      raw,
      parsed: { relPath: parsedRel, bytes: parsedBuffer.byteLength, sha256: parsedSha },
    };
  }
}
