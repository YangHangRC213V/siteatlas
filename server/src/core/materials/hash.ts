/**
 * core/materials/hash.ts —— sha256 小工具（素材与导出共用）
 *
 * 单独成文件是为了避免 archive.ts ↔ export/service.ts 的循环依赖：
 * `siteDataDir()` 在 export/service.ts，而归档要用它；散落的 createHash 调用
 * 又容易写出「一处 utf8、一处 hex」不一致的实现。
 */
import { createHash } from 'node:crypto';

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
