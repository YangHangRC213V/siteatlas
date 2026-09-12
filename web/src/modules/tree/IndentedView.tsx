/**
 * 缩进列表视图（requirements §4.5「拓扑展现形式」之一）
 *
 * 与目录树的区别：**一次把整棵树铺开**（最多 2000 行），层级用缩进 + 连接线表达，
 * 适合「一眼扫完整站结构 / 用浏览器自带的查找定位文本」。
 * 目录树（虚拟滚动）负责万级站点，缩进列表负责「看得清、找得到」。
 */
import { useMemo, useState } from 'react';
import type { TopoNode } from './layout.ts';

export interface IndentedViewProps {
  nodes: TopoNode[];
  selectedId: string | null;
  onSelect(nodeId: string): void;
  onOpen(nodeId: string): void;
}

interface TreeLine {
  node: TopoNode;
  children: TreeLine[];
  /** 是否为所在分支的最后一个子节点（决定连接线怎么画） */
  isLast: boolean;
}

/** 由「父指针」建出嵌套结构（父不在集合内的节点当根处理） */
export function buildForest(nodes: TopoNode[]): TreeLine[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const childrenOf = new Map<string, TopoNode[]>();
  const roots: TopoNode[] = [];
  for (const node of nodes) {
    if (node.parentId === null || !byId.has(node.parentId)) {
      roots.push(node);
      continue;
    }
    const list = childrenOf.get(node.parentId);
    if (list === undefined) childrenOf.set(node.parentId, [node]);
    else list.push(node);
  }
  const build = (node: TopoNode, isLast: boolean): TreeLine => {
    const children = (childrenOf.get(node.id) ?? []).slice().sort((a, b) => a.label.localeCompare(b.label));
    return { node, isLast, children: children.map((child, index) => build(child, index === children.length - 1)) };
  };
  return roots
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((root, index, all) => build(root, index === all.length - 1));
}

function flatten(lines: TreeLine[], depth: number, out: Array<{ line: TreeLine; depth: number }>): void {
  for (const line of lines) {
    out.push({ line, depth });
    flatten(line.children, depth + 1, out);
  }
}

export function IndentedView({ nodes, selectedId, onSelect, onOpen }: IndentedViewProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(2000);

  const rows = useMemo(() => {
    const forest = buildForest(nodes);
    const out: Array<{ line: TreeLine; depth: number }> = [];
    const walk = (lines: TreeLine[], depth: number): void => {
      for (const line of lines) {
        out.push({ line, depth });
        if (!collapsed.has(line.node.id)) walk(line.children, depth + 1);
      }
    };
    walk(forest, 0);
    return out;
  }, [nodes, collapsed]);

  const visible = rows.slice(0, limit);

  return (
    <div className="indent-view" data-testid="indent-view">
      <div className="topo-toolbar">
        <span className="field__hint">
          整树铺开 {rows.length} 行（节点共 {nodes.length} 个）
          {rows.length > limit ? ` · 只显示前 ${limit} 行` : ''}
        </span>
        <span className="nav__spacer" />
        <button type="button" className="btn btn--sm" onClick={() => setCollapsed(new Set())}>
          全部展开
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => setCollapsed(new Set(nodes.filter((n) => n.childCount > 0).map((n) => n.id)))}
        >
          只留顶层
        </button>
        {rows.length > limit && (
          <button type="button" className="btn btn--sm" onClick={() => setLimit((v) => v + 2000)}>
            再多显示 2000 行
          </button>
        )}
      </div>

      <ul className="indent-list">
        {visible.map(({ line, depth }) => {
          const node = line.node;
          const hasChildren = line.children.length > 0;
          const isCollapsed = collapsed.has(node.id);
          return (
            <li
              key={node.id}
              className={`indent-row${selectedId === node.id ? ' indent-row--selected' : ''}`}
              data-node-id={node.id}
              style={{ paddingLeft: 8 + depth * 18 }}
            >
              <button
                type="button"
                className="indent-row__toggle"
                disabled={!hasChildren}
                aria-label={isCollapsed ? '展开' : '折叠'}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(node.id)) next.delete(node.id);
                    else next.add(node.id);
                    return next;
                  })
                }
              >
                {hasChildren ? (isCollapsed ? '▸' : '▾') : '·'}
              </button>
              <button type="button" className="indent-row__label" onClick={() => onSelect(node.id)}>
                {node.label}
              </button>
              <span className={`badge badge--muted indent-row__status indent-row__status--${node.status}`}>{node.status}</span>
              <span className="field__hint">深度 {node.depth}</span>
              {node.childCount > 0 && <span className="field__hint">{node.childCount} 个子节点</span>}
              <span className="nav__spacer" />
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpen(node.id)} title="查看原始网页">
                查看网页
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
