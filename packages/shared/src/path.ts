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

/** Binary heap of (f, index) pairs in typed arrays, kept between searches. */
class Heap {
  private f = new Float64Array(1024);
  private idx = new Int32Array(1024);
  size = 0;
  clear(): void {
    this.size = 0;
  }
  push(f: number, index: number): void {
    if (this.size === this.f.length) {
      const nf = new Float64Array(this.size * 2);
      nf.set(this.f);
      this.f = nf;
      const ni = new Int32Array(this.size * 2);
      ni.set(this.idx);
      this.idx = ni;
    }
    const F = this.f;
    const I = this.idx;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (F[p] <= f) break;
      F[i] = F[p];
      I[i] = I[p];
      i = p;
    }
    F[i] = f;
    I[i] = index;
  }
  pop(): number {
    const F = this.f;
    const I = this.idx;
    const top = I[0];
    const n = --this.size;
    if (n > 0) {
      const f = F[n];
      const index = I[n];
      let i = 0;
      for (;;) {
        let m = i * 2 + 1;
        if (m >= n) break;
        if (m + 1 < n && F[m + 1] < F[m]) m++;
        if (F[m] >= f) break;
        F[i] = F[m];
        I[i] = I[m];
        i = m;
      }
      F[i] = f;
      I[i] = index;
    }
    return top;
  }
}
const heap = new Heap();

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
  heap.clear();
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
 * How far every tile is from (gx, gy), walking, for a whole group sent there at once: one search for
 * all of them instead of one each (see pathDown). Unreachable tiles are Infinity.
 */
export function distanceField(map: GameMap, gx: number, gy: number, team = -1): Float32Array {
  const n = map.size;
  const dist = new Float32Array(n * n).fill(Infinity);
  if (gx < 0 || gy < 0 || gx >= n || gy >= n) return dist;
  heap.clear();
  dist[gy * n + gx] = 0;
  heap.push(0, gy * n + gx);
  while (heap.size > 0) {
    const cur = heap.pop();
    const cx = cur % n;
    const cy = (cur - cx) / n;
    const d = dist[cur];
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(map, nx, ny, team)) continue;
      if (dx !== 0 && dy !== 0 && (!isWalkable(map, cx + dx, cy, team) || !isWalkable(map, cx, cy + dy, team))) continue;
      const ni = ny * n + nx;
      if (dist[ni] <= d + cost) continue;
      dist[ni] = d + cost;
      heap.push(d + cost, ni);
    }
  }
  return dist;
}

/**
 * A path from (sx, sy) to (tx, ty) using a distance field towards a spot near (tx, ty): downhill
 * until close to the target, then a short search for the last steps. Same path as a search would
 * find, at a fraction of the cost when many units share the field.
 */
export function pathDown(map: GameMap, field: Float32Array, sx: number, sy: number, tx: number, ty: number, team = -1): number[] {
  const n = map.size;
  const out: number[] = [];
  let cx = sx;
  let cy = sy;
  if (!Number.isFinite(field[cy * n + cx])) return findPath(map, sx, sy, tx, ty, team);
  for (let guard = 0; guard < n * 4 && Math.max(Math.abs(cx - tx), Math.abs(cy - ty)) > 2; guard++) {
    let best = -1;
    let bestD = field[cy * n + cx];
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(map, nx, ny, team)) continue;
      if (dx !== 0 && dy !== 0 && (!isWalkable(map, cx + dx, cy, team) || !isWalkable(map, cx, cy + dy, team))) continue;
      const d = field[ny * n + nx];
      if (d < bestD) [best, bestD] = [ny * n + nx, d];
    }
    if (best < 0) break;
    cx = best % n;
    cy = (best - cx) / n;
    out.push(cx, cy);
    // Past the target, towards the middle of the group: the rest is the short search.
    if (field[cy * n + cx] <= field[ty * n + tx]) break;
  }
  return out.concat(cx === tx && cy === ty ? [] : findPath(map, cx, cy, tx, ty, team));
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

// Walking areas: every walkable tile is labelled with the connected area it belongs to, per team
// (a team walks through its own gates). Asking whether a unit can get somewhere at all is then
// instant, instead of a search that floods the whole map before giving up.
const areas = new WeakMap<GameMap, { version: number; byTeam: Map<number, Int32Array> }>();

function areaLabels(map: GameMap, team: number): Int32Array {
  let cache = areas.get(map);
  if (!cache || cache.version !== map.version) {
    cache = { version: map.version, byTeam: new Map() };
    areas.set(map, cache);
  }
  let labels = cache.byTeam.get(team);
  if (labels) return labels;
  const n = map.size;
  labels = new Int32Array(n * n);
  const queue = new Int32Array(n * n);
  let next = 0;
  for (let i = 0; i < n * n; i++) {
    if (labels[i] !== 0 || !isWalkable(map, i % n, (i / n) | 0, team)) continue;
    next++;
    labels[i] = next;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % n;
      const cy = (cur - cx) / n;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!isWalkable(map, nx, ny, team)) continue;
        if (dx !== 0 && dy !== 0 && (!isWalkable(map, cx + dx, cy, team) || !isWalkable(map, cx, cy + dy, team))) continue;
        const ni = ny * n + nx;
        if (labels[ni] !== 0) continue;
        labels[ni] = next;
        queue[tail++] = ni;
      }
    }
  }
  cache.byTeam.set(team, labels);
  return labels;
}

/** The walking area a tile belongs to, or 0 where nobody can stand. */
export function areaAt(map: GameMap, x: number, y: number, team = -1): number {
  if (x < 0 || y < 0 || x >= map.size || y >= map.size) return 0;
  return areaLabels(map, team)[y * map.size + x];
}

/**
 * Whether someone at (sx, sy) can walk to the tile (gx, gy), or right next to the square area
 * at (gx, gy) of size `s`. Someone standing where nobody can stand (just freed from a building
 * site, say) is given the benefit of the doubt.
 */
export function canReach(map: GameMap, sx: number, sy: number, gx: number, gy: number, team = -1, s = 0): boolean {
  const from = areaAt(map, sx, sy, team);
  if (from === 0) return true;
  if (s === 0) return areaAt(map, gx, gy, team) === from;
  for (let y = gy - 1; y <= gy + s; y++) {
    for (let x = gx - 1; x <= gx + s; x++) {
      const edge = x === gx - 1 || x === gx + s || y === gy - 1 || y === gy + s;
      if (edge && areaAt(map, x, y, team) === from) return true;
    }
  }
  return false;
}

/**
 * The tile nearest to (gx, gy) that someone at (sx, sy) can walk to: (gx, gy) itself when it can
 * be reached, otherwise the closest tile of the walker's own area, looked for ring by ring.
 */
export function nearestReachable(map: GameMap, sx: number, sy: number, gx: number, gy: number, team = -1): [number, number] {
  const from = areaAt(map, sx, sy, team);
  if (from === 0 || areaAt(map, gx, gy, team) === from) return [gx, gy];
  for (let ring = 1; ring < map.size; ring++) {
    let best: [number, number] | undefined;
    let bestD = Infinity;
    for (let y = gy - ring; y <= gy + ring; y++) {
      for (let x = gx - ring; x <= gx + ring; x++) {
        if (Math.max(Math.abs(x - gx), Math.abs(y - gy)) !== ring || areaAt(map, x, y, team) !== from) continue;
        const d = Math.hypot(x - gx, y - gy);
        if (d < bestD) {
          bestD = d;
          best = [x, y];
        }
      }
    }
    if (best) return best;
  }
  return [sx, sy];
}
