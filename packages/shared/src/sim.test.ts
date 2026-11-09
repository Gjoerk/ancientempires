import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addPlayer, applyCommand, createGame, DEFS, Entity, findPath, GameState, generateMap, isWalkable, spawn, step, Tile,
  TILE_RESOURCE,
} from './index';

const owned = (s: GameState, slot: number, kind: string): Entity[] =>
  [...s.entities.values()].filter((e) => e.owner === slot && e.kind === kind);
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
  // Housing is 5 and four villagers were there from the start.
  assert.equal(owned(s, 0, 'villager').length, 5);
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
  assert.equal([...s.entities.values()].filter((e) => e.owner === 1).length, 0);
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
  applyCommand(s, 0, { type: 'train', building: smith.id, kind: 'steel' });
  assert.equal(smith.queue.length, 0, 'needs forging and the third age');
  applyCommand(s, 0, { type: 'train', building: smith.id, kind: 'forging' });
  applyCommand(s, 0, { type: 'train', building: tc.id, kind: 'loom' });
  run(s, 260);
  assert.ok(p.techs.has('forging') && p.techs.has('loom'));
  assert.equal(owned(s, 0, 'villager')[0].hp, 40);
  // Forging makes a swordsman hit a house for 8 + 2 (forging) + 2 (vs buildings) - 3 (armour) = 9.
  addPlayer(s, 1);
  const house = spawn(s, 1, 'house', 30, 30);
  const sword = spawn(s, 0, 'swordsman', 29, 30);
  applyCommand(s, 0, { type: 'interact', ids: [sword.id], target: house.id });
  run(s, 2);
  assert.equal(house.hp, DEFS.house.hp - 9);
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
