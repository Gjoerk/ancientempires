import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createGame, findPath, generateMap, isWalkable, spawnPlayer, step } from './index';

test('map generation is deterministic and start areas are open', () => {
  const a = generateMap(42);
  const b = generateMap(42);
  assert.deepEqual(a.tiles, b.tiles);
  for (const [x, y] of a.starts) assert.ok(isWalkable(a, x, y));
});

test('paths only cross walkable tiles and end at the goal', () => {
  const map = generateMap(7);
  const [sx, sy] = map.starts[0];
  const [gx, gy] = map.starts[1];
  const path = findPath(map, sx, sy, gx, gy);
  assert.ok(path.length > 0);
  for (let i = 0; i < path.length; i += 2) assert.ok(isWalkable(map, path[i], path[i + 1]));
  assert.deepEqual(path.slice(-2), [gx, gy]);
});

test('a move command walks units to distinct tiles and ignores foreign units', () => {
  const state = createGame(3);
  spawnPlayer(state, 0);
  spawnPlayer(state, 1);
  const mine = [...state.entities.values()].filter((e) => e.owner === 0);
  const theirs = [...state.entities.values()].filter((e) => e.owner === 1);
  const before = theirs.map((e) => [e.x, e.y]);
  const [sx, sy] = state.map.starts[0];
  applyCommand(state, 0, { type: 'move', ids: [...mine, ...theirs].map((e) => e.id), x: sx + 4, y: sy + 3 });
  for (let i = 0; i < 200; i++) step(state);
  const spots = new Set(mine.map((e) => `${e.x},${e.y}`));
  assert.equal(spots.size, mine.length);
  for (const e of mine) assert.ok(Math.hypot(e.x - (sx + 4.5), e.y - (sy + 3.5)) < 3);
  assert.deepEqual(theirs.map((e) => [e.x, e.y]), before);
});
