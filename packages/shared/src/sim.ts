import {
  armorOf, attackOf, bonusOf, CARRY_CAPACITY, FALLOW_SECONDS, CONVERT_REST, CONVERT_TIME, cooldownOf, TRADE_GOODS, Cost, DEFAULT_SIGHT, DEFS, FARM_FOOD, FARM_RATE, GATHER_RATE, GATHER_TECH, RESEED_COST, isTech, Kind, KINDS, maxHpOf, POP_MAX,
  QUEUE_MAX, QUICK_RESOURCES, rangeOf, Res, RESOURCES, START_RESOURCES, TechId, TECHS, TRADE_BUY, TRADE_SELL,
} from './defs';
import { GameMap, generateMap, inBounds, isWalkable, markBuilding, Tile, TILE_RESOURCE } from './map';
import { areaAt, canReach, findPath, findPathToArea, nearestReachable } from './path';

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
  | { t: 'attack'; id: number; auto: boolean; then?: [number, number]; walled?: boolean; answer?: boolean; hold?: boolean }
  /** Walk to a point, fighting anything met on the way. */
  | { t: 'amove'; x: number; y: number }
  /** Walk to a town centre or castle and go inside (villagers and the king). */
  | { t: 'garrison'; id: number }
  /** Monks: restore a friendly unit's health. */
  | { t: 'heal'; id: number; back?: number }
  /** A monk keeps close to an attack on `id` and heals whoever gets hurt there. */
  | { t: 'escort'; id: number }
  /** Monks: win an enemy unit over; `progress` is in seconds. */
  | { t: 'convert'; id: number; progress: number }
  /** Monks: walk to a relic and pick it up. */
  | { t: 'fetch'; relic: number }
  /** Monks carrying a relic: take it into a monastery. */
  | { t: 'deliver'; id: number };

/** A relic: lying on the ground, carried by a monk, or kept in a monastery. */
export interface Relic {
  x: number;
  y: number;
  /** The monk carrying it, or -1. */
  carrier: number;
  /** The monastery keeping it, or -1. */
  monastery: number;
  /** Bit mask of the players who have seen it so far. */
  foundBy: number;
}

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
  /** While moving with a group: the group's speed, so that everyone keeps the same pace. */
  pace?: number;
  /** Building sites a villager will work on next, in order. */
  tasks?: number[];
  /** Farms: the tick the field ran out of food and went fallow, until it is sown again. */
  fallow?: number;
  /** A villager's job that ended by itself, kept for a while so they can go back to it (see resumeWork). */
  resume?: { order: Order; since: number; tries: number };
  /** Id of the castle this unit is sheltering in, or -1. */
  inside: number;
  /** Soldiers: 'defensive' ones only fight back when struck; otherwise they go for enemies they see. */
  stance?: Stance;
  /** How the unit lines up when it moves with others; a line when unset. */
  formation?: Formation;
  /** The way the unit's group last faced when it lined up, as a unit vector. */
  facing?: [number, number];
  /** Villagers called in by the town bell: the job to go back to when it rings again. */
  recall?: Order;
}

export type Stance = 'aggressive' | 'defensive';
/** Line: a wide front. Box: soldiers all around the archers and siege. Staggered: spread out
 *  against catapult fire. Flank: two wings with a gap in the middle. */
export const FORMATIONS = ['line', 'box', 'staggered', 'flank'] as const;
export type Formation = (typeof FORMATIONS)[number];

export interface PlayerState {
  slot: number;
  /** Players on the same team are allies: they do not fight each other and win together. */
  team: number;
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
  /** What is left in the resource tiles that were worked this tick: tile index -> amount. */
  amountEvents: Map<number, number>;
  shots: [number, number][];
  /** Melee blows of the current tick: [attacker id, target id]. */
  hits: [number, number][];
  /** Units and buildings that died this tick: [kind index, x, y, owner]. */
  deaths: [number, number, number, number][];
  /** Highest population anyone may reach. */
  popLimit: number;
  /** Monk effects of the current tick: [monk id, target id, 1 heal / 2 convert]. */
  blessings: [number, number, number][];
  /** Tile index -> id of the unit standing there or heading there. Rebuilt every tick. */
  occupied: Map<number, number>;
  /** True once two teams have been in the game together. */
  contested: boolean;
  /** The last team with a king standing, or -1. */
  winner: number;
  /** Notes the computer opponents keep between their turns. */
  ai: Map<number, { lastAttack: number; waves: number }>;
  relics: Relic[];
}

export type Command =
  | { type: 'move'; ids: number[]; x: number; y: number }
  | { type: 'gather'; ids: number[]; tile: number }
  | { type: 'interact'; ids: number[]; target: number }
  /** With `queue`, villagers busy building take the new site on after the ones they have. */
  | { type: 'place'; ids: number[]; kind: Kind; x: number; y: number; queue?: boolean }
  /** Villagers take on exactly what another villager is doing. */
  | { type: 'copy'; ids: number[]; from: number }
  /** `kind` is a unit to train or a technology to research. */
  | { type: 'train'; building: number; kind: string }
  | { type: 'rally'; building: number; x: number; y: number }
  | { type: 'trade'; building: number; res: Res; buy: boolean }
  | { type: 'amove'; ids: number[]; x: number; y: number }
  | { type: 'stop'; ids: number[] }
  | { type: 'stance'; ids: number[]; stance: Stance }
  | { type: 'formation'; ids: number[]; formation: Formation }
  /** The town bell: villagers go into shelter, or, rung again, back to work. */
  | { type: 'bell' }
  /** Monks go and pick up a relic. */
  | { type: 'fetch'; ids: number[]; relic: number }
  /** Destroys one of the player's own units or buildings. */
  | { type: 'delete'; id: number }
  | { type: 'cancel'; building: number }
  /** Give up: the player's king dies. */
  | { type: 'resign' }
  /** Send whoever is inside a castle back out. */
  | { type: 'eject'; building: number };

interface Rect { x: number; y: number; s: number }

const isBuilding = (e: Entity) => DEFS[e.kind].building === true;
const sizeOf = (e: Entity) => DEFS[e.kind].size ?? 1;
const rectOf = (e: Entity): Rect => ({ x: e.x, y: e.y, s: sizeOf(e) });
const tileRect = (map: GameMap, tile: number): Rect => ({ x: tile % map.size, y: Math.floor(tile / map.size), s: 1 });

export function createGame(seed: number, size?: number, popLimit = POP_MAX): GameState {
  return {
    popLimit, blessings: [],
    tick: 0, seed, map: generateMap(seed, size), entities: new Map(), players: new Map(), nextId: 1,
    changedTiles: new Map(), tileEvents: [], amountEvents: new Map(), shots: [], hits: [], deaths: [], contested: false, winner: -1, ai: new Map(), occupied: new Map(), relics: [],
  };
}

export function teamOf(state: GameState, owner: number): number {
  return state.players.get(owner)?.team ?? -1 - owner;
}

export function isEnemy(state: GameState, a: number, b: number): boolean {
  return teamOf(state, a) !== teamOf(state, b);
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
  // A building site that nobody has started on yet is only a blueprint on the ground: it cannot be
  // built over, but anyone can walk across it. It closes once the first builder sets to work.
  if (def.building && (built || def.walkable)) setBlocked(state.map, e, 1);
  else if (def.building) markBuilding(state.map, tx, ty, sizeOf(e), true, 1);
  // A farm's `carry` is the food left before it must be sown again.
  if (kind === 'farm') e.carry = FARM_FOOD;
  if (kind === 'gate') {
    state.map.gate[ty * state.map.size + tx] = teamOf(state, owner) + 1;
    state.map.version++;
  }
  return e;
}

function setBlocked(map: GameMap, e: Entity, value: number): void {
  markBuilding(map, e.x, e.y, sizeOf(e), DEFS[e.kind].walkable === true, value);
}

