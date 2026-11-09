export const MAP_SIZE = 48;
export const MAX_PLAYERS = 4;

export const enum Tile {
  Grass = 0,
  Water = 1,
  Forest = 2,
}

export interface GameMap {
  size: number;
  tiles: Uint8Array;
  /** Start tile per player slot. */
  starts: [number, number][];
}

/** Small deterministic PRNG so server and clients build the same map from a seed. */
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
  return inBounds(map, tx, ty) && tileAt(map, tx, ty) === Tile.Grass;
}

export function generateMap(seed: number, size = MAP_SIZE): GameMap {
  const rand = mulberry32(seed);
  const tiles = new Uint8Array(size * size);
  const inset = 8;
  const far = size - 1 - inset;
  const starts: [number, number][] = [
    [inset, inset],
    [far, far],
    [far, inset],
    [inset, far],
  ];

  const blob = (tile: Tile, cx: number, cy: number, r: number, density: number) => {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.hypot(x - cx, y - cy) / r;
        if (d <= 1 && rand() < density * (1.25 - d)) tiles[y * size + x] = tile;
      }
    }
  };

  for (let i = 0; i < 4; i++) blob(Tile.Water, rand() * size, rand() * size, 3 + rand() * 3, 1);
  for (let i = 0; i < 22; i++) blob(Tile.Forest, rand() * size, rand() * size, 2 + rand() * 3, 0.8);

  // Keep every start area open so players always have room to build.
  for (const [sx, sy] of starts) {
    for (let y = sy - 6; y <= sy + 6; y++) {
      for (let x = sx - 6; x <= sx + 6; x++) {
        if (x >= 0 && y >= 0 && x < size && y < size && Math.hypot(x - sx, y - sy) <= 6) {
          tiles[y * size + x] = Tile.Grass;
        }
      }
    }
  }

  return { size, tiles, starts };
}
