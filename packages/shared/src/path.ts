import { GameMap, isWalkable } from './map';

const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

function octile(dx: number, dy: number): number {
  dx = Math.abs(dx);
  dy = Math.abs(dy);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

// Search buffers are kept between searches; `stamp` marks which entries belong to the current one.
let size = 0;
let g = new Float32Array(0);
let from = new Int32Array(0);
let seen = new Uint32Array(0);
let done = new Uint32Array(0);
let stamp = 0;

function prepare(n: number): void {
  if (n * n !== size) {
    size = n * n;
    g = new Float32Array(size);
    from = new Int32Array(size);
    seen = new Uint32Array(size);
    done = new Uint32Array(size);
    stamp = 0;
  }
  stamp++;
}

/** Binary heap of [f, index] pairs stored flat. */
class Heap {
  private a: number[] = [];
  get size(): number {
    return this.a.length;
  }
  push(f: number, idx: number): void {
    const a = this.a;
    let i = a.length;
    a.push(f, idx);
    while (i > 0) {
      const p = ((i / 2 - 1) >> 1) * 2;
      if (a[p] <= a[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      [a[p + 1], a[i + 1]] = [a[i + 1], a[p + 1]];
      i = p;
    }
  }
  pop(): number {
    const a = this.a;
    const top = a[1];
    const lastIdx = a.pop()!;
    const lastF = a.pop()!;
    if (a.length > 0) {
      a[0] = lastF;
      a[1] = lastIdx;
      let i = 0;
      for (;;) {
        const l = i * 2 + 2;
        const r = l + 2;
        let m = i;
        if (l < a.length && a[l] < a[m]) m = l;
        if (r < a.length && a[r] < a[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        [a[m + 1], a[i + 1]] = [a[i + 1], a[m + 1]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * A* over the tile grid, 8 directions, never cutting a corner of a blocked tile.
 * Searches from (sx, sy) until `isGoal` accepts a tile; `h` estimates the remaining distance.
 * Returns the path as flat tile coordinates [x0, y0, x1, y1, ...] without the start tile,
 * and whether a goal was reached. If none was, the path leads to the reachable tile with the
 * lowest estimate. Gates of the given team count as open.
 */
export function search(
  map: GameMap, sx: number, sy: number, isGoal: (x: number, y: number) => boolean, h: (x: number, y: number) => number, team = -1,
): { path: number[]; reached: boolean } {
  const n = map.size;
  prepare(n);
  const start = sy * n + sx;
  if (isGoal(sx, sy)) return { path: [], reached: true };
  const heap = new Heap();
  g[start] = 0;
  from[start] = -1;
  seen[start] = stamp;
  heap.push(h(sx, sy), start);
  let best = start;
  let bestH = h(sx, sy);
  let reached = false;

  while (heap.size > 0) {
    const cur = heap.pop();
    if (done[cur] === stamp) continue;
    done[cur] = stamp;
    const cx = cur % n;
    const cy = (cur - cx) / n;
    if (isGoal(cx, cy)) {
      best = cur;
      reached = true;
      break;
    }
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(map, nx, ny, team)) continue;
      if (dx !== 0 && dy !== 0 && (!isWalkable(map, cx + dx, cy, team) || !isWalkable(map, cx, cy + dy, team))) continue;
      const ni = ny * n + nx;
      if (done[ni] === stamp) continue;
      const ng = g[cur] + cost;
      if (seen[ni] === stamp && ng >= g[ni]) continue;
      seen[ni] = stamp;
      g[ni] = ng;
      from[ni] = cur;
      const hn = h(nx, ny);
      if (hn < bestH) {
        bestH = hn;
        best = ni;
      }
      heap.push(ng + hn, ni);
    }
  }

  const out: number[] = [];
  for (let i = best; i !== start && i !== -1; i = from[i]) {
    const x = i % n;
    out.push((i - x) / n, x);
  }
  return { path: out.reverse(), reached };
}

/** Path to a tile, or towards the reachable tile closest to it. */
export function findPath(map: GameMap, sx: number, sy: number, gx: number, gy: number, team = -1): number[] {
  return search(map, sx, sy, (x, y) => x === gx && y === gy, (x, y) => octile(x - gx, y - gy), team).path;
}

/**
 * Path to any walkable tile within `reach` tiles of a square area (its edge, not its centre),
 * or inside it when `inside` is set. Used to walk up to buildings, fields and resources.
 */
export function findPathToArea(
  map: GameMap, sx: number, sy: number, ax: number, ay: number, s: number, team = -1, inside = false, reach = 1,
): { path: number[]; reached: boolean } {
  // Distance in tiles from a tile to the area: 0 inside, 1 next to it, and so on.
  const gap = (x: number, y: number) => Math.max(ax - x, 0, x - (ax + s - 1), ay - y, 0, y - (ay + s - 1));
  const isGoal = inside ? (x: number, y: number) => gap(x, y) === 0 : (x: number, y: number) => {
    const d = gap(x, y);
    return d >= 1 && d <= reach;
  };
  const h = (x: number, y: number) => {
    const dx = Math.max(ax - x, 0, x - (ax + s - 1));
    const dy = Math.max(ay - y, 0, y - (ay + s - 1));
    return Math.max(0, octile(dx, dy) - (inside ? 0 : 1));
  };
  return search(map, sx, sy, isGoal, h, team);
}