function kill(state: GameState, e: Entity): void {
  if (!state.entities.delete(e.id)) return;
  // A relic falls where its monk dies, or out of a monastery that is destroyed.
  for (const r of state.relics) {
    if (r.carrier === e.id) r.carrier = -1;
    if (r.monastery === e.id) {
      r.monastery = -1;
      [r.x, r.y] = [e.x + sizeOf(e) / 2, e.y + sizeOf(e)];
    }
  }
  if (e.inside < 0) state.deaths.push([KINDS.indexOf(e.kind), e.x, e.y, e.owner]);
  if (!isBuilding(e)) return;
  // Research that was under way is lost and can be ordered again.
  const owner = state.players.get(e.owner);
  for (const item of e.queue) if (isTech(item)) owner?.researching.delete(item);
  setBlocked(state.map, e, 0);
  if (e.kind === 'gate') {
    state.map.gate[e.y * state.map.size + e.x] = 0;
    state.map.version++;
  }
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

export function countInside(state: GameState, b: Entity): number {
  let n = 0;
  for (const e of state.entities.values()) if (e.inside === b.id) n++;
  return n;
}

export function hasKingInside(state: GameState, b: Entity): boolean {
  for (const e of state.entities.values()) if (e.inside === b.id && e.kind === 'king') return true;
  return false;
}

/** Gives a player their town centre, castle, king, villagers and starting resources. */
export function addPlayer(state: GameState, slot: number, team = slot, quick = false): void {
  state.players.set(slot, {
    slot, team, res: { ...(quick ? QUICK_RESOURCES : START_RESOURCES) }, pop: 0, cap: 0, defeated: false,
    age: 1, techs: new Set(), researching: new Set(),
  });
  const [sx, sy] = state.map.starts[slot];
  spawn(state, slot, 'towncenter', sx - 4, sy - 2);
  spawn(state, slot, 'castle', sx + 1, sy - 2);
  // A king, a scout to explore with, and villagers; together they fill the town centre's housing.
  const spots = freeTilesNear(state.map, sx - 1, sy + 1, quick ? 9 : 5);
  spawn(state, slot, 'king', spots[0][0], spots[0][1]);
  spawn(state, slot, 'scout', spots[1][0], spots[1][1]);
  for (let i = 2; i < spots.length; i++) spawn(state, slot, 'villager', spots[i][0], spots[i][1]);
  if (quick) spawn(state, slot, 'house', sx - 4, sy + 2);
  if (new Set([...state.players.values()].filter((p) => !p.defeated).map((p) => p.team)).size >= 2) state.contested = true;
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
  for (let y = ty; y < ty + s; y++) {
    for (let x = tx; x < tx + s; x++) if (!isWalkable(map, x, y) || map.footprint[y * map.size + x]) return false;
  }
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

/**
 * Sends a unit to the nearest reachable tile next to a rectangle, one that no other unit stands on
 * or is heading for when there is such a tile. False if the rectangle cannot be reached at all.
 */
function goAdjacent(state: GameState, e: Entity, r: Rect): boolean {
  if (isAdjacent(e, r)) {
    e.path = [];
    return true;
  }
  const team = teamOf(state, e.owner);
  const ex = Math.floor(e.x);
  const ey = Math.floor(e.y);
  const res = findPathToArea(state.map, ex, ey, r.x, r.y, r.s, team);
  if (!res.reached) return false;
  e.path = res.path;
  // If that spot is already taken, prefer a free one on the way round, when it is not much further.
  const end = e.path.length >= 2 ? e.path[e.path.length - 1] * state.map.size + e.path[e.path.length - 2] : -1;
  if (end >= 0 && isTaken(state, end, e)) {
    const spot = freeSpotAround(state, e, r);
    if (spot) {
      const alt = findPath(state.map, ex, ey, spot[0], spot[1], team);
      if (alt.length >= 2 && alt[alt.length - 2] === spot[0] && alt[alt.length - 1] === spot[1] && alt.length <= e.path.length + 8) e.path = alt;
    }
  }
  return true;
}

/** Walks a unit onto a rectangle (a field). False if it cannot be reached. */
function goOnto(state: GameState, e: Entity, r: Rect): boolean {
  const res = findPathToArea(state.map, Math.floor(e.x), Math.floor(e.y), r.x, r.y, r.s, teamOf(state, e.owner), true);
  if (!res.reached) return false;
  e.path = res.path;
  return true;
}

const isInside = (e: Entity, r: Rect) => {
  const tx = Math.floor(e.x);
  const ty = Math.floor(e.y);
  return tx >= r.x && tx < r.x + r.s && ty >= r.y && ty < r.y + r.s;
};

/** Whether another unit stands on a tile or is on its way there. */
function isTaken(state: GameState, tile: number, self: Entity): boolean {
  const who = state.occupied.get(tile);
  return who !== undefined && who !== self.id;
}

/** The free walkable tile around a rectangle that is nearest to a unit, rings further out if needed. */
function freeSpotAround(state: GameState, e: Entity, r: Rect, maxRing = 2): [number, number] | undefined {
  const map = state.map;
  let best: [number, number] | undefined;
  for (let ring = 1; ring <= maxRing && !best; ring++) {
    let bestD = Infinity;
    for (let y = r.y - ring; y <= r.y + r.s - 1 + ring; y++) {
      for (let x = r.x - ring; x <= r.x + r.s - 1 + ring; x++) {
        const edge = x === r.x - ring || x === r.x + r.s - 1 + ring || y === r.y - ring || y === r.y + r.s - 1 + ring;
        if (!edge || !isWalkable(map, x, y, teamOf(state, e.owner)) || isTaken(state, y * map.size + x, e)) continue;
        if (!canReach(map, Math.floor(e.x), Math.floor(e.y), x, y, teamOf(state, e.owner))) continue;
        const d = Math.hypot(x + 0.5 - e.x, y + 0.5 - e.y);
        if (d < bestD) {
          bestD = d;
          best = [x, y];
        }
      }
    }
  }
  return best;
}

/** Records where units stand and where moving units are going, so that others can pick different tiles. */
function updateOccupied(state: GameState): void {
  state.occupied.clear();
  const n = state.map.size;
  for (const e of state.entities.values()) {
    if (isBuilding(e) || e.inside >= 0) continue;
    const tile = e.path.length >= 2 ? e.path[e.path.length - 1] * n + e.path[e.path.length - 2] : Math.floor(e.y) * n + Math.floor(e.x);
    if (!state.occupied.has(tile)) state.occupied.set(tile, e.id);
  }
}

function claim(state: GameState, e: Entity): void {
  if (e.path.length < 2) return;
  const n = state.map.size;
  const tile = e.path[e.path.length - 1] * n + e.path[e.path.length - 2];
  if (!state.occupied.has(tile)) state.occupied.set(tile, e.id);
}

/**
 * The nearest tile of a resource within `radius` of a tile. With `by`, only tiles that unit can
 * walk up to count: a tree in the middle of a wood, with no free side to stand at, is skipped.
 */
function nearestResourceTile(map: GameMap, from: number, res: Res, radius: number, by?: { e: Entity; team: number }): number {
  const fx = from % map.size;
  const fy = Math.floor(from / map.size);
  let best = -1;
  let bestD = Infinity;
  for (let y = Math.max(0, fy - radius); y <= Math.min(map.size - 1, fy + radius); y++) {
    for (let x = Math.max(0, fx - radius); x <= Math.min(map.size - 1, fx + radius); x++) {
      const i = y * map.size + x;
      if (TILE_RESOURCE[map.tiles[i] as Tile]?.res !== res) continue;
      const d = Math.hypot(x - fx, y - fy);
      if (d >= bestD) continue;
      if (by && !canReach(map, Math.floor(by.e.x), Math.floor(by.e.y), x, y, by.team, 1)) continue;
      {
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

/** The player's own units among `ids`. A new order wipes their list of queued building sites unless `keepTasks`. */
function ownUnits(state: GameState, player: number, ids: unknown, keepTasks = false): Entity[] {
  if (!Array.isArray(ids)) return [];
  const units = ids
    .slice(0, 200)
    .map((id) => state.entities.get(id))
    .filter((e): e is Entity => !!e && e.owner === player && !isBuilding(e) && e.inside < 0);
  for (const e of units) {
    if (!keepTasks) e.tasks = undefined;
    // The player has given new orders: whatever job was left off is forgotten.
    e.resume = undefined;
  }
  return units;
}

/** Housing the player has, counting buildings still going up. */
function housingOf(state: GameState, slot: number): number {
  let n = 0;
  for (const e of state.entities.values()) if (e.owner === slot && isBuilding(e)) n += DEFS[e.kind].housing ?? 0;
  return n;
}

/** Whether a unit may shelter in a building: villagers and the king, in their own town centre or castle, while there is room. */
function canShelter(state: GameState, e: Entity, b: Entity): boolean {
  const room = DEFS[b.kind].garrison;
  if (!room || b.owner !== e.owner || b.progress < 1 || (e.kind !== 'villager' && e.kind !== 'king')) return false;
  return e.kind === 'king' || countInside(state, b) < room;
}

const isRangedKind = (k: Kind) => (DEFS[k].range ?? 0) > 2;

/** Where each unit of a group stands at the destination: soldiers in front, archers behind, the rest at the back. */
function formation(state: GameState, units: Entity[], x: number, y: number, face?: [number, number]): Map<Entity, [number, number]> {
  const n = units.length;
  let cx = 0;
  let cy = 0;
  for (const e of units) {
    cx += e.x / n;
    cy += e.y / n;
  }
  // Rows face the direction of travel.
  let dx = x - cx;
  let dy = y - cy;
  const len = Math.hypot(dx, dy);
  if (face) [dx, dy] = face;
  else if (len < 0.5) [dx, dy] = units[0]?.facing ?? [1, 1].map((v) => v / Math.SQRT2) as [number, number];
  else [dx, dy] = [dx / len, dy / len];
  // Snapped to one of eight directions, so that rows run along whole tiles and the shape stays clean.
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const fx = Math.round(Math.cos(angle));
  const fy = Math.round(Math.sin(angle));
  const l = Math.hypot(fx, fy);
  for (const e of units) e.facing = [fx / l, fy / l];
  [dx, dy] = [fx / l, fy / l];
  const [px, py] = [-dy, dx];
  const rank = (e: Entity) => (DEFS[e.kind].building ? 9 : e.kind === 'villager' || e.kind === 'king' ? 3 : e.kind === 'ram' ? 2 : isRangedKind(e.kind) ? 1 : 0);
  const ordered = [...units].sort((a, b) => rank(a) - rank(b) || (a.x - cx) * px + (a.y - cy) * py - ((b.x - cx) * px + (b.y - cy) * py));
  const slots = formationSlots(groupFormation(units), ordered.map(rank));
  const taken = new Set<number>();
  const out = new Map<Entity, [number, number]>();
  ordered.forEach((e, i) => {
    // Each slot is [steps behind the front, steps to the side].
    // Whole steps along the snapped axes: straight rows, or on a diagonal a neat chequer of tiles.
    const row = Math.round(slots[i][0]);
    const col = Math.round(slots[i][1]);
    const tx = Math.floor(x) - fx * row - fy * col;
    const ty = Math.floor(y) - fy * row + fx * col;
    // The nearest free tile to the slot, so that walls and trees just bend the formation.
    const spot = freeTilesNear(state.map, tx, ty, 12).find(([sx, sy]) => !taken.has(sy * state.map.size + sx));
    if (!spot) return;
    taken.add(spot[1] * state.map.size + spot[0]);
    out.set(e, spot);
  });
  return out;
}

/** The formation most of the soldiers in a group have been given. */
function groupFormation(units: Entity[]): Formation {
  const votes = new Map<Formation, number>();
  for (const e of units) if (e.formation) votes.set(e.formation, (votes.get(e.formation) ?? 0) + 1);
  let best: Formation = 'line';
  let most = 0;
  for (const [f, c] of votes) if (c > most || (c === most && f < best)) [best, most] = [f, c];
  return most * 2 >= units.length ? best : 'line';
}

/**
 * Where each member of a group stands, as [rows behind the front, steps to the side of the middle].
 * `ranks` is sorted: soldiers first (0), then archers (1), siege (2) and villagers or the king (3).
 */
export function formationSlots(kind: Formation, ranks: number[]): [number, number][] {
  const n = ranks.length;
  const rows = (count: number, cols: number, gap: number, stagger: boolean, from = 0): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, count - row * cols);
      let col = ((i % cols) - (inRow - 1) / 2) * gap;
      if (stagger && row % 2 === 1) col += gap / 2;
      out.push([(from + row) * gap, col]);
    }
    return out;
  };
  if (kind === 'staggered') {
    // Two tiles apart and offset row by row: one boulder hits one soldier.
    return rows(n, Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * 2)))), 2, true);
  }
  if (kind === 'flank') {
    // Two wings side by side with a gap of four tiles; each wing keeps soldiers in front.
    const left: number[] = [];
    const right: number[] = [];
    ranks.forEach((_, i) => (i % 2 === 0 ? left : right).push(i));
    const out: [number, number][] = new Array(n);
    for (const [wing, side] of [[left, -1], [right, 1]] as const) {
      const cols = Math.max(1, Math.ceil(Math.sqrt(wing.length * 1.5)));
      const spots = rows(wing.length, cols, 1, false);
      const half = (Math.min(cols, wing.length) - 1) / 2;
      wing.forEach((idx, k) => (out[idx] = [spots[k][0], spots[k][1] + side * (half + 2.5)]));
    }
    return out;
  }
  if (kind === 'box') {
    // A hollow square: soldiers spread evenly around its edge, archers, siege and villagers inside.
    const inner = ranks.filter((r) => r > 0).length;
    const outer = n - inner;
    let side = 2;
    while ((side - 2) ** 2 < inner || 4 * (side - 1) < outer) side++;
    const mid = (side - 1) / 2;
    // The edge, walked once around.
    const edge: [number, number][] = [];
    for (let c = 0; c < side - 1; c++) edge.push([0, c]);
    for (let r = 0; r < side - 1; r++) edge.push([r, side - 1]);
    for (let c = side - 1; c > 0; c--) edge.push([side - 1, c]);
    for (let r = side - 1; r > 0; r--) edge.push([r, 0]);
    const inside: [number, number][] = [];
    for (let r = 1; r < side - 1; r++) for (let c = 1; c < side - 1; c++) inside.push([r, c]);
    inside.sort((a, b) => Math.hypot(a[0] - mid, a[1] - mid) - Math.hypot(b[0] - mid, b[1] - mid));
    let o = 0;
    let m = 0;
    return ranks.map((r) => {
      const [row, col] = r > 0 ? inside[m++] : edge[Math.floor((o++ * edge.length) / Math.max(1, outer))];
      return [row - mid, col - mid] as [number, number];
    });
  }
  // Line: a wide front, soldiers in front and archers behind.
  return rows(n, Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * 2.5)))), 1, false);
}

