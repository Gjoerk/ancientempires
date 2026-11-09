import {
  CARRY_CAPACITY, Cost, DEFS, FARM_RATE, GATHER_RATE, Kind, KINDS, POP_MAX, QUEUE_MAX, Res, RESOURCES, START_RESOURCES,
} from './defs';
import { GameMap, generateMap, inBounds, isWalkable, Tile, TILE_RESOURCE } from './map';
import { findPath } from './path';

/** Simulation steps per second. The host runs this; guests only draw snapshots. */
export const TICK_RATE = 10;
export const TICK_MS = 1000 / TICK_RATE;

export type Order =
  | { t: 'idle' }
  | { t: 'move' }
  /** Gather from a resource tile, or from a farm when `farm` is set. */
  | { t: 'gather'; tile: number; farm: number; res: Res; phase: 'go' | 'work' | 'return'; drop: number }
  | { t: 'build'; id: number }
  | { t: 'attack'; id: number; auto: boolean };

export interface Entity {
  id: number;
  owner: number;
  kind: Kind;
  /** Units: position in tile units (tile centres at .5). Buildings: top-left tile. */
  x: number;
  y: number;
  hp: number;
  /** Remaining waypoints as flat tile coordinates [x0, y0, x1, y1, ...]. */
  path: number[];
  order: Order;
  /** Ticks until the next attack. */
  cooldown: number;
  carry: number;
  carryRes: Res;
  /** Fraction of the next resource unit already gathered. */
  work: number;
  /** Construction progress, 1 when finished. Always 1 for units. */
  progress: number;
  queue: Kind[];
  trainTicks: number;
}

export interface PlayerState {
  slot: number;
  res: Record<Res, number>;
  pop: number;
  cap: number;
  defeated: boolean;
}

export interface GameState {
  tick: number;
  seed: number;
  map: GameMap;
  entities: Map<number, Entity>;
  players: Map<number, PlayerState>;
  nextId: number;
  /** Tiles that differ from the generated map, for players who join later. */
  changedTiles: Map<number, number>;
  /** Tile changes and ranged shots of the current tick, for the snapshot. */
  tileEvents: [number, number][];
  shots: [number, number][];
  /** True once two players have been in the game together. */
  contested: boolean;
  /** Slot of the last king standing, or -1. */
  winner: number;
}

export type Command =
  | { type: 'move'; ids: number[]; x: number; y: number }
  | { type: 'gather'; ids: number[]; tile: number }
  | { type: 'interact'; ids: number[]; target: number }
  | { type: 'place'; ids: number[]; kind: Kind; x: number; y: number }
  | { type: 'train'; building: number; kind: Kind }
  | { type: 'cancel'; building: number };

interface Rect { x: number; y: number; s: number }

const isBuilding = (e: Entity) => DEFS[e.kind].building === true;
const sizeOf = (e: Entity) => DEFS[e.kind].size ?? 1;
const rectOf = (e: Entity): Rect => ({ x: e.x, y: e.y, s: sizeOf(e) });
const tileRect = (map: GameMap, tile: number): Rect => ({ x: tile % map.size, y: Math.floor(tile / map.size), s: 1 });

export function createGame(seed: number): GameState {
  return {
    tick: 0, seed, map: generateMap(seed), entities: new Map(), players: new Map(), nextId: 1,
    changedTiles: new Map(), tileEvents: [], shots: [], contested: false, winner: -1,
  };
}

export function spawn(state: GameState, owner: number, kind: Kind, tx: number, ty: number, built = true): Entity {
  const def = DEFS[kind];
  const e: Entity = {
    id: state.nextId++, owner, kind,
    x: def.building ? tx : tx + 0.5, y: def.building ? ty : ty + 0.5,
    hp: built ? def.hp : 1, path: [], order: { t: 'idle' }, cooldown: 0,
    carry: 0, carryRes: 'food', work: 0, progress: built ? 1 : 0, queue: [], trainTicks: 0,
  };
  state.entities.set(e.id, e);
  if (def.building) setBlocked(state.map, rectOf(e), 1);
  return e;
}

