/**
 * core/crawl/prefix.ts —— 路径前缀 Trie 剪枝（dev-spec §6.3 护栏 3）
 *
 * 对付「无限目录」：/a/1/、/a/2/、/a/3/… 这种同前缀连续命中超过阈值即剪枝该前缀。
 * 判定粒度 = 路径段（不是字符），避免把 /ab 与 /a 混为一谈。
 */

export interface PrefixNode {
  segment: string;
  /** 该前缀下已抓取（命中）次数 */
  hits: number;
  children: Map<string, PrefixNode>;
}

export class PrefixTrie {
  private readonly root: PrefixNode = { segment: '', hits: 0, children: new Map() };
  private readonly threshold: number;
  private readonly pruned = new Set<string>();

  constructor(threshold: number) {
    this.threshold = Math.max(1, threshold);
  }

  private segmentsOf(url: string): string[] {
    try {
      const pathname = new URL(url).pathname;
      return pathname.split('/').filter((s) => s.length > 0);
    } catch {
      return [];
    }
  }

  private prefixKey(segments: string[]): string {
    return `/${segments.join('/')}`;
  }

  /** 记录一次命中，返回本次是否触发了剪枝 */
  recordHit(url: string): { pruned: boolean; prefix: string | null } {
    const segments = this.segmentsOf(url);
    if (segments.length === 0) return { pruned: false, prefix: null };

    let node = this.root;
    let triggered: string | null = null;
    const walked: string[] = [];
    for (const segment of segments) {
      walked.push(segment);
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { segment, hits: 0, children: new Map() };
        node.children.set(segment, child);
      }
      child.hits += 1;
      node = child;
      // 路径上「任一」前缀连续命中超阈值即剪枝（不止最深那层，否则无限目录永远追不上）
      const key = this.prefixKey(walked);
      if (child.hits > this.threshold && !this.pruned.has(key) && triggered === null) {
        this.pruned.add(key);
        triggered = key;
      }
    }
    return { pruned: triggered !== null, prefix: triggered };
  }

  /** 该 URL 是否落在已剪枝的前缀下 */
  isPruned(url: string): string | null {
    const segments = this.segmentsOf(url);
    const walked: string[] = [];
    for (const segment of segments) {
      walked.push(segment);
      const key = this.prefixKey(walked);
      if (this.pruned.has(key)) return key;
    }
    return null;
  }

  get prunedPrefixes(): string[] {
    return [...this.pruned];
  }
}
