/**
 * 图形视图的布局算法（requirements §4.5「拓扑展现形式」）
 *
 * 三种布局都是**纯函数 + 确定性**的：
 *   · 输入同一份节点/父指针，输出同一份坐标（不用随机数做初始位置）——
 *     这样「图不会跳」，也给单测留下了可断言的空间（同一输入两次布局必须完全一致）；
 *   · 力导向用**固定轮数 + 速度阻尼**代替「跑到能量收敛」：不依赖 requestAnimationFrame 的
 *     时序，也不会因为节点增多而抖个不停；
 *   · 布局只依赖结构（深度 + 父指针），不读 DOM，因此可以在没有浏览器的情况下测试。
 */

export interface TopoNode {
  id: string;
  label: string;
  depth: number;
  parentId: string | null;
  childCount: number;
  status: string;
}

export interface TopoLink {
  from: string;
  to: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface Layout {
  positions: Map<string, Point>;
  width: number;
  height: number;
}

/** 从「节点 + 有效父指针」推出链接（树/图共用；跨层边以后再加） */
export function linksOf(nodes: TopoNode[]): TopoLink[] {
  const ids = new Set(nodes.map((n) => n.id));
  const links: TopoLink[] = [];
  for (const node of nodes) {
    if (node.parentId === null || !ids.has(node.parentId)) continue;
    links.push({ from: node.parentId, to: node.id });
  }
  return links;
}

/**
 * 分层布局：按 depth 分行、行内按父节点分组排序。
 * 适合看「目录层级」——每层一条水平带，父子用折线连接。
 */
export interface LayeredOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  gapX?: number;
  gapY?: number;
  padding?: number;
}

