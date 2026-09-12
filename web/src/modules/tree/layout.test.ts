/**
 * 图形布局单测（web/src/modules/tree/layout.ts）
 *
 * 布局是纯函数，因此可以在没有浏览器的情况下直接测：
 *   · 确定性：同一份数据两次布局必须完全一致（图不能每次打开都跳）；
 *   · 分层布局：同深度同一行、深度越小 y 越小、节点变多时画布变宽；
 *   · 力导向：所有点落在画布内、父子距离明显小于随机两点距离、坐标是有限数；
 *   · 径向：根在圆心、半径随深度增大。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forceLayout, layeredLayout, linksOf, radialLayout, type TopoNode } from './layout.ts';

function makeNodes(count: number, fanout = 3): TopoNode[] {
  const nodes: TopoNode[] = [
    { id: 'n0', label: '根', depth: 0, parentId: null, childCount: fanout, status: 'ok' },
  ];
  let depth = 1;
  let parentIndex = 0;
  while (nodes.length < count) {
    const parent = nodes[parentIndex] as TopoNode;
    if (parent.childCount === 0) {
      parentIndex += 1;
      continue;
    }
    const child: TopoNode = {
      id: `n${nodes.length}`,
      label: `节点 ${nodes.length}`,
      depth,
      parentId: parent.id,
      childCount: fanout,
      status: 'ok',
    };
    nodes.push(child);
    if (nodes.filter((n) => n.parentId === parent.id).length >= fanout) {
      parentIndex += 1;
      depth = Math.min(3, (nodes[parentIndex]?.depth ?? 0) + 1);
    }
  }
  return nodes;
}

test('linksOf：忽略父节点不在集合内的游离节点', () => {
  const nodes: TopoNode[] = [
    { id: 'a', label: 'A', depth: 0, parentId: null, childCount: 1, status: 'ok' },
    { id: 'b', label: 'B', depth: 1, parentId: 'a', childCount: 0, status: 'ok' },
    { id: 'c', label: 'C', depth: 1, parentId: 'ghost', childCount: 0, status: 'ok' },
  ];
  assert.deepEqual(linksOf(nodes), [{ from: 'a', to: 'b' }]);
});

test('分层布局：同深度同一行，深度决定纵向位置，画布随节点数变宽', () => {
  const nodes = makeNodes(10);
  const layout = layeredLayout(nodes);
  const rootY = (layout.positions.get('n0') as { y: number }).y;
  const depth1 = nodes.filter((n) => n.depth === 1);
  const depth2 = nodes.filter((n) => n.depth === 2);
  for (const node of depth1) assert.ok((layout.positions.get(node.id) as { y: number }).y > rootY, '深度 1 应在根下一行');
  for (const node of depth2) {
    assert.ok((layout.positions.get(node.id) as { y: number }).y > (layout.positions.get((depth1[0] as TopoNode).id) as { y: number }).y);
  }
  const more = layeredLayout(makeNodes(30));
  assert.ok(more.width > layout.width, '节点变多画布应变宽');
  assert.ok(more.height >= layout.height, '层数不减少时高度不应变小');
});

test('布局确定性：同一份数据两次布局完全一致（图不会每次跳）', () => {
  const nodes = makeNodes(24);
  const links = linksOf(nodes);
  const a1 = forceLayout(nodes, links);
  const a2 = forceLayout(nodes, links);
  for (const node of nodes) {
    assert.deepEqual(a1.positions.get(node.id), a2.positions.get(node.id), `节点 ${node.id} 两次布局应一致`);
  }
  const l1 = layeredLayout(nodes);
  const l2 = layeredLayout(nodes);
  for (const node of nodes) assert.deepEqual(l1.positions.get(node.id), l2.positions.get(node.id));
  const r1 = radialLayout(nodes);
  const r2 = radialLayout(nodes);
  for (const node of nodes) assert.deepEqual(r1.positions.get(node.id), r2.positions.get(node.id));
});

test('力导向：坐标有限、落在画布内、父子边明显短于全局平均距离', () => {
  const nodes = makeNodes(20);
  const links = linksOf(nodes);
  const layout = forceLayout(nodes, links);
  assert.equal(layout.positions.size, nodes.length);

  for (const node of nodes) {
    const point = layout.positions.get(node.id) as { x: number; y: number };
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), '坐标必须是有限数');
    assert.ok(point.x >= -1 && point.x <= layout.width + 1, 'x 应在画布内');
    assert.ok(point.y >= -1 && point.y <= layout.height + 1, 'y 应在画布内');
  }

  const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
  const linkDistances = links.map((link) =>
    distance(layout.positions.get(link.from) as { x: number; y: number }, layout.positions.get(link.to) as { x: number; y: number }),
  );
  const allDistances: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      allDistances.push(
        distance(
          layout.positions.get((nodes[i] as TopoNode).id) as { x: number; y: number },
          layout.positions.get((nodes[j] as TopoNode).id) as { x: number; y: number },
        ),
      );
    }
  }
  const avg = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;
  assert.ok(avg(linkDistances) < avg(allDistances), '父子边平均长度应小于全局平均距离（弹簧起作用了）');
  // 自适应铺满：至少用掉画布的一个方向
  const xs = nodes.map((n) => (layout.positions.get(n.id) as { x: number }).x);
  const ys = nodes.map((n) => (layout.positions.get(n.id) as { y: number }).y);
  assert.ok(Math.max(...xs) - Math.min(...xs) > layout.width * 0.4 || Math.max(...ys) - Math.min(...ys) > layout.height * 0.4);
});

test('径向布局：根在圆心，半径随深度单调增大', () => {
  const nodes = makeNodes(16);
  const layout = radialLayout(nodes, { size: 800, radiusStep: 120 });
  const center = { x: 400, y: 400 };
  const root = layout.positions.get('n0') as { x: number; y: number };
  assert.equal(root.x, center.x);
  assert.equal(root.y, center.y);

  const radiusOf = (node: TopoNode): number => {
    const point = layout.positions.get(node.id) as { x: number; y: number };
    return Math.hypot(point.x - center.x, point.y - center.y);
  };
  const byDepth = new Map<number, number[]>();
  for (const node of nodes) {
    const list = byDepth.get(node.depth);
    if (list === undefined) byDepth.set(node.depth, [radiusOf(node)]);
    else list.push(radiusOf(node));
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  for (let i = 1; i < depths.length; i++) {
    const inner = Math.max(...(byDepth.get(depths[i - 1] as number) as number[]));
    const outer = Math.min(...(byDepth.get(depths[i] as number) as number[]));
    assert.ok(outer >= inner, `深度 ${depths[i]} 的半径不应小于上一层`);
  }
});

test('空数据与单节点：不抛异常且给出可用坐标', () => {
  assert.equal(layeredLayout([]).positions.size, 0);
  assert.equal(forceLayout([], []).positions.size, 0);
  assert.equal(radialLayout([]).positions.size, 0);

  const single: TopoNode[] = [{ id: 'only', label: '只此一个', depth: 0, parentId: null, childCount: 0, status: 'ok' }];
  const layout = forceLayout(single, []);
  const point = layout.positions.get('only') as { x: number; y: number };
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
});
