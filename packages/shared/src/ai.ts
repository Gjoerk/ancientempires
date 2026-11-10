import { DEFS, Kind, POP_MAX, Res, TECH_IDS, TechId, TECHS } from './defs';
import { GameMap, Tile, TILE_RESOURCE } from './map';
import { applyCommand, canAfford, canPlace, Entity, GameState, isEnemy } from './sim';

// A simple computer opponent. It plays through the same commands a person does:
// it grows a village, advances through the ages, raises an army and sends it out in waves.

const VILLAGER_GOAL = 18;
const ARMY_LIMIT = 26;
/** Share of villagers wanted on each resource. */
const WORKER_SHARE: Record<Res, number> = { food: 0.45, wood: 0.33, gold: 0.2, stone: 0.02 };
const RES_TILES: Record<Res, number[]> = { food: [Tile.Berries], wood: [Tile.Forest], gold: [Tile.Gold], stone: [Tile.Stone] };

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
  const build = (kind: Kind, near: [number, number] = [sx, sy]): boolean => {
    const def = DEFS[kind];
    if (sites.length > 0 || (def.age ?? 1) > p.age || !canAfford(p, def.cost)) return false;
    const spot = findSite(map, kind, near[0], near[1]);
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
  const woodTile = nearestTile(map, RES_TILES.wood, sx, sy, 24);
  const goldTile = nearestTile(map, RES_TILES.gold, sx, sy, 24);
  const berriesLeft = nearestTile(map, RES_TILES.food, sx, sy, 16) >= 0;
  if (p.pop >= p.cap - 2 && p.cap < POP_MAX) build('house');
  else if (of('barracks').length === 0 && villagers.length >= 7) build('barracks');
  else if (of('lumbercamp').length === 0 && villagers.length >= 8 && woodTile >= 0) build('lumbercamp', [woodTile % map.size, Math.floor(woodTile / map.size)]);
  else if (of('miningcamp').length === 0 && villagers.length >= 9 && goldTile >= 0) build('miningcamp', [goldTile % map.size, Math.floor(goldTile / map.size)]);
  else if (of('mill').length === 0 && farms.length >= 3) build('mill');
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
    // Army-wide upgrades first, then whatever else the smith offers.
    const next = TECH_IDS.find((id) => TECHS[id].at === 'blacksmith' && wants(id) && canAfford(p, TECHS[id].cost) && id !== 'arrowslits');
    if (next) applyCommand(state, slot, { type: 'train', building: smith.id, kind: next });
  }
  for (const [kind, tech] of [['lumbercamp', 'axes'], ['miningcamp', 'picks'], ['mill', 'ploughs']] as const) {
    const camp = built(kind)[0];
    if (camp && camp.queue.length === 0 && wants(tech) && !saving) applyCommand(state, slot, { type: 'train', building: camp.id, kind: tech });
  }

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

  // Villagers are spread over the resources in fixed shares. Idle ones go where workers are
  // most lacking, and when the split has drifted one villager at a time is moved back.
  const working: Record<Res, number> = { food: 0, wood: 0, gold: 0, stone: 0 };
  for (const v of villagers) if (v.order.t === 'gather') working[v.order.res]++;
  const assign = (v: Entity, res: Res): boolean => {
    if (res === 'food' && !berriesLeft) {
      const farm = farms.find((f) => !villagers.some((w) => w.order.t === 'gather' && w.order.farm === f.id));
      if (!farm) return false;
      applyCommand(state, slot, { type: 'interact', ids: [v.id], target: farm.id });
    } else {
      const tile = nearestTile(map, RES_TILES[res], sx, sy, 24);
      if (tile < 0 || !TILE_RESOURCE[map.tiles[tile] as Tile]) return false;
      applyCommand(state, slot, { type: 'gather', ids: [v.id], tile });
    }
    if (v.order.t === 'gather') working[v.order.res]--;
    working[res]++;
    return true;
  };
  const byNeed = (): Res[] => (['food', 'wood', 'gold', 'stone'] as Res[]).sort(
    (a, b) => working[a] / WORKER_SHARE[a] - working[b] / WORKER_SHARE[b],
  );
  for (const v of villagers) {
    if (v.order.t !== 'idle') continue;
    for (const res of byNeed()) if (assign(v, res)) break;
  }
  const order = byNeed();
  const most = order[order.length - 1];
  const least = order.find((res) => working[res] < WORKER_SHARE[res] * villagers.length - 1);
  if (least && least !== most && working[most] > WORKER_SHARE[most] * villagers.length + 1) {
    const mover = villagers.find((v) => v.order.t === 'gather' && v.order.res === most && v.carry === 0);
    if (mover) assign(mover, least);
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
