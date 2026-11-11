import { Tile } from '@kingsfall/shared';

/**
 * Paints detailed ground into a block picture, in 2 × 2 pixel cells like chunky pixel art:
 * grass in soft patches with blades, a darker forest floor with fallen leaves,
 * sandy banks and foam where land meets water, and water that deepens away from the shore.
 * Every cell is worked out from its position in the world, so blocks join without seams and the
 * coastline wanders a little instead of following the tile grid.
 */

export interface GroundSource {
  size: number;
  tiles: ArrayLike<number>;
  /** Whether a tile has been seen; unseen ground is left out. */
  seen: (index: number) => boolean;
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

const GRASS = ['#3d7630', '#447f34', '#4b8838', '#52913d', '#5a9a43', '#64a44a'].map(rgb);
const FOREST = ['#2d5424', '#325b27', '#38632b', '#406c2f'].map(rgb);
const LITTER = ['#5b4a29', '#6d5a31'].map(rgb);
const SAND = ['#c6b276', '#d2bf85', '#dccb93'].map(rgb);
const WATER = ['#2a5f97', '#2f6aa3', '#3474ad', '#3c80b8'].map(rgb);
const SHALLOW = ['#4a92c4', '#57a0cf'].map(rgb);
const FOAM = rgb('#d8edf3');
const WAVE = rgb('#6fb0dc');
const BLADE_DARK = rgb('#356a2a');
const BLADE_LIGHT = rgb('#78b456');

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1). */
function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

const NEIGHBOURS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];

/**
 * Distance from a point inside a tile at (fx, fy) to the nearest neighbouring tile of the other
 * kind, in tiles; `mask` has a bit set for each neighbour (in NEIGHBOURS order) of the other kind.
 */
function distanceTo(mask: number, fx: number, fy: number): number {
  let best = 1.5;
  for (let k = 0; k < 8; k++) {
    if (!(mask & (1 << k))) continue;
    const [dx, dy] = NEIGHBOURS[k];
    const ex = dx < 0 ? fx : dx > 0 ? 1 - fx : 0;
    const ey = dy < 0 ? fy : dy > 0 ? 1 - fy : 0;
    const d = dx !== 0 && dy !== 0 ? Math.sqrt(ex * ex + ey * ey) : ex + ey;
    if (d < best) best = d;
  }
  return best;
}

const pack = (c: [number, number, number]) => (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0];
const P = {
  grass: GRASS.map(pack), forest: FOREST.map(pack), litter: LITTER.map(pack), sand: SAND.map(pack), water: WATER.map(pack),
  shallow: SHALLOW.map(pack), foam: pack(FOAM), wave: pack(WAVE), bladeDark: pack(BLADE_DARK), bladeLight: pack(BLADE_LIGHT),
};

let buffer: ImageData | undefined;

/**
 * Paints the block of `chunk` × `chunk` tiles starting at tile (x0, y0) into `c`, whose top left is
 * `hw * chunk + 1` pixels left of the block's top corner.
 */