function setBlocked(map: GameMap, r: Rect, value: number): void {
  for (let y = r.y; y < r.y + r.s; y++) for (let x = r.x; x < r.x + r.s; x++) map.blocked[y * map.size + x] = value;
}

function kill(state: GameState, e: Entity): void {
  if (!state.entities.delete(e.id)) return;
  if (isBuilding(e)) setBlocked(state.map, rectOf(e), 0);
}

/** Gives a player their town centre, king, villagers and starting resources. */
export function addPlayer(state: GameState, slot: number): void {
  state.players.set(slot, { slot, res: { ...START_RESOURCES }, pop: 0, cap: 0, defeated: false });
  const [sx, sy] = state.map.starts[slot];
  spawn(state, slot, 'towncenter', sx - 1, sy - 1);
  const spots = freeTilesNear(state.map, sx, sy + 2, 5);
  spawn(state, slot, 'king', spots[0][0], spots[0][1]);
  for (let i = 1; i < spots.length; i++) spawn(state, slot, 'villager', spots[i][0], spots[i][1]);
  if ([...state.players.values()].filter((p) => !p.defeated).length >= 2) state.contested = true;
}

export function removePlayer(state: GameState, slot: number): void {
  for (const e of [...state.entities.values()]) if (e.owner === slot) kill(state, e);
  state.players.delete(slot);
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

export function canAfford(player: PlayerState, cost: Cost): boolean {
  return RESOURCES.every((r) => player.res[r] >= (cost[r] ?? 0));
}

function pay(player: PlayerState, cost: Cost, sign = -1): void {
  for (const r of RESOURCES) player.res[r] += sign * (cost[r] ?? 0);
}

/** Whether a building of this kind fits with its top-left corner on a tile. */
export function canPlace(map: GameMap, kind: Kind, tx: number, ty: number): boolean {
  const s = DEFS[kind].size ?? 1;
  for (let y = ty; y < ty + s; y++) for (let x = tx; x < tx + s; x++) if (!isWalkable(map, x, y)) return false;
  return true;
}

// --- geometry ----------------------------------------------------------------

function centre(e: Entity): [number, number] {
  const half = isBuilding(e) ? sizeOf(e) / 2 : 0;
  return [e.x + half, e.y + half];
}

/** Distance from an attacker's centre to the nearest point of the target. */
function distance(from: Entity, to: Entity): number {
  const [fx, fy] = centre(from);
  const s = isBuilding(to) ? sizeOf(to) : 0;
  const dx = Math.max(to.x - fx, 0, fx - (to.x + s));
  const dy = Math.max(to.y - fy, 0, fy - (to.y + s));
  return Math.hypot(dx, dy);
}

function isAdjacent(e: Entity, r: Rect): boolean {
  const tx = Math.floor(e.x);
  const ty = Math.floor(e.y);
  return tx >= r.x - 1 && tx <= r.x + r.s && ty >= r.y - 1 && ty <= r.y + r.s;
}

/** Sends a unit to the nearest reachable tile next to a rectangle. False if there is none. */
function goAdjacent(state: GameState, e: Entity, r: Rect): boolean {
  if (isAdjacent(e, r)) {
    e.path = [];
    return true;
  }
  const ex = Math.floor(e.x);
  const ey = Math.floor(e.y);
  const ring: [number, number, number][] = [];
  for (let y = r.y - 1; y <= r.y + r.s; y++) {
    for (let x = r.x - 1; x <= r.x + r.s; x++) {
      const inside = x >= r.x && x < r.x + r.s && y >= r.y && y < r.y + r.s;
      if (!inside && isWalkable(state.map, x, y)) ring.push([x, y, Math.hypot(x - ex, y - ey)]);
    }
  }
  ring.sort((a, b) => a[2] - b[2]);
  for (const [x, y] of ring.slice(0, 4)) {
    const path = findPath(state.map, ex, ey, x, y);
    if (path.length >= 2 && path[path.length - 2] === x && path[path.length - 1] === y) {
      e.path = path;
      return true;
    }
  }
  return false;
}

function nearestResourceTile(map: GameMap, from: number, res: Res, radius: number): number {
  const fx = from % map.size;
  const fy = Math.floor(from / map.size);
  let best = -1;
  let bestD = Infinity;
  for (let y = Math.max(0, fy - radius); y <= Math.min(map.size - 1, fy + radius); y++) {
    for (let x = Math.max(0, fx - radius); x <= Math.min(map.size - 1, fx + radius); x++) {
      const i = y * map.size + x;
      if (TILE_RESOURCE[map.tiles[i] as Tile]?.res !== res) continue;
      const d = Math.hypot(x - fx, y - fy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  return best;
}

function farmIsFree(state: GameState, farm: Entity, except: Entity): boolean {
  for (const e of state.entities.values()) {
    if (e !== except && e.order.t === 'gather' && e.order.farm === farm.id) return false;
  }
  return true;
}

// --- commands ----------------------------------------------------------------

function ownUnits(state: GameState, player: number, ids: unknown): Entity[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .slice(0, 200)
    .map((id) => state.entities.get(id))
    .filter((e): e is Entity => !!e && e.owner === player && !isBuilding(e));
}

function moveUnits(state: GameState, units: Entity[], x: number, y: number): void {
  // Each unit gets its own tile around the target so a group does not stack up.
  const spots = freeTilesNear(state.map, Math.floor(x), Math.floor(y), units.length);
  units.forEach((e, i) => {
    const spot = spots[i];
    if (!spot) return;
    e.path = findPath(state.map, Math.floor(e.x), Math.floor(e.y), spot[0], spot[1]);
    e.order = { t: 'move' };
  });
}

function gatherOrder(tile: number, farm: number, res: Res): Order {
  return { t: 'gather', tile, farm, res, phase: 'go', drop: -1 };
}

/** Applies a player's command. Anything the player may not do is ignored. */
export function applyCommand(state: GameState, slot: number, cmd: Command): void {
  const player = state.players.get(slot);
  if (!player || player.defeated || !cmd) return;
  const map = state.map;

  if (cmd.type === 'move') {
    if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) return;
    moveUnits(state, ownUnits(state, slot, cmd.ids), cmd.x, cmd.y);
  } else if (cmd.type === 'gather') {
    const tile = cmd.tile;
    if (!Number.isInteger(tile) || tile < 0 || tile >= map.tiles.length) return;
    const res = TILE_RESOURCE[map.tiles[tile] as Tile]?.res;
    const units = ownUnits(state, slot, cmd.ids);
    const r = tileRect(map, tile);
    if (!res) return moveUnits(state, units, r.x, r.y);
    // Spread a group over the neighbouring tiles of the same resource.
    const patch: number[] = [];
    for (let y = r.y - 2; y <= r.y + 2; y++) {
      for (let x = r.x - 2; x <= r.x + 2; x++) {
        if (inBounds(map, x, y) && TILE_RESOURCE[map.tiles[y * map.size + x] as Tile]?.res === res) patch.push(y * map.size + x);
      }
    }
    const dist = (i: number) => Math.hypot((i % map.size) - r.x, Math.floor(i / map.size) - r.y);
    patch.sort((a, b) => dist(a) - dist(b));
    const workers = units.filter((e) => e.kind === 'villager');
    workers.forEach((e, i) => {
      e.order = gatherOrder(patch[i % patch.length], -1, res);
      e.path = [];
    });
    moveUnits(state, units.filter((e) => e.kind !== 'villager'), r.x, r.y);
  } else if (cmd.type === 'interact') {
    const target = state.entities.get(cmd.target);
    if (!target) return;
    for (const e of ownUnits(state, slot, cmd.ids)) {
      e.path = [];
      if (target.owner !== slot) {
        if (DEFS[e.kind].attack) e.order = { t: 'attack', id: target.id, auto: false };
      } else if (isBuilding(target) && e.kind === 'villager' && target.progress < 1) {
        e.order = { t: 'build', id: target.id };
      } else if (target.kind === 'farm' && e.kind === 'villager' && farmIsFree(state, target, e)) {
        e.order = gatherOrder(-1, target.id, 'food');
      } else if (isBuilding(target)) {
        if (e.kind === 'villager' && e.carry > 0 && DEFS[target.kind].dropoff) {
          // Deliver what is carried, then stand by.
          e.order = { t: 'gather', tile: -1, farm: -1, res: e.carryRes, phase: 'return', drop: target.id };
        } else {
          goAdjacent(state, e, rectOf(target));
          e.order = { t: 'move' };
        }
      } else {
        moveUnits(state, [e], target.x, target.y);
      }
    }
  } else if (cmd.type === 'place') {
    const def = DEFS[cmd.kind];
    if (!def?.building || !Number.isInteger(cmd.x) || !Number.isInteger(cmd.y)) return;
    const builders = ownUnits(state, slot, cmd.ids).filter((e) => e.kind === 'villager');
    if (builders.length === 0 || !canPlace(map, cmd.kind, cmd.x, cmd.y) || !canAfford(player, def.cost)) return;
    pay(player, def.cost);
    const site = spawn(state, slot, cmd.kind, cmd.x, cmd.y, false);
    for (const e of builders) {
      e.order = { t: 'build', id: site.id };
      e.path = [];
    }
  } else if (cmd.type === 'train') {
    const b = state.entities.get(cmd.building);
    const def = DEFS[cmd.kind];
    if (!b || b.owner !== slot || b.progress < 1 || !def || !DEFS[b.kind].trains?.includes(cmd.kind)) return;
    if (b.queue.length >= QUEUE_MAX || !canAfford(player, def.cost)) return;
    pay(player, def.cost);
    b.queue.push(cmd.kind);
  } else if (cmd.type === 'cancel') {
    const b = state.entities.get(cmd.building);
    if (!b || b.owner !== slot || b.queue.length === 0) return;
    const kind = b.queue.pop()!;
    pay(player, DEFS[kind].cost, 1);
    if (b.queue.length === 0) b.trainTicks = 0;
  }
}

// --- simulation --------------------------------------------------------------

function findEnemy(state: GameState, e: Entity, reach: number): Entity | undefined {
  let best: Entity | undefined;
  let bestScore = Infinity;
  for (const other of state.entities.values()) {
    if (other.owner === e.owner) continue;
    const d = distance(e, other);
    if (d > reach) continue;
    // Prefer units over buildings at a similar distance.
    const score = isBuilding(other) ? d + 4 : d;
    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}

function strike(state: GameState, e: Entity, target: Entity): void {
  const def = DEFS[e.kind];
  const dmg = Math.max(1, (def.attack ?? 0) + (def.bonus?.[target.kind] ?? 0) - (DEFS[target.kind].armor ?? 0));
  e.cooldown = Math.round((def.cooldown ?? 1.5) * TICK_RATE);
  if ((def.range ?? 0) > 2) state.shots.push([e.id, target.id]);
  target.hp -= dmg;
  if (target.hp <= 0) kill(state, target);
}

function depleteTile(state: GameState, tile: number): void {
  state.map.tiles[tile] = Tile.Grass;
  state.changedTiles.set(tile, Tile.Grass);
  state.tileEvents.push([tile, Tile.Grass]);
}

function nearestDropoff(state: GameState, e: Entity): Entity | undefined {
  let best: Entity | undefined;
  let bestD = Infinity;
  for (const b of state.entities.values()) {
    if (b.owner !== e.owner || !DEFS[b.kind].dropoff || b.progress < 1) continue;
    const d = distance(e, b);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

function stepGather(state: GameState, e: Entity, o: Extract<Order, { t: 'gather' }>): void {
  const map = state.map;
  const farm = o.farm >= 0 ? state.entities.get(o.farm) : undefined;

  if (o.phase === 'return') {
    let drop = state.entities.get(o.drop);
    if (!drop) {
      drop = nearestDropoff(state, e);
      if (!drop) return void (e.order = { t: 'idle' });
      o.drop = drop.id;
      e.path = [];
    }
    if (e.path.length > 0) return;
    if (isAdjacent(e, rectOf(drop))) {
      state.players.get(e.owner)!.res[e.carryRes] += e.carry;
      e.carry = 0;
      if (o.tile < 0 && o.farm < 0) e.order = { t: 'idle' };
      else o.phase = 'go';
    } else if (!goAdjacent(state, e, rectOf(drop))) {
      e.order = { t: 'idle' };
    }
    return;
  }

  // Make sure the source still exists; otherwise look for more of the same nearby.
  let rect: Rect;
  if (o.farm >= 0) {
    if (!farm || farm.progress < 1) return void (e.order = { t: 'idle' });
    rect = rectOf(farm);
  } else {
    if (TILE_RESOURCE[map.tiles[o.tile] as Tile]?.res !== o.res) {
      const next = nearestResourceTile(map, o.tile, o.res, 8);
      if (next < 0) {
        if (e.carry > 0) {
          o.tile = -1;
          o.phase = 'return';
          o.drop = -1;
        } else e.order = { t: 'idle' };
        return;
      }
      o.tile = next;
      o.phase = 'go';
      e.path = [];
    }
    rect = tileRect(map, o.tile);
  }

  if (o.phase === 'go') {
    if (e.path.length > 0) return;
    if (isAdjacent(e, rect)) {
      o.phase = 'work';
      if (e.carryRes !== o.res) {
        e.carry = 0;
        e.carryRes = o.res;
      }
    } else if (!goAdjacent(state, e, rect)) {
      e.order = { t: 'idle' };
    }
    return;
  }

  // phase 'work'
  e.work += (o.farm >= 0 ? FARM_RATE : GATHER_RATE) / TICK_RATE;
  while (e.work >= 1 && e.carry < CARRY_CAPACITY) {
    e.work -= 1;
    e.carry++;
    if (o.farm < 0 && --map.amount[o.tile] <= 0) {
      depleteTile(state, o.tile);
      break;
    }
  }
  if (e.carry >= CARRY_CAPACITY) {
    o.phase = 'return';
    o.drop = -1;
  } else if (o.farm < 0 && map.tiles[o.tile] === Tile.Grass) {
    o.phase = 'go';
  }
}

function stepBuild(state: GameState, e: Entity, o: Extract<Order, { t: 'build' }>): void {
  const site = state.entities.get(o.id);
  if (!site) return void (e.order = { t: 'idle' });
  if (site.progress >= 1) {
    if (site.kind === 'farm' && farmIsFree(state, site, e)) return void (e.order = gatherOrder(-1, site.id, 'food'));
    // Help with another unfinished building close by, if there is one.
    for (const other of state.entities.values()) {
      if (other.owner === e.owner && other.progress < 1 && distance(e, other) < 8) return void (o.id = other.id);
    }
    return void (e.order = { t: 'idle' });
  }
  if (e.path.length > 0) return;
  if (!isAdjacent(e, rectOf(site))) {
    if (!goAdjacent(state, e, rectOf(site))) e.order = { t: 'idle' };
    return;
  }
  const def = DEFS[site.kind];
  const perTick = 1 / (def.time * TICK_RATE);
  site.progress = Math.min(1, site.progress + perTick);
  site.hp = Math.min(def.hp, site.hp + def.hp * perTick);
}

function stepAttack(state: GameState, e: Entity, o: Extract<Order, { t: 'attack' }>): void {
  const def = DEFS[e.kind];
  const target = state.entities.get(o.id);
  if (!target || target.owner === e.owner) return void (e.order = { t: 'idle' });
  const d = distance(e, target);
  if (d <= (def.range ?? 0)) {
    e.path = [];
    if (e.cooldown <= 0) strike(state, e, target);
    return;
  }
  if (isBuilding(e) || (o.auto && d > (def.sight ?? 6) + 4)) return void (e.order = { t: 'idle' });
  // Chase, re-planning now and then because the target moves.
  if (e.path.length === 0 || (state.tick + e.id) % 5 === 0) {
    if (isBuilding(target)) {
      if (!goAdjacent(state, e, rectOf(target)) && o.auto) e.order = { t: 'idle' };
    } else {
      e.path = findPath(state.map, Math.floor(e.x), Math.floor(e.y), Math.floor(target.x), Math.floor(target.y));
    }
  }
}

function stepTraining(state: GameState, b: Entity): void {
  if (b.queue.length === 0) return;
  const kind = b.queue[0];
  const total = DEFS[kind].time * TICK_RATE;
  if (b.trainTicks < total) b.trainTicks++;
  const player = state.players.get(b.owner)!;
  // A finished unit waits inside until there is housing for it.
  if (b.trainTicks < total || player.pop >= player.cap) return;
  const s = sizeOf(b);
  const [spot] = freeTilesNear(state.map, b.x + Math.floor(s / 2), b.y + s, 1);
  if (!spot) return;
  spawn(state, b.owner, kind, spot[0], spot[1]);
  player.pop++;
  b.queue.shift();
  b.trainTicks = 0;
}

function moveAlongPath(e: Entity): void {
  let budget = (DEFS[e.kind].speed ?? 0) / TICK_RATE;
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

/** Advances the simulation by one tick. */
export function step(state: GameState): void {
  state.tick++;
  state.tileEvents = [];
  state.shots = [];

  for (const p of state.players.values()) p.pop = p.cap = 0;
  for (const e of state.entities.values()) {
    const p = state.players.get(e.owner);
    if (!p) continue;
    if (isBuilding(e)) p.cap += e.progress >= 1 ? DEFS[e.kind].housing ?? 0 : 0;
    else if (e.kind !== 'king') p.pop++;
  }
  for (const p of state.players.values()) p.cap = Math.min(POP_MAX, p.cap);

  for (const e of [...state.entities.values()]) {
    if (!state.entities.has(e.id)) continue;
    const def = DEFS[e.kind];
    if (e.cooldown > 0) e.cooldown--;
    if (isBuilding(e) && e.progress < 1) continue;
    if (isBuilding(e)) stepTraining(state, e);

    const o = e.order;
    if (o.t === 'gather') stepGather(state, e, o);
    else if (o.t === 'build') stepBuild(state, e, o);
    else if (o.t === 'attack') stepAttack(state, e, o);
    else if (o.t === 'move' && e.path.length === 0) e.order = { t: 'idle' };

    // Soldiers and towers pick fights on their own; villagers and kings do not.
    if (e.order.t === 'idle' && def.attack && e.kind !== 'villager' && (state.tick + e.id) % 5 === 0) {
      const enemy = findEnemy(state, e, isBuilding(e) ? def.range ?? 0 : def.sight ?? 6);
      if (enemy) e.order = { t: 'attack', id: enemy.id, auto: true };
    }
    if (!isBuilding(e)) moveAlongPath(e);
  }

  // A player whose king is dead is out, and everything they own goes with them.
  const kings = new Set<number>();
  for (const e of state.entities.values()) if (e.kind === 'king') kings.add(e.owner);
  for (const p of state.players.values()) {
    if (p.defeated || kings.has(p.slot)) continue;
    p.defeated = true;
    for (const e of [...state.entities.values()]) if (e.owner === p.slot) kill(state, e);
  }
  if (state.contested && state.winner < 0) {
    const alive = [...state.players.values()].filter((p) => !p.defeated);
    if (alive.length === 1) state.winner = alive[0].slot;
  }
}

/** Activity code sent to clients: 0 idle, 1 moving, 2 working, 3 fighting. */
export function activityOf(e: Entity): number {
  if (e.path.length > 0) return 1;
  if (e.order.t === 'attack') return 3;
  if (e.order.t === 'gather' || e.order.t === 'build') return 2;
  return 0;
}

export const kindIndex = (kind: Kind): number => KINDS.indexOf(kind);