function moveUnits(state: GameState, units: Entity[], x: number, y: number, face?: [number, number]): void {
  // A group keeps formation and walks at the pace of its slowest member.
  const slots = formation(state, units, x, y, face);
  const pace = units.length > 1 ? Math.min(...units.map((e) => DEFS[e.kind].speed ?? 1)) : undefined;
  const nearby = new Map<string, { spots: [number, number][]; next: number }>();
  for (const e of units) {
    let spot = slots.get(e);
    if (!spot) continue;
    // Somewhere that cannot be walked to (behind a wall, across water): go as near as possible
    // instead, without a search that floods the whole map to find that out.
    const ex = Math.floor(e.x);
    const ey = Math.floor(e.y);
    const team = teamOf(state, e.owner);
    if (!canReach(state.map, ex, ey, spot[0], spot[1], team)) {
      // One set of spots per walking area the group stands in, shared out among its members.
      const key = `${team}:${areaAt(state.map, ex, ey, team)}`;
      let near = nearby.get(key);
      if (!near) {
        const [nx, ny] = nearestReachable(state.map, ex, ey, Math.floor(x), Math.floor(y), team);
        const free = freeTilesNear(state.map, nx, ny, 40).filter(([fx, fy]) => canReach(state.map, ex, ey, fx, fy, team));
        near = { spots: free.length > 0 ? free : [[nx, ny]], next: 0 };
        nearby.set(key, near);
      }
      spot = near.spots[near.next++ % near.spots.length];
    }
    e.path = findPath(state.map, ex, ey, spot[0], spot[1], team);
    e.order = { t: 'move' };
    e.pace = pace;
  }
}

/** Units standing where a new building goes step off it, so that nobody is walled in. */
/** Units standing where a building goes walk off it to the nearest free tile, then carry on. */
function clearFootprint(state: GameState, r: Rect): void {
  for (const e of state.entities.values()) {
    if (isBuilding(e) || e.inside >= 0 || !isInside(e, r)) continue;
    const [spot] = freeTilesNear(state.map, Math.floor(e.x), Math.floor(e.y), 1);
    if (!spot) continue;
    const rest = e.path.length > 0 ? findPath(state.map, spot[0], spot[1], e.path[e.path.length - 2], e.path[e.path.length - 1], teamOf(state, e.owner)) : [];
    e.path = [spot[0], spot[1], ...rest];
  }
}

