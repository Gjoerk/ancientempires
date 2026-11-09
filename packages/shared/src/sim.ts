import {
  armorOf, attackOf, CARRY_CAPACITY, Cost, DEFAULT_SIGHT, DEFS, FARM_RATE, GATHER_RATE, isTech, Kind, KINDS, maxHpOf, POP_MAX,
  QUEUE_MAX, rangeOf, Res, RESOURCES, START_RESOURCES, TechId, TECHS, TRADE_BUY, TRADE_SELL,
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
  /** `then` is where an attack-move continues to once the fight is over. */
  | { t: 'attack'; id: number; auto: boolean; then?: [number, number] }
  /** Walk to a point, fighting anything met on the way. */
  | { t: 'amove'; x: number; y: number }
  /** Walk to a castle and go inside (kings only). */
  | { t: 'garrison'; id: number };

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
  /** Units to train and technologies to research, first in line first. */
  queue: string[];
  trainTicks: number;
  /** Where newly trained units go, as tile coordinates. */
  rally?: [number, number];
  /** Id of the castle this unit is sheltering in, or -1. */
  inside: number;
}

export interface PlayerState {
  slot: number;
  res: Record<Res, number>;
  pop: number;
  cap: number;
  defeated: boolean;
  /** 1 Village Age, 2 Town Age, 3 Kingdom Age. */
  age: number;
  techs: Set<TechId>;
  /** Technologies sitting in a queue, so they cannot be ordered twice. */
  researching: Set<TechId>;
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
  /** Melee blows of the current tick: [attacker id, target id]. */
  hits: [number, number][];
  /** Units and buildings that died this tick: [kind index, x, y, owner]. */
  deaths: [number, number, number, number][];
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
  /** `kind` is a unit to train or a technology to research. */
  | { type: 'train'; building: number; kind: string }
  | { type: 'rally'; building: number; x: number; y: number }
  | { type: 'trade'; building: number; res: Res; buy: boolean }
  | { type: 'amove'; ids: number[]; x: number; y: number }
  | { type: 'stop'; ids: number[] }
  /** Destroys one of the player's own units or buildings. */
  | { type: 'delete'; id: number }
  | { type: 'cancel'; building: number }
  /** Send whoever is inside a castle back out. */
  | { type: 'eject'; building: number };

interface Rect { x: number; y: number; s: number }

const isBuilding = (e: Entity) => DEFS[e.kind].building === true;
const sizeOf = (e: Entity) => DEFS[e.kind].size ?? 1;
const rectOf = (e: Entity): Rect => ({ x: e.x, y: e.y, s: sizeOf(e) });
const tileRect = (map: GameMap, tile: number): Rect => ({ x: tile % map.size, y: Math.floor(tile / map.size), s: 1 });

export function createGame(seed: number): GameState {
  return {
    tick: 0, seed, map: generateMap(seed), entities: new Map(), players: new Map(), nextId: 1,
    changedTiles: new Map(), tileEvents: [], shots: [], hits: [], deaths: [], contested: false, winner: -1,
  };
}

/** Returns a lookup telling whether a player has researched a technology. */
export function hasTech(state: GameState, owner: number): (tech: TechId) => boolean {
  const techs = state.players.get(owner)?.techs;
  return (tech) => techs?.has(tech) === true;
}

export function spawn(state: GameState, owner: number, kind: Kind, tx: number, ty: number, built = true): Entity {
  const def = DEFS[kind];
  const e: Entity = {
    id: state.nextId++, owner, kind,
    x: def.building ? tx : tx + 0.5, y: def.building ? ty : ty + 0.5,
    hp: built ? maxHpOf(kind, hasTech(state, owner)) : 1, path: [], order: { t: 'idle' }, cooldown: 0,
    carry: 0, carryRes: 'food', work: 0, progress: built ? 1 : 0, queue: [], trainTicks: 0, inside: -1,
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
  if (e.inside < 0) state.deaths.push([KINDS.indexOf(e.kind), e.x, e.y, e.owner]);
  if (!isBuilding(e)) return;
  // Research that was under way is lost and can be ordered again.
  const owner = state.players.get(e.owner);
  for (const item of e.queue) if (isTech(item)) owner?.researching.delete(item);
  setBlocked(state.map, rectOf(e), 0);
  eject(state, e);
}

/** Puts everyone sheltering in a building back on the map next to it. */
function eject(state: GameState, b: Entity): void {
  const s = sizeOf(b);
  for (const e of state.entities.values()) {
    if (e.inside !== b.id) continue;
    const [spot] = freeTilesNear(state.map, b.x + Math.floor(s / 2), b.y + s, 1);
    e.inside = -1;
    e.x = spot[0] + 0.5;
    e.y = spot[1] + 0.5;
    e.path = [];
    e.order = { t: 'idle' };
  }
}

export function hasKingInside(state: GameState, b: Entity): boolean {
  for (const e of state.entities.values()) if (e.inside === b.id) return true;
  return false;
}

/** Gives a player their town centre, king, villagers and starting resources. */
export function addPlayer(state: GameState, slot: number): void {
  state.players.set(slot, {
    slot, res: { ...START_RESOURCES }, pop: 0, cap: 0, defeated: false, age: 1, techs: new Set(), researching: new Set(),
  });
  const [sx, sy] = state.map.starts[slot];
  spawn(state, slot, 'towncenter', sx - 4, sy - 2);
  spawn(state, slot, 'castle', sx + 1, sy - 2);
  const spots = freeTilesNear(state.map, sx - 1, sy + 1, 5);
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
    .filter((e): e is Entity => !!e && e.owner === player && !isBuilding(e) && e.inside < 0);
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

function attackMove(state: GameState, units: Entity[], x: number, y: number): void {
  moveUnits(state, units, x, y);
  for (const e of units) e.order = DEFS[e.kind].attack && e.kind !== 'villager' ? { t: 'amove', x, y } : e.order;
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
      } else if (target.kind === 'castle' && e.kind === 'king' && target.progress >= 1) {
        e.order = { t: 'garrison', id: target.id };
      } else if (isBuilding(target) && e.kind === 'villager'
        && (target.progress < 1 || (target.hp < DEFS[target.kind].hp && target.kind !== 'farm'))) {
        // Finish the building, or repair it.
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
    if ((def.age ?? 1) > player.age) return;
    if (builders.length === 0 || !canPlace(map, cmd.kind, cmd.x, cmd.y) || !canAfford(player, def.cost)) return;
    pay(player, def.cost);
    const site = spawn(state, slot, cmd.kind, cmd.x, cmd.y, false);
    for (const e of builders) {
      e.order = { t: 'build', id: site.id };
      e.path = [];
    }
  } else if (cmd.type === 'train') {
    const b = state.entities.get(cmd.building);
    if (!b || b.owner !== slot || b.progress < 1 || b.queue.length >= QUEUE_MAX || typeof cmd.kind !== 'string') return;
    let cost: Cost;
    if (isTech(cmd.kind)) {
      const tech = TECHS[cmd.kind];
      if (tech.at !== b.kind || tech.age > player.age || player.techs.has(cmd.kind) || player.researching.has(cmd.kind)) return;
      if (tech.requires && !player.techs.has(tech.requires)) return;
      cost = tech.cost;
    } else {
      const def = DEFS[cmd.kind as Kind];
      if (!def || !DEFS[b.kind].trains?.includes(cmd.kind as Kind) || (def.age ?? 1) > player.age) return;
      cost = def.cost;
    }
    if (!canAfford(player, cost)) return;
    pay(player, cost);
    if (isTech(cmd.kind)) player.researching.add(cmd.kind);
    b.queue.push(cmd.kind);
  } else if (cmd.type === 'cancel') {
    const b = state.entities.get(cmd.building);
    if (!b || b.owner !== slot || b.queue.length === 0) return;
    const item = b.queue.pop()!;
    if (isTech(item)) {
      player.researching.delete(item);
      pay(player, TECHS[item].cost, 1);
    } else pay(player, DEFS[item as Kind].cost, 1);
    if (b.queue.length === 0) b.trainTicks = 0;
  } else if (cmd.type === 'rally') {
    const b = state.entities.get(cmd.building);
    if (!b || b.owner !== slot || !isBuilding(b) || !Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) return;
    b.rally = [Math.max(0, Math.min(map.size - 1, Math.floor(cmd.x))), Math.max(0, Math.min(map.size - 1, Math.floor(cmd.y)))];
  } else if (cmd.type === 'trade') {
    const b = state.entities.get(cmd.building);
    if (!b || b.owner !== slot || b.kind !== 'market' || b.progress < 1) return;
    if (!RESOURCES.includes(cmd.res) || cmd.res === 'gold') return;
    if (cmd.buy) {
      if (player.res.gold < TRADE_BUY) return;
      player.res.gold -= TRADE_BUY;
      player.res[cmd.res] += 100;
    } else {
      if (player.res[cmd.res] < 100) return;
      player.res[cmd.res] -= 100;
      player.res.gold += TRADE_SELL;
    }
  } else if (cmd.type === 'amove') {
    if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) return;
    attackMove(state, ownUnits(state, slot, cmd.ids), cmd.x, cmd.y);
  } else if (cmd.type === 'stop') {
    for (const e of ownUnits(state, slot, cmd.ids)) {
      e.path = [];
      e.order = { t: 'idle' };
    }
  } else if (cmd.type === 'delete') {
    const e = state.entities.get(cmd.id);
    // The king cannot be thrown away, and neither can a castle while he is inside.
    if (!e || e.owner !== slot || e.kind === 'king' || hasKingInside(state, e)) return;
    kill(state, e);
  } else if (cmd.type === 'eject') {
    const b = state.entities.get(cmd.building);
    if (b && b.owner === slot) eject(state, b);
  }
}

// --- simulation --------------------------------------------------------------

function findEnemy(state: GameState, e: Entity, reach: number): Entity | undefined {
  let best: Entity | undefined;
  let bestScore = Infinity;
  for (const other of state.entities.values()) {
    if (other.owner === e.owner || other.inside >= 0) continue;
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
  const bonus = (def.bonus?.[target.kind] ?? 0) + (isBuilding(target) ? def.vsBuildings ?? 0 : 0);
  const dmg = Math.max(1, attackOf(e.kind, hasTech(state, e.owner)) + bonus - armorOf(target.kind, hasTech(state, target.owner)));
  e.cooldown = Math.round((def.cooldown ?? 1.5) * TICK_RATE);
  if ((def.range ?? 0) > 2) state.shots.push([e.id, target.id]);
  else state.hits.push([e.id, target.id]);
  target.hp -= dmg;
  if (target.hp <= 0) return kill(state, target);
  // Soldiers standing around fight back, even against something beyond their sight.
  if (target.order.t === 'idle' && DEFS[target.kind].attack && !isBuilding(target) && target.kind !== 'villager') {
    target.order = { t: 'attack', id: e.id, auto: true };
  }
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
  const has = hasTech(state, e.owner);
  const capacity = CARRY_CAPACITY + (has('handcart') ? 5 : 0);
  e.work += ((o.farm >= 0 ? FARM_RATE : GATHER_RATE) * (has('tools') ? 1.2 : 1)) / TICK_RATE;
  while (e.work >= 1 && e.carry < capacity) {
    e.work -= 1;
    e.carry++;
    if (o.farm < 0 && --map.amount[o.tile] <= 0) {
      depleteTile(state, o.tile);
      break;
    }
  }
  if (e.carry >= capacity) {
    o.phase = 'return';
    o.drop = -1;
  } else if (o.farm < 0 && map.tiles[o.tile] === Tile.Grass) {
    o.phase = 'go';
  }
}

function stepBuild(state: GameState, e: Entity, o: Extract<Order, { t: 'build' }>): void {
  const site = state.entities.get(o.id);
  if (!site) return void (e.order = { t: 'idle' });
  const full = DEFS[site.kind].hp;
  if (site.progress >= 1 && (site.hp >= full || site.kind === 'farm')) {
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
  // Repairing a finished building goes at half the speed of building it.
  if (site.progress >= 1) site.hp = Math.min(def.hp, site.hp + def.hp * perTick * 0.5);
  else {
    site.progress = Math.min(1, site.progress + perTick);
    site.hp = Math.min(def.hp, site.hp + def.hp * perTick);
  }
}

/** Ends a fight: an attack-move carries on to its destination, anything else stands by. */
function endAttack(state: GameState, e: Entity, o: Extract<Order, { t: 'attack' }>): void {
  if (o.then && !isBuilding(e)) attackMove(state, [e], o.then[0], o.then[1]);
  else e.order = { t: 'idle' };
}

function stepAttack(state: GameState, e: Entity, o: Extract<Order, { t: 'attack' }>): void {
  const def = DEFS[e.kind];
  const target = state.entities.get(o.id);
  if (!target || target.owner === e.owner || target.inside >= 0) return endAttack(state, e, o);
  const d = distance(e, target);
  if (d <= rangeOf(e.kind, hasTech(state, e.owner))) {
    e.path = [];
    if (e.cooldown <= 0) strike(state, e, target);
    return;
  }
  if (isBuilding(e) || (o.auto && d > (def.sight ?? DEFAULT_SIGHT) + 4)) return endAttack(state, e, o);
  // Chase, re-planning now and then because the target moves.
  if (e.path.length === 0 || (state.tick + e.id) % 5 === 0) {
    if (isBuilding(target)) {
      if (!goAdjacent(state, e, rectOf(target)) && o.auto) endAttack(state, e, o);
    } else {
      e.path = findPath(state.map, Math.floor(e.x), Math.floor(e.y), Math.floor(target.x), Math.floor(target.y));
    }
  }
}

function stepGarrison(state: GameState, e: Entity, o: Extract<Order, { t: 'garrison' }>): void {
  const castle = state.entities.get(o.id);
  if (!castle || castle.owner !== e.owner || castle.progress < 1) return void (e.order = { t: 'idle' });
  if (e.path.length > 0) return;
  if (!isAdjacent(e, rectOf(castle))) {
    if (!goAdjacent(state, e, rectOf(castle))) e.order = { t: 'idle' };
    return;
  }
  e.inside = castle.id;
  e.order = { t: 'idle' };
  [e.x, e.y] = centre(castle);
}

function stepTraining(state: GameState, b: Entity): void {
  if (b.queue.length === 0) return;
  const item = b.queue[0];
  const player = state.players.get(b.owner)!;
  const total = (isTech(item) ? TECHS[item].time : DEFS[item as Kind].time) * TICK_RATE;
  if (b.trainTicks < total) b.trainTicks++;
  if (b.trainTicks < total) return;
  if (isTech(item)) {
    player.researching.delete(item);
    if (item === 'age2' || item === 'age3') player.age = Math.max(player.age, item === 'age2' ? 2 : 3);
    player.techs.add(item);
    if (item === 'loom') {
      for (const e of state.entities.values()) if (e.owner === b.owner && e.kind === 'villager') e.hp += 15;
    }
  } else {
    // A finished unit waits inside until there is housing for it.
    if (player.pop >= player.cap) return;
    const s = sizeOf(b);
    const [spot] = freeTilesNear(state.map, b.x + Math.floor(s / 2), b.y + s, 1);
    if (!spot) return;
    const unit = spawn(state, b.owner, item as Kind, spot[0], spot[1]);
    player.pop++;
    if (b.rally) {
      const tile = b.rally[1] * state.map.size + b.rally[0];
      const res = TILE_RESOURCE[state.map.tiles[tile] as Tile]?.res;
      if (res && unit.kind === 'villager') unit.order = gatherOrder(tile, -1, res);
      else moveUnits(state, [unit], b.rally[0], b.rally[1]);
    }
  }
  b.queue.shift();
  b.trainTicks = 0;
}

/** Units standing idle on the same tile shuffle apart so that each can be seen and clicked. */
function spreadIdleUnits(state: GameState): void {
  const taken = new Set<number>();
  const crowded: Entity[] = [];
  for (const e of state.entities.values()) {
    if (isBuilding(e) || e.inside >= 0 || e.path.length > 0) continue;
    const tile = Math.floor(e.y) * state.map.size + Math.floor(e.x);
    if (taken.has(tile) && e.order.t === 'idle') crowded.push(e);
    else taken.add(tile);
  }
  for (const e of crowded) {
    const spot = freeTilesNear(state.map, Math.floor(e.x), Math.floor(e.y), 16).find(([x, y]) => !taken.has(y * state.map.size + x));
    if (!spot) continue;
    taken.add(spot[1] * state.map.size + spot[0]);
    e.path = findPath(state.map, Math.floor(e.x), Math.floor(e.y), spot[0], spot[1]);
    e.order = { t: 'move' };
  }
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
  state.hits = [];
  state.deaths = [];
  if (state.tick % 10 === 0) spreadIdleUnits(state);

  for (const p of state.players.values()) p.pop = p.cap = 0;
  for (const e of state.entities.values()) {
    const p = state.players.get(e.owner);
    if (!p) continue;
    if (isBuilding(e)) p.cap += e.progress >= 1 ? DEFS[e.kind].housing ?? 0 : 0;
    else if (e.kind !== 'king') p.pop++;
  }
  for (const p of state.players.values()) p.cap = Math.min(POP_MAX, p.cap);

  for (const e of [...state.entities.values()]) {
    if (!state.entities.has(e.id) || e.inside >= 0) continue;
    const def = DEFS[e.kind];
    if (e.cooldown > 0) e.cooldown--;
    if (isBuilding(e) && e.progress < 1) continue;
    if (isBuilding(e)) stepTraining(state, e);

    const o = e.order;
    if (o.t === 'gather') stepGather(state, e, o);
    else if (o.t === 'build') stepBuild(state, e, o);
    else if (o.t === 'attack') stepAttack(state, e, o);
    else if (o.t === 'garrison') stepGarrison(state, e, o);
    else if ((o.t === 'move' || o.t === 'amove') && e.path.length === 0) e.order = { t: 'idle' };

    // Soldiers and towers pick fights on their own; villagers and kings do not.
    const now = e.order;
    if ((now.t === 'idle' || now.t === 'amove') && def.attack && e.kind !== 'villager' && (state.tick + e.id) % 5 === 0) {
      const reach = isBuilding(e) ? rangeOf(e.kind, hasTech(state, e.owner)) : def.sight ?? DEFAULT_SIGHT;
      const enemy = findEnemy(state, e, reach);
      if (enemy) e.order = { t: 'attack', id: enemy.id, auto: true, then: now.t === 'amove' ? [now.x, now.y] : undefined };
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

/**
 * What a unit is visibly busy with and where, for work animations:
 * [task, target]. Tasks: 0 none, 1 wood, 2 berries, 3 gold, 4 stone, 5 farm, 6 build, 7 attack.
 * The target is a tile index for 1-4 and an entity id for 5-7.
 */
export function taskOf(e: Entity): [number, number] {
  const o = e.order;
  if (o.t === 'attack') return [7, o.id];
  if (e.path.length > 0) return [0, 0];
  if (o.t === 'build') return [6, o.id];
  if (o.t !== 'gather' || o.phase !== 'work') return [0, 0];
  if (o.farm >= 0) return [5, o.farm];
  return [1 + ['wood', 'food', 'gold', 'stone'].indexOf(o.res), o.tile];
}

export const kindIndex = (kind: Kind): number => KINDS.indexOf(kind);
