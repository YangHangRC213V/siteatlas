/**
 * core/store/repos/crawl.ts —— 采集任务/队列/日志/循环计数仓储
 * 对应 dev-spec §4 的 crawl_tasks、crawl_queue、fetch_logs、access_counts 四张表。
 */
import type { CrawlPreset, CrawlStats, CrawlTaskRecord, CrawlTaskStatus, NodeStatus } from '@siteatlas/shared';
import type { DatabaseSync } from 'node:sqlite';
import { nowSec, ulid } from '../ids.ts';
import { effectiveProjection } from '../effective.ts';

type Row = Record<string, unknown>;

export interface QueueItem {
  id: number;
  task_id: string;
  site_id: string;
  node_id: string;
  depth: number;
  priority: number;
  state: string;
  attempts: number;
  next_retry_at: number | null;
}

function toQueueItem(row: Row): QueueItem {
  return {
    id: Number(row['id']),
    task_id: String(row['task_id']),
    site_id: String(row['site_id']),
    node_id: String(row['node_id']),
    depth: Number(row['depth']),
    priority: Number(row['priority']),
    state: String(row['state']),
    attempts: Number(row['attempts']),
    next_retry_at: row['next_retry_at'] === null || row['next_retry_at'] === undefined ? null : Number(row['next_retry_at']),
  };
}

function toTask(row: Row): CrawlTaskRecord {
  return {
    id: String(row['id']),
    site_id: String(row['site_id']),
    preset_json: String(row['preset_json']),
    status: row['status'] as CrawlTaskStatus,
    stats_json: (row['stats_json'] as string | null) ?? null,
    started_at: row['started_at'] === null || row['started_at'] === undefined ? null : Number(row['started_at']),
    finished_at:
      row['finished_at'] === null || row['finished_at'] === undefined ? null : Number(row['finished_at']),
  };
}

export class CrawlRepo {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /* ---------------- crawl_tasks ---------------- */

  createTask(siteId: string, preset: CrawlPreset, id?: string): CrawlTaskRecord {
    const taskId = id ?? ulid();
    this.db
      .prepare(
        `INSERT INTO crawl_tasks (id, site_id, preset_json, status, stats_json, started_at, finished_at)
         VALUES (?, ?, ?, 'running', NULL, ?, NULL)`,
      )
      .run(taskId, siteId, JSON.stringify(preset), nowSec());
    const task = this.getTask(taskId);
    if (task === null) throw new Error(`创建采集任务后读取失败：${taskId}`);
    return task;
  }

  getTask(id: string): CrawlTaskRecord | null {
    const row = this.db.prepare('SELECT * FROM crawl_tasks WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : toTask(row);
  }

  /** 站点最近一次任务（含 running/paused，用于恢复与状态展示） */
  latestTask(siteId: string): CrawlTaskRecord | null {
    const row = this.db
      .prepare('SELECT * FROM crawl_tasks WHERE site_id = ? ORDER BY started_at DESC, id DESC LIMIT 1')
      .get(siteId) as Row | undefined;
    return row === undefined ? null : toTask(row);
  }

  activeTask(siteId: string): CrawlTaskRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM crawl_tasks WHERE site_id = ? AND status IN ('running','paused')
         ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(siteId) as Row | undefined;
    return row === undefined ? null : toTask(row);
  }

  setTaskStatus(id: string, status: CrawlTaskStatus, stats?: CrawlStats): void {
    const finished = status === 'done' || status === 'failed' || status === 'stopped';
    this.db
      .prepare('UPDATE crawl_tasks SET status = ?, stats_json = ?, finished_at = ? WHERE id = ?')
      .run(status, stats !== undefined ? JSON.stringify(stats) : null, finished ? nowSec() : null, id);
  }

  /** 进程重启恢复（dev-spec §6.6）：running 的队列项复位为 pending */
  recoverStaleQueue(): number {
    const res = this.db.prepare("UPDATE crawl_queue SET state = 'pending' WHERE state = 'running'").run();
    this.db.prepare("UPDATE crawl_tasks SET status = 'paused' WHERE status = 'running'").run();
    return Number(res.changes ?? 0);
  }