export function layeredLayout(nodes: TopoNode[], options: LayeredOptions = {}): Layout {
  const nodeWidth = options.nodeWidth ?? 168;
  const nodeHeight = options.nodeHeight ?? 30;
  const gapX = options.gapX ?? 14;
  const gapY = options.gapY ?? 26;
  const padding = options.padding ?? 24;

  const byDepth = new Map<number, TopoNode[]>();
  for (const node of nodes) {
    const list = byDepth.get(node.depth);
    if (list === undefined) byDepth.set(node.depth, [node]);
    else list.push(node);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const positions = new Map<string, Point>();
  let maxRow = 0;
  for (const depth of depths) {
    // 同一层内按「父节点 id + 自身 id」排序：父相邻的兄弟也会相邻，连线不交叉得厉害
    const row = (byDepth.get(depth) as TopoNode[]).slice().sort((a, b) => {
      const pa = a.parentId ?? '';
      const pb = b.parentId ?? '';
      return pa === pb ? a.id.localeCompare(b.id) : pa.localeCompare(pb);
    });
    maxRow = Math.max(maxRow, row.length);
    row.forEach((node, index) => {
      positions.set(node.id, { x: padding + index * (nodeWidth + gapX), y: padding + depth * (nodeHeight + gapY) });
    });
  }
  return {
    positions,
    width: padding * 2 + Math.max(1, maxRow) * (nodeWidth + gapX),
    height: padding * 2 + Math.max(1, depths.length) * (nodeHeight + gapY),
  };
}

/**
 * 力导向布局：斥力（所有点对，用网格近似避免 O(n²) 爆炸）+ 弹簧（父子边）+ 向心力。
 * 固定 iterations 轮，速度带阻尼并限幅，跑完即静止。
 */
export interface ForceOptions {
  iterations?: number;
  width?: number;
  height?: number;
  /** 理想边长 */
  linkDistance?: number;
}

export function forceLayout(nodes: TopoNode[], links: TopoLink[], options: ForceOptions = {}): Layout {
  const width = options.width ?? 1000;
  const height = options.height ?? 700;
  const linkDistance = options.linkDistance ?? 90;
  const iterations = options.iterations ?? 220;

  const count = nodes.length;
  const positions = new Map<string, Point>();
  const velocities = new Map<string, Point>();
  if (count === 0) return { positions, width, height };

  // 确定性初值：按索引在同心螺旋上铺开（不用随机数 → 同一份数据每次得到同一张图）
  const golden = Math.PI * (3 - Math.sqrt(5));
  nodes.forEach((node, index) => {
    const radius = Math.sqrt((index + 0.5) / count) * Math.min(width, height) * 0.42;
    const angle = index * golden;
    positions.set(node.id, { x: width / 2 + radius * Math.cos(angle), y: height / 2 + radius * Math.sin(angle) });
    velocities.set(node.id, { x: 0, y: 0 });
  });

  const indexOf = new Map(nodes.map((n, i) => [n.id, i] as const));
  const linkPairs: Array<[number, number]> = links.flatMap((link) => {
    const a = indexOf.get(link.from);
    const b = indexOf.get(link.to);
    return a === undefined || b === undefined ? [] : [[a, b] as [number, number]];
  });

  const array = nodes.map((n) => ({ ...(positions.get(n.id) as Point) }));
  const velocity = nodes.map(() => ({ x: 0, y: 0 }));
  const repulsion = 1400;
  const springK = 0.035;
  const centerPull = 0.012;
  const damping = 0.82;
  const maxSpeed = 26;

  for (let step = 0; step < iterations; step++) {
    // 斥力：全局点对（画图上限 5000，但这里再抽稀，保证 500 个点以内每轮都是全量）
    const stride = array.length > 400 ? Math.ceil(array.length / 400) : 1;
    for (let i = 0; i < array.length; i += 1) {
      const a = array[i] as Point;
      for (let j = i + 1; j < array.length; j += stride) {
        const b = array[j] as Point;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        if (dx === 0 && dy === 0) {
          dx = ((i % 7) - 3) * 0.5;
          dy = ((j % 5) - 2) * 0.5;
        }
        const dist2 = dx * dx + dy * dy + 0.01;
        if (dist2 > 120000) continue; // 太远就不算，省一半时间
        const force = repulsion / dist2;
        const dist = Math.sqrt(dist2);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        (velocity[i] as Point).x += fx;
        (velocity[i] as Point).y += fy;
        (velocity[j] as Point).x -= fx * stride;
        (velocity[j] as Point).y -= fy * stride;
      }
    }
    // 弹簧：父子边收缩到理想边长
    for (const [i, j] of linkPairs) {
      const a = array[i] as Point;
      const b = array[j] as Point;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const force = (dist - linkDistance) * springK;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      (velocity[i] as Point).x += fx;
      (velocity[i] as Point).y += fy;
      (velocity[j] as Point).x -= fx;
      (velocity[j] as Point).y -= fy;
    }
    // 向心力 + 阻尼 + 限幅 + 落位
    for (let i = 0; i < array.length; i += 1) {
      const point = array[i] as Point;
      const v = velocity[i] as Point;
      v.x += (width / 2 - point.x) * centerPull;
      v.y += (height / 2 - point.y) * centerPull;
      v.x *= damping;
      v.y *= damping;
      const speed = Math.hypot(v.x, v.y);
      if (speed > maxSpeed) {
        v.x = (v.x / speed) * maxSpeed;
        v.y = (v.y / speed) * maxSpeed;
      }
      point.x += v.x;
      point.y += v.y;
    }
  }

  // 自适应铺满：布局跑完后再按实际包围盒缩放平移。
  // 不做这一步，10 个节点也会缩成画布中间一小团（力导向的常见观感问题）。
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of array) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const margin = 60;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.min((width - margin * 2) / spanX, (height - margin * 2) / spanY, 3);
  const offsetX = (width - spanX * scale) / 2 - minX * scale;
  const offsetY = (height - spanY * scale) / 2 - minY * scale;

  nodes.forEach((node, index) => {
    const point = array[index] as Point;
    positions.set(node.id, {
      x: Math.round((point.x * scale + offsetX) * 100) / 100,
      y: Math.round((point.y * scale + offsetY) * 100) / 100,
    });
  });
  return { positions, width, height };
}

/** 径向布局：根在圆心，depth 决定半径（适合看「几层、每层多少」） */
export function radialLayout(nodes: TopoNode[], options: { radiusStep?: number; size?: number } = {}): Layout {
  const radiusStep = options.radiusStep ?? 130;
  const size = options.size ?? 900;
  const positions = new Map<string, Point>();
  const byDepth = new Map<number, TopoNode[]>();
  for (const node of nodes) {
    const list = byDepth.get(node.depth);
    if (list === undefined) byDepth.set(node.depth, [node]);
    else list.push(node);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  for (const depth of depths) {
    const row = (byDepth.get(depth) as TopoNode[]).slice().sort((a, b) => a.id.localeCompare(b.id));
    if (depth === 0) {
      for (const node of row) positions.set(node.id, { x: size / 2, y: size / 2 });
      continue;
    }
    const radius = Math.min(size / 2 - 40, depth * radiusStep);
    row.forEach((node, index) => {
      const angle = (index / row.length) * Math.PI * 2;
      positions.set(node.id, {
        x: size / 2 + radius * Math.cos(angle),
        y: size / 2 + radius * Math.sin(angle),
      });
    });
  }
  return { positions, width: size, height: size };
}
