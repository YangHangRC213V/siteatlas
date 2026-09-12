/**
 * 项目根目录解析
 *
 * 不能依赖 import.meta.dirname：dev（tsx src/index.ts）与打包/直跑时它可能落在
 * 调用方 cwd 或 tsc 输出目录上，曾导致 data/ 与 web/dist 指错位置。
 * 这里以「显式传入的 candidate 或其所在目录」为起点向父目录回溯，命中
 * 带 `workspaces` 的 package.json 即认定为仓库根。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function isWorkspaceRoot(dir: string): boolean {
  const pkgFile = resolve(dir, 'package.json');
  if (!existsSync(pkgFile)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { workspaces?: unknown };
    return Array.isArray(pkg.workspaces) && pkg.workspaces.length > 0;
  } catch {
    return false;
  }
}

/** 从 startDir（或 startDir 的目录）向上最多 6 层查找 npm workspaces 根 */
export function findProjectRoot(fallback: string): string {
  let dir = dirname(resolve(fallback));
  for (let i = 0; i < 6; i++) {
    if (isWorkspaceRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(fallback);
}
