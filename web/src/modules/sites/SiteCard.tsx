/**
 * 站点卡片（requirements §4.1「卡片/文件夹视图」）
 * 显示：站点名、根域名、节点数、采集状态；点击进入该树的详情/树视图。
 */
import type { SiteCard as SiteCardData } from '@siteatlas/shared';
import { formatTime, rootDomain, statusClass, statusLabel } from './types.ts';
import './sites.css';

export interface SiteCardProps {
  card: SiteCardData;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore?: (id: string) => void;
}

export function SiteCard({ card, onOpen, onDelete, onRestore }: SiteCardProps): React.JSX.Element {
  const { site, stats } = card;
  const archived = site.archived === 1;

  return (
    <article className={`site-card${archived ? ' site-card--archived' : ''}`} data-site-id={site.id}>
      <button
        type="button"
        className="site-card__body"
        onClick={() => onOpen(site.id)}
        aria-label={`打开站点 ${site.name}`}
      >
        <span className="site-card__folder" aria-hidden="true">
          ▤
        </span>
        <span className="site-card__meta">
          <span className="site-card__row">
            <h3 className="site-card__name" title={site.name}>
              {site.name}
            </h3>
            <span className={statusClass(stats.rootStatus)}>{statusLabel(stats.rootStatus)}</span>
          </span>
          <span className="site-card__host mono" title={site.root_url}>
            {rootDomain(site.root_host)}
          </span>
          <span className="site-card__stats">
            <span>{stats.nodeCount} 个节点</span>
            <span aria-hidden="true">·</span>
            <span>最大深度 {stats.maxDepth}</span>
            {stats.errorCount > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="site-card__warn">{stats.errorCount} 个失败</span>
              </>
            ) : null}
          </span>
          <span className="site-card__time">
            更新于 {formatTime(site.updated_at)}
            {site.note !== null && site.note.length > 0 ? ` · ${site.note}` : ''}
          </span>
        </span>
      </button>

      <div className="site-card__actions">
        {archived ? (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => onRestore?.(site.id)}
            title="从回收站恢复"
          >
            恢复
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => onOpen(site.id)}
            title="进入站点（树视图 M2）"
          >
            打开
          </button>
        )}
        <button
          type="button"
          className="btn btn--sm btn--danger"
          disabled={archived}
          onClick={() => {
            if (window.confirm(`确定删除站点「${site.name}」？（软删除，可恢复，将影响 ${stats.nodeCount} 个节点）`)) {
              onDelete(site.id);
            }
          }}
          title="软删除整站（二次确认）"
        >
          删除
        </button>
      </div>
    </article>
  );
}