  /* ---------------- crawl_queue ---------------- */

  /** 入队；已存在（task_id,node_id）则忽略。返回是否真的新建 */
  enqueue(taskId: string, siteId: string, nodeId: string, depth: number, priority?: number): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO crawl_queue (task_id, site_id, node_id, depth, priority, state, attempts, next_retry_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL)
         ON CONFLICT(task_id, node_id) DO NOTHING`,
      )
      .run(taskId, siteId, nodeId, depth, priority ?? -depth);
    return Number(res.changes ?? 0) > 0;
  }

  /** 取下一批待抓（浅层优先：priority DESC = depth ASC） */
  pickPending(taskId: string, limit: number, nowMs: number): QueueItem[] {
    const nowS = Math.floor(nowMs / 1000);
    const rows = this.db
      .prepare(
        `SELECT * FROM crawl_queue
         WHERE task_id = ? AND state = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY priority DESC, id ASC LIMIT ?`,
      )
      .all(taskId, nowS, limit) as Row[];
    return rows.map((r) => toQueueItem(r));
  }

  markRunning(id: number): void {
    this.db.prepare("UPDATE crawl_queue SET state = 'running' WHERE id = ?").run(id);
  }

  markDone(id: number): void {
    this.db.prepare("UPDATE crawl_queue SET state = 'done' WHERE id = ?").run(id);
  }

  markSkipped(id: number): void {
    this.db.prepare("UPDATE crawl_queue SET state = 'skipped' WHERE id = ?").run(id);
  }

  markFailed(id: number): void {
    this.db.prepare("UPDATE crawl_queue SET state = 'failed' WHERE id = ?").run(id);
  }

  /** 重试：attempts+1，state 回 pending 并设置 next_retry_at */
  scheduleRetry(id: number, nextRetryAtMs: number): void {
    this.db
      .prepare(
        `UPDATE crawl_queue SET state = 'pending', attempts = attempts + 1, next_retry_at = ? WHERE id = ?`,
      )
      .run(Math.floor(nextRetryAtMs / 1000), id);
  }

  queueCounts(taskId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT state, COUNT(*) AS c FROM crawl_queue WHERE task_id = ? GROUP BY state')
      .all(taskId) as Row[];
    const out: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
    for (const row of rows) out[String(row['state'])] = Number(row['c']);
    return out;
  }

  /** 暂停/停止时把 running 复位，避免任务卡死 */
  releaseRunning(taskId: string): void {
    this.db
      .prepare("UPDATE crawl_queue SET state = 'pending' WHERE task_id = ? AND state = 'running'")
      .run(taskId);
  }

  /* ---------------- fetch_logs ---------------- */

  logFetch(input: {
    taskId: string;
    nodeId: string;
    url: string;
    httpStatus: number | null;
    durationMs: number;
    error: string | null;
    redirectChain: string[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO fetch_logs (task_id, node_id, url, http_status, duration_ms, error, redirect_chain, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.taskId,
        input.nodeId,
        input.url,
        input.httpStatus,
        input.durationMs,
        input.error,
        JSON.stringify(input.redirectChain),
        nowSec(),
      );
  }

  recentLogs(taskId: string, limit = 20): Array<{ url: string; http_status: number | null; error: string | null; at: number }> {
    const rows = this.db
      .prepare(
        `SELECT url, http_status, error, at FROM fetch_logs WHERE task_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(taskId, limit) as Row[];
    return rows.map((r) => ({
      url: String(r['url']),
      http_status: r['http_status'] === null ? null : Number(r['http_status']),
      error: (r['error'] as string | null) ?? null,
      at: Number(r['at']),
    }));
  }

  /* ---------------- access_counts（§6.3 护栏 2） ---------------- */

  /** 记一次访问并返回累计次数 */
  countVisit(siteId: string, identityKey: string): number {
    this.db
      .prepare(
        `INSERT INTO access_counts (site_id, identity_key, visits, last_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(site_id, identity_key) DO UPDATE SET visits = visits + 1, last_at = excluded.last_at`,
      )
      .run(siteId, identityKey, nowSec());
    const row = this.db
      .prepare('SELECT visits FROM access_counts WHERE site_id = ? AND identity_key = ?')
      .get(siteId, identityKey) as Row | undefined;
    return row === undefined ? 1 : Number(row['visits']);
  }

  getVisits(siteId: string, identityKey: string): number {
    const row = this.db
      .prepare('SELECT visits FROM access_counts WHERE site_id = ? AND identity_key = ?')
      .get(siteId, identityKey) as Row | undefined;
    return row === undefined ? 0 : Number(row['visits']);
  }

  /* ---------------- 状态统计 ---------------- */

  /** 站点节点状态/深度分布（用于进度面板） */
  siteDistribution(siteId: string, taskId?: string): { statusCounts: Record<string, number>; depthDistribution: Record<string, number> } {
    void taskId;
    const statusRows = this.db
      .prepare('SELECT status, COUNT(*) AS c FROM nodes WHERE site_id = ? AND is_deleted = 0 GROUP BY status')
      .all(siteId) as Row[];
    const depthRows = this.db
      .prepare('SELECT depth, COUNT(*) AS c FROM nodes WHERE site_id = ? AND is_deleted = 0 GROUP BY depth ORDER BY depth')
      .all(siteId) as Row[];
    const statusCounts: Record<string, number> = {};
    for (const row of statusRows) statusCounts[String(row['status'])] = Number(row['c']);
    const depthDistribution: Record<string, number> = {};
    for (const row of depthRows) depthDistribution[String(row['depth'])] = Number(row['c']);
    return { statusCounts, depthDistribution };
  }

  /**
   * 站点内检索候选（§5.1 GET /search 的 SQL 侧过滤）。
   * 读有效投影（修正层叠加），因此改过别名/地址的节点也能被检索到。
   */
  searchNodes(
    siteId: string,
    filter: { depth?: number | null; status?: string | null; limit?: number },
  ): Array<{
    id: string;
    url: string;
    alias: string | null;
    title: string | null;
    display_label: string | null;
    depth: number;
    status: string;
    effective_parent_id: string | null;
  }> {
    const outer: string[] = ['t.is_deleted = 0'];
    const outerArgs: Array<string | number> = [];
    if (filter.depth !== undefined && filter.depth !== null) {
      outer.push('t.depth = ?');
      outerArgs.push(filter.depth);
    }
    if (filter.status !== undefined && filter.status !== null) {
      outer.push('t.status = ?');
      outerArgs.push(filter.status);
    }
    const limit = Math.max(1, Math.min(20000, filter.limit ?? 5000));
    const rows = this.db
      .prepare(
        `SELECT t.id, t.url, t.alias, t.title, t.display_label, t.depth, t.status, t.effective_parent_id
         FROM (
           SELECT ${effectiveProjection('v')}
           FROM v_nodes_effective v WHERE v.site_id = ?
         ) t
         WHERE ${outer.join(' AND ')}
         ORDER BY t.depth ASC, t.id ASC
         LIMIT ?`,
      )
      .all(siteId, ...outerArgs, limit) as Row[];
    return rows.map((r) => ({
      id: String(r['id']),
      url: String(r['url']),
      alias: (r['alias'] as string | null) ?? null,
      title: (r['title'] as string | null) ?? null,
      display_label: (r['display_label'] as string | null) ?? null,
      depth: Number(r['depth']),
      status: String(r['status']),
      effective_parent_id: (r['effective_parent_id'] as string | null) ?? null,
    }));
  }

  /** 汇总本次任务的抓取结果 */
  taskSummary(taskId: string): { ok: number; failed: number; fetched: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN http_status IS NOT NULL AND http_status < 400 AND error IS NULL THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN error IS NOT NULL OR http_status IS NULL OR http_status >= 400 THEN 1 ELSE 0 END) AS failed,
           COUNT(*) AS total
         FROM fetch_logs WHERE task_id = ?`,
      )
      .get(taskId) as Row | undefined;
    return {
      ok: Number(row?.['ok'] ?? 0),
      failed: Number(row?.['failed'] ?? 0),
      fetched: Number(row?.['total'] ?? 0),
    };
  }
}

export type { NodeStatus };
