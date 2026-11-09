import type { Res } from './defs';

export const MAP_SIZE = 64;
export const MAX_PLAYERS = 4;

export const Tile = { Grass: 0, Water: 1, Forest: 2, Berries: 3, Gold: 4, Stone: 5 } as const;
export type Tile = (typeof Tile)[keyof typeof Tile];

/** Which resource a tile yields, and how much it holds when the map is made. */
export const TILE_RESOURCE: Partial<Record<Tile, { res: Res; amount: number }>> = {
  [Tile.Forest]: { res: 'wood', amount: 100 },
  [Tile.Berries]: { res: 'food', amount: 200 },
  [Tile.Gold]: { res: 'gold', amount: 500 },
  [Tile.Stone]: { res: 'stone', amount: 400 },
};

export interface GameMap {
  size: number;
  tiles: Uint8Array;
  /** Resources left in each tile. */
  amount: Uint16Array;
  /** 1 where a building stands. */
  blocked: Uint8Array;
  /** Start tile per player slot. */
  starts: [number, number][];
}

/** Small deterministic PRNG so host and guests build the same map from a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function inBounds(map: GameMap, tx: number, ty: number): boolean {
  return tx >= 0 && ty >= 0 && tx < map.size && ty < map.size;
}

export function tileAt(map: GameMap, tx: number, ty: number): Tile {
  return map.tiles[ty * map.size + tx] as Tile;
}

export function isWalkable(map: GameMap, tx: number, ty: number): boolean {
  if (!inBounds(map, tx, ty)) return false;
  const i = ty * map.size + tx;
  return map.tiles[i] === Tile.Grass && map.blocked[i] === 0;
}

export function generateMap(seed: number, size = MAP_SIZE): GameMap {
  const rand = mulberry32(seed);
  const tiles = new Uint8Array(size * size);
  const inset = 10;
  const far = size - 1 - inset;
  const starts: [number, number][] = [
    [inset, inset],
    [far, far],
    [far, inset],
    [inset, far],
  ];
  const nearStart = (x: number, y: number, r: number) => starts.some(([sx, sy]) => Math.hypot(x - sx, y - sy) <= r);

  const blob = (tile: Tile, cx: number, cy: number, r: number, density: number, keepOut: number) => {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= size || y >= size || nearStart(x, y, keepOut)) continue;
        const d = Math.hypot(x - cx, y - cy) / r;
        if (d <= 1 && rand() < density * (1.25 - d)) tiles[y * size + x] = tile;
      }
    }
  };

  for (let i = 0; i < 6; i++) blob(Tile.Water, rand() * size, rand() * size, 3 + rand() * 3, 1, 12);
  for (let i = 0; i < 34; i++) blob(Tile.Forest, rand() * size, rand() * size, 2 + rand() * 3, 0.8, 7);
  for (let i = 0; i < 7; i++) blob(Tile.Gold, 6 + rand() * (size - 12), 6 + rand() * (size - 12), 1.5, 0.8, 12);
  for (let i = 0; i < 6; i++) blob(Tile.Stone, 6 + rand() * (size - 12), 6 + rand() * (size - 12), 1.5, 0.8, 12);

  // A connected patch of exactly `count` tiles, grown outwards from a centre.
  const patch = (tile: Tile, cx: number, cy: number, count: number) => {
    const clamp = (v: number) => Math.max(1, Math.min(size - 2, Math.round(v)));
    const cells: [number, number][] = [[clamp(cx), clamp(cy)]];
    tiles[cells[0][1] * size + cells[0][0]] = tile;
    for (let tries = 0; cells.length < count && tries < 400; tries++) {
      const [bx, by] = cells[Math.floor(rand() * cells.length)];
      const [dx, dy] = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(rand() * 4)];
      const x = bx + dx;
      const y = by + dy;
      if (x < 1 || y < 1 || x >= size - 1 || y >= size - 1 || nearStart(x, y, 3.6) || tiles[y * size + x] === tile) continue;
      tiles[y * size + x] = tile;
      cells.push([x, y]);
    }
  };

  // Every player gets the same starting resources at a random angle around their base.
  for (const [sx, sy] of starts) {
    const base = rand() * Math.PI * 2;
    const spot = (turn: number, dist: number): [number, number] => {
      const a = base + turn * Math.PI * 2;
      return [sx + Math.cos(a) * dist, sy + Math.sin(a) * dist];
    };
    blob(Tile.Forest, ...spot(0.22, 8), 2.6, 1, 3.6);
    blob(Tile.Forest, ...spot(0.85, 8.5), 2.4, 1, 3.6);
    patch(Tile.Berries, ...spot(0, 5.5), 6);
    patch(Tile.Gold, ...spot(0.45, 7), 5);
    patch(Tile.Stone, ...spot(0.65, 7), 4);
  }

  const amount = new Uint16Array(size * size);
  for (let i = 0; i < tiles.length; i++) amount[i] = TILE_RESOURCE[tiles[i] as Tile]?.amount ?? 0;
  return { size, tiles, amount, blocked: new Uint8Array(size * size), starts };
}
