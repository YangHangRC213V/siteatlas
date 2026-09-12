/**
 * core/store/repos/edges.ts —— 边层仓储（dev-spec §4 edges / §3「父节点由边决定」）
 *
 * M1 写入抓取得到的链接关系；去重键 = (from_id, to_id, order_in_page) 的等价判定，
 * 用「先查后插」避免同一页重复抓取时产生重复边。
 */
import type { EdgeRecord, EdgeSource } from '@siteatlas/shared';
import type { DatabaseSync } from 'node:sqlite';
import { nowSec } from '../ids.ts';

type Row = Record<string, unknown>;

function toEdge(row: Row): EdgeRecord {
  return {
    id: Number(row['id']),
    site_id: String(row['site_id']),
    from_id: String(row['from_id']),
    to_id: String(row['to_id']),
    anchor_text: (row['anchor_text'] as string | null) ?? null,
    selector: (row['selector'] as string | null) ?? null,
    dom_path: (row['dom_path'] as string | null) ?? null,
    rel: (row['rel'] as string | null) ?? null,
    target: (row['target'] as string | null) ?? null,
    is_nofollow: Number(row['is_nofollow'] ?? 0),
    fragment: (row['fragment'] as string | null) ?? null,
    source: row['source'] as EdgeSource,
    order_in_page: row['order_in_page'] === null || row['order_in_page'] === undefined ? null : Number(row['order_in_page']),
    created_at: Number(row['created_at']),
  };
}

export interface InsertEdgeInput {
  siteId: string;
  fromId: string;
  toId: string;
  anchorText: string | null;
  selector: string | null;
  domPath: string | null;
  rel: string | null;
  target: string | null;
  isNofollow: boolean;
  fragment: string | null;
  source: EdgeSource;
  orderInPage: number | null;
}

export class EdgesRepo {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * 是否已存在同一 from→to 的边。
   * 去重键为 (from, to, fragment)：同一页多次纯链接同一目标只留 1 条，
   * 但指向同一页不同页内锚点（#a / #b）是不同链接，必须各留一条。
   */
  exists(fromId: string, toId: string, fragment: string | null = null): boolean {
    const row = (
      fragment === null
        ? this.db.prepare('SELECT 1 AS x FROM edges WHERE from_id = ? AND to_id = ? AND fragment IS NULL LIMIT 1').get(fromId, toId)
        : this.db.prepare('SELECT 1 AS x FROM edges WHERE from_id = ? AND to_id = ? AND fragment = ? LIMIT 1').get(fromId, toId, fragment)
    ) as Row | undefined;
    return row !== undefined;
  }

  insert(input: InsertEdgeInput): number {
    const res = this.db
      .prepare(
        `INSERT INTO edges (site_id, from_id, to_id, anchor_text, selector, dom_path, rel, target,
                            is_nofollow, fragment, source, order_in_page, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.siteId,
        input.fromId,
        input.toId,
        input.anchorText,
        input.selector,
        input.domPath,
        input.rel,
        input.target,
        input.isNofollow ? 1 : 0,
        input.fragment,
        input.source,
        input.orderInPage,
        nowSec(),
      );
    return Number(res.lastInsertRowid);
  }

  /** 入链：指向该节点的边 + 来源节点 */
  incoming(nodeId: string, limit = 200): EdgeRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM edges WHERE to_id = ? ORDER BY id LIMIT ?')
      .all(nodeId, limit) as Row[];
    return rows.map((r) => toEdge(r));
  }

  /** 出链：该节点发出的边 */
  outgoing(nodeId: string, limit = 500): EdgeRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM edges WHERE from_id = ? ORDER BY order_in_page, id LIMIT ?')
      .all(nodeId, limit) as Row[];
    return rows.map((r) => toEdge(r));
  }

  countForSite(siteId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM edges WHERE site_id = ?').get(siteId) as Row;
    return Number(row['c'] ?? 0);
  }

  /** 记录重定向链（dev-spec §6.2）：原 URL 保留为别名/历史，此处按 source='redirect' 建边 */
  linkRedirect(siteId: string, fromId: string, toId: string, chain: string[]): void {
    if (this.exists(fromId, toId)) return;
    this.insert({
      siteId,
      fromId,
      toId,
      anchorText: null,
      selector: null,
      domPath: null,
      rel: null,
      target: null,
      isNofollow: false,
      fragment: null,
      source: 'redirect',
      orderInPage: null,
    });
    void chain;
  }
}
