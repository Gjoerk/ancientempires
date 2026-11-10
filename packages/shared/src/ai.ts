import { DEFS, Kind, POP_MAX, Res, TechId } from './defs';
import { GameMap, Tile, TILE_RESOURCE } from './map';
import { applyCommand, canAfford, canPlace, Entity, GameState, isEnemy } from './sim';

// A simple computer opponent. It plays through the same commands a person does:
// it grows a village, advances through the ages, raises an army and sends it out in waves.

const VILLAGER_GOAL = 18;
const ARMY_LIMIT = 26;
/** Share of villagers wanted on each resource. */
const WORKER_SHARE: Record<Res, number> = { food: 0.45, wood: 0.35, gold: 0.2 };
const RES_TILES: Record<Res, number[]> = { food: [Tile.Berries], wood: [Tile.Forest], gold: [Tile.Gold] };

function nearestTile(map: GameMap, tiles: number[], fx: number, fy: number, radius: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let y = Math.max(0, fy - radius); y <= Math.min(map.size - 1, fy + radius); y++) {
    for (let x = Math.max(0, fx - radius); x <= Math.min(map.size - 1, fx + radius); x++) {
      const i = y * map.size + x;
      if (!tiles.includes(map.tiles[i])) continue;
      const d = Math.hypot(x - fx, y - fy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  return best;
}

/** A free spot for a building near a point, leaving a tile of room around it to walk. */
function findSite(map: GameMap, kind: Kind, cx: number, cy: number): [number, number] | undefined {
  const s = DEFS[kind].size ?? 1;
  for (let r = 3; r <= 16; r++) {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
        let free = true;
        for (let v = y - 1; v <= y + s && free; v++) {
          for (let u = x - 1; u <= x + s && free; u++) {
            // The footprint must be buildable and the ring around it must not hold a building.
            const inside = u >= x && u < x + s && v >= y && v < y + s;
            if (u < 0 || v < 0 || u >= map.size || v >= map.size) free = false;
            else if (inside ? !canPlace(map, 'wall', u, v) : map.blocked[v * map.size + u] === 1) free = false;
          }
        }
        if (free) return [x, y];
      }
    }
  }
  return undefined;
}