export function paintGround(c: CanvasRenderingContext2D, src: GroundSource, x0: number, y0: number, chunk: number, hw: number, hh: number): void {
  const w = c.canvas.width;
  const h = c.canvas.height;
  if (!buffer || buffer.width !== w || buffer.height !== h) buffer = c.createImageData(w, h);
  const px = new Uint32Array(buffer.data.buffer);
  px.fill(0);
  const n = src.size;
  // Per tile of the block: its kind, whether it is drawn, and which neighbours differ (water, forest).
  const kinds = new Uint8Array(chunk * chunk);
  const seen = new Uint8Array(chunk * chunk);
  const wetMask = new Uint8Array(chunk * chunk);
  const woodMask = new Uint8Array(chunk * chunk);
  for (let ly = 0; ly < chunk; ly++) {
    for (let lx = 0; lx < chunk; lx++) {
      const tx = x0 + lx;
      const ty = y0 + ly;
      const k = ly * chunk + lx;
      if (tx >= n || ty >= n) continue;
      const index = ty * n + tx;
      const tile = src.tiles[index];
      seen[k] = src.seen(index) ? 1 : 0;
      kinds[k] = tile;
      const wet = tile === Tile.Water;
      const wood = tile === Tile.Forest;
      for (let j = 0; j < 8; j++) {
        const x = tx + NEIGHBOURS[j][0];
        const y = ty + NEIGHBOURS[j][1];
        // Beyond the edge of the map counts as the same kind, so no beach runs along the border.
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const other = src.tiles[y * n + x];
        if ((other === Tile.Water) !== wet) wetMask[k] |= 1 << j;
        if ((other === Tile.Forest) !== wood) woodMask[k] |= 1 << j;
      }
    }
  }
  const ox = chunk * hw + 1;
  const half = chunk * hw;
  const tall = chunk * hh;
  // World pixel of the block's top corner, so the pattern carries on from block to block.
  const wx0 = (x0 - y0) * hw;
  const wy0 = (x0 + y0) * hh;
  for (let cy = 0; cy < h; cy += 2) {
    const v = cy;
    // Only the cells inside the block's diamond.
    const span = (1 - Math.abs(v - tall) / tall) * half + 2;
    const from = Math.max(0, (Math.floor((ox - span - 1) / 2) * 2));
    const to = Math.min(w, ox + span);
    const wyRow = wy0 + v;
    const cellY = Math.floor(wyRow / 2);
    for (let cx = from; cx < to; cx += 2) {
      const u = cx + 1 - ox;
      const ftx = (u / hw + v / hh) / 2;
      const fty = (v / hh - u / hw) / 2;
      const lx = Math.floor(ftx);
      const ly = Math.floor(fty);
      if (lx < 0 || ly < 0 || lx >= chunk || ly >= chunk) continue;
      const k = ly * chunk + lx;
      if (!seen[k]) continue;
      const fx = ftx - lx;
      const fy = fty - ly;
      const wx = wx0 + u;
      const wy = wyRow * 2;
      const cellX = Math.floor(wx / 2);
      const grain = hash(cellX, cellY);
      const tile = kinds[k];
      const wet = tile === Tile.Water;
      let color: number;
      // Signed distance to the shore, positive out in the water, with a wobble so it meanders.
      let shore = wet ? 1.5 : -1.5;
      if (wetMask[k]) {
        shore = distanceTo(wetMask[k], fx, fy) * (wet ? 1 : -1);
        shore += (noise(wx / 26, wy / 26) - 0.5) * 0.34;
      }
      if (shore > 0) {
        if (shore < 0.07) color = P.foam;
        else if (shore < 0.32) color = P.shallow[grain < 0.5 ? 0 : 1];
        else {
          const deep = noise(wx / 90, wy / 90);
          const depth = Math.min(1, (shore - 0.32) / 0.9) * 0.75 + deep * 0.35;
          color = P.water[Math.max(0, Math.min(3, 3 - Math.floor(depth * 4)))];
          // Short wave crests in rows, drifting with the depth.
          const row = cellY + Math.floor(deep * 6);
          if (row % 5 === 0 && hash(Math.floor(cellX / 3), row) < 0.32) color = P.wave;
        }
      } else if (shore > -0.17) {
        color = P.sand[Math.floor(grain * 3)];
      } else {
        const wooded = tile === Tile.Forest;
        let edge = wooded ? 1.5 : -1.5;
        if (woodMask[k]) {
          edge = distanceTo(woodMask[k], fx, fy) * (wooded ? 1 : -1);
          edge += (noise(wx / 18 + 40, wy / 18) - 0.5) * 0.4;
        }
        const soft = noise(wx / 230, wy / 230) * 0.55 + noise(wx / 55, wy / 55) * 0.3 + grain * 0.15;
        if (edge > 0) {
          color = grain < 0.07 ? P.litter[grain < 0.035 ? 0 : 1] : P.forest[Math.min(3, Math.floor(soft * 4))];
        } else if (grain < 0.025) {
          // Blades of grass: a dark stalk with a light tip above it.
          color = P.bladeDark;
        } else if (hash(cellX, cellY + 1) < 0.025) {
          color = P.bladeLight;
        } else {
          color = P.grass[Math.min(5, Math.floor(soft * 6))];
        }
      }
      const o = cy * w + cx;
      px[o] = color;
      if (cx + 1 < w) px[o + 1] = color;
      if (cy + 1 < h) {
        px[o + w] = color;
        if (cx + 1 < w) px[o + w + 1] = color;
      }
    }
  }
  c.putImageData(buffer, 0, 0);
}
