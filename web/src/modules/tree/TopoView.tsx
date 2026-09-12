/**
 * 图形视图（requirements §4.5「其它易于理解和查看的拓扑展现形式」）
 *
 * 三种形式，共用同一份数据（`/api/sites/:id/tree/flat` 的有效投影）：
 *   · 层级图（layered）：按深度分行，适合看目录层级与同层规模；
 *   · 关系图（force）：力导向，适合看「谁连到谁、哪里扎堆」；
 *   · 径向图（radial）：根在圆心、按深度成环，适合看「几层、每层多少」。
 *
 * 为什么自己画 SVG 而不是引三方图库：布局算法只有几十行、且必须**确定性**（图不能每次跳），
 * 引库会顺手把「随机抖动 + 动画」一起引进来；自己画还顺带得到「点击 = 选中节点」这类交互。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TopoLink, TopoNode } from './layout.ts';
import { forceLayout, layeredLayout, linksOf, radialLayout } from './layout.ts';

export type TopoLayoutKind = 'layered' | 'force' | 'radial';

export interface TopoViewProps {
  nodes: TopoNode[];
  layoutKind: TopoLayoutKind;
  selectedId: string | null;
  /** 被软删/未收录等需要提示的 id 集合（用于淡显） */
  dimIds?: Set<string>;
  onSelect(nodeId: string): void;
  onOpen(nodeId: string): void;
}

/** 状态色（与列表视图的徽标同源，避免两处各写一遍） */
function statusFill(status: string): string {
  switch (status) {
    case 'ok':
      return 'var(--c-status-ok-bg)';
    case 'error':
      return 'var(--c-status-error-bg)';
    case 'blocked':
      return 'var(--c-danger-soft)';
    case 'need_human':
      return 'var(--c-accent-soft)';
    default:
      return 'var(--c-surface-2)';
  }
}

export function TopoView({ nodes, layoutKind, selectedId, dimIds, onSelect, onOpen }: TopoViewProps): React.JSX.Element {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const links: TopoLink[] = useMemo(() => linksOf(nodes), [nodes]);
  const layout = useMemo(() => {
    if (layoutKind === 'layered') return layeredLayout(nodes);
    if (layoutKind === 'radial') return radialLayout(nodes);
    return forceLayout(nodes, links);
  }, [nodes, links, layoutKind]);

  // 换布局/换数据时归位视图，避免「找不到自己在哪」
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [layoutKind, nodes.length]);

  const nodeWidth = 168;
  const nodeHeight = 30;
  /** 节点不多时给力导向/径向图也画上标签，否则一堆点看不出谁是谁 */
  const showDotLabels = nodes.length <= 60;

  return (
    <div className="topo-view" data-layout={layoutKind} data-testid="topo-view">
      <div className="topo-toolbar">
        <span className="field__hint">
          共 {nodes.length} 个节点 · {links.length} 条父子边
        </span>
        <span className="nav__spacer" />
        <button type="button" className="btn btn--sm" onClick={() => setZoom((z) => Math.min(2.5, z * 1.2))}>
          放大
        </button>
        <button type="button" className="btn btn--sm" onClick={() => setZoom((z) => Math.max(0.3, z / 1.2))}>
          缩小
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          重置视图
        </button>
      </div>

      <div
        className="topo-canvas"
        onMouseDown={(e) => {
          dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
        }}
        onMouseMove={(e) => {
          const drag = dragRef.current;
          if (drag === null) return;
          setPan({ x: drag.panX + (e.clientX - drag.x), y: drag.panY + (e.clientY - drag.y) });
        }}
        onMouseUp={() => {
          dragRef.current = null;
        }}
        onMouseLeave={() => {
          dragRef.current = null;
        }}
      >
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label={`拓扑图：${nodes.length} 个节点`}
        >
          <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
            {links.map((link) => {
              const from = layout.positions.get(link.from);
              const to = layout.positions.get(link.to);
              if (from === undefined || to === undefined) return null;
              if (layoutKind === 'layered') {
                const y1 = from.y + nodeHeight;
                const y2 = to.y;
                const mid = (y1 + y2) / 2;
                return (
                  <path
                    key={`${link.from}->${link.to}`}
                    d={`M ${from.x + nodeWidth / 2} ${y1} C ${from.x + nodeWidth / 2} ${mid}, ${to.x + nodeWidth / 2} ${mid}, ${to.x + nodeWidth / 2} ${y2}`}
                    className="topo-link"
                  />
                );
              }
              return <line key={`${link.from}->${link.to}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="topo-link" />;
            })}

            {nodes.map((node) => {
              const point = layout.positions.get(node.id);
              if (point === undefined) return null;
              const dim = dimIds?.has(node.id) === true;
              const selected = selectedId === node.id;
              if (layoutKind === 'layered') {
                return (
                  <g
                    key={node.id}
                    transform={`translate(${point.x} ${point.y})`}
                    className={`topo-node${selected ? ' topo-node--selected' : ''}${dim ? ' topo-node--dim' : ''}`}
                    onClick={() => onSelect(node.id)}
                    onDoubleClick={() => onOpen(node.id)}
                    tabIndex={0}
                    role="button"
                    data-node-id={node.id}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onSelect(node.id);
                    }}
                  >
                    <title>{`${node.label}（深度 ${node.depth}，子节点 ${node.childCount}）· 双击打开原始网页`}</title>
                    <rect width={nodeWidth} height={nodeHeight} rx={6} fill={statusFill(node.status)} />
                    <text x={8} y={19} className="topo-node__label">
                      {node.label.length > 18 ? `${node.label.slice(0, 18)}…` : node.label}
                    </text>
                  </g>
                );
              }
              const radius = 4 + Math.min(6, node.childCount);
              return (
                <g
                  key={node.id}
                  className={`topo-node${selected ? ' topo-node--selected' : ''}${dim ? ' topo-node--dim' : ''}`}
                  onClick={() => onSelect(node.id)}
                  onDoubleClick={() => onOpen(node.id)}
                  tabIndex={0}
                  role="button"
                  data-node-id={node.id}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onSelect(node.id);
                  }}
                >
                  <title>{`${node.label}（深度 ${node.depth}）· 双击打开原始网页`}</title>
                  <circle cx={point.x} cy={point.y} r={radius} fill={statusFill(node.status)} stroke="var(--c-border-strong)" />
                  {selected && <circle cx={point.x} cy={point.y} r={radius + 4} fill="none" stroke="var(--c-accent)" strokeWidth={2} />}
                  {showDotLabels && (
                    <text x={point.x + radius + 3} y={point.y + 3.5} className="topo-node__label">
                      {node.label.length > 16 ? `${node.label.slice(0, 16)}…` : node.label}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <p className="field__hint topo-hint">拖动空白处平移 · 双击节点打开原始网页 · 单击选中并看右侧属性</p>
    </div>
  );
}
