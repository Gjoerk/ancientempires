import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addPlayer, applyCommand, armorOf, attackOf, canPlace, createGame, DEFS, hasTech, Entity, findPath, GameHost, GameState, generateMap, isWalkable, spawn, step, Tile,
  TILE_RESOURCE, RESEED_COST, FARM_FOOD, FALLOW_SECONDS, formationSlots, FORMATIONS,
} from './index';

const owned = (s: GameState, slot: number, kind: string): Entity[] =>
  [...s.entities.values()].filter((e) => e.owner === slot && e.kind === kind);
const attacking = (e: Entity, target: Entity) => e.order.t === 'attack' && e.order.id === target.id;
const run = (s: GameState, ticks: number) => {
  for (let i = 0; i < ticks; i++) step(s);
};
const findTile = (s: GameState, tile: number, near: [number, number]): number => {
  let best = -1;
  let bestD = Infinity;
  s.map.tiles.forEach((t, i) => {
    const d = Math.hypot((i % s.map.size) - near[0], Math.floor(i / s.map.size) - near[1]);
    if (t === tile && d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
};

test('map generation is deterministic and every start has all four resources nearby', () => {
  const a = generateMap(42);
  assert.deepEqual(a.tiles, generateMap(42).tiles);
  for (const [sx, sy] of a.starts) {
    assert.ok(isWalkable(a, sx, sy));
    for (const tile of [Tile.Forest, Tile.Berries, Tile.Gold, Tile.Stone]) {
      let found = false;
      for (let y = sy - 12; y <= sy + 12; y++) for (let x = sx - 12; x <= sx + 12; x++) if (a.tiles[y * a.size + x] === tile) found = true;
      assert.ok(found, `tile ${tile} near start`);
    }
  }
});

test('paths only cross walkable tiles and end at the goal', () => {
  const map = generateMap(7);
  const [sx, sy] = map.starts[0];
  const path = findPath(map, sx, sy, sx + 3, sy + 3);
  assert.deepEqual(path.slice(-2), [sx + 3, sy + 3]);
  for (let i = 0; i < path.length; i += 2) assert.ok(isWalkable(map, path[i], path[i + 1]));
});

test('villagers gather every resource and deliver it to the town centre', () => {
  for (const tile of [Tile.Forest, Tile.Berries, Tile.Gold, Tile.Stone]) {
    const s = createGame(5);
    addPlayer(s, 0);
    const res = TILE_RESOURCE[tile as Tile]!.res;
    const before = s.players.get(0)!.res[res];
    applyCommand(s, 0, { type: 'gather', ids: owned(s, 0, 'villager').map((e) => e.id), tile: findTile(s, tile, s.map.starts[0]) });
    run(s, 600);
    assert.ok(s.players.get(0)!.res[res] >= before + 40, `${res}: ${s.players.get(0)!.res[res]}`);
  }
});

test('a depleted tile turns to grass and is reported', () => {
  const s = createGame(5);
  addPlayer(s, 0);
  const tile = findTile(s, Tile.Berries, s.map.starts[0]);
  s.map.amount[tile] = 3;
  applyCommand(s, 0, { type: 'gather', ids: [owned(s, 0, 'villager')[0].id], tile });
  run(s, 300);
  assert.equal(s.map.tiles[tile], Tile.Grass);
  assert.equal(s.changedTiles.get(tile), Tile.Grass);
});

test('building costs resources, gets built, and houses raise the population limit', () => {
  const s = createGame(9);
  addPlayer(s, 0);
  const [sx, sy] = s.map.starts[0];
  const p = s.players.get(0)!;
  const ids = owned(s, 0, 'villager').map((e) => e.id);
  applyCommand(s, 0, { type: 'place', ids, kind: 'house', x: sx - 1, y: sy + 3 });
  assert.equal(p.res.wood, 200 - 30);
  // The same spot is taken now, and nobody can build without the resources.
  applyCommand(s, 0, { type: 'place', ids, kind: 'house', x: sx - 1, y: sy + 3 });
  assert.equal(owned(s, 0, 'house').length, 1);
  run(s, 200);
  const house = owned(s, 0, 'house')[0];
  assert.equal(house.progress, 1);
  assert.equal(house.hp, DEFS.house.hp);
  assert.equal(p.cap, 10);
});

test('training takes resources and time, and stops at the population limit', () => {
  const s = createGame(9);
  addPlayer(s, 0);
  const tc = owned(s, 0, 'towncenter')[0];
  applyCommand(s, 0, { type: 'train', building: tc.id, kind: 'villager' });
  applyCommand(s, 0, { type: 'train', building: tc.id, kind: 'villager' });
  applyCommand(s, 0, { type: 'train', building: tc.id, kind: 'swordsman' });
  assert.equal(s.players.get(0)!.res.food, 100);
  assert.equal(tc.queue.length, 2);
  run(s, 400);
  // Housing is 5: three villagers and a scout were there from the start, so one more fits.
  assert.equal(owned(s, 0, 'villager').length, 4);
  assert.equal(tc.queue.length, 1);
});

test('soldiers attack on their own, counters matter, and losing the king ends the game', () => {
  const s = createGame(11);
  addPlayer(s, 0);
  addPlayer(s, 1);
  const king = owned(s, 1, 'king')[0];
  const kx = Math.floor(king.x);
  const ky = Math.floor(king.y);
  for (let i = 0; i < 4; i++) spawn(s, 0, 'swordsman', kx + 2, ky + 1 + (i % 2));
  run(s, 5);
  assert.equal(s.winner, -1);
  applyCommand(s, 0, { type: 'interact', ids: owned(s, 0, 'swordsman').map((e) => e.id), target: king.id });
  run(s, 300);
  assert.equal(s.players.get(1)!.defeated, true);
  // The game is over: the loser's town is left standing, so everyone can see what they built.
  assert.ok(owned(s, 1, 'towncenter').length > 0);
  assert.equal(s.winner, 0);

  const duel = createGame(11);
  addPlayer(duel, 0);
  addPlayer(duel, 1);
  spawn(duel, 0, 'spearman', 30, 30);
  spawn(duel, 1, 'rider', 31, 30);
  run(duel, 300);
  assert.equal(owned(duel, 1, 'rider').length, 0);
  assert.equal(owned(duel, 0, 'spearman').length, 1);
});

test('commands for units of another player are ignored', () => {
  const s = createGame(3);
  addPlayer(s, 0);
  addPlayer(s, 1);
  const theirs = owned(s, 1, 'villager');
  const before = theirs.map((e) => [e.x, e.y]);
  applyCommand(s, 0, { type: 'move', ids: theirs.map((e) => e.id), x: 30, y: 30 });
  run(s, 50);
  assert.deepEqual(theirs.map((e) => [e.x, e.y]), before);
});

test('a king shelters in the castle, cannot be attacked there, and comes out when told or when it falls', () => {
  const s = createGame(21);
  addPlayer(s, 0);
  addPlayer(s, 1);
  const king = owned(s, 0, 'king')[0];
  const castle = owned(s, 0, 'castle')[0];
  applyCommand(s, 0, { type: 'interact', ids: [king.id], target: castle.id });
  run(s, 100);
  assert.equal(king.inside, castle.id);
  const raider = spawn(s, 1, 'swordsman', castle.x - 1, castle.y + 4);
  applyCommand(s, 1, { type: 'interact', ids: [raider.id], target: king.id });
  run(s, 30);
  assert.equal(king.hp, DEFS.king.hp);
  s.entities.delete(raider.id);
  applyCommand(s, 0, { type: 'eject', building: castle.id });
  assert.equal(king.inside, -1);
  assert.ok(isWalkable(s.map, Math.floor(king.x), Math.floor(king.y)));
  applyCommand(s, 0, { type: 'interact', ids: [king.id], target: castle.id });
  run(s, 100);
  assert.equal(king.inside, castle.id);
  castle.hp = 1;
  const second = spawn(s, 1, 'swordsman', castle.x - 1, castle.y + 4);
  applyCommand(s, 1, { type: 'interact', ids: [second.id], target: castle.id });
  run(s, 40);
  assert.equal(s.entities.has(castle.id), false);
  assert.equal(king.inside, -1);
  assert.equal(s.players.get(0)!.defeated, false);
});

test('ages gate buildings and units, and research unlocks and improves things', () => {
  const s = createGame(31);
  addPlayer(s, 0);
  const p = s.players.get(0)!;
  Object.assign(p.res, { food: 5000, wood: 5000, gold: 5000, stone: 5000 });
  const [sx, sy] = s.map.starts[0];
  const ids = owned(s, 0, 'villager').map((e) => e.id);
  const tc = owned(s, 0, 'towncenter')[0];
  // Not available in the first age.
  applyCommand(s, 0, { type: 'place', ids, kind: 'blacksmith', x: sx - 1, y: sy + 3 });
  assert.equal(owned(s, 0, 'blacksmith').length, 0);
  applyCommand(s, 0, { type: 'train', building: tc.id, kind: 'age3' });
  assert.equal(tc.queue.length, 0);
  applyCommand(s, 0, { type: 'train', building: tc.id, kind: 'age2' });
  applyCommand(s, 0, { type: 'train', building: tc.id, kind: 'age2' });
  assert.equal(tc.queue.length, 1, 'cannot be ordered twice');
  run(s, 410);
  assert.equal(p.age, 2);
  applyCommand(s, 0, { type: 'place', ids, kind: 'blacksmith', x: sx - 1, y: sy + 3 });
  run(s, 100);
  const smith = owned(s, 0, 'blacksmith')[0];
  assert.equal(smith.progress, 1);
  applyCommand(s, 0, { type: 'train', building: smith.id, kind: 'weapons' });
  applyCommand(s, 0, { type: 'train', building: tc.id, kind: 'loom' });
  run(s, 310);
  assert.ok(p.techs.has('weapons') && p.techs.has('loom'));
  assert.equal(owned(s, 0, 'villager')[0].hp, 40);
  // Better weapons make a swordsman hit a house for 7 + 1 (upgrade) + 2 (vs buildings) - 3 (armour) = 7.
  addPlayer(s, 1);
  const house = spawn(s, 1, 'house', 30, 30);
  const sword = spawn(s, 0, 'swordsman', 29, 30);
  applyCommand(s, 0, { type: 'interact', ids: [sword.id], target: house.id });
  run(s, 2);
  assert.equal(house.hp, DEFS.house.hp - 7);

  // Upgrades for one kind of soldier leave the others alone, and existing units gain the health.
  const spear = spawn(s, 0, 'spearman', 28, 28);
  applyCommand(s, 0, { type: 'train', building: smith.id, kind: 'jacks' });
  applyCommand(s, 0, { type: 'train', building: smith.id, kind: 'blades' });
  run(s, 520);
  assert.ok(p.techs.has('jacks') && p.techs.has('blades'));
  assert.equal(spear.hp, DEFS.spearman.hp + 15);
  const has = hasTech(s, 0);
  assert.equal(attackOf('swordsman', has), DEFS.swordsman.attack! + 1 + 3);
  assert.equal(attackOf('spearman', has), 4 + 1);
  assert.equal(armorOf('spearman', has), 1);
  assert.equal(armorOf('swordsman', has), 1);
});

test('the market trades, villagers repair, and own things can be deleted', () => {
  const s = createGame(33);
  addPlayer(s, 0);
  const p = s.players.get(0)!;
  p.age = 2;
  const [sx, sy] = s.map.starts[0];
  const market = spawn(s, 0, 'market', sx - 2, sy + 3);
  applyCommand(s, 0, { type: 'trade', building: market.id, res: 'food', buy: false });
  assert.deepEqual([p.res.food, p.res.gold], [100, 160]);
  applyCommand(s, 0, { type: 'trade', building: market.id, res: 'stone', buy: true });
  assert.deepEqual([p.res.stone, p.res.gold], [200, 30]);
  applyCommand(s, 0, { type: 'trade', building: market.id, res: 'stone', buy: true });
  assert.equal(p.res.gold, 30, 'cannot buy without the gold');

  market.hp = 100;
  applyCommand(s, 0, { type: 'interact', ids: [owned(s, 0, 'villager')[0].id], target: market.id });
  run(s, 100);
  assert.ok(market.hp > 150, `repaired to ${market.hp}`);

  const king = owned(s, 0, 'king')[0];
  applyCommand(s, 0, { type: 'delete', id: king.id });
  assert.ok(s.entities.has(king.id), 'the king cannot be deleted');
  applyCommand(s, 0, { type: 'delete', id: market.id });
  assert.equal(s.entities.has(market.id), false);
  assert.ok(isWalkable(s.map, market.x, market.y));
});

test('attack-move fights on the way and then carries on; rally points send new units out', () => {
  const s = createGame(35);
  addPlayer(s, 0);
  addPlayer(s, 1);
  const a = spawn(s, 0, 'swordsman', 28, 30);
  const victim = spawn(s, 1, 'villager', 32, 30);
  applyCommand(s, 0, { type: 'amove', ids: [a.id], x: 38, y: 30 });
  run(s, 150);
  assert.equal(s.entities.has(victim.id), false, 'killed what it met');
  assert.ok(Math.hypot(a.x - 38.5, a.y - 30.5) < 2.5, `arrived at ${a.x},${a.y}`);

  const tc = owned(s, 0, 'towncenter')[0];
  const [sx, sy] = s.map.starts[0];
  s.players.get(0)!.cap = 50;
  spawn(s, 0, 'house', sx - 1, sy + 4);
  applyCommand(s, 0, { type: 'rally', building: tc.id, x: sx + 2, y: sy + 5 });
  applyCommand(s, 0, { type: 'train', building: tc.id, kind: 'villager' });
  run(s, 180);
  const newest = owned(s, 0, 'villager').sort((x, y) => y.id - x.id)[0];
  assert.ok(Math.hypot(newest.x - (sx + 2.5), newest.y - (sy + 5.5)) < 1.5, `went to ${newest.x},${newest.y}`);
});

test('walls block the way and idle units on one tile spread out', () => {
  const s = createGame(37);
  addPlayer(s, 0);
  const [sx, sy] = s.map.starts[0];
  spawn(s, 0, 'wall', sx, sy + 4);
  assert.equal(isWalkable(s.map, sx, sy + 4), false);
  const a = spawn(s, 0, 'spearman', sx, sy + 5);
  const b = spawn(s, 0, 'spearman', sx, sy + 5);
  run(s, 40);
  assert.notDeepEqual([a.x, a.y], [b.x, b.y]);
});

test('gates let their own team through and nobody else', () => {
  const s = createGame(41);
  addPlayer(s, 0, 0);
  addPlayer(s, 1, 1);
  addPlayer(s, 2, 0);
  // A wall right across the map with a single gate of team 0.
  const y = 40;
  for (let x = 0; x < s.map.size; x++) {
    s.map.tiles[y * s.map.size + x] = Tile.Grass;
    if (x !== 20) spawn(s, 0, 'wall', x, y);
  }
  spawn(s, 0, 'gate', 20, y);
  for (const tile of [(y - 1) * s.map.size + 20, (y + 1) * s.map.size + 20]) s.map.tiles[tile] = Tile.Grass;
  const reaches = (owner: number) => {
    const path = findPath(s.map, 20, y - 1, 20, y + 1, s.players.get(owner)!.team);
    return path.length > 0 && path[path.length - 1] === y + 1;
  };
  assert.equal(reaches(0), true, 'owner');
  assert.equal(reaches(2), true, 'ally');
  assert.equal(reaches(1), false, 'enemy');
});

test('allies do not fight each other and a team wins together', () => {
  const s = createGame(43);
  addPlayer(s, 0, 0);
  addPlayer(s, 1, 0);
  addPlayer(s, 2, 1);
  const mine = spawn(s, 0, 'swordsman', 30, 30);
  const ally = spawn(s, 1, 'villager', 31, 30);
  applyCommand(s, 0, { type: 'interact', ids: [mine.id], target: ally.id });
  run(s, 60);
  assert.equal(ally.hp, DEFS.villager.hp);
  assert.equal(s.winner, -1);
  s.entities.delete(owned(s, 2, 'king')[0].id);
  run(s, 2);
  assert.equal(s.winner, 0, 'team 0 wins');
  assert.equal(s.players.get(0)!.defeated || s.players.get(1)!.defeated, false);
});

test('a computer opponent builds up, advances and beats an idle player', () => {
  const host = new GameHost('TEST');
  host.join('Idle');
  host.join('Computer', 'ai');
  host.start(11);
  const s = host.state!;
  let ticks = 0;
  for (; ticks < 14000 && s.winner < 0; ticks++) host.tick();
  const p = s.players.get(1)!;
  assert.ok(owned(s, 1, 'villager').length >= 10, `villagers: ${owned(s, 1, 'villager').length}`);
  assert.ok(p.age >= 2, `age ${p.age}`);
  assert.equal(s.winner, 1, `no win after ${ticks} ticks; army ${[...s.entities.values()].filter((e) => e.owner === 1 && DEFS[e.kind].attack && !DEFS[e.kind].building && e.kind !== 'villager').length}`);
});

test('each resource is delivered only where it belongs, and camps put their builders to work', () => {
  const s = createGame(51);
  addPlayer(s, 0);
  const p = s.players.get(0)!;
  p.res.wood = 1000;
  const wood = findTile(s, Tile.Forest, s.map.starts[0]);
  const wx = wood % s.map.size;
  const wy = Math.floor(wood / s.map.size);
  // Find room for a lumber camp next to the trees.
  let spot: [number, number] | undefined;
  for (let r = 1; r < 6 && !spot; r++) {
    for (let y = wy - r; y <= wy + r && !spot; y++) for (let x = wx - r; x <= wx + r && !spot; x++) {
      if ([0, 1].every((dx) => [0, 1].every((dy) => isWalkable(s.map, x + dx, y + dy)))) spot = [x, y];
    }
  }
  const v = owned(s, 0, 'villager')[0];
  applyCommand(s, 0, { type: 'place', ids: [v.id], kind: 'lumbercamp', x: spot![0], y: spot![1] });
  run(s, 400);
  const camp = owned(s, 0, 'lumbercamp')[0];
  assert.equal(camp.progress, 1);
  assert.equal(v.order.t, 'gather', 'the builder went on to chop wood');
  // Wood goes to the camp; gold does not.
  const miner = owned(s, 0, 'villager')[1];
  miner.carry = 5;
  miner.carryRes = 'gold';
  const goldBefore = p.res.gold;
  applyCommand(s, 0, { type: 'interact', ids: [miner.id], target: camp.id });
  run(s, 150);
  assert.equal(p.res.gold, goldBefore, 'a lumber camp takes no gold');
});

test('a farm runs out and lies fallow until a villager sows it again, or is gone', () => {
  const s = createGame(53);
  addPlayer(s, 0);
  const [sx, sy] = s.map.starts[0];
  const farm = spawn(s, 0, 'farm', sx - 1, sy + 3);
  farm.carry = 4;
  const p = s.players.get(0)!;
  const wood = p.res.wood;
  const farmer = owned(s, 0, 'villager')[0];
  applyCommand(s, 0, { type: 'interact', ids: [farmer.id], target: farm.id });
  run(s, 200);
  // Used up: fallow, no wood spent, the farmer has stopped and is not sent back by itself.
  assert.ok(farm.fallow !== undefined, 'the farm lies fallow');
  assert.equal(p.res.wood, wood);
  run(s, 100);
  assert.equal(farmer.order.t, 'idle');
  // A villager sows it again for wood and farms it.
  applyCommand(s, 0, { type: 'interact', ids: [farmer.id], target: farm.id });
  assert.equal(p.res.wood, wood - RESEED_COST);
  assert.equal(farm.fallow, undefined);
  assert.equal(farm.carry, FARM_FOOD);
  assert.equal((farmer.order as { t: string }).t, 'gather');
  // Left fallow too long, it is gone.
  farm.carry = 1;
  run(s, 100);
  assert.ok(farm.fallow !== undefined);
  applyCommand(s, 0, { type: 'stop', ids: [farmer.id] });
  run(s, FALLOW_SECONDS * 10 + 5);
  assert.ok(!s.entities.has(farm.id), 'the fallow farm is gone');
});

test('resigning kills the king and ends the game for that player', () => {
  const s = createGame(55);
  addPlayer(s, 0);
  addPlayer(s, 1);
  applyCommand(s, 1, { type: 'resign' });
  run(s, 2);
  assert.equal(s.players.get(1)!.defeated, true);
  assert.equal(s.winner, 0);
});

test('fields can be walked over, and villagers among many fields stay free to move', () => {
  const s = createGame(61);
  addPlayer(s, 0);
  const [sx, sy] = s.map.starts[0];
  // A 3 x 3 block of fields with no gaps, and a villager standing in the middle of it.
  const fx = sx - 3;
  const fy = sy + 3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    for (let y = fy + j * 2; y < fy + j * 2 + 2; y++) for (let x = fx + i * 2; x < fx + i * 2 + 2; x++) s.map.tiles[y * s.map.size + x] = Tile.Grass;
    spawn(s, 0, 'farm', fx + i * 2, fy + j * 2);
  }
  const v = owned(s, 0, 'villager')[0];
  v.x = fx + 3.5;
  v.y = fy + 3.5;
  assert.ok(isWalkable(s.map, fx + 3, fy + 3), 'a field does not block');
  applyCommand(s, 0, { type: 'move', ids: [v.id], x: fx + 9, y: fy + 3 });
  run(s, 80);
  assert.ok(Math.hypot(v.x - (fx + 9.5), v.y - (fy + 3.5)) < 1.5, `walked out to ${v.x},${v.y}`);
  // Two farmers on two neighbouring fields each stand on their own field.
  const [a, b] = owned(s, 0, 'villager');
  const farms = owned(s, 0, 'farm');
  applyCommand(s, 0, { type: 'interact', ids: [a.id], target: farms[4].id });
  applyCommand(s, 0, { type: 'interact', ids: [b.id], target: farms[5].id });
  run(s, 120);
  for (const [unit, farm] of [[a, farms[4]], [b, farms[5]]] as const) {
    assert.equal(unit.order.t, 'gather');
    assert.ok(unit.x >= farm.x && unit.x < farm.x + 2 && unit.y >= farm.y && unit.y < farm.y + 2, `farmer on field: ${unit.x},${unit.y}`);
  }
  // Nothing can be built on top of a field.
  assert.equal(canPlace(s.map, 'house', fx, fy), false);
});

test('a building surrounded by others is reached through the one gap left', () => {
  const s = createGame(63);
  addPlayer(s, 0);
  const [sx, sy] = s.map.starts[0];
  const bx = sx - 4;
  const by = sy + 5;
  for (let y = by - 3; y < by + 6; y++) for (let x = bx - 3; x < bx + 6; x++) s.map.tiles[y * s.map.size + x] = Tile.Grass;
  const target = spawn(s, 0, 'mill', bx, by, false);
  // Houses all round it, leaving a single one-tile gap on the far side.
  for (const [x, y] of [[bx - 2, by - 2], [bx, by - 2], [bx + 2, by - 2], [bx - 2, by], [bx + 2, by], [bx - 2, by + 2], [bx + 2, by + 2]]) spawn(s, 0, 'house', x, y);
  spawn(s, 0, 'wall', bx, by + 2);
  const v = owned(s, 0, 'villager')[0];
  v.x = bx + 0.5;
  v.y = by - 4.5;
  applyCommand(s, 0, { type: 'interact', ids: [v.id], target: target.id });
  run(s, 400);
  assert.ok(target.progress > 0.3, `builder got there: progress ${target.progress.toFixed(2)}`);
});

test('soldiers attacking one target surround it instead of stacking up', () => {
  const s = createGame(65);
  addPlayer(s, 0);
  addPlayer(s, 1);
  const tx = 40;
  const ty = 40;
  for (let y = 30; y < 50; y++) for (let x = 30; x < 50; x++) s.map.tiles[y * s.map.size + x] = Tile.Grass;
  // A villager stands still and does not hit back.
  const victim = spawn(s, 1, 'villager', tx, ty);
  victim.hp = 100000;
  const army = Array.from({ length: 6 }, (_, i) => spawn(s, 0, 'swordsman', 33, 36 + i));
  applyCommand(s, 0, { type: 'interact', ids: army.map((e) => e.id), target: victim.id });
  run(s, 120);
  const tiles = new Set(army.map((e) => `${Math.floor(e.x)},${Math.floor(e.y)}`));
  assert.equal(tiles.size, 6, `six attackers on ${tiles.size} tiles`);
  assert.ok(army.every((e) => e.order.t === 'attack' && Math.hypot(e.x - victim.x, e.y - victim.y) < 1.6), 'all in reach');
});

test('a group moves in formation at the pace of its slowest unit', () => {
  const s = createGame(67);
  addPlayer(s, 0);
  for (let y = 20; y < 60; y++) for (let x = 20; x < 60; x++) s.map.tiles[y * s.map.size + x] = Tile.Grass;
  const rider = spawn(s, 0, 'rider', 25, 30);
  const foot = Array.from({ length: 5 }, (_, i) => spawn(s, 0, 'spearman', 25, 31 + i));
  applyCommand(s, 0, { type: 'move', ids: [rider.id, ...foot.map((e) => e.id)], x: 45, y: 33 });
  run(s, 30);
  const furthest = Math.max(...foot.map((e) => e.x));
  assert.ok(rider.x <= furthest + 1.1, `rider ${rider.x.toFixed(1)} stays with the infantry (${furthest.toFixed(1)})`);
  run(s, 150);
  const spots = new Set([rider, ...foot].map((e) => `${Math.floor(e.x)},${Math.floor(e.y)}`));
  assert.equal(spots.size, 6, 'each on its own tile');
  // Spearmen, being melee, stand in front of the rider-free rear? All arrived near the target.
  assert.ok([rider, ...foot].every((e) => Math.hypot(e.x - 45, e.y - 33) < 4));
});

test('every training click counts, up to fifteen in a queue', () => {
  const s = createGame(69);
  addPlayer(s, 0);
  const p = s.players.get(0)!;
  p.res.food = 5000;
  const tc = owned(s, 0, 'towncenter')[0];
  for (let i = 0; i < 20; i++) applyCommand(s, 0, { type: 'train', building: tc.id, kind: 'villager' });
  assert.equal(tc.queue.length, 15);
  assert.equal(p.res.food, 5000 - 15 * 50);
});

test('blueprints can be walked over until work starts, then whoever stands there walks off', () => {
  const s = createGame(71);
  addPlayer(s, 0);
  const [sx, sy] = s.map.starts[0];
  const [builder, bystander] = owned(s, 0, 'villager');
  bystander.x = sx - 0.5;
  bystander.y = sy + 3.5;
  builder.x = sx + 8.5;
  builder.y = sy + 8.5;
  applyCommand(s, 0, { type: 'place', ids: [builder.id], kind: 'house', x: sx - 1, y: sy + 3 });
  const [house] = owned(s, 0, 'house');
  assert.ok(house);
  // Only a blueprint: walkable, but nothing else can be built there.
  assert.ok(isWalkable(s.map, sx - 1, sy + 3), 'a blueprint can be walked over');
  assert.ok(!canPlace(s.map, 'house', sx - 1, sy + 3), 'but not built over');
  const across = findPath(s.map, sx - 2, sy + 4, sx + 1, sy + 4);
  assert.ok(across.length <= 6, 'the way across leads straight over it');
  run(s, 400);
  assert.ok(house.progress > 0, 'work has started');
  assert.ok(!isWalkable(s.map, sx - 1, sy + 3), 'now a building site');
  assert.ok(isWalkable(s.map, Math.floor(bystander.x), Math.floor(bystander.y)), 'walked off the site');
});

test('a mixed crowd of nine melee fighters never shares a tile around its target', () => {
  const s = createGame(65);
  addPlayer(s, 0);
  addPlayer(s, 1);
  for (let y = 30; y < 50; y++) for (let x = 30; x < 50; x++) s.map.tiles[y * s.map.size + x] = Tile.Grass;
  const victim = spawn(s, 1, 'villager', 42, 40);
  victim.hp = 100000;
  const kinds = ['spearman', 'swordsman', 'rider'] as const;
  const army = Array.from({ length: 9 }, (_, i) => spawn(s, 0, kinds[i % 3], 33 + (i % 3), 36 + Math.floor(i / 3)));
  applyCommand(s, 0, { type: 'interact', ids: army.map((e) => e.id), target: victim.id });
  run(s, 200);
  assert.equal(new Set(army.map((e) => `${Math.floor(e.x)},${Math.floor(e.y)}`)).size, 9);
});

test('houses cannot be built past the population limit, and the limit caps housing', () => {
  const s = createGame(81, undefined, 20);
  addPlayer(s, 0);
  const p = s.players.get(0)!;
  p.res.wood = 5000;
  const [sx, sy] = s.map.starts[0];
  const v = owned(s, 0, 'villager')[0];
  // The town centre gives 5; three houses bring it to 20, and a fourth is refused.
  const spots = [[sx - 2, sy + 4], [sx, sy + 4], [sx + 2, sy + 4], [sx + 4, sy + 4]];
  for (const [x, y] of spots) {
    for (let yy = y; yy < y + 2; yy++) for (let xx = x; xx < x + 2; xx++) s.map.tiles[yy * s.map.size + xx] = Tile.Grass;
    applyCommand(s, 0, { type: 'place', ids: [v.id], kind: 'house', x, y, queue: true });
  }
  assert.equal(owned(s, 0, 'house').length, 3);
  run(s, 600);
  assert.equal(p.cap, 20);
});

test('one villager works through a list of building sites', () => {
  const s = createGame(83);
  addPlayer(s, 0);
  s.players.get(0)!.res.wood = 1000;
  const [sx, sy] = s.map.starts[0];
  const v = owned(s, 0, 'villager')[0];
  for (const [x, y] of [[sx - 2, sy + 4], [sx, sy + 4], [sx + 2, sy + 4]]) {
    for (let yy = y; yy < y + 2; yy++) for (let xx = x; xx < x + 2; xx++) s.map.tiles[yy * s.map.size + xx] = Tile.Grass;
    applyCommand(s, 0, { type: 'place', ids: [v.id], kind: 'house', x, y, queue: true });
  }
  assert.equal(v.tasks?.length, 2);
  run(s, 500);
  assert.deepEqual(owned(s, 0, 'house').map((h) => h.progress), [1, 1, 1]);
  // A new order without the queue flag wipes the list.
  const w = owned(s, 0, 'villager')[1];
  applyCommand(s, 0, { type: 'place', ids: [w.id], kind: 'house', x: sx - 2, y: sy + 7, queue: true });
  applyCommand(s, 0, { type: 'move', ids: [w.id], x: sx, y: sy });
  assert.equal(w.tasks, undefined);
});

test('villagers and the king shelter in the town centre, and come out again', () => {
  const s = createGame(85);
  addPlayer(s, 0);
  const tc = owned(s, 0, 'towncenter')[0];
  const [a, b] = owned(s, 0, 'villager');
  const king = owned(s, 0, 'king')[0];
  applyCommand(s, 0, { type: 'interact', ids: [a.id, b.id, king.id], target: tc.id });
  run(s, 100);
  assert.deepEqual([a.inside, b.inside, king.inside], [tc.id, tc.id, tc.id]);
  applyCommand(s, 0, { type: 'eject', building: tc.id });
  assert.deepEqual([a.inside, b.inside, king.inside], [-1, -1, -1]);
  // A villager carrying food delivers it instead of going in.
  a.carry = 5;
  a.carryRes = 'food';
  const food = s.players.get(0)!.res.food;
  applyCommand(s, 0, { type: 'interact', ids: [a.id], target: tc.id });
  run(s, 60);
  assert.equal(a.inside, -1);
  assert.equal(s.players.get(0)!.res.food, food + 5);
});

test('monks heal friends and convert enemies, but never kings', () => {
  const s = createGame(87);
  addPlayer(s, 0);
  addPlayer(s, 1);
  for (let y = 30; y < 50; y++) for (let x = 30; x < 50; x++) s.map.tiles[y * s.map.size + x] = Tile.Grass;
  const monk = spawn(s, 0, 'monk', 35, 35);
  const hurt = spawn(s, 0, 'spearman', 37, 35);
  hurt.hp = 10;
  // Two hit points a second: 35 to go takes under twenty seconds.
  run(s, 220);
  assert.equal(hurt.hp, DEFS.spearman.hp, 'healed on its own');
  const enemy = spawn(s, 1, 'swordsman', 40, 38);
  enemy.order = { t: 'move' };
  applyCommand(s, 0, { type: 'interact', ids: [monk.id], target: enemy.id });
  run(s, 100);
  assert.equal(enemy.owner, 0, 'converted');
  assert.ok(monk.cooldown > 0, 'the monk rests');
  const king = owned(s, 1, 'king')[0];
  applyCommand(s, 0, { type: 'interact', ids: [monk.id], target: king.id });
  assert.notEqual(monk.order.t, 'convert');
});

test('a villager copies the job of another', () => {
  const s = createGame(89);
  addPlayer(s, 0);
  const [a, b] = owned(s, 0, 'villager');
  const tree = findTile(s, Tile.Forest, s.map.starts[0]);
  applyCommand(s, 0, { type: 'gather', ids: [a.id], tile: tree });
  applyCommand(s, 0, { type: 'copy', ids: [b.id], from: a.id });
  assert.equal(b.order.t, 'gather');
  assert.equal(b.order.t === 'gather' && b.order.res, 'wood');
});

test('soldiers only pick fights with units; buildings wait for an order', () => {
  const s = createGame(11);
  addPlayer(s, 0);
  addPlayer(s, 1);
  const sword = spawn(s, 0, 'swordsman', 30, 30);
  const house = spawn(s, 1, 'house', 32, 29);
  run(s, 30);
  assert.equal(sword.order.t, 'idle');
  const foe = spawn(s, 1, 'villager', 33, 32);
  run(s, 10);
  assert.ok(attacking(sword, foe));
  applyCommand(s, 0, { type: 'interact', ids: [sword.id], target: house.id });
  assert.ok(attacking(sword, house));
});

test('defensive soldiers wait until struck, then fight back', () => {
  const s = createGame(11);
  addPlayer(s, 0);
  addPlayer(s, 1);
  const guard = spawn(s, 0, 'swordsman', 30, 30);
  applyCommand(s, 0, { type: 'stance', ids: [guard.id], stance: 'defensive' });
  assert.equal(guard.stance, 'defensive');
  const passer = spawn(s, 1, 'villager', 32, 30);
  run(s, 30);
  assert.equal(guard.order.t, 'idle');
  const raider = spawn(s, 1, 'archer', 34, 30);
  run(s, 40);
  assert.ok(attacking(guard, raider) || !s.entities.has(raider.id));
  assert.ok(s.entities.has(passer.id));
  applyCommand(s, 0, { type: 'stance', ids: [guard.id], stance: 'aggressive' });
  assert.equal(guard.stance, undefined);
});

test('a building deleted between ticks is reported in the next snapshot, once', () => {
  const host = new GameHost('TEST');
  host.join('Me');
  host.start(5);
  const s = host.state!;
  host.tick();
  const tc = owned(s, 0, 'towncenter')[0];
  const house = spawn(s, 0, 'house', tc.x + 5, tc.y + 5);
  host.tick();
  host.command(0, { type: 'delete', id: house.id });
  const snap = host.tick();
  assert.ok(snap && snap.t === 'snap');
  assert.equal(snap.deaths.filter((d) => d[0] === 8).length, 1);
  const after = host.tick();
  assert.ok(after && after.t === 'snap' && after.deaths.length === 0);
});

test('the town bell calls villagers in, and rung again sends them back to their work', () => {
  const s = createGame(85);
  addPlayer(s, 0);
  const villagers = owned(s, 0, 'villager');
  const [a] = villagers;
  const tree = findTile(s, Tile.Forest, s.map.starts[0]);
  applyCommand(s, 0, { type: 'gather', ids: [a.id], tile: tree });
  run(s, 5);
  applyCommand(s, 0, { type: 'bell' });
  run(s, 200);
  assert.ok(villagers.every((v) => v.inside >= 0), 'everyone inside');
  applyCommand(s, 0, { type: 'bell' });
  assert.ok(villagers.every((v) => v.inside < 0 && v.recall === undefined), 'everyone out');
  assert.ok(a.order.t === 'gather' && a.order.tile === tree, 'back to the tree');
});

test('a monk carries a relic to the monastery, which gives the army extra attack', () => {
  const host = new GameHost('TEST');
  host.join('Me');
  host.start(9);
  const s = host.state!;
  assert.equal(s.relics.length, 1, 'one relic on the map');
  for (const r of s.relics) for (const [sx, sy] of s.map.starts) assert.ok(Math.hypot(r.x - sx, r.y - sy) > s.map.size * 0.2, 'away from towns');
  const relic = s.relics[0];
  const tc = owned(s, 0, 'towncenter')[0];
  const monastery = spawn(s, 0, 'monastery', tc.x + 5, tc.y + 5);
  const monk = spawn(s, 0, 'monk', relic.x + 1, relic.y);
  // Brought within a few steps of home, so that the walk is short.
  const swordsman = spawn(s, 0, 'swordsman', tc.x - 3, tc.y);
  const target = spawn(s, 1, 'villager', tc.x - 3, tc.y + 1);
  host.command(0, { type: 'fetch', ids: [monk.id], relic: 0 });
  for (let i = 0; i < 20 && relic.carrier < 0; i++) host.tick();
  assert.equal(relic.carrier, monk.id);
  [monk.x, monk.y] = [monastery.x - 0.5, monastery.y + 1.5];
  monk.path = [];
  for (let i = 0; i < 40 && relic.monastery < 0; i++) host.tick();
  assert.equal(relic.monastery, monastery.id);
  // A blow now does two more damage than before.
  const before = target.hp;
  swordsman.order = { t: 'attack', id: target.id, auto: false };
  swordsman.cooldown = 0;
  for (let i = 0; i < 5 && target.hp === before; i++) host.tick();
  assert.equal(before - target.hp, attackOf('swordsman', () => false) - armorOf('villager', () => false) + 2);
});

test('towns are spread at random but never close together', () => {
  const spots = new Set<string>();
  let notCorners = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const m = generateMap(seed, 96);
    for (const [x, y] of m.starts) {
      assert.ok(x >= 12 && y >= 12 && x <= 96 - 13 && y <= 96 - 13, `inside the map: ${x},${y}`);
    }
    for (let i = 0; i < m.starts.length; i++) {
      for (let j = i + 1; j < m.starts.length; j++) {
        const d = Math.hypot(m.starts[i][0] - m.starts[j][0], m.starts[i][1] - m.starts[j][1]);
        assert.ok(d >= 30, `towns ${i} and ${j} only ${d.toFixed(1)} apart`);
      }
    }
    const [a, b] = m.starts;
    if (!(Math.abs(a[0] - b[0]) > 40 && Math.abs(a[1] - b[1]) > 40)) notCorners++;
    spots.add(m.starts[0].join(','));
  }
  assert.ok(notCorners >= 3, 'the first two towns are not always across from each other');
  assert.ok(spots.size >= 8, `only ${spots.size} different first towns`);
});

test('the relic notes who has seen it', () => {
  const host = new GameHost('TEST');
  host.join('Me');
  host.join('Them');
  host.start(9);
  const s = host.state!;
  const relic = s.relics[0];
  for (let i = 0; i < 6; i++) host.tick();
  assert.equal(relic.foundBy, 0, 'nobody starts next to it');
  spawn(s, 1, 'scout', relic.x + 3, relic.y);
  for (let i = 0; i < 6; i++) host.tick();
  assert.equal(relic.foundBy, 1 << 1, 'only the scout\'s player has seen it');
});

test('a pause needs everyone to agree, and everyone to continue', () => {
  const host = new GameHost('TEST');
  host.join('Me');
  host.join('Them');
  host.join('Computer', 'ai');
  host.start(5);
  const s = host.state!;
  host.tick();
  assert.equal(host.answerPause(1, 'request')?.t, 'pause');
  assert.deepEqual((host.answerPause(0, 'no') as { declinedBy: number }).declinedBy, 0, 'declined');
  assert.equal(host.pause, undefined);
  host.answerPause(1, 'request');
  const asked = host.answerPause(1, 'yes') as { phase: string; waiting: number[] };
  assert.deepEqual([asked.phase, asked.waiting], ['asking', [0]], 'the computer does not get a say');
  assert.equal(host.tick()?.t, 'snap', 'the game runs while asking');
  assert.equal((host.answerPause(0, 'yes') as { phase: string }).phase, 'paused');
  const tick = s.tick;
  assert.equal(host.tick(), undefined);
  assert.equal(s.tick, tick, 'nothing moves while paused');
  assert.equal((host.answerPause(0, 'yes') as { phase: string; waiting: number[] }).waiting.join(), '1');
  assert.equal((host.answerPause(1, 'yes') as { phase: string }).phase, 'off');
  assert.equal(host.tick()?.t, 'snap', 'running again');
  // Someone leaving while the others wait does not leave the game stuck.
  host.answerPause(0, 'request');
  host.answerPause(1, 'yes');
  assert.equal((host.pause as { phase: string } | undefined)?.phase, 'paused');
  host.answerPause(0, 'yes');
  host.leave(1);
  assert.equal(host.pause, undefined);
});

test('a crowd stopped by a wall never walks through it, and does not slow the game down', () => {
  const s = createGame(3, 96);
  addPlayer(s, 0, 0);
  addPlayer(s, 1, 1);
  for (const e of [...s.entities.values()]) s.entities.delete(e.id);
  s.map.blocked.fill(0);
  s.map.footprint.fill(0);
  s.map.tiles.fill(Tile.Grass);
  spawn(s, 0, 'king', 2, 2);
  spawn(s, 1, 'king', 93, 93);
  for (let y = 0; y < 96; y++) spawn(s, 1, 'wall', 50, y);
  const enemies = [0, 1, 2, 3].map((i) => spawn(s, 1, 'swordsman', 53 + i, 40));
  const ids: number[] = [];
  for (let i = 0; i < 40; i++) ids.push(spawn(s, 0, i % 3 ? 'swordsman' : 'archer', 38 + (i % 8), 36 + Math.floor(i / 8)).id);
  applyCommand(s, 0, { type: 'amove', ids, x: 60, y: 40 });
  const half = ids.slice(0, 20);
  applyCommand(s, 0, { type: 'interact', ids: half, target: enemies[0].id });
  const started = performance.now();
  for (let t = 0; t < 400; t++) {
    step(s);
    for (const id of ids) assert.ok((s.entities.get(id)?.x ?? 0) < 50, `unit ${id} is through the wall at tick ${t}`);
  }
  assert.ok(performance.now() - started < 1500, `400 ticks took ${(performance.now() - started).toFixed(0)} ms`);
  // They went up to the wall and stopped there.
  assert.ok(ids.every((id) => s.entities.get(id)!.path.length === 0), 'everyone has stopped');
  assert.ok(ids.filter((id) => s.entities.get(id)!.x > 44).length >= 10, 'they came up to the wall');
});

test('monks sent with an attack on a building follow it and heal the wounded', () => {
  const s = createGame(3, 96);
  addPlayer(s, 0, 0);
  addPlayer(s, 1, 1);
  for (const e of [...s.entities.values()]) s.entities.delete(e.id);
  s.map.blocked.fill(0);
  s.map.footprint.fill(0);
  s.map.tiles.fill(Tile.Grass);
  spawn(s, 0, 'king', 2, 2);
  spawn(s, 1, 'king', 93, 93);
  const house = spawn(s, 1, 'house', 60, 40);
  const army = [0, 1, 2].map((i) => spawn(s, 0, 'swordsman', 30 + i, 40));
  const monk = spawn(s, 0, 'monk', 28, 41);
  applyCommand(s, 0, { type: 'interact', ids: [...army, monk].map((e) => e.id), target: house.id });
  assert.equal(monk.order.t, 'escort');
  run(s, 200);
  assert.ok(Math.hypot(monk.x - 61, monk.y - 41) < 8, `the monk came along: ${monk.x.toFixed(1)},${monk.y.toFixed(1)}`);
  army[0].hp -= 30;
  const hurt = army[0].hp;
  run(s, 60);
  assert.ok(army[0].hp > hurt, 'and heals the wounded');
  run(s, 300);
  assert.ok(['escort', 'heal'].includes((monk.order as { t: string }).t) || !s.entities.has(house.id), `still with the attack: ${monk.order.t}`);
});

const openField = () => {
  const s = createGame(3, 96);
  addPlayer(s, 0, 0);
  addPlayer(s, 1, 1);
  for (const e of [...s.entities.values()]) s.entities.delete(e.id);
  s.map.blocked.fill(0);
  s.map.footprint.fill(0);
  s.map.tiles.fill(Tile.Grass);
  spawn(s, 0, 'king', 2, 2);
  spawn(s, 1, 'king', 93, 93);
  return s;
};

test('walls shrug off soldiers but fall to rams', () => {
  const ticksToBreak = (kind: 'swordsman' | 'ram', n: number) => {
    const s = openField();
    const wall = spawn(s, 1, 'wall', 50, 40);
    const ids = Array.from({ length: n }, (_, i) => spawn(s, 0, kind, 45 + (i % 4), 38 + Math.floor(i / 4)).id);
    applyCommand(s, 0, { type: 'interact', ids, target: wall.id });
    let t = 0;
    for (; t < 3000 && s.entities.has(wall.id); t++) step(s);
    return t;
  };
  const swords = ticksToBreak('swordsman', 10);
  const ram = ticksToBreak('ram', 1);
  assert.ok(swords > 400, `ten swordsmen took only ${swords / 10} s`);
  assert.ok(ram < swords * 0.7, `one ram (${ram / 10} s) should beat ten swordsmen (${swords / 10} s)`);
});

test('a catapult tower crushes a group, cannot aim at its foot, and falls to rams', () => {
  const s = openField();
  const tower = spawn(s, 1, 'catapulttower', 50, 40);
  // A tight group well in range: one boulder hurts several of them.
  const group = [0, 1, 2, 3].map((i) => spawn(s, 0, 'archer', 44 + (i % 2), 40 + Math.floor(i / 2)));
  for (const a of group) a.stance = 'defensive';
  let t = 0;
  for (; t < 100 && group.every((a) => a.hp >= 30); t++) step(s);
  step(s);
  assert.ok(group.filter((a) => !s.entities.has(a.id) || a.hp < 30).length >= 3, 'one shot hurt most of the group');
  // Someone right beside its wall is too close to be aimed at.
  const s2 = openField();
  const t2 = spawn(s2, 1, 'catapulttower', 50, 40);
  const close = spawn(s2, 0, 'swordsman', 52, 40);
  close.stance = 'defensive';
  run(s2, 100);
  assert.equal(close.hp, DEFS.swordsman.hp, 'safe at its foot');
  assert.ok(t2.hp > 0);
  // Two rams knock it down unharmed.
  const s3 = openField();
  const t3 = spawn(s3, 1, 'catapulttower', 50, 40);
  const rams = [0, 1].map((i) => spawn(s3, 0, 'ram', 46, 40 + i));
  applyCommand(s3, 0, { type: 'interact', ids: rams.map((r) => r.id), target: t3.id });
  run(s3, 600);
  assert.ok(!s3.entities.has(t3.id), 'the rams brought it down');
  assert.ok(rams.every((r) => s3.entities.has(r.id)), 'and both rams survive');
});

test('a villager whose work stopped by itself goes back to it after a few seconds', () => {
  const s = openField();
  s.map.tiles[40 * s.map.size + 50] = Tile.Gold;
  s.map.amount[40 * s.map.size + 50] = 500;
  spawn(s, 0, 'towncenter', 40, 39);
  const v = spawn(s, 0, 'villager', 46, 40);
  applyCommand(s, 0, { type: 'gather', ids: [v.id], tile: 40 * s.map.size + 50 });
  // Walls go up all round the gold before the villager gets there: nowhere to stand, so they stop.
  const walls = [];
  for (let y = 38; y <= 42; y++) for (let x = 48; x <= 52; x++) if (Math.max(Math.abs(x - 50), Math.abs(y - 40)) === 2) walls.push(spawn(s, 1, 'wall', x, y));
  run(s, 30);
  assert.equal(v.order.t, 'idle', 'stuck for now');
  // The way opens again: without being told, the villager goes back to the gold.
  for (const w of walls) applyCommand(s, 1, { type: 'delete', id: w.id });
  assert.ok(walls.every((w) => !s.entities.has(w.id)));
  run(s, 60);
  assert.equal((v.order as { t: string }).t, 'gather', 'back at work');
  const before = s.players.get(0)!.res.gold;
  run(s, 600);
  assert.ok(s.players.get(0)!.res.gold > before, 'and bringing gold in');
  // Someone the player has told to stop stays stopped.
  applyCommand(s, 0, { type: 'stop', ids: [v.id] });
  run(s, 100);
  assert.equal((v.order as { t: string }).t, 'idle');
});

test('formations give every member its own spot; a box keeps the archers inside', () => {
  for (const f of FORMATIONS) {
    for (const n of [1, 2, 5, 12, 30]) {
      const ranks = Array.from({ length: n }, (_, i) => (i < n / 2 ? 0 : 1));
      const slots = formationSlots(f, ranks);
      assert.equal(slots.length, n);
      assert.equal(new Set(slots.map(([r, c]) => `${Math.floor(r + 0.5)},${Math.floor(c + 0.5)}`)).size, n, `${f} ${n}`);
    }
  }
  const ranks = [...Array(12).fill(0), ...Array(4).fill(1)];
  const box = formationSlots('box', ranks);
  const ring = ([r, c]: [number, number]) => Math.max(Math.abs(r), Math.abs(c));
  const outside = Math.min(...box.slice(0, 12).map(ring));
  assert.ok(Math.max(...box.slice(12).map(ring)) < outside, 'archers in the middle');
  // A flank leaves a gap in the middle; staggered spreads out.
  assert.ok(formationSlots('flank', Array(8).fill(0)).every(([, c]) => Math.abs(c) >= 2));
  const st = formationSlots('staggered', Array(9).fill(0));
  for (let i = 0; i < st.length; i++) for (let j = i + 1; j < st.length; j++) assert.ok(Math.hypot(st[i][0] - st[j][0], st[i][1] - st[j][1]) >= 1.9);
});

test('a group set to a box walks there as a box', () => {
  const s = createGame(5);
  addPlayer(s, 0);
  const tc = owned(s, 0, 'towncenter')[0];
  // Open ground, so that nothing bends the shapes.
  for (let y = tc.y + 3; y < tc.y + 26; y++) for (let x = tc.x - 6; x < tc.x + 16; x++) {
    const i = y * s.map.size + x;
    if (!s.map.blocked[i] && s.map.tiles[i] !== Tile.Grass) { s.map.tiles[i] = Tile.Grass; s.map.amount[i] = 0; }
  }
  s.map.version++;
  const ids: number[] = [];
  for (let i = 0; i < 8; i++) ids.push(spawn(s, 0, 'swordsman', tc.x + 4 + (i % 4), tc.y + 4 + Math.floor(i / 4))!.id);
  for (let i = 0; i < 4; i++) ids.push(spawn(s, 0, 'archer', tc.x + 4 + i, tc.y + 6)!.id);
  applyCommand(s, 0, { type: 'formation', ids, formation: 'box' });
  assert.ok(ids.every((id) => s.entities.get(id)!.formation === 'box'));
  applyCommand(s, 0, { type: 'move', ids, x: tc.x + 4, y: tc.y + 16 });
  run(s, 300);
  const units = ids.map((id) => s.entities.get(id)!);
  const cx = units.reduce((a, e) => a + e.x, 0) / units.length;
  const cy = units.reduce((a, e) => a + e.y, 0) / units.length;
  const d = (e: Entity) => Math.hypot(e.x - cx, e.y - cy);
  const archers = units.filter((e) => e.kind === 'archer');
  const swords = units.filter((e) => e.kind === 'swordsman');
  assert.ok(Math.max(...archers.map(d)) <= Math.max(...swords.map(d)), 'archers are not on the outside');
  // Pressing a formation button lines a standing group up straight away.
  const closest = () => Math.min(...units.flatMap((a, i) => units.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
  applyCommand(s, 0, { type: 'formation', ids, formation: 'staggered' });
  assert.ok(units.some((e) => e.order.t === 'move'), 'the group moves into the new shape');
  run(s, 200);
  assert.ok(closest() >= 1.4, `spread out: ${closest().toFixed(2)}`);
});
