import { GameMap, isWalkable } from './map';

const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

/**
 * A* over the tile grid, 8 directions, no cutting corners around blocked tiles.
 * Returns a flat list of tile coordinates [x0, y0, x1, y1, ...] excluding the
 * start tile. If the goal cannot be reached, the path leads to the reachable
 * tile closest to it. Gates of the given team count as open.
 */
export function findPath(map: GameMap, sx: number, sy: number, gx: number, gy: number, team = -1): number[] {
  const n = map.size;
  if (sx === gx && sy === gy) return [];
  const g = new Float32Array(n * n).fill(Infinity);
  const from = new Int32Array(n * n).fill(-1);
  const closed = new Uint8Array(n * n);
  // Binary heap of [f, index] pairs stored flat.
  const heap: number[] = [];
  const push = (f: number, idx: number) => {
    let i = heap.length;
    heap.push(f, idx);
    while (i > 0) {
      const p = ((i / 2 - 1) >> 1) * 2;
      if (heap[p] <= heap[i]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      [heap[p + 1], heap[i + 1]] = [heap[i + 1], heap[p + 1]];
      i = p;
    }
  };
  const pop = (): number => {
    const top = heap[1];
    const lastIdx = heap.pop()!;
    const lastF = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = lastF;
      heap[1] = lastIdx;
      let i = 0;
      for (;;) {
        const l = i * 2 + 2;
        const r = l + 2;
        let m = i;
        if (l < heap.length && heap[l] < heap[m]) m = l;
        if (r < heap.length && heap[r] < heap[m]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        [heap[m + 1], heap[i + 1]] = [heap[i + 1], heap[m + 1]];
        i = m;
      }
    }
    return top;
  };

  const start = sy * n + sx;
  const goal = gy * n + gx;
  g[start] = 0;
  push(octile(sx, sy, gx, gy), start);
  let best = start;
  let bestH = octile(sx, sy, gx, gy);

  while (heap.length > 0) {
    const cur = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) {
      best = goal;
      break;
    }
    const cx = cur % n;
    const cy = (cur - cx) / n;
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(map, nx, ny, team)) continue;
      if (dx !== 0 && dy !== 0 && (!isWalkable(map, cx + dx, cy, team) || !isWalkable(map, cx, cy + dy, team))) continue;
      const ni = ny * n + nx;
      if (closed[ni]) continue;
      const ng = g[cur] + cost;
      if (ng >= g[ni]) continue;
      g[ni] = ng;
      from[ni] = cur;
      const h = octile(nx, ny, gx, gy);
      if (h < bestH) {
        bestH = h;
        best = ni;
      }
      push(ng + h, ni);
    }
  }

  const out: number[] = [];
  for (let i = best; i !== start && i !== -1; i = from[i]) {
    const x = i % n;
    out.push((i - x) / n, x);
  }
  return out.reverse();
}
