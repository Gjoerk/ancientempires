import type { Res } from './defs';

export const MAP_SIZE = 80;
/** Map sizes the host can choose from, in tiles along one edge. */
export const MAP_SIZES = { small: 96, medium: 128, large: 160 } as const;
export type MapSizeName = keyof typeof MAP_SIZES;
export const MAX_PLAYERS = 4;
/** Teams to choose from in the lobby; each has its own colour. */
export const MAX_TEAMS = 8;
/** Radius around each start tile kept free for the town centre and castle. */
const BASE_RADIUS = 9;

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
  /** 1 where a building stands that units cannot walk through. */
  blocked: Uint8Array;
  /** 1 where any building stands, fields included: nothing else can be built there. */
  footprint: Uint8Array;
  /** Where a gate stands: the team that may walk through it, plus 1. */
  gate: Uint8Array;
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

/** Whether a unit can stand on a tile. With a team given, that team's gates count as open. */
/** Marks or clears the tiles a building covers. */
export function markBuilding(map: GameMap, x0: number, y0: number, size: number, walkable: boolean, value: number): void {
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      if (!inBounds(map, x, y)) continue;
      map.footprint[y * map.size + x] = value;
      if (!walkable) map.blocked[y * map.size + x] = value;
    }
  }
}

export function isWalkable(map: GameMap, tx: number, ty: number, team = -1): boolean {
  if (!inBounds(map, tx, ty)) return false;
  const i = ty * map.size + tx;
  return map.tiles[i] === Tile.Grass && (map.blocked[i] === 0 || (team >= 0 && map.gate[i] === team + 1));
}

export function generateMap(seed: number, size = MAP_SIZE): GameMap {
  const rand = mulberry32(seed);
  const tiles = new Uint8Array(size * size);
  // Towns go anywhere on the map, at random, as long as they keep a fair distance from each other;
  // if the dice can't manage that the distance is relaxed a little at a time.
  const inset = 14;
  const room = size - 1 - inset * 2;
  const starts: [number, number][] = [];
  let apart = size * 0.5;
  for (let tries = 0; starts.length < 4; tries++) {
    if (tries > 0 && tries % 300 === 0) {
      apart *= 0.95;
      starts.length = 0;
    }
    const p: [number, number] = [inset + Math.floor(rand() * (room + 1)), inset + Math.floor(rand() * (room + 1))];
    if (starts.every(([x, y]) => Math.hypot(x - p[0], y - p[1]) >= apart)) starts.push(p);
  }
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

  // The amount of scenery grows with the area of the map.
  const area = (size * size) / (80 * 80);
  for (let i = 0; i < Math.round(9 * area); i++) blob(Tile.Water, rand() * size, rand() * size, 3 + rand() * 3, 1, 15);
  for (let i = 0; i < Math.round(52 * area); i++) blob(Tile.Forest, rand() * size, rand() * size, 2 + rand() * 3, 0.8, 9);
  for (let i = 0; i < Math.round(10 * area); i++) blob(Tile.Gold, 6 + rand() * (size - 12), 6 + rand() * (size - 12), 1.5, 0.8, 12);
  for (let i = 0; i < Math.round(9 * area); i++) blob(Tile.Stone, 6 + rand() * (size - 12), 6 + rand() * (size - 12), 1.5, 0.8, 12);

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
      if (x < 1 || y < 1 || x >= size - 1 || y >= size - 1 || nearStart(x, y, BASE_RADIUS) || tiles[y * size + x] === tile) continue;
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
    blob(Tile.Forest, ...spot(0.22, 13.5), 2.8, 1, BASE_RADIUS);
    blob(Tile.Forest, ...spot(0.85, 13.5), 2.6, 1, BASE_RADIUS);
    patch(Tile.Berries, ...spot(0, 10), 6);
    patch(Tile.Gold, ...spot(0.45, 11.5), 5);
    patch(Tile.Stone, ...spot(0.65, 11.5), 4);
  }

  const amount = new Uint16Array(size * size);
  for (let i = 0; i < tiles.length; i++) amount[i] = TILE_RESOURCE[tiles[i] as Tile]?.amount ?? 0;
  return { size, tiles, amount, blocked: new Uint8Array(size * size), footprint: new Uint8Array(size * size), gate: new Uint8Array(size * size), starts };
}
