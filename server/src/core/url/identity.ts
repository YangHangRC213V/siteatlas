/**
 * URL 身份指纹（dev-spec §6.1）
 *
 * 同一资源不同跟踪参数 → 同一 identityKey → 同一节点。
 * identityKey 只进 `nodes.identity_key`；`nodes.url` 存含 fragment 的完整地址。
 */
import type { NormalizeOptions } from '@siteatlas/shared';
import { InvalidUrlError, normalizeUrl } from './normalize.ts';

export { InvalidUrlError } from './normalize.ts';

/** 生成 identityKey（不含 fragment） */
export function identityKeyOf(input: string, options: NormalizeOptions = {}): string {
  return normalizeUrl(input, options).identityKey;
}

/** 判断两个 URL 是否指向同一资源 */
export function isSameIdentity(a: string, b: string, options: NormalizeOptions = {}): boolean {
  try {
    return identityKeyOf(a, options) === identityKeyOf(b, options);
  } catch (err) {
    if ((err as InvalidUrlError).name === 'InvalidUrlError') return false;
    throw err;
  }
}