/** Gives a villager the same job as another one. */
function copyTask(state: GameState, e: Entity, from: Entity): void {
  const o = from.order;
  e.path = [];
  e.tasks = from.tasks ? [...from.tasks] : undefined;
  if (o.t === 'gather' && o.farm >= 0) {
    // Fields take one farmer each: take the nearest free one.
    let best: Entity | undefined;
    for (const f of state.entities.values()) {
      if (f.owner !== e.owner || f.kind !== 'farm' || f.progress < 1 || !farmIsFree(state, f, e)) continue;
      if (!best || distance(e, f) < distance(e, best)) best = f;
    }
    e.order = best ? gatherOrder(-1, best.id, 'food') : { t: 'idle' };
  } else if (o.t === 'gather' && o.tile >= 0) {
    e.order = gatherOrder(o.tile, -1, o.res);
  } else if (o.t === 'build') {
    e.order = { t: 'build', id: o.id };
  } else if (o.t === 'garrison') {
    e.order = { t: 'garrison', id: o.id };
  } else if (o.t === 'attack') {
    e.order = { t: 'attack', id: o.id, auto: false };
  } else if (from.path.length >= 2) {
    moveUnits(state, [e], from.path[from.path.length - 2], from.path[from.path.length - 1]);
  } else {
    e.order = { t: 'idle' };
  }
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
  // Villagers given a new job are no longer waiting for the bell to send them back.
  if ('ids' in cmd && Array.isArray(cmd.ids) && cmd.type !== 'stance' && cmd.type !== 'formation') for (const e of ownUnits(state, slot, cmd.ids, true)) delete e.recall;

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
      // Only tiles with a free side to stand at; a villager given one deep inside a wood would just stand there.
      const team = teamOf(state, e.owner);
      const open = patch.filter((t) => canReach(map, Math.floor(e.x), Math.floor(e.y), t % map.size, Math.floor(t / map.size), team, 1));
      const choice = open.length > 0 ? open : [tile];
      e.order = gatherOrder(choice[i % choice.length], -1, res);
      e.path = [];
    });
    moveUnits(state, units.filter((e) => e.kind !== 'villager'), r.x, r.y);
  } else if (cmd.type === 'interact') {
    const target = state.entities.get(cmd.target);
    if (!target) return;
    for (const e of ownUnits(state, slot, cmd.ids)) {
      e.path = [];
      if (isEnemy(state, target.owner, slot)) {
        if (DEFS[e.kind].buildingsOnly && !isBuilding(target)) moveUnits(state, [e], target.x, target.y);
        else if (DEFS[e.kind].attack) e.order = { t: 'attack', id: target.id, auto: false };
        // Monks try to win enemy units over; kings and buildings cannot be converted.
        else if (DEFS[e.kind].converts && !isBuilding(target) && target.kind !== 'king') e.order = { t: 'convert', id: target.id, progress: 0 };
        // A building (or a king) cannot be won over: monks follow the attack and heal the wounded.
        else if (DEFS[e.kind].heal) e.order = { t: 'escort', id: target.id };
      } else if (target.owner !== slot) {
        // An ally: just walk over.
        moveUnits(state, [e], target.x, target.y);
      } else if (e.kind === 'monk' && target.kind === 'monastery' && carrying(state, e) && target.progress >= 1) {
        // A monk carrying a relic takes it into the monastery.
        e.order = { t: 'deliver', id: target.id };
      } else if (e.kind === 'monk' && !isBuilding(target)) {
        // Monks heal their own side.
        e.order = target.hp < maxHpOf(target.kind, hasTech(state, target.owner)) ? { t: 'heal', id: target.id } : { t: 'idle' };
        if (e.order.t === 'idle') moveUnits(state, [e], target.x, target.y);
      } else if (e.kind === 'king' && canShelter(state, e, target)) {
        e.order = { t: 'garrison', id: target.id };
      } else if (isBuilding(target) && e.kind === 'villager'
        && (target.progress < 1 || (target.hp < DEFS[target.kind].hp && target.kind !== 'farm'))) {
        // Finish the building, or repair it.
        e.order = { t: 'build', id: target.id };
      } else if (target.kind === 'farm' && e.kind === 'villager' && target.fallow !== undefined) {
        // Sowing a fallow field again costs wood; whoever sows it farms it.
        if (player.res.wood >= RESEED_COST) {
          player.res.wood -= RESEED_COST;
          target.carry = FARM_FOOD;
          target.fallow = undefined;
          e.order = gatherOrder(-1, target.id, 'food');
        }
      } else if (target.kind === 'farm' && e.kind === 'villager' && farmIsFree(state, target, e)) {
        e.order = gatherOrder(-1, target.id, 'food');
      } else if (isBuilding(target)) {
        if (e.kind === 'villager' && e.carry > 0 && DEFS[target.kind].dropoff?.includes(e.carryRes) && target.progress >= 1) {
          // Deliver what is carried, then stand by.
          e.order = { t: 'gather', tile: -1, farm: -1, res: e.carryRes, phase: 'return', drop: target.id };
        } else if (canShelter(state, e, target)) {
          // An empty-handed villager sent to an undamaged town centre or castle goes inside.
          e.order = { t: 'garrison', id: target.id };
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
    const builders = ownUnits(state, slot, cmd.ids, cmd.queue === true).filter((e) => e.kind === 'villager');
    if ((def.age ?? 1) > player.age) return;
    // No more houses once they would only add room beyond the population limit.
    if (def.housing && housingOf(state, slot) >= state.popLimit) return;
    if (builders.length === 0 || !canPlace(map, cmd.kind, cmd.x, cmd.y) || !canAfford(player, def.cost)) return;
    pay(player, def.cost);
    const site = spawn(state, slot, cmd.kind, cmd.x, cmd.y, false);
    for (const e of builders) {
      if (cmd.queue && e.order.t === 'build') {
        // Already building: this site comes next on the list.
        (e.tasks ??= []).push(site.id);
      } else {
        e.order = { t: 'build', id: site.id };
        e.path = [];
      }
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
    if (!TRADE_GOODS.includes(cmd.res)) return;
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
  } else if (cmd.type === 'stance') {
    if (cmd.stance !== 'aggressive' && cmd.stance !== 'defensive') return;
    for (const e of ownUnits(state, slot, cmd.ids)) {
      if (!DEFS[e.kind].attack || e.kind === 'villager' || e.kind === 'king') continue;
      if (cmd.stance === 'defensive') e.stance = 'defensive';
      else delete e.stance;
      // Going defensive calls off fights the unit picked itself.
      if (cmd.stance === 'defensive' && e.order.t === 'attack' && e.order.auto) {
        e.path = [];
        e.order = { t: 'idle' };
      }
    }
  } else if (cmd.type === 'formation') {
    if (!FORMATIONS.includes(cmd.formation)) return;
    const group: Entity[] = [];
    for (const e of ownUnits(state, slot, cmd.ids)) {
      if (isBuilding(e) || e.kind === 'villager') continue;
      if (cmd.formation === 'line') delete e.formation;
      else e.formation = cmd.formation;
      // Those standing about or on the march line up at once; fights carry on.
      if (e.order.t === 'idle' || e.order.t === 'move') group.push(e);
    }
    if (group.length < 2) return;
    const marching = group.find((e) => e.order.t === 'move' && e.path.length >= 2);
    if (marching) {
      // On the march: the same destination, in the new shape.
      moveUnits(state, group, marching.path[marching.path.length - 2], marching.path[marching.path.length - 1]);
    } else {
      // Standing still: around the middle of the group, still facing the same way.
      const cx = group.reduce((a, e) => a + e.x, 0) / group.length;
      const cy = group.reduce((a, e) => a + e.y, 0) / group.length;
      const votes = group.map((e) => e.facing).filter((f): f is [number, number] => !!f);
      let face: [number, number] | undefined;
      if (votes.length) {
        const fx = votes.reduce((a, f) => a + f[0], 0);
        const fy = votes.reduce((a, f) => a + f[1], 0);
        const l = Math.hypot(fx, fy);
        if (l > 0.1) face = [fx / l, fy / l];
      }
      moveUnits(state, group, Math.floor(cx), Math.floor(cy), face ?? [Math.SQRT1_2, Math.SQRT1_2]);
    }
  } else if (cmd.type === 'bell') {
    ringBell(state, slot);
  } else if (cmd.type === 'fetch') {
    const relic = state.relics[cmd.relic];
    if (!relic || relic.monastery >= 0) return;
    for (const e of ownUnits(state, slot, cmd.ids)) {
      if (e.kind !== 'monk' || carrying(state, e)) continue;
      e.path = [];
      e.order = { t: 'fetch', relic: cmd.relic };
    }
  } else if (cmd.type === 'copy') {
    const from = state.entities.get(cmd.from);
    if (!from || from.owner !== slot || from.kind !== 'villager') return;
    for (const e of ownUnits(state, slot, cmd.ids).filter((u) => u.kind === 'villager' && u.id !== from.id)) copyTask(state, e, from);
  } else if (cmd.type === 'resign') {
    for (const e of [...state.entities.values()]) {
      if (e.owner !== slot || e.kind !== 'king') continue;
      e.inside = -1;
      kill(state, e);
    }
  } else if (cmd.type === 'delete') {
    const e = state.entities.get(cmd.id);
    // The king cannot be thrown away, and neither can a castle while he is inside.
    if (!e || e.owner !== slot || e.kind === 'king' || hasKingInside(state, e)) return;
    // Whoever sheltered inside comes out before the building goes.
    if (isBuilding(e)) eject(state, e);
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
    // Only units are picked on sight; buildings are attacked when a player orders it. Siege
    // engines are the other way round: they go only for buildings.
    if (isBuilding(other) !== !!DEFS[e.kind].buildingsOnly || !isEnemy(state, other.owner, e.owner) || other.inside >= 0) continue;
    if (other.kind === 'farm' && DEFS[e.kind].buildingsOnly) continue;
    const d = distance(e, other);
    if (d > reach || d >= bestScore || d < (DEFS[e.kind].minRange ?? 0)) continue;
    // Never pick a fight with someone who cannot be got at (behind a wall, across water), unless
    // they can be shot from here: chasing them would go nowhere.
    if (!isBuilding(e) && d > rangeOf(e.kind, hasTech(state, e.owner)) && !canReach(state.map, Math.floor(e.x), Math.floor(e.y), Math.floor(other.x), Math.floor(other.y), teamOf(state, e.owner))) continue;
    {
      bestScore = d;
      best = other;
    }
  }
  return best;
}

const SPLASH_SHARE = 0.75;

function strike(state: GameState, e: Entity, target: Entity): void {
  const def = DEFS[e.kind];
  const has = hasTech(state, e.owner);
  const dmg = Math.max(1, attackOf(e.kind, has) + bonusOf(e.kind, target.kind, has) + relicBonus(state, e) - armorOf(target.kind, hasTech(state, target.owner)));
  e.cooldown = Math.round(cooldownOf(e.kind, has) * TICK_RATE);
  if ((def.range ?? 0) > 2) state.shots.push([e.id, target.id]);
  else state.hits.push([e.id, target.id]);
  target.hp -= dmg;
  // A boulder crashes down among the target's neighbours too, at three quarters of its strength.
  if (def.splash) {
    const [cx, cy] = isBuilding(target) ? centre(target) : [target.x, target.y];
    for (const other of [...state.entities.values()]) {
      if (other === target || isBuilding(other) || other.inside >= 0 || !isEnemy(state, other.owner, e.owner)) continue;
      if (Math.hypot(other.x - cx, other.y - cy) > def.splash) continue;
      other.hp -= Math.max(1, Math.round((attackOf(e.kind, has) + relicBonus(state, e)) * SPLASH_SHARE) - armorOf(other.kind, hasTech(state, other.owner)));
      if (other.hp <= 0) kill(state, other);
    }
  }
  if (target.hp <= 0) return kill(state, target);
  if (!isBuilding(target) && !isBuilding(e)) fightBack(state, target, e);
}

const isSoldier = (e: Entity) => !isBuilding(e) && !!DEFS[e.kind].attack && !DEFS[e.kind].buildingsOnly && e.kind !== 'villager' && e.kind !== 'king';

/** How far comrades come to help someone who is attacked; those holding their ground only defend their own group. */
const HELP_RADIUS = 6;
const HOLD_RADIUS = 3;

/**
 * A soldier who is struck turns on the attacker, even one beyond their sight (an archer shooting
 * from afar), unless the player has them busy with something else, and comrades close by come to
 * help (those holding their ground only when it is their own group). Nobody goes for an attacker
 * they could never get at.
 */
function fightBack(state: GameState, victim: Entity, attacker: Entity): void {
  const answer = (u: Entity) => {
    if (!isSoldier(u) || u.inside >= 0) return;
    const o = u.order;
    const has = hasTech(state, u.owner);
    let free = o.t === 'idle' || o.t === 'amove';
    if (o.t === 'attack' && o.auto) {
      // A picked fight is dropped for the attacker only when its target is not in reach now.
      const current = state.entities.get(o.id);
      free = o.id !== attacker.id && (!current || distance(u, current) > rangeOf(u.kind, has));
    }
    if (!free) return;
    const d = distance(u, attacker);
    if (d > rangeOf(u.kind, has) && !canReach(state.map, Math.floor(u.x), Math.floor(u.y), Math.floor(attacker.x), Math.floor(attacker.y), teamOf(state, u.owner))) return;
    const then = o.t === 'amove' ? [o.x, o.y] as [number, number] : o.t === 'attack' ? o.then : undefined;
    u.order = { t: 'attack', id: attacker.id, auto: true, then, answer: true };
  };
  answer(victim);
  for (const u of state.entities.values()) {
    if (u === victim || u.owner !== victim.owner || !isSoldier(u)) continue;
    const radius = u.stance === 'defensive' ? HOLD_RADIUS : HELP_RADIUS;
    if (Math.abs(u.x - victim.x) > radius || Math.abs(u.y - victim.y) > radius || distance(u, victim) > radius) continue;
    answer(u);
  }
}

function depleteTile(state: GameState, tile: number): void {
  state.map.tiles[tile] = Tile.Grass;
  state.map.version++;
  state.changedTiles.set(tile, Tile.Grass);
  state.tileEvents.push([tile, Tile.Grass]);
}

function nearestDropoff(state: GameState, e: Entity): Entity | undefined {
  let best: Entity | undefined;
  let bestD = Infinity;
  for (const b of state.entities.values()) {
    if (b.owner !== e.owner || !DEFS[b.kind].dropoff?.includes(e.carryRes) || b.progress < 1) continue;
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
      const next = nearestResourceTile(map, o.tile, o.res, 8, { e, team: teamOf(state, e.owner) });
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
    if (farm ? isInside(e, rect) : isAdjacent(e, rect)) {
      o.phase = 'work';
      if (e.carryRes !== o.res) {
        e.carry = 0;
        e.carryRes = o.res;
      }
    } else if (!(farm ? goOnto(state, e, rect) : goAdjacent(state, e, rect))) {
      // That tile cannot be got at (it is walled in by more of the same, or by others' buildings):
      // work the nearest one of the same kind that can, rather than giving up.
      const next = farm ? -1 : nearestResourceTile(map, o.tile, o.res, 8, { e, team: teamOf(state, e.owner) });
      if (next >= 0 && next !== o.tile) o.tile = next;
      else e.order = { t: 'idle' };
    }
    return;
  }

  // phase 'work'
  const has = hasTech(state, e.owner);
  const capacity = CARRY_CAPACITY + (has('handcart') ? 5 : 0);
  if (farm && farm.carry <= 0) {
    // The field is used up: it lies fallow, and the farmer takes what they have to the mill and stops.
    farm.fallow ??= state.tick;
    if (e.carry > 0) {
      o.farm = -1;
      o.phase = 'return';
      o.drop = -1;
    } else e.order = { t: 'idle' };
    return;
  }
  e.work += ((o.farm >= 0 ? FARM_RATE : GATHER_RATE) * (has(GATHER_TECH[o.res]) ? 1.2 : 1)) / TICK_RATE;
  while (e.work >= 1 && e.carry < capacity) {
    e.work -= 1;
    e.carry++;
    if (farm && --farm.carry <= 0) {
      farm.fallow = state.tick;
      break;
    }
    if (o.farm < 0) {
      state.amountEvents.set(o.tile, --map.amount[o.tile]);
      if (map.amount[o.tile] <= 0) {
        depleteTile(state, o.tile);
        break;
      }
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
  const full = site ? DEFS[site.kind].hp : 0;
  const finished = !site || (site.progress >= 1 && (site.hp >= full || site.kind === 'farm'));
  if (finished && e.tasks?.length) {
    // On to the next building on the list.
    o.id = e.tasks.shift()!;
    e.path = [];
    return;
  }
  if (!site) return void (e.order = { t: 'idle' });
  if (site.progress >= 1 && (site.hp >= full || site.kind === 'farm')) {
    if (site.kind === 'farm' && farmIsFree(state, site, e)) return void (e.order = gatherOrder(-1, site.id, 'food'));
    // Whoever builds a camp or mill starts gathering what it is for, if some is close by.
    const stores = site.kind === 'towncenter' ? undefined : DEFS[site.kind].dropoff;
    for (const res of stores ?? []) {
      const tile = nearestResourceTile(state.map, site.y * state.map.size + site.x, res, 6, { e, team: teamOf(state, e.owner) });
      if (tile >= 0) return void (e.order = gatherOrder(tile, -1, res));
    }
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
  if (site.progress === 0 && !def.walkable && state.map.blocked[site.y * state.map.size + site.x] === 0) {
    // Work begins: the blueprint becomes a building site, and whoever stands on it walks off.
    setBlocked(state.map, site, 1);
    clearFootprint(state, rectOf(site));
    if (e.path.length > 0) return;
  }
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
  if (!target || !isEnemy(state, target.owner, e.owner) || target.inside >= 0) return endAttack(state, e, o);
  const d = distance(e, target);
  // Too close to aim at: a catapult tower drops it and looks for someone further off.
  if (d < (def.minRange ?? 0)) return isBuilding(e) ? endAttack(state, e, o) : undefined;
  if (d <= rangeOf(e.kind, hasTech(state, e.owner))) {
    // In reach. A melee fighter stops here only if nobody else stands on this tile; otherwise it carries on
    // to its own spot, swinging as it goes, so that fighters never pile up on one another.
    const here = Math.floor(e.y) * state.map.size + Math.floor(e.x);
    const crowded = !isRangedKind(e.kind) && isTaken(state, here, e);
    if (!crowded) {
      if (isRangedKind(e.kind) || e.path.length > 4) e.path = [];
      if (e.path.length === 0) state.occupied.set(here, e.id);
    } else if (e.path.length === 0) {
      const spot = freeSpotAround(state, e, isBuilding(target) ? rectOf(target) : { x: Math.floor(target.x), y: Math.floor(target.y), s: 1 });
      if (spot) {
        e.path = findPath(state.map, Math.floor(e.x), Math.floor(e.y), spot[0], spot[1], teamOf(state, e.owner));
        claim(state, e);
      }
    }
    if (e.cooldown <= 0) strike(state, e, target);
    return;
  }
  // Holding ground: whoever steps out of reach is let go. A picked fight is given up once the enemy
  // gets well away; answering an attack, a bit further.
  if (o.hold) return endAttack(state, e, o);
  if (isBuilding(e) || (o.auto && d > (def.sight ?? DEFAULT_SIGHT) + (o.answer ? 10 : 4))) return endAttack(state, e, o);
  // Out of reach and no way to get there, e.g. behind a wall: searching again and again would only
  // flood the whole map each time. Picked fights are dropped; an ordered one walks as near as it
  // can once and then gives up there.
  const area = isBuilding(target) ? rectOf(target) : { x: Math.floor(target.x), y: Math.floor(target.y), s: 0 };
  if (!canReach(state.map, Math.floor(e.x), Math.floor(e.y), area.x, area.y, teamOf(state, e.owner), area.s)) {
    if (o.auto) return endAttack(state, e, o);
    if (!o.walled) {
      o.walled = true;
      const ex = Math.floor(e.x);
      const ey = Math.floor(e.y);
      const [nx, ny] = nearestReachable(state.map, ex, ey, area.x, area.y, teamOf(state, e.owner));
      e.path = findPath(state.map, ex, ey, nx, ny, teamOf(state, e.owner));
    } else if (e.path.length === 0) e.order = { t: 'idle' };
    return;
  }
  o.walled = false;
  // Chase, re-planning now and then because the target moves. Melee fighters each go for their own
  // tile next to the target, so that a crowd surrounds it instead of piling onto one spot.
  if (e.path.length === 0 || (state.tick + e.id) % 5 === 0) {
    const r = isBuilding(target) ? rectOf(target) : { x: Math.floor(target.x), y: Math.floor(target.y), s: 1 };
    const ranged = isRangedKind(e.kind);
    if (!ranged || isBuilding(target)) {
      const spot = d < 6 ? freeSpotAround(state, e, r) : undefined;
      if (spot) {
        e.path = findPath(state.map, Math.floor(e.x), Math.floor(e.y), spot[0], spot[1], teamOf(state, e.owner));
        // Already on that tile but off its centre: step to the centre, which is in reach. (An empty path
        // otherwise means the spot cannot be reached, e.g. it is behind a wall: never walk straight there.)
        if (e.path.length === 0 && Math.floor(e.x) === spot[0] && Math.floor(e.y) === spot[1]) e.path = [spot[0], spot[1]];
        claim(state, e);
      } else if (!goAdjacent(state, e, r) && o.auto) endAttack(state, e, o);
    } else {
      e.path = findPath(state.map, Math.floor(e.x), Math.floor(e.y), r.x, r.y, teamOf(state, e.owner));
    }
  }
}

/** The relic, kept in a player's monastery, adds this to the attack of their whole army. */
export const RELIC_ATTACK = 2;
export const RELIC_MAX = 1;

/** How many relics a player keeps, counted up to RELIC_MAX. */
export function relicsKept(state: GameState, owner: number): number {
  let n = 0;
  for (const r of state.relics) if (r.monastery >= 0 && state.entities.get(r.monastery)?.owner === owner) n++;
  return Math.min(RELIC_MAX, n);
}

/** Extra attack from relics: for soldiers, towers and castles, not for villagers. */
function relicBonus(state: GameState, e: Entity): number {
  return e.kind === 'villager' ? 0 : relicsKept(state, e.owner) * RELIC_ATTACK;
}

function carrying(state: GameState, e: Entity): Relic | undefined {
  return state.relics.find((r) => r.carrier === e.id);
}

function nearestMonastery(state: GameState, e: Entity): Entity | undefined {
  let best: Entity | undefined;
  for (const b of state.entities.values()) {
    if (b.owner !== e.owner || b.kind !== 'monastery' || b.progress < 1) continue;
    if (!best || distance(e, b) < distance(e, best)) best = b;
  }
  return best;
}

function stepFetch(state: GameState, e: Entity, o: Extract<Order, { t: 'fetch' }>): void {
  const relic = state.relics[o.relic];
  if (!relic || relic.monastery >= 0 || (relic.carrier >= 0 && relic.carrier !== e.id)) return void (e.order = { t: 'idle' });
  if (Math.hypot(e.x - relic.x, e.y - relic.y) <= 1.1) {
    // Picked up: off to the nearest monastery, if there is one.
    e.path = [];
    relic.carrier = e.id;
    const home = nearestMonastery(state, e);
    e.order = home ? { t: 'deliver', id: home.id } : { t: 'idle' };
    return;
  }
  if (e.path.length === 0 || (state.tick + e.id) % 10 === 0) {
    e.path = findPath(state.map, Math.floor(e.x), Math.floor(e.y), Math.floor(relic.x), Math.floor(relic.y), teamOf(state, e.owner));
    if (e.path.length === 0 && Math.hypot(e.x - relic.x, e.y - relic.y) > 1.1) e.order = { t: 'idle' };
  }
}

function stepDeliver(state: GameState, e: Entity, o: Extract<Order, { t: 'deliver' }>): void {
  const relic = carrying(state, e);
  const home = state.entities.get(o.id);
  if (!relic || !home || home.owner !== e.owner || home.kind !== 'monastery' || home.progress < 1) return void (e.order = { t: 'idle' });
  if (e.path.length > 0) return;
  if (!isAdjacent(e, rectOf(home))) {
    if (!goAdjacent(state, e, rectOf(home))) e.order = { t: 'idle' };
    return;
  }
  relic.carrier = -1;
  relic.monastery = home.id;
  [relic.x, relic.y] = centre(home);
  e.order = { t: 'idle' };
}

/** Notes which players have seen each relic: anything of theirs within sight of it. */
function spotRelics(state: GameState): void {
  if (state.tick % 5 !== 0) return;
  for (const r of state.relics) {
    for (const e of state.entities.values()) {
      if (e.inside >= 0 || (r.foundBy >> e.owner) & 1) continue;
      const half = isBuilding(e) ? sizeOf(e) / 2 : 0;
      const sight = (DEFS[e.kind].sight ?? DEFAULT_SIGHT) + half;
      if (Math.hypot(e.x + half - r.x, e.y + half - r.y) <= sight) r.foundBy |= 1 << e.owner;
    }
  }
}

/** Carried relics go with their monks. */
function moveRelics(state: GameState): void {
  for (const r of state.relics) {
    if (r.carrier < 0) continue;
    const monk = state.entities.get(r.carrier);
    if (!monk) {
      r.carrier = -1;
      continue;
    }
    r.x = monk.x;
    r.y = monk.y;
  }
}

/**
 * The town bell. Rung once, every villager stops what they are doing and goes into the nearest
 * town centre or castle that has room (or waits by the nearest one if none has); rung again,
 * they come out and go back to the job they had.
 */
function ringBell(state: GameState, slot: number): void {
  const villagers = [...state.entities.values()].filter((e) => e.owner === slot && e.kind === 'villager');
  if (villagers.some((e) => e.recall)) {
    for (const e of villagers) {
      if (!e.recall) continue;
      if (e.inside >= 0) {
        const b = state.entities.get(e.inside);
        if (b) ejectOne(state, b, e);
      }
      e.path = [];
      e.order = e.recall;
      delete e.recall;
    }
    return;
  }
  const shelters = [...state.entities.values()].filter((b) => b.owner === slot && DEFS[b.kind].garrison && b.progress >= 1);
  if (shelters.length === 0) return;
  const room = new Map(shelters.map((b) => [b.id, (DEFS[b.kind].garrison ?? 0) - countInside(state, b)]));
  for (const e of villagers) {
    if (e.inside >= 0) continue;
    const byDistance = [...shelters].sort((a, b) => distance(e, a) - distance(e, b));
    const b = byDistance.find((s) => (room.get(s.id) ?? 0) > 0) ?? byDistance[0];
    room.set(b.id, (room.get(b.id) ?? 0) - 1);
    e.recall = e.order.t === 'garrison' ? { t: 'idle' } : e.order;
    e.path = [];
    e.order = { t: 'garrison', id: b.id };
  }
}

/** Lets one unit out of a building. */
function ejectOne(state: GameState, b: Entity, e: Entity): void {
  const s = sizeOf(b);
  const [spot] = freeTilesNear(state.map, b.x + Math.floor(s / 2), b.y + s, 1);
  e.inside = -1;
  e.x = spot[0] + 0.5;
  e.y = spot[1] + 0.5;
}

/** Puts the relic on the map for a new game: on open ground, far from every starting town. */
export function placeRelics(state: GameState): void {
  const map = state.map;
  const n = map.size;
  const count = 1;
  let seed = (state.seed ^ 0x9e3779b9) >>> 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const awayFromTowns = n * 0.22;
  for (let tries = 0; tries < 4000 && state.relics.length < count; tries++) {
    const x = 4 + Math.floor(random() * (n - 8));
    const y = 4 + Math.floor(random() * (n - 8));
    const i = y * n + x;
    if (map.tiles[i] !== Tile.Grass || map.footprint[i] || map.blocked[i]) continue;
    if (map.starts.some(([sx, sy]) => Math.hypot(sx - x, sy - y) < awayFromTowns)) continue;
    if (state.relics.some((r) => Math.hypot(r.x - x, r.y - y) < n * 0.2)) continue;
    state.relics.push({ x: x + 0.5, y: y + 0.5, carrier: -1, monastery: -1, foundBy: 0 });
  }
}

function stepGarrison(state: GameState, e: Entity, o: Extract<Order, { t: 'garrison' }>): void {
  const castle = state.entities.get(o.id);
  if (!castle || !canShelter(state, e, castle)) return void (e.order = { t: 'idle' });
  if (e.path.length > 0) return;
  if (!isAdjacent(e, rectOf(castle))) {
    if (!goAdjacent(state, e, rectOf(castle))) e.order = { t: 'idle' };
    return;
  }
  e.inside = castle.id;
  e.order = { t: 'idle' };
  [e.x, e.y] = centre(castle);
}

function stepHeal(state: GameState, e: Entity, o: Extract<Order, { t: 'heal' }>): void {
  const target = state.entities.get(o.id);
  // Done: back to the attack being followed, if there is one.
  const done = () => void (e.order = o.back !== undefined ? { t: 'escort', id: o.back } : { t: 'idle' });
  if (!target || isEnemy(state, target.owner, e.owner) || target.inside >= 0) return done();
  const max = maxHpOf(target.kind, hasTech(state, target.owner));
  if (target.hp >= max) return done();
  if (distance(e, target) > 4) {
    if (e.path.length === 0 || (state.tick + e.id) % 5 === 0) {
      e.path = findPath(state.map, Math.floor(e.x), Math.floor(e.y), Math.floor(target.x), Math.floor(target.y), teamOf(state, e.owner));
    }
    return;
  }
  e.path = [];
  target.hp = Math.min(max, target.hp + (DEFS[e.kind].heal ?? 1) / TICK_RATE);
  if (state.tick % 5 === 0) state.blessings.push([e.id, target.id, 1]);
}

/** How many tiles lie between a unit and a rectangle: 0 on it, 1 right next to it. */
function gapTo(e: Entity, r: Rect): number {
  const tx = Math.floor(e.x);
  const ty = Math.floor(e.y);
  return Math.max(r.x - tx, 0, tx - (r.x + r.s - 1), r.y - ty, ty - (r.y + r.s - 1));
}

const ESCORT_GAP = 5;

function stepEscort(state: GameState, e: Entity, o: Extract<Order, { t: 'escort' }>): void {
  const target = state.entities.get(o.id);
  if (!target || !isEnemy(state, target.owner, e.owner) || target.inside >= 0) return void (e.order = { t: 'idle' });
  const def = DEFS[e.kind];
  // Heal whoever on our side is hurt worst nearby.
  if ((state.tick + e.id) % 5 === 0) {
    let best: Entity | undefined;
    let worst = 0;
    for (const f of state.entities.values()) {
      if (f === e || isBuilding(f) || f.inside >= 0 || isEnemy(state, f.owner, e.owner) || distance(e, f) > (def.sight ?? 6)) continue;
      const lack = maxHpOf(f.kind, hasTech(state, f.owner)) - f.hp;
      if (lack > worst) {
        worst = lack;
        best = f;
      }
    }
    if (best) {
      e.order = { t: 'heal', id: best.id, back: o.id };
      e.path = [];
      return;
    }
  }
  // Otherwise keep a few steps behind the fighting.
  const r = isBuilding(target) ? rectOf(target) : { x: Math.floor(target.x), y: Math.floor(target.y), s: 1 };
  if (gapTo(e, r) <= ESCORT_GAP || (e.path.length > 0 && (state.tick + e.id) % 10 !== 0)) return;
  const ex = Math.floor(e.x);
  const ey = Math.floor(e.y);
  const team = teamOf(state, e.owner);
  if (!canReach(state.map, ex, ey, r.x, r.y, team, r.s)) return void (e.order = { t: 'idle' });
  e.path = findPathToArea(state.map, ex, ey, r.x, r.y, r.s, team, false, ESCORT_GAP - 1).path;
}

function stepConvert(state: GameState, e: Entity, o: Extract<Order, { t: 'convert' }>): void {
  const target = state.entities.get(o.id);
  if (!target || !isEnemy(state, target.owner, e.owner) || target.inside >= 0 || target.kind === 'king') return void (e.order = { t: 'idle' });
  if (distance(e, target) > (DEFS[e.kind].range ?? 6)) {
    if (e.path.length === 0 || (state.tick + e.id) % 5 === 0) {
      e.path = findPath(state.map, Math.floor(e.x), Math.floor(e.y), Math.floor(target.x), Math.floor(target.y), teamOf(state, e.owner));
    }
    return;
  }
  e.path = [];
  // A monk who has just converted someone must rest first.
  if (e.cooldown > 0) return;
  o.progress += 1 / TICK_RATE;
  if (state.tick % 5 === 0) state.blessings.push([e.id, target.id, 2]);
  if (o.progress < CONVERT_TIME) return;
  target.owner = e.owner;
  target.order = { t: 'idle' };
  target.path = [];
  target.tasks = undefined;
  e.cooldown = CONVERT_REST * TICK_RATE;
  e.order = { t: 'idle' };
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
    // Units already in the field get the extra health at once.
    const boost = TECHS[item].boost;
    if (boost?.hp) {
      for (const e of state.entities.values()) if (e.owner === b.owner && boost.kinds.includes(e.kind)) e.hp += boost.hp;
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
    const shooting = e.order.t === 'attack' && isRangedKind(e.kind);
    if (taken.has(tile) && (e.order.t === 'idle' || shooting)) crowded.push(e);
    else taken.add(tile);
  }
  for (const e of crowded) {
    const team = teamOf(state, e.owner);
    const spot = freeTilesNear(state.map, Math.floor(e.x), Math.floor(e.y), 16)
      .find(([x, y]) => !taken.has(y * state.map.size + x) && canReach(state.map, Math.floor(e.x), Math.floor(e.y), x, y, team));
    if (!spot) continue;
    taken.add(spot[1] * state.map.size + spot[0]);
    e.path = findPath(state.map, Math.floor(e.x), Math.floor(e.y), spot[0], spot[1], teamOf(state, e.owner));
    // Archers keep shooting from the new spot.
    if (e.order.t === 'idle') e.order = { t: 'move' };
  }
}

function moveAlongPath(e: Entity): void {
  const speed = DEFS[e.kind].speed ?? 0;
  const grouped = e.pace !== undefined && (e.order.t === 'move' || e.order.t === 'amove');
  let budget = (grouped ? Math.min(speed, e.pace!) : speed) / TICK_RATE;
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

/** How long a villager who lost their job by themselves stands about before going back to work. */
const RESUME_TICKS = 5 * TICK_RATE;

/**
 * Villagers whose work stopped on its own (not by a player's order) and who then just stand there
 * are put back to it after a few seconds: the same job if it can still be done, otherwise the
 * nearest of the same kind.
 */
function watchIdle(state: GameState, e: Entity, before: Order): void {
  // (A villager sent only to drop off what they carry is meant to stand by afterwards.)
  const job = before.t === 'build' || (before.t === 'gather' && (before.tile >= 0 || before.farm >= 0));
  if (job && e.order.t === 'idle') {
    e.resume = { order: before, since: state.tick, tries: e.resume?.tries ?? 0 };
    return;
  }
  const r = e.resume;
  if (!r) return;
  if (e.order.t !== 'idle') {
    // Busy again: once they have been at it a good while, the slate is wiped clean.
    if (state.tick - r.since > 60 * TICK_RATE) e.resume = undefined;
    return;
  }
  if (e.path.length > 0 || state.tick - r.since < RESUME_TICKS) return;
  if (r.tries >= 3) return void (e.resume = undefined);
  r.tries++;
  r.since = state.tick;
  const o = r.order;
  const team = teamOf(state, e.owner);
  if (o.t === 'build') {
    const site = state.entities.get(o.id);
    if (site && site.owner === e.owner && (site.progress < 1 || (site.hp < DEFS[site.kind].hp && site.kind !== 'farm'))) e.order = { t: 'build', id: site.id };
    else e.resume = undefined;
  } else if (o.t === 'gather' && o.farm >= 0) {
    const farm = state.entities.get(o.farm);
    if (farm && farm.progress >= 1 && farm.fallow === undefined && farmIsFree(state, farm, e)) e.order = gatherOrder(-1, farm.id, 'food');
    else e.resume = undefined;
  } else if (o.t === 'gather') {
    const from = o.tile >= 0 ? o.tile : Math.floor(e.y) * state.map.size + Math.floor(e.x);
    const tile = nearestResourceTile(state.map, from, o.res, 10, { e, team });
    if (tile >= 0) e.order = gatherOrder(tile, -1, o.res);
    else e.resume = undefined;
  }
}

/** Advances the simulation by one tick. */
export function step(state: GameState): void {
  state.tick++;
  state.tileEvents = [];
  state.amountEvents = new Map();
  state.shots = [];
  state.hits = [];
  // Deaths are kept until they have been sent (GameHost starts a fresh list after each snapshot):
  // units and buildings also go between ticks, when a player deletes one, and those must not be
  // lost. Without a host the list is only kept from growing without end.
  if (state.deaths.length > 500) state.deaths.splice(0, state.deaths.length - 500);
  state.blessings = [];
  updateOccupied(state);
  if (state.tick % 10 === 0) spreadIdleUnits(state);

  for (const p of state.players.values()) p.pop = p.cap = 0;
  for (const e of state.entities.values()) {
    const p = state.players.get(e.owner);
    if (!p) continue;
    if (isBuilding(e)) p.cap += e.progress >= 1 ? DEFS[e.kind].housing ?? 0 : 0;
    else if (e.kind !== 'king') p.pop++;
  }
  for (const p of state.players.values()) p.cap = Math.min(state.popLimit, p.cap);

  for (const e of [...state.entities.values()]) {
    if (!state.entities.has(e.id) || e.inside >= 0) continue;
    const def = DEFS[e.kind];
    if (e.cooldown > 0) e.cooldown--;
    if (isBuilding(e) && e.progress < 1) continue;
    if (isBuilding(e)) stepTraining(state, e);
    // A field left fallow too long is gone.
    if (e.fallow !== undefined && state.tick - e.fallow >= FALLOW_SECONDS * TICK_RATE) {
      kill(state, e);
      continue;
    }

    const o = e.order;
    if (o.t === 'gather') stepGather(state, e, o);
    else if (o.t === 'build') stepBuild(state, e, o);
    else if (o.t === 'attack') stepAttack(state, e, o);
    else if (o.t === 'garrison') stepGarrison(state, e, o);
    else if (o.t === 'heal') stepHeal(state, e, o);
    else if (o.t === 'convert') stepConvert(state, e, o);
    else if (o.t === 'escort') stepEscort(state, e, o);
    else if (o.t === 'fetch') stepFetch(state, e, o);
    else if (o.t === 'deliver') stepDeliver(state, e, o);
    else if ((o.t === 'move' || o.t === 'amove') && e.path.length === 0) e.order = { t: 'idle' };
    if (e.kind === 'villager') watchIdle(state, e, o);

    // Soldiers and towers pick fights on their own; villagers and kings do not.
    const now = e.order;
    // Defensive soldiers wait until struck, though they still fight their way through an attack-move.
    const holding = now.t === 'idle' && e.stance === 'defensive';
    const looking = now.t === 'amove' || now.t === 'idle';
    if (looking && def.attack && e.kind !== 'villager' && (state.tick + e.id) % 5 === 0) {
      // Holding their ground, they still strike at anyone in reach without stepping out for them.
      const reach = isBuilding(e) || holding ? rangeOf(e.kind, hasTech(state, e.owner)) + (holding ? 0.3 : 0) : def.sight ?? DEFAULT_SIGHT;
      const enemy = findEnemy(state, e, reach);
      if (enemy) e.order = { t: 'attack', id: enemy.id, auto: true, then: now.t === 'amove' ? [now.x, now.y] : undefined, hold: holding || undefined };
    }
    // Idle monks look after wounded friends nearby.
    if (e.order.t === 'idle' && def.heal && (state.tick + e.id) % 5 === 0) {
      for (const f of state.entities.values()) {
        if (f === e || isBuilding(f) || f.inside >= 0 || isEnemy(state, f.owner, e.owner)) continue;
        if (f.hp < maxHpOf(f.kind, hasTech(state, f.owner)) && distance(e, f) <= (def.sight ?? 6)) {
          e.order = { t: 'heal', id: f.id };
          break;
        }
      }
    }
    if (!isBuilding(e)) moveAlongPath(e);
  }
  moveRelics(state);
  spotRelics(state);

  // A player whose king is dead is out, and everything they own goes with them.
  const kings = new Set<number>();
  for (const e of state.entities.values()) if (e.kind === 'king') kings.add(e.owner);
  for (const p of state.players.values()) {
    if (p.defeated || kings.has(p.slot)) continue;
    p.defeated = true;
    for (const e of [...state.entities.values()]) if (e.owner === p.slot) kill(state, e);
  }
  if (state.contested && state.winner < 0) {
    const alive = new Set([...state.players.values()].filter((p) => !p.defeated).map((p) => p.team));
    if (alive.size === 1) state.winner = [...alive][0];
  }
}

/** Activity code sent to clients: 0 idle, 1 moving, 2 working, 3 fighting. */
export function activityOf(e: Entity): number {
  if (e.path.length > 0) return 1;
  if (e.order.t === 'attack') return 3;
  if (e.order.t === 'gather' || e.order.t === 'build' || e.order.t === 'heal' || e.order.t === 'convert') return 2;
  return 0;
}

/**
 * What a unit is busy with, for its status line and work animations: [task, target].
 *  0 nothing · 1 wood, 2 berries, 3 gold, 4 stone (target: tile) · 5 farming (target: field)
 *  6 building or repairing (target: building) · 7 attacking (target: unit) · 8 taking resources home (target: resource index)
 *  9 going into a building (target: building) · 10 walking · 11 healing, 12 converting (target: unit)
 *  13 going for a relic (target: relic) · 14 taking the relic to a monastery (target: monastery)
 * Gathering and building are reported while walking there too; clients animate work only while the unit stands still.
 */
export function taskOf(e: Entity): [number, number] {
  const o = e.order;
  if (o.t === 'attack') return [7, o.id];
  if (o.t === 'heal') return [11, o.id];
  if (o.t === 'convert') return [12, o.id];
  if (o.t === 'fetch') return [13, o.relic];
  if (o.t === 'deliver') return [14, o.id];
  if (o.t === 'escort') return [15, o.id];
  if (o.t === 'build') return [6, o.id];
  if (o.t === 'garrison') return [9, o.id];
  if (o.t === 'gather') {
    if (o.phase === 'return') return [8, RESOURCES.indexOf(e.carryRes)];
    if (o.farm >= 0) return [5, o.farm];
    return [1 + ['wood', 'food', 'gold', 'stone'].indexOf(o.res), o.tile];
  }
  if (o.t === 'move' || o.t === 'amove') return [10, 0];
  return [0, 0];
}

export const kindIndex = (kind: Kind): number => KINDS.indexOf(kind);
