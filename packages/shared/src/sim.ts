import { GameMap, generateMap, inBounds, isWalkable } from './map';
import { findPath } from './path';

/** Simulation steps per second. The server is authoritative and runs this. */
export const TICK_RATE = 10;
export const TICK_MS = 1000 / TICK_RATE;

export const UNIT_KINDS = ['villager', 'king'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export interface UnitStats {
  hp: number;
  /** Tiles per second. */
  speed: number;
}

export const UNIT_STATS: Record<UnitKind, UnitStats> = {
  villager: { hp: 25, speed: 2.2 },
  king: { hp: 75, speed: 2.6 },
};

export interface Entity {
  id: number;
  owner: number;
  kind: UnitKind;
  /** Position in tile units; tile centres are at .5. */
  x: number;
  y: number;
  hp: number;
  /** Remaining waypoints as flat tile coordinates [x0, y0, x1, y1, ...]. */
  path: number[];
}

export interface GameState {
  tick: number;
  seed: number;
  map: GameMap;
  entities: Map<number, Entity>;
  nextId: number;
}

export type Command = { type: 'move'; ids: number[]; x: number; y: number };

export function createGame(seed: number): GameState {
  return { tick: 0, seed, map: generateMap(seed), entities: new Map(), nextId: 1 };
}

export function spawnUnit(state: GameState, owner: number, kind: UnitKind, tx: number, ty: number): Entity {
  const e: Entity = { id: state.nextId++, owner, kind, x: tx + 0.5, y: ty + 0.5, hp: UNIT_STATS[kind].hp, path: [] };
  state.entities.set(e.id, e);
  return e;
}

/** Gives a player their starting king and villagers around their start tile. */
export function spawnPlayer(state: GameState, slot: number): void {
  const [sx, sy] = state.map.starts[slot];
  const spots = freeTilesNear(state.map, sx, sy, 6);
  spawnUnit(state, slot, 'king', spots[0][0], spots[0][1]);
  for (let i = 1; i < spots.length; i++) spawnUnit(state, slot, 'villager', spots[i][0], spots[i][1]);
}

export function removePlayer(state: GameState, slot: number): void {
  for (const e of state.entities.values()) if (e.owner === slot) state.entities.delete(e.id);
}

/** The `count` walkable tiles nearest to a tile, found breadth-first. */
export function freeTilesNear(map: GameMap, tx: number, ty: number, count: number): [number, number][] {
  const out: [number, number][] = [];
  const cx = Math.min(map.size - 1, Math.max(0, tx));
  const cy = Math.min(map.size - 1, Math.max(0, ty));
  const seen = new Uint8Array(map.size * map.size);
  const queue: number[] = [cx, cy];
  seen[cy * map.size + cx] = 1;
  for (let i = 0; i < queue.length && out.length < count; i += 2) {
    const x = queue[i];
    const y = queue[i + 1];
    if (isWalkable(map, x, y)) out.push([x, y]);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(map, nx, ny) || seen[ny * map.size + nx]) continue;
      seen[ny * map.size + nx] = 1;
      queue.push(nx, ny);
    }
  }
  return out;
}

/** Applies a player's command. Units the player does not own are ignored. */
export function applyCommand(state: GameState, player: number, cmd: Command): void {
  if (cmd.type !== 'move') return;
  if (!Array.isArray(cmd.ids) || !Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) return;
  const units = cmd.ids
    .slice(0, 200)
    .map((id) => state.entities.get(id))
    .filter((e): e is Entity => !!e && e.owner === player);
  if (units.length === 0) return;
  // Each unit gets its own tile around the target so a group does not stack up.
  const spots = freeTilesNear(state.map, Math.floor(cmd.x), Math.floor(cmd.y), units.length);
  units.forEach((e, i) => {
    const spot = spots[i];
    if (!spot) return;
    e.path = findPath(state.map, Math.floor(e.x), Math.floor(e.y), spot[0], spot[1]);
  });
}

/** Advances the simulation by one tick. */
export function step(state: GameState): void {
  state.tick++;
  for (const e of state.entities.values()) {
    let budget = UNIT_STATS[e.kind].speed / TICK_RATE;
    while (budget > 0 && e.path.length >= 2) {
      const wx = e.path[0] + 0.5;
      const wy = e.path[1] + 0.5;
      const d = Math.hypot(wx - e.x, wy - e.y);
      if (d <= budget) {
        e.x = wx;
        e.y = wy;
        e.path.splice(0, 2);
        budget -= d;
      } else {
        e.x += ((wx - e.x) / d) * budget;
        e.y += ((wy - e.y) / d) * budget;
        budget = 0;
      }
    }
  }
}