export function runAi(state: GameState, slot: number): void {
  const p = state.players.get(slot);
  if (!p || p.defeated) return;
  const map = state.map;
  const [sx, sy] = map.starts[slot];
  const notes = state.ai.get(slot) ?? { lastAttack: 0, waves: 0 };
  state.ai.set(slot, notes);

  const mine: Entity[] = [];
  for (const e of state.entities.values()) if (e.owner === slot) mine.push(e);
  const of = (kind: Kind) => mine.filter((e) => e.kind === kind);
  const built = (kind: Kind) => mine.filter((e) => e.kind === kind && e.progress >= 1);
  const villagers = of('villager');
  const soldiers = mine.filter((e) => !DEFS[e.kind].building && e.kind !== 'villager' && e.kind !== 'king');
  const sites = mine.filter((e) => DEFS[e.kind].building && e.progress < 1);
  const tc = built('towncenter')[0];
  const has = (tech: TechId) => p.techs.has(tech);
  const wants = (tech: TechId) => !has(tech) && !p.researching.has(tech);

  // The king stays in the castle.
  const king = of('king')[0];
  const castle = built('castle')[0];
  if (king && king.inside < 0 && castle && king.order.t === 'idle') {
    applyCommand(state, slot, { type: 'interact', ids: [king.id], target: castle.id });
  }

  // One new building at a time, so the wood is not spread over half-finished sites.
  const build = (kind: Kind): boolean => {
    const def = DEFS[kind];
    if (sites.length > 0 || (def.age ?? 1) > p.age || !canAfford(p, def.cost)) return false;
    const spot = findSite(map, kind, sx, sy);
    const builder = villagers.find((v) => v.order.t === 'idle') ?? villagers.find((v) => v.order.t === 'gather' && v.order.res === 'wood') ?? villagers[0];
    if (!spot || !builder) return false;
    applyCommand(state, slot, { type: 'place', ids: [builder.id], kind, x: spot[0], y: spot[1] });
    return true;
  };
  // Unfinished buildings always get a builder.
  for (const site of sites) {
    if (villagers.some((v) => v.order.t === 'build' && v.order.id === site.id)) continue;
    const helper = villagers.find((v) => v.order.t === 'idle') ?? villagers.find((v) => v.order.t === 'gather');
    if (helper) applyCommand(state, slot, { type: 'interact', ids: [helper.id], target: site.id });
  }

  const farms = built('farm');
  const berriesLeft = nearestTile(map, RES_TILES.food, sx, sy, 16) >= 0;
  if (p.pop >= p.cap - 2 && p.cap < POP_MAX) build('house');
  else if (of('barracks').length === 0 && villagers.length >= 7) build('barracks');
  else if (!berriesLeft && farms.length + of('farm').filter((f) => f.progress < 1).length < 8 && p.res.food < 300) build('farm');
  else if (p.age >= 2 && of('range').length === 0) build('range');
  else if (p.age >= 2 && of('blacksmith').length === 0 && soldiers.length >= 4) build('blacksmith');
  else if (p.age >= 2 && of('stable').length === 0 && soldiers.length >= 8) build('stable');
  else if (p.age >= 3 && of('workshop').length === 0) build('workshop');

  // Villagers, ages and upgrades.
  // While saving up for the next age, nothing else is bought with food.
  const saving = (p.age === 1 && villagers.length >= 10 && wants('age2')) || (p.age === 2 && soldiers.length >= 8 && wants('age3'));
  if (tc && tc.queue.length === 0) {
    if (saving) applyCommand(state, slot, { type: 'train', building: tc.id, kind: p.age === 1 ? 'age2' : 'age3' });
    else if (villagers.length < VILLAGER_GOAL && p.pop < p.cap) applyCommand(state, slot, { type: 'train', building: tc.id, kind: 'villager' });
    else if (p.age >= 2 && wants('loom')) applyCommand(state, slot, { type: 'train', building: tc.id, kind: 'loom' });
  }
  const smith = built('blacksmith')[0];
  if (smith && smith.queue.length === 0) {
    for (const tech of ['weapons', 'armour'] as const) if (wants(tech)) applyCommand(state, slot, { type: 'train', building: smith.id, kind: tech });
  }
  const store = built('storehouse')[0] ?? undefined;
  if (store && store.queue.length === 0 && wants('tools')) applyCommand(state, slot, { type: 'train', building: store.id, kind: 'tools' });

  // Soldiers: a mixed army, once the village can pay for it.
  if (soldiers.length < ARMY_LIMIT && villagers.length >= 8 && !saving) {
    for (const b of built('barracks')) {
      if (b.queue.length > 0) continue;
      const kind = p.age >= 2 && (b.id + state.tick) % 2 === 0 ? 'swordsman' : 'spearman';
      applyCommand(state, slot, { type: 'train', building: b.id, kind });
    }
    for (const b of [...built('range'), ...built('stable')]) {
      if (b.queue.length === 0) applyCommand(state, slot, { type: 'train', building: b.id, kind: b.kind === 'range' ? 'archer' : 'rider' });
    }
    for (const b of built('workshop')) {
      if (b.queue.length === 0 && of('ram').length < 2) applyCommand(state, slot, { type: 'train', building: b.id, kind: 'ram' });
    }
  }

  // Put idle villagers on whatever resource is most short of workers.
  const working: Record<Res, number> = { food: 0, wood: 0, gold: 0 };
  for (const v of villagers) if (v.order.t === 'gather') working[v.order.res]++;
  for (const v of villagers) {
    if (v.order.t !== 'idle') continue;
    const order: Res[] = (['food', 'wood', 'gold'] as Res[]).sort(
      (a, b) => working[a] / WORKER_SHARE[a] - working[b] / WORKER_SHARE[b],
    );
    for (const res of order) {
      if (res === 'food') {
        const farm = farms.find((f) => !villagers.some((w) => w.order.t === 'gather' && w.order.farm === f.id));
        if (!berriesLeft && farm) {
          applyCommand(state, slot, { type: 'interact', ids: [v.id], target: farm.id });
          working.food++;
          break;
        }
      }
      const tile = nearestTile(map, RES_TILES[res], sx, sy, 24);
      if (tile < 0 || !TILE_RESOURCE[map.tiles[tile] as Tile]) continue;
      applyCommand(state, slot, { type: 'gather', ids: [v.id], tile });
      working[res]++;
      break;
    }
  }

  // Attack in waves that grow each time; in between, the army waits at home.
  const army = soldiers.filter((e) => e.kind !== 'ram' || p.age >= 3);
  const waveSize = Math.min(20, 6 + notes.waves * 3);
  if (army.length >= waveSize && state.tick - notes.lastAttack > 450) {
    let target: Entity | undefined;
    let bestD = Infinity;
    for (const e of state.entities.values()) {
      if (!isEnemy(state, e.owner, slot) || !DEFS[e.kind].building || e.kind === 'wall') continue;
      const d = Math.hypot(e.x - sx, e.y - sy) - (e.kind === 'castle' ? 6 : 0);
      if (d < bestD) {
        bestD = d;
        target = e;
      }
    }
    if (target) {
      applyCommand(state, slot, { type: 'amove', ids: army.map((e) => e.id), x: target.x + 1, y: target.y + 1 });
      notes.lastAttack = state.tick;
      notes.waves++;
    }
  }
}
