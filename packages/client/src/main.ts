import {
  AGE_NAMES,
  armorOf,
  attackOf,
  BUILDABLE,
  canPlace,
  ClientMessage,
  Command,
  Cost,
  DEFAULT_SIGHT,
  DEFS,
  GameMap,
  GameSettings,
  generateMap,
  markBuilding,
  spawn,
  isTech,
  Kind,
  KINDS,
  maxHpOf,
  PlayerInfo,
  QUEUE_ITEMS,
  Res,
  RESOURCES,
  ServerMessage,
  TECH_IDS,
  TechId,
  TECHS,
  Tile,
  TICK_MS,
  TILE_RESOURCE,
  TRADE_BUY,
  TRADE_GOODS,
  rangeOf,
  TRADE_SELL,
} from '@kingsfall/shared';
import { hostGame, joinGame, normaliseCode, Session } from './net';
import { loadSprites } from './assets';
import { drawBuilding } from './buildings';
import { clearIcons, icon } from './icons';
import { Detail, describeAction, describeKind, describeTech } from './describe';
import { isMuted, play, toggleMute, unlockSound } from './sound';
import { drawProp, drawUnit, HH, HW, PLAYER_COLORS } from './sprites';

interface View {
  id: number;
  owner: number;
  kind: Kind;
  hp: number;
  /** 0 idle, 1 moving, 2 working, 3 fighting. */
  act: number;
  /** Units: carried amount + 100 * resource index. Buildings: construction progress 0-100. */
  extra: number;
  /** What a unit is working on (see taskOf in the rules); 1 for a castle with a king inside. */
  task: number;
  target: number;
  /** Visual offset in tiles that moves a working unit up to its work. */
  ox: number;
  oy: number;
  /** When this unit last struck a blow, and when it was last hit (for animations). */
  struck: number;
  hurt: number;
  /** 1 facing right on screen, -1 facing left. */
  face: number;
  // Position at the previous snapshot and at the latest one, for interpolation.
  px: number;
  py: number;
  x: number;
  y: number;
}

interface PlayerView {
  res: Record<string, number>;
  pop: number;
  cap: number;
  defeated: boolean;
  age: number;
  /** Bit masks over TECH_IDS. */
  techs: number;
  researching: number;
  /** Villagers gathering each resource. */
  workers: Record<string, number>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('game');
const ctx = canvas.getContext('2d')!;
const minimap = $<HTMLCanvasElement>('minimap');
const mctx = minimap.getContext('2d')!;

let session: Session | undefined;
let me = -1;
let map: GameMap | undefined;
/** Ground colour of every tile, as an index into GROUND_COLORS. */
let ground = new Uint8Array(0);
let miniTerrain: HTMLCanvasElement | undefined;
/** Resource tiles that have something standing on them: tile index -> tile type. */
const props = new Map<number, number>();
const views = new Map<number, View>();
const players = new Map<number, PlayerView>();
let roster: PlayerInfo[] = [];
const queues = new Map<number, number[]>();
const selected = new Set<number>();
let shots: { from: [number, number]; to: [number, number]; t: number }[] = [];
let winner = -1;
let gameTick = 0;
let snapTime = 0;
let centred = false;
const cam = { x: 0, y: 0 };
const keys = new Set<string>();
const mouse = { x: 0, y: 0, inside: false, onMap: false, onButton: false };
let drag: { x: number; y: number } | undefined;
let marker: { x: number; y: number; t: number } | undefined;
/** Resource tile that was just targeted, outlined for a moment. */
let tileFlash: { tile: number; t: number } | undefined;
/** Building kind the player is about to place, if any. */
let placing: Kind | undefined;
/** Resource tile the player clicked to see how much is left, or -1. */
let selectedTile = -1;
/** How much the map is magnified. The canvas has fewer pixels than the window and is stretched. */
let zoom = window.innerWidth >= 1200 ? 1.5 : window.innerWidth >= 820 ? 1.25 : 1;
/** On touch screens: the next drag draws a selection box instead of scrolling. */
let boxMode = false;
/** First tile of a wall being dragged out. */
let wallStart: [number, number] | undefined;
const rallies = new Map<number, [number, number]>();
/** Dust clouds where something died. */
let puffs: { x: number; y: number; t: number; big: boolean }[] = [];
/** Enemy that was just ordered to be attacked, marked for a moment. */
let attackFlash: { id: number; t: number } | undefined;
/** Where the player was last attacked off screen. */
let alert: { x: number; y: number; t: number } | undefined;
const groups = new Map<string, number[]>();

// Fog of war, from the point of view of the player being controlled.
let visible: Uint8Array = new Uint8Array(0);
let explored: Uint8Array = new Uint8Array(0);
const exploredBy = new Map<number, Uint8Array>();
/** Enemy buildings as they were last seen, per controlled player. */
const rememberedBy = new Map<number, Map<number, View>>();
let remembered = new Map<number, View>();
let revealAll = false;
let fogTime = 0;
let fogMini: HTMLCanvasElement | undefined;
/** Players whose sight is shown: the controlled one, plus all sides a host plays in a test game. */
let sharedSight = new Set<number>();

const teamOf = (slot: number) => roster.find((p) => p.slot === slot)?.team ?? -1 - slot;
const isEnemy = (owner: number) => teamOf(owner) !== teamOf(me);
const hasOf = (owner: number) => (tech: TechId) => ((players.get(owner)?.techs ?? 0) >> TECH_IDS.indexOf(tech) & 1) === 1;
const maxHp = (v: View) => maxHpOf(v.kind, hasOf(v.owner));

const isBuilding = (kind: Kind) => DEFS[kind].building === true;
const sizeOf = (kind: Kind) => DEFS[kind].size ?? 1;

// --- coordinates -----------------------------------------------------------

function tileToWorld(tx: number, ty: number): [number, number] {
  return [(tx - ty) * HW, (tx + ty) * HH];
}

function worldToScreen(wx: number, wy: number): [number, number] {
  return [wx - cam.x + canvas.width / 2, wy - cam.y + canvas.height / 2];
}

function tileToScreen(tx: number, ty: number): [number, number] {
  return worldToScreen(...tileToWorld(tx, ty));
}

function screenToTile(sx: number, sy: number): [number, number] {
  const wx = sx + cam.x - canvas.width / 2;
  const wy = sy + cam.y - canvas.height / 2;
  return [(wx / HW + wy / HH) / 2, (wy / HH - wx / HW) / 2];
}

function viewPos(v: View, alpha: number): [number, number] {
  return [v.px + (v.x - v.px) * alpha, v.py + (v.y - v.py) * alpha];
}

/** Where a unit is drawn right now, on screen. */
function unitScreen(v: View): [number, number] {
  return tileToScreen(v.x + v.ox, v.y + v.oy);
}

/** The point in tile units a working unit is busy at, if any. */
function workSpot(v: View, now: number): [number, number] | undefined {
  // Only real work (tasks 1-6) pulls a unit towards a spot; an attacker walks there itself.
  if (!map || v.task === 0 || v.task > 6 || isBuilding(v.kind)) return undefined;
  if (v.task <= 4) return [(v.target % map.size) + 0.5, Math.floor(v.target / map.size) + 0.5];
  const b = views.get(v.target);
  if (!b) return undefined;
  const s = sizeOf(b.kind);
  if (v.task === 5) {
    // Farmers stand on their field and move slowly up and down their furrow.
    const fx = Math.max(b.x + 0.3, Math.min(b.x + s - 0.3, v.x + Math.cos(now / 4000 + v.id) * 0.35));
    const fy = Math.max(b.y + 0.3, Math.min(b.y + s - 0.3, v.y + Math.sin(now / 3100 + v.id * 2) * 0.2));
    return [fx, fy];
  }
  return [Math.max(b.x, Math.min(b.x + s, v.x)), Math.max(b.y, Math.min(b.y + s, v.y))];
}

/** Eases working units towards their work so they do not stand a tile away from it. */
function updateWorkOffsets(now: number, dt: number): void {
  const k = 1 - Math.exp(-dt * 7);
  for (const v of views.values()) {
    let gx = 0;
    let gy = 0;
    const spot = workSpot(v, now);
    if (spot) {
      const dx = spot[0] - v.x;
      const dy = spot[1] - v.y;
      const d = Math.hypot(dx, dy);
      const keep = v.task === 5 ? 0 : v.task === 6 ? 0.1 : 0.58;
      if (d > keep) {
        gx = (dx * (d - keep)) / d;
        gy = (dy * (d - keep)) / d;
      }
    }
    v.ox += (gx - v.ox) * k;
    v.oy += (gy - v.oy) * k;
  }
}

/** Centre of an entity in tile units. */
function centreOf(v: View): [number, number] {
  const half = isBuilding(v.kind) ? sizeOf(v.kind) / 2 : 0;
  return [v.x + half, v.y + half];
}

// --- fog of war ------------------------------------------------------------

function tileSeen(tx: number, ty: number): boolean {
  return !!map && tx >= 0 && ty >= 0 && tx < map.size && ty < map.size && visible[ty * map.size + tx] === 1;
}

/** Whether the controlled player can currently see this unit or building. */
function canSee(v: View): boolean {
  if (revealAll || sharedSight.has(v.owner)) return true;
  if (!isBuilding(v.kind)) return tileSeen(Math.floor(v.x), Math.floor(v.y));
  const s = sizeOf(v.kind);
  for (let y = v.y; y < v.y + s; y++) for (let x = v.x; x < v.x + s; x++) if (tileSeen(x, y)) return true;
  return false;
}

function updateFog(now: number): void {
  if (!map || now - fogTime < 200 || !players.has(me)) return;
  fogTime = now;
  const n = map.size;
  if (visible.length !== n * n) visible = new Uint8Array(n * n);
  explored = exploredBy.get(me) ?? new Uint8Array(n * n);
  exploredBy.set(me, explored);
  remembered = rememberedBy.get(me) ?? new Map();
  rememberedBy.set(me, remembered);
  const p = players.get(me)!;
  // Once the game is decided, or for someone who is out, the whole map is shown.
  // An ally who is still in the game keeps the fog on for a fallen player.
  const teamAlive = roster.some((q) => q.team === teamOf(me) && players.get(q.slot)?.defeated === false);
  revealAll = winner >= 0 || (p.defeated && !teamAlive);
  // Allies share what they see.
  sharedSight = new Set([me, ...controllable(), ...roster.filter((q) => q.team === teamOf(me)).map((q) => q.slot)]);
  if (revealAll) {
    visible.fill(1);
    explored.fill(1);
  } else {
    visible.fill(0);
    for (const v of views.values()) {
      if (!sharedSight.has(v.owner)) continue;
      const [cx, cy] = centreOf(v);
      const r = isBuilding(v.kind) && v.extra < 100 ? 2 : (DEFS[v.kind].sight ?? DEFAULT_SIGHT) + (isBuilding(v.kind) ? sizeOf(v.kind) / 2 : 0);
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(n - 1, Math.floor(cy + r)); y++) {
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(n - 1, Math.floor(cx + r)); x++) {
          if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) visible[y * n + x] = explored[y * n + x] = 1;
        }
      }
    }
  }
  // Enemy buildings stay on the map as last seen until the spot is seen again.
  for (const v of views.values()) if (!sharedSight.has(v.owner) && isBuilding(v.kind) && canSee(v)) remembered.set(v.id, { ...v });
  for (const [id, ghost] of remembered) if (!views.has(id) && canSee(ghost)) remembered.delete(id);

  fogMini ??= document.createElement('canvas');
  fogMini.width = fogMini.height = n;
  const g = fogMini.getContext('2d')!;
  const img = g.createImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    img.data[i * 4] = 8;
    img.data[i * 4 + 1] = 12;
    img.data[i * 4 + 2] = 8;
    img.data[i * 4 + 3] = visible[i] ? 0 : explored[i] ? 115 : 255;
  }
  g.putImageData(img, 0, 0);
  // Ground blocks with newly explored tiles in them are drawn again.
  const blocks = Math.ceil(n / CHUNK);
  if (chunkSeen.length !== blocks * blocks) chunkSeen = new Int32Array(blocks * blocks).fill(-1);
  const count = new Int32Array(blocks * blocks);
  for (let i = 0; i < n * n; i++) if (explored[i] || revealAll) count[Math.floor(Math.floor(i / n) / CHUNK) * blocks + Math.floor((i % n) / CHUNK)]++;
  for (let c = 0; c < count.length; c++) {
    if (count[c] !== chunkSeen[c]) {
      chunkSeen[c] = count[c];
      chunks.delete(c);
    }
  }
}

/**
 * Darkens what is not in sight and blacks out what was never seen. The fog is a picture with one pixel per
 * tile, stretched over the map in one go; smoothing gives it soft edges.
 */
function drawFog(): void {
  if (!map || revealAll || !fogMini) return;
  ctx.save();
  ctx.setTransform(HW, HH, -HW, HH, canvas.width / 2 - cam.x, canvas.height / 2 - cam.y);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(fogMini, 0, 0);
  ctx.restore();
}

// --- terrain ---------------------------------------------------------------

function hash(x: number, y: number): number {
  // Deterministic pseudo-random number in [0, 1) for a pair of integers.
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const MINI_COLORS: Record<number, string> = {
  [Tile.Grass]: '#4f8a3a', [Tile.Water]: '#1c3f66', [Tile.Forest]: '#2a5a26',
  [Tile.Berries]: '#b8506a', [Tile.Gold]: '#f2cf3a', [Tile.Stone]: '#9aa0a8',
};

const GROUND_COLORS = ['#4f8a3a', '#55913d', '#4a8436', '#5a9642', '#2f6fa8', '#2b68a0', '#3476b0', '#3d6e2e', '#396a2b'];

/** Works out how a tile looks on the ground and on the minimap, and what stands on it. */
function paintTile(m: GameMap, index: number): void {
  const n = m.size;
  const x = index % n;
  const y = Math.floor(index / n);
  const tile = m.tiles[index];
  const r = hash(x, y);
  ground[index] = tile === Tile.Water ? 4 + Math.floor(r * 3) : tile === Tile.Forest ? 7 + Math.floor(r * 2) : Math.floor(r * 4);
  const mt = miniTerrain!.getContext('2d')!;
  mt.fillStyle = MINI_COLORS[tile];
  mt.fillRect(x, y, 1, 1);
  if (TILE_RESOURCE[tile as Tile]) props.set(index, tile);
  else props.delete(index);
}

function buildTerrain(m: GameMap): void {
  chunks.clear();
  chunkSeen = new Int32Array(0);
  ground = new Uint8Array(m.size * m.size);
  miniTerrain = document.createElement('canvas');
  miniTerrain.width = miniTerrain.height = m.size;
  props.clear();
  for (let i = 0; i < m.tiles.length; i++) paintTile(m, i);
}

/** The range of tiles that can be on screen: [x0, y0, x1, y1]. */
function visibleTiles(): [number, number, number, number] {
  const n = map!.size;
  const corners = [screenToTile(0, 0), screenToTile(canvas.width, 0), screenToTile(0, canvas.height), screenToTile(canvas.width, canvas.height)];
  return [
    Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))) - 1), Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))) - 1),
    Math.min(n - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))) + 1), Math.min(n - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))) + 1),
  ];
}

/** Tiles per side of a pre-drawn block of ground. */
const CHUNK = 8;
/** Pre-drawn blocks of ground, by block index; a block is dropped when something in it changes. */
const chunks = new Map<number, { img: HTMLCanvasElement; used: number }>();
let chunkSeen = new Int32Array(0);
let frameNo = 0;

function paintChunk(bx: number, by: number): HTMLCanvasElement {
  const n = map!.size;
  const img = document.createElement('canvas');
  img.width = CHUNK * HW * 2 + 2;
  img.height = CHUNK * HH * 2 + 2;
  const c = img.getContext('2d')!;
  const x0 = bx * CHUNK;
  const y0 = by * CHUNK;
  const paths = GROUND_COLORS.map(() => new Path2D());
  const specks = new Path2D();
  for (let ty = y0; ty < Math.min(n, y0 + CHUNK); ty++) {
    for (let tx = x0; tx < Math.min(n, x0 + CHUNK); tx++) {
      const i = ty * n + tx;
      // Ground never seen stays dark: nothing is drawn there at all.
      if (!revealAll && !explored[i]) continue;
      const x = (tx - x0 - (ty - y0)) * HW + CHUNK * HW + 1;
      const y = (tx - x0 + (ty - y0)) * HH + 1;
      const path = paths[ground[i]];
      // A hair wider than the tile so that no seams show between neighbours.
      path.moveTo(x, y - 0.5);
      path.lineTo(x + HW + 0.5, y + HH);
      path.lineTo(x, y + HH * 2 + 0.5);
      path.lineTo(x - HW - 0.5, y + HH);
      path.closePath();
      const r = hash(tx, ty);
      if (ground[i] < 4 && r > 0.8) specks.rect(x - 8 + (Math.floor(r * 60) % 16), y + 10 + (Math.floor(r * 90) % 10), 2, 2);
    }
  }
  GROUND_COLORS.forEach((color, k) => {
    c.fillStyle = color;
    c.fill(paths[k]);
  });
  c.fillStyle = '#6aa64c';
  c.fill(specks);
  return img;
}

/** Draws the ground from pre-drawn blocks, only those that can be on screen. */
function drawGround(): void {
  const n = map!.size;
  const blocks = Math.ceil(n / CHUNK);
  const [x0, y0, x1, y1] = visibleTiles();
  frameNo++;
  for (let by = Math.floor(y0 / CHUNK); by <= Math.floor(y1 / CHUNK); by++) {
    for (let bx = Math.floor(x0 / CHUNK); bx <= Math.floor(x1 / CHUNK); bx++) {
      if (bx < 0 || by < 0 || bx >= blocks || by >= blocks) continue;
      const [sx, sy] = tileToScreen(bx * CHUNK, by * CHUNK);
      const left = Math.round(sx) - CHUNK * HW - 1;
      const top = Math.round(sy) - 1;
      if (left > canvas.width || top > canvas.height || left + CHUNK * HW * 2 < 0 || top + CHUNK * HH * 2 < 0) continue;
      const key = by * blocks + bx;
      let chunk = chunks.get(key);
      if (!chunk) {
        chunk = { img: paintChunk(bx, by), used: 0 };
        chunks.set(key, chunk);
      }
      chunk.used = frameNo;
      ctx.drawImage(chunk.img, left, top);
    }
  }
  // Keep memory in check: forget the blocks that have not been on screen for the longest.
  if (chunks.size > 160) {
    const old = [...chunks].sort((a, b) => a[1].used - b[1].used).slice(0, chunks.size - 120);
    for (const [key] of old) chunks.delete(key);
  }
}

function setTile(index: number, tile: number): void {
  if (!map) return;
  map.tiles[index] = tile;
  paintTile(map, index);
  const blocks = Math.ceil(map.size / CHUNK);
  chunks.delete(Math.floor(Math.floor(index / map.size) / CHUNK) * blocks + Math.floor((index % map.size) / CHUNK));
}

function setBlocked(v: View, value: number): void {
  if (!map || !isBuilding(v.kind)) return;
  markBuilding(map, v.x, v.y, sizeOf(v.kind), DEFS[v.kind].walkable === true, value);
}

// --- network ---------------------------------------------------------------

function send(cmd: Command): void {
  const msg: ClientMessage = { t: 'cmd', cmd };
  session?.send(msg);
}

function renderPlayers(): void {
  const el = $('players');
  el.textContent = '';
  for (const p of roster) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = PLAYER_COLORS[p.slot];
    const label = document.createElement('span');
    label.textContent = p.name + (p.slot === me ? (p.slot === myOwnSlot ? ' (you)' : ' (playing)') : '');
    label.style.marginRight = '14px';
    if (players.get(p.slot)?.defeated) label.style.textDecoration = 'line-through';
    el.append(chip, label);
  }
}

function onMessage(msg: ServerMessage): void {
  if (msg.t === 'lobby') {
    resetGame();
    roster = msg.players;
    renderRoom(msg.room, msg.you, msg.host, msg.settings);
    history.replaceState(null, '', `?room=${msg.room}`);
    $('lobby').style.display = 'none';
    $('waiting').style.display = '';
  } else if (msg.t === 'start') {
    resetGame();
    me = myOwnSlot = msg.you;
    map = generateMap(msg.seed, msg.size);
    buildTerrain(map);
    roster = msg.players;
    $('room-code').textContent = msg.room;
    renderPlayers();
    $('lobby').style.display = 'none';
    $('waiting').style.display = 'none';
    $('top').hidden = false;
    $('bottom').hidden = false;
    $('host-tools').hidden = !session?.host;
    $('switch-btn').hidden = !roster.some((p) => p.test);
  } else if (msg.t === 'players') {
    roster = msg.players;
    renderPlayers();
  } else if (msg.t === 'snap') {
    const now = performance.now();
    const alpha = Math.min(1, (now - snapTime) / TICK_MS);
    const seen = new Set<number>();
    for (const [id, owner, kindIdx, x, y, hp, act, extra, task, target] of msg.ents) {
      seen.add(id);
      const v = views.get(id);
      if (v) {
        // Continue from wherever the unit is currently drawn, so motion stays smooth.
        [v.px, v.py] = viewPos(v, alpha);
        const turn = x - v.x - (y - v.y);
        if (Math.abs(turn) > 0.01) v.face = turn > 0 ? 1 : -1;
        if (hp < v.hp && v.owner === me) underAttack(v, now);
        if (v.owner === me && isBuilding(v.kind) && v.extra < 100 && extra >= 100) play('built', 400);
        Object.assign(v, { x, y, hp, act, extra, task, target });
      } else {
        const created: View = { id, owner, kind: KINDS[kindIdx], hp, act, extra, task, target, ox: 0, oy: 0, struck: 0, hurt: 0, face: 1, px: x, py: y, x, y };
        views.set(id, created);
        setBlocked(created, 1);
        if (owner === me && !isBuilding(created.kind) && msg.tick > 20) play('trained', 300);
      }
    }
    for (const [id, v] of views) {
      if (seen.has(id)) continue;
      setBlocked(v, 0);
      views.delete(id);
      selected.delete(id);
    }
    for (const [index, tile] of msg.tiles) setTile(index, tile);
    for (const [index, amount] of msg.amounts) if (map) map.amount[index] = amount;
    for (const [from, to] of msg.shots) {
      const a = views.get(from);
      const b = views.get(to);
      if (!a || !b) continue;
      a.struck = now;
      b.hurt = now + 200;
      if (canSee(a) || canSee(b)) play('arrow', 120);
      if (canSee(a) || canSee(b)) shots.push({ from: centreOf(a), to: centreOf(b), t: now });
    }
    for (const [from, to] of msg.hits) {
      const a = views.get(from);
      const b = views.get(to);
      if (a) a.struck = now;
      if (b) b.hurt = now + 120;
      if ((a && canSee(a)) || (b && canSee(b))) play('hit', 110);
    }
    for (const [kindIdx, x, y] of msg.deaths) {
      const kind = KINDS[kindIdx];
      const half = isBuilding(kind) ? sizeOf(kind) / 2 : 0;
      if (revealAll || tileSeen(Math.floor(x + half), Math.floor(y + half))) {
        puffs.push({ x: x + half, y: y + half, t: now, big: isBuilding(kind) });
        play(isBuilding(kind) ? 'collapse' : 'death', 150);
      }
    }
    rallies.clear();
    for (const [id, x, y] of msg.rallies) rallies.set(id, [x, y]);
    queues.clear();
    for (const [id, ...rest] of msg.queues) queues.set(id, rest);
    let defeatChanged = false;
    gameTick = msg.tick;
    for (const [slot, food, wood, gold, stone, pop, cap, defeated, age, techs, researching, w0, w1, w2, w3] of msg.players) {
      const old = players.get(slot);
      if (old?.defeated !== (defeated === 1)) defeatChanged = true;
      if (slot === me && old) {
        if (age > old.age) play('age');
        else if (techs !== old.techs) play('research');
        if (defeated === 1 && !old.defeated) play('defeat');
      }
      players.set(slot, {
        res: { food, wood, gold, stone }, pop, cap, defeated: defeated === 1, age, techs, researching,
        workers: { food: w0, wood: w1, gold: w2, stone: w3 },
      });
    }
    if (msg.winner >= 0 && winner < 0 && msg.winner === teamOf(me)) play('victory');
    if (defeatChanged) renderPlayers();
    winner = msg.winner;
    snapTime = now;
    if (!centred) {
      const king = [...views.values()].find((v) => v.owner === me && v.kind === 'king');
      if (king) {
        [cam.x, cam.y] = tileToWorld(king.x, king.y);
        centred = true;
      }
    }
  } else if (msg.t === 'chat') {
    showChat(msg.from, msg.text);
  } else if (msg.t === 'error') {
    $('lobby-msg').textContent = msg.message;
  }
}

function showChat(from: number, text: string): void {
  const line = document.createElement('div');
  const who = document.createElement('b');
  who.textContent = `${roster.find((p) => p.slot === from)?.name ?? 'Someone'}: `;
  who.style.color = PLAYER_COLORS[from] ?? '';
  line.append(who, text);
  $('chat-log').append(line);
  setTimeout(() => line.remove(), 12000);
  play('trained', 0);
}

/** Tells the player when something of theirs is attacked where they are not looking. */
function underAttack(v: View, now: number): void {
  if (alert && now - alert.t < 7000) return;
  const [cx, cy] = centreOf(v);
  const [sx, sy] = tileToScreen(cx, cy);
  if (sx > 0 && sy > 40 && sx < canvas.width && sy < canvas.height - 230 / zoom) return;
  alert = { x: cx, y: cy, t: now };
  play('alarm');
  const toast = $('toast');
  toast.textContent = `Your ${DEFS[v.kind].label.toLowerCase()} is under attack! (Space to look)`;
  toast.hidden = false;
  setTimeout(() => (toast.hidden = true), 4000);
}

/** Clears everything that belongs to a running game. */
function resetGame(): void {
  me = -1;
  revealAll = false;
  centred = false;
  placing = undefined;
  winner = -1;
  map = undefined;
  views.clear();
  players.clear();
  queues.clear();
  rallies.clear();
  groups.clear();
  exploredBy.clear();
  rememberedBy.clear();
  visible = new Uint8Array(0);
  fogTime = 0;
  selected.clear();
  shots = [];
  puffs = [];
  alert = attackFlash = undefined;
  $('toast').hidden = true;
  $('menu').hidden = true;
  $('touch-tools').hidden = true;
  selectedTile = -1;
  $('chat-log').textContent = '';
  $('chat-input').hidden = true;
  hudSignature = panelSignature = detailSignature = idleSignature = lastButtons = '';
  $('top').hidden = true;
  $('bottom').hidden = true;
  $('banner').hidden = true;
}

function showLobby(message: string): void {
  session = undefined;
  resetGame();
  $('waiting').style.display = 'none';
  $('lobby').style.display = '';
  $('lobby-msg').textContent = message;
}

/** The waiting room: who is in, and for the host the controls to set up and start. */
function renderRoom(room: string, you: number, host: number, settings: GameSettings): void {
  const hosting = !!session?.host;
  $('room-title').textContent = `Room ${room}`;
  $<HTMLInputElement>('room-link').value = `${location.origin}${location.pathname}?room=${room}`;
  const list = $('room-players');
  list.textContent = '';
  for (const p of roster) {
    const li = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = PLAYER_COLORS[p.slot];
    const tags = [
      p.slot === you ? 'you' : '', p.slot === host ? 'host' : '', p.test ? 'played by the host' : '', p.ai ? 'computer' : '',
    ].filter(Boolean);
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = p.name + (tags.length ? ` (${tags.join(', ')})` : '');
    // The host puts players into teams; same team means allies.
    const team = document.createElement('select');
    team.title = 'Team';
    for (let t = 0; t < 4; t++) team.add(new Option(`Team ${t + 1}`, String(t)));
    team.value = String(p.team);
    team.disabled = !hosting;
    team.addEventListener('change', () => session?.host?.setTeam(p.slot, Number(team.value)));
    li.append(chip, name, team);
    if ((p.test || p.ai) && hosting) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => session?.host?.removeExtra(p.slot));
      li.append(remove);
    }
    list.append(li);
  }
  $('room-host').hidden = !hosting;
  $('room-wait').hidden = hosting;
  $<HTMLButtonElement>('add-test-btn').disabled = $<HTMLButtonElement>('add-ai-btn').disabled = roster.length >= 4;
  const quickBox = $<HTMLInputElement>('quick-box');
  quickBox.checked = settings.quick;
  quickBox.disabled = !hosting;
  const sizeBox = $<HTMLSelectElement>('size-select');
  sizeBox.value = settings.mapSize;
  sizeBox.disabled = !hosting;
  const teams = new Set(roster.map((p) => p.team)).size;
  $('room-hint').textContent = roster.length < 2
    ? 'You are alone. Share the link, or add a computer opponent.'
    : teams < 2 ? 'Everyone is on the same team, so nobody can win. Put at least one player on another team.'
      : `${roster.length} players in ${teams} teams. Everyone starts at the same time.`;
}

/** The slot this browser joined as; `me` can differ while the host plays a test opponent. */
let myOwnSlot = -1;

/** The players this browser may give orders to: itself, plus the host's test opponents. */
function controllable(): number[] {
  return roster.filter((p) => p.slot === myOwnSlot || (p.test && session?.host)).map((p) => p.slot);
}

/** Hands control to another of the host's own players; without a slot, to the next one. */
function switchTeam(to?: number, keepSelection = false): void {
  const host = session?.host;
  if (!host || me < 0) return;
  const mine = controllable();
  const next = to ?? mine[(mine.indexOf(me) + 1) % mine.length];
  if (next === me || !mine.includes(next) || !host.control(next)) return;
  me = next;
  placing = undefined;
  hudSignature = panelSignature = '';
  fogTime = 0;
  renderPlayers();
  if (keepSelection) return;
  selected.clear();
  const home = [...views.values()].find((v) => v.owner === me && v.kind === 'king')
    ?? [...views.values()].find((v) => v.owner === me && v.kind === 'castle');
  if (home) [cam.x, cam.y] = tileToWorld(home.x, home.y);
}

$('start-btn').addEventListener('click', () => session?.host?.start());
$('add-test-btn').addEventListener('click', () => session?.host?.addTestPlayer());
$('add-ai-btn').addEventListener('click', () => session?.host?.addComputer());
$('size-select').addEventListener('change', (ev) => session?.host?.setMapSize((ev.target as HTMLSelectElement).value));
$('quick-box').addEventListener('change', (ev) => session?.host?.setQuickStart((ev.target as HTMLInputElement).checked));
$('leave-btn').addEventListener('click', () => session?.close());
$('switch-btn').addEventListener('click', () => switchTeam());
$('end-btn').addEventListener('click', () => {
  if (confirm('End this game for everyone and go back to the lobby?')) session?.host?.backToLobby();
});
$('room-link').addEventListener('click', (ev) => (ev.target as HTMLInputElement).select());

$<HTMLFormElement>('lobby-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const hosting = (ev as SubmitEvent).submitter?.id === 'host-btn';
  const name = $<HTMLInputElement>('name').value;
  let code = normaliseCode($<HTMLInputElement>('room').value);
  if (!hosting && !code) {
    $('lobby-msg').textContent = 'Enter the room code your host gave you.';
    return;
  }
  if (!code) code = normaliseCode(Math.random().toString(36).slice(2, 7));
  $('lobby-msg').textContent = 'Connecting…';
  session?.close();
  const handlers = { onMessage, onClose: showLobby };
  session = hosting ? hostGame(code, name, handlers) : joinGame(code, name, handlers);
});
$<HTMLInputElement>('room').value = new URLSearchParams(location.search).get('room') ?? '';
// Enter in the room-code field joins; anywhere else in the form it hosts.
$('room').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  $<HTMLButtonElement>('join-btn').click();
});

// --- picking and commands --------------------------------------------------

function clampCamera(): void {
  if (!map) return;
  const n = map.size;
  cam.x = Math.max(-n * HW, Math.min(n * HW, cam.x));
  cam.y = Math.max(0, Math.min(n * HH * 2, cam.y));
}

function unitAt(sx: number, sy: number): View | undefined {
  let best: View | undefined;
  let bestD = 18;
  for (const v of views.values()) {
    if (isBuilding(v.kind) || !canSee(v)) continue;
    const [x, y] = unitScreen(v);
    const d = Math.hypot(x - sx, y - 10 - sy);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

function buildingAt(sx: number, sy: number): View | undefined {
  // Walls rise above the footprint, so also test points a little below the cursor.
  for (const dy of [0, 12, 24]) {
    const [tx, ty] = screenToTile(sx, sy + dy);
    for (const v of views.values()) {
      if (!isBuilding(v.kind) || !canSee(v)) continue;
      const s = sizeOf(v.kind);
      if (tx >= v.x && tx < v.x + s && ty >= v.y && ty < v.y + s) return v;
    }
  }
  return undefined;
}

function resourceTileAt(sx: number, sy: number): number {
  if (!map) return -1;
  // The trunk first, then the tile in front whose crown may cover the cursor.
  for (const dy of [0, 16]) {
    const [tx, ty] = screenToTile(sx, sy + dy).map(Math.floor);
    if (tx < 0 || ty < 0 || tx >= map.size || ty >= map.size) continue;
    const index = ty * map.size + tx;
    if (props.has(index) && explored[index]) return index;
  }
  return -1;
}

function ownSelectedUnits(): View[] {
  return [...selected].map((id) => views.get(id)!).filter((v) => v && v.owner === me && !isBuilding(v.kind));
}

function placementSpot(): [number, number] {
  const s = sizeOf(placing!);
  const [tx, ty] = screenToTile(mouse.x, mouse.y);
  return [Math.floor(tx - (s - 1) / 2), Math.floor(ty - (s - 1) / 2)];
}

function canAfford(cost: Cost): boolean {
  const p = players.get(me);
  return !!p && RESOURCES.every((r) => p.res[r] >= (cost[r] ?? 0));
}

function rightClick(sx: number, sy: number, attackMove: boolean): void {
  const [tx, ty] = screenToTile(sx, sy);
  const units = ownSelectedUnits();
  if (units.length === 0) {
    // With only a building selected, a right-click sets where its new units gather.
    const b = [...selected].map((id) => views.get(id)).find((v) => v && v.owner === me && DEFS[v.kind].trains);
    if (b) {
      const tile = resourceTileAt(sx, sy);
      const spot: [number, number] = tile >= 0 && map ? [tile % map.size, Math.floor(tile / map.size)] : [Math.floor(tx), Math.floor(ty)];
      send({ type: 'rally', building: b.id, x: spot[0], y: spot[1] });
      marker = { x: spot[0] + 0.5, y: spot[1] + 0.5, t: performance.now() };
    }
    return;
  }
  const ids = units.map((v) => v.id);
  marker = { x: tx, y: ty, t: performance.now() };
  if (attackMove) {
    send({ type: 'amove', ids, x: tx, y: ty });
    return;
  }
  const target = unitAt(sx, sy) ?? buildingAt(sx, sy);
  if (target && (target.owner !== me || isBuilding(target.kind))) {
    send({ type: 'interact', ids, target: target.id });
    marker = undefined;
    if (isEnemy(target.owner)) attackFlash = { id: target.id, t: performance.now() };
    play('order');
    return;
  }
  const tile = resourceTileAt(sx, sy);
  play('order');
  if (tile >= 0) {
    send({ type: 'gather', ids, tile });
    tileFlash = { tile, t: performance.now() };
    marker = undefined;
  } else send({ type: 'move', ids, x: tx, y: ty });
}

/** Tiles on a straight line between two tiles, ends included. */
function lineTiles(a: [number, number], b: [number, number]): [number, number][] {
  const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const k = steps === 0 ? 0 : i / steps;
    out.push([Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k)]);
  }
  return out;
}

function ageAllows(kind: Kind): boolean {
  return (DEFS[kind].age ?? 1) <= (players.get(me)?.age ?? 1);
}

function placeAtCursor(keep: boolean): void {
  if (!placing || !map) return;
  const [x, y] = placementSpot();
  const ids = ownSelectedUnits().filter((v) => v.kind === 'villager').map((v) => v.id);
  if (!canPlace(map, placing, x, y) || !canAfford(DEFS[placing].cost)) return;
  send({ type: 'place', ids, kind: placing, x, y });
  play('order');
  if (!keep) placing = undefined;
}

/** Places the wall line that was dragged out. */
function finishWall(keep: boolean): void {
  if (!wallStart || !map) return;
  const ids = ownSelectedUnits().filter((v) => v.kind === 'villager').map((v) => v.id);
  for (const [x, y] of lineTiles(wallStart, placementSpot())) {
    if (canPlace(map, 'wall', x, y)) send({ type: 'place', ids, kind: 'wall', x, y });
  }
  wallStart = undefined;
  if (!keep) placing = undefined;
}

/** Selects whatever is at a point: a unit, a building, or a resource to see what is left of it. */
function clickSelect(sx: number, sy: number): void {
  const v = unitAt(sx, sy) ?? buildingAt(sx, sy);
  if (!v) {
    if (selected.size === 0) selectedTile = resourceTileAt(sx, sy);
    return;
  }
  selected.add(v.id);
  // Selecting something of a test opponent hands control to that side.
  if (v.owner !== me && controllable().includes(v.owner)) {
    selected.clear();
    selected.add(v.id);
    switchTeam(v.owner, true);
  }
}

function boxSelect(box: { x0: number; y0: number; x1: number; y1: number }): void {
  const inBox = (owner: number) => [...views.values()].filter((v) => {
    if (v.owner !== owner || isBuilding(v.kind)) return false;
    const [x, y] = unitScreen(v);
    return x >= box.x0 && x <= box.x1 && y - 10 >= box.y0 && y - 10 <= box.y1;
  });
  let picked = inBox(me);
  if (picked.length === 0 && selected.size === 0) {
    // Nothing of the current side in the box: take a test opponent's units and control that side.
    for (const slot of controllable()) {
      if (slot === me) continue;
      picked = inBox(slot);
      if (picked.length > 0) {
        switchTeam(slot, true);
        break;
      }
    }
  }
  for (const v of picked) selected.add(v.id);
}

canvas.addEventListener('mousedown', (ev) => {
  if (me < 0) return;
  $('menu').hidden = true;
  const x = ev.clientX / zoom;
  const y = ev.clientY / zoom;
  if (ev.button === 2) {
    if (placing) placing = wallStart = undefined;
    else rightClick(x, y, ev.ctrlKey || ev.metaKey);
    return;
  }
  if (ev.button !== 0) return;
  if (placing === 'wall') {
    // Walls are dragged out as a line and placed on release.
    wallStart = placementSpot();
    return;
  }
  if (placing) return placeAtCursor(ev.shiftKey);
  drag = { x, y };
});

window.addEventListener('mouseup', (ev) => {
  if (ev.button === 0 && wallStart && placing === 'wall') return finishWall(ev.shiftKey);
  if (ev.button !== 0 || !drag) return;
  const x = ev.clientX / zoom;
  const y = ev.clientY / zoom;
  const box = { x0: Math.min(drag.x, x), y0: Math.min(drag.y, y), x1: Math.max(drag.x, x), y1: Math.max(drag.y, y) };
  const isClick = box.x1 - box.x0 < 5 && box.y1 - box.y0 < 5;
  drag = undefined;
  if (!ev.shiftKey) {
    selected.clear();
    selectedTile = -1;
  }
  if (isClick) clickSelect(x, y);
  else boxSelect(box);
});

// --- touch -----------------------------------------------------------------
// One finger: tap to select or to send the selected units, drag to scroll, hold to inspect.
// Two fingers: pinch to zoom.

const finger = { x0: 0, y0: 0, x: 0, y: 0, moved: false, hold: 0, pinch: undefined as { d: number; zoom: number } | undefined };

function touchPoint(t: Touch): [number, number] {
  return [t.clientX / zoom, t.clientY / zoom];
}

function tap(x: number, y: number): void {
  if (placing) return placeAtCursor(false);
  const hit = unitAt(x, y) ?? buildingAt(x, y);
  const canOrder = ownSelectedUnits().length > 0 || [...selected].some((id) => views.get(id)?.owner === me && DEFS[views.get(id)!.kind].trains);
  if (hit && controllable().includes(hit.owner) && !(canOrder && isBuilding(hit.kind) && hit.owner === me && ownSelectedUnits().length > 0)) {
    // Something of your own: select it. (A building is an order target while units are selected.)
    selected.clear();
    selectedTile = -1;
    clickSelect(x, y);
  } else if (canOrder) {
    rightClick(x, y, false);
  } else {
    selected.clear();
    selectedTile = -1;
    clickSelect(x, y);
  }
}

canvas.addEventListener('touchstart', (ev) => {
  ev.preventDefault();
  if (me < 0) return;
  unlockSound();
  $('touch-tools').hidden = false;
  $('menu').hidden = true;
  clearTimeout(finger.hold);
  if (ev.touches.length >= 2) {
    const [a, b] = [ev.touches[0], ev.touches[1]];
    finger.pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom };
    finger.moved = true;
    drag = wallStart = undefined;
    return;
  }
  const [x, y] = touchPoint(ev.touches[0]);
  Object.assign(finger, { x0: x, y0: y, x, y, moved: false, pinch: undefined });
  Object.assign(mouse, { x, y, onMap: true });
  if (placing === 'wall') wallStart = placementSpot();
  else if (boxMode && !placing) drag = { x, y };
  else {
    finger.hold = window.setTimeout(() => {
      // Press and hold: look at what is there without giving an order.
      if (finger.moved) return;
      finger.moved = true;
      selected.clear();
      selectedTile = -1;
      clickSelect(x, y);
    }, 550);
  }
}, { passive: false });

canvas.addEventListener('touchmove', (ev) => {
  ev.preventDefault();
  if (me < 0) return;
  if (ev.touches.length >= 2 && finger.pinch) {
    const [a, b] = [ev.touches[0], ev.touches[1]];
    setZoom((finger.pinch.zoom * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)) / finger.pinch.d);
    return;
  }
  const [x, y] = touchPoint(ev.touches[0]);
  if (Math.hypot(x - finger.x0, y - finger.y0) > 9) {
    finger.moved = true;
    clearTimeout(finger.hold);
  }
  if (wallStart || drag || placing) Object.assign(mouse, { x, y });
  else if (finger.moved && !finger.pinch) {
    cam.x -= x - finger.x;
    cam.y -= y - finger.y;
    clampCamera();
  }
  finger.x = x;
  finger.y = y;
}, { passive: false });

canvas.addEventListener('touchend', (ev) => {
  ev.preventDefault();
  clearTimeout(finger.hold);
  if (me < 0 || ev.touches.length > 0) return;
  const { x, y } = finger;
  if (finger.pinch) finger.pinch = undefined;
  else if (wallStart && placing === 'wall') finishWall(false);
  else if (drag) {
    const box = { x0: Math.min(drag.x, x), y0: Math.min(drag.y, y), x1: Math.max(drag.x, x), y1: Math.max(drag.y, y) };
    drag = undefined;
    selected.clear();
    selectedTile = -1;
    boxSelect(box);
    boxMode = false;
    $('box-btn').classList.remove('on');
  } else if (!finger.moved) tap(x, y);
  mouse.onMap = false;
}, { passive: false });

$('box-btn').addEventListener('click', () => {
  boxMode = !boxMode;
  $('box-btn').classList.toggle('on', boxMode);
});
$('deselect-btn').addEventListener('click', () => {
  selected.clear();
  selectedTile = -1;
  placing = wallStart = undefined;
});

// Double-click selects every unit of that kind on screen.
canvas.addEventListener('dblclick', (ev) => {
  const hit = unitAt(ev.clientX / zoom, ev.clientY / zoom);
  if (!hit || hit.owner !== me) return;
  for (const v of views.values()) {
    if (v.owner !== me || v.kind !== hit.kind) continue;
    const [x, y] = tileToScreen(v.x, v.y);
    if (x >= 0 && y >= 0 && x <= canvas.width && y <= canvas.height) selected.add(v.id);
  }
});

window.addEventListener('mousemove', (ev) => {
  mouse.x = ev.clientX / zoom;
  mouse.y = ev.clientY / zoom;
  mouse.inside = true;
  mouse.onMap = ev.target === canvas;
  // No edge scrolling while the cursor is on something clickable in the interface.
  mouse.onButton = !!(ev.target as HTMLElement).closest?.('button, #minimap, input');
});
document.addEventListener('mouseleave', () => (mouse.inside = false));
window.addEventListener('blur', () => (mouse.inside = false));
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
window.addEventListener('keydown', (ev) => {
  if ((ev.target as HTMLElement).tagName === 'INPUT') return;
  const key = ev.key.toLowerCase();
  keys.add(key);
  if (key === 'escape') {
    placing = wallStart = undefined;
    $('help').hidden = true;
  }
  if (key === 'enter' && me >= 0) {
    ev.preventDefault();
    const box = $<HTMLInputElement>('chat-input');
    box.hidden = false;
    box.focus();
    return;
  }
  if (key === ',') selectIdleSoldiers();
  if (key === 'h') $('help').hidden = !$('help').hidden;
  if (key === 'f') toggleFullscreen();
  if (key === 'm') $('mute-btn').textContent = toggleMute() ? 'Sound off (M)' : 'Sound on (M)';
  if (key === 'x') send({ type: 'stop', ids: ownSelectedUnits().map((v) => v.id) });
  if (key === 'delete' || key === 'backspace') {
    for (const id of selected) if (views.get(id)?.owner === me) send({ type: 'delete', id });
  }
  if (key === ' ' && alert) {
    ev.preventDefault();
    [cam.x, cam.y] = tileToWorld(alert.x, alert.y);
  }
  if (/^Digit[1-9]$/.test(ev.code)) {
    // Shift+number stores the selection as a group, the number alone recalls it.
    if (ev.shiftKey) groups.set(ev.code, [...selected].filter((id) => views.get(id)?.owner === me));
    else if (groups.has(ev.code)) {
      const alive = groups.get(ev.code)!.filter((id) => views.get(id)?.owner === me);
      if (alive.length > 0) {
        selected.clear();
        for (const id of alive) selected.add(id);
      }
    }
  }
  if (key === 'tab') {
    ev.preventDefault();
    switchTeam();
  }
  if (key === '.') nextIdleVillager();
});

const idleVillagers = () => [...views.values()].filter((v) => v.owner === me && v.kind === 'villager' && v.act === 0);
const idleSoldiers = () => [...views.values()].filter((v) => v.owner === me && v.act === 0 && !isBuilding(v.kind) && v.kind !== 'villager' && v.kind !== 'king');

/** Selects the next villager with nothing to do and looks at it. */
function nextIdleVillager(): void {
  const idle = idleVillagers();
  if (idle.length === 0) return;
  const current = idle.findIndex((v) => selected.has(v.id));
  const next = idle[(current + 1) % idle.length];
  selected.clear();
  selectedTile = -1;
  selected.add(next.id);
  [cam.x, cam.y] = tileToWorld(next.x, next.y);
}

/** Selects every soldier that is standing around. */
function selectIdleSoldiers(): void {
  const idle = idleSoldiers();
  if (idle.length === 0) return;
  selected.clear();
  selectedTile = -1;
  for (const v of idle) selected.add(v.id);
}

$('idle-vil-btn').addEventListener('click', nextIdleVillager);
$('idle-mil-btn').addEventListener('click', selectIdleSoldiers);

let idleSignature = '';
function renderIdle(): void {
  const vil = idleVillagers().length;
  const mil = idleSoldiers().length;
  const signature = `${vil}|${mil}|${me}`;
  if (signature === idleSignature) return;
  idleSignature = signature;
  const set = (id: string, count: number, iconId: string) => {
    const b = $(id);
    b.classList.toggle('none', count === 0);
    b.querySelector('b')!.textContent = String(count);
    b.querySelector('img')!.src = icon(iconId, me);
  };
  set('idle-vil-btn', vil, 'villager');
  set('idle-mil-btn', mil, 'swordsman');
}
window.addEventListener('keyup', (ev) => keys.delete(ev.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => undefined);
}
$('full-btn').addEventListener('click', toggleFullscreen);
$('menu-btn').addEventListener('click', () => ($('menu').hidden = !$('menu').hidden));
for (const img of document.querySelectorAll<HTMLImageElement>('.card .emblem')) img.src = icon('crown');

// Browsers only allow sound after the player has clicked or pressed a key.
window.addEventListener('pointerdown', unlockSound);
window.addEventListener('keydown', unlockSound);
$('mute-btn').textContent = isMuted() ? 'Sound off (M)' : 'Sound on (M)';
$('mute-btn').addEventListener('click', () => ($('mute-btn').textContent = toggleMute() ? 'Sound off (M)' : 'Sound on (M)'));
$('help-close').addEventListener('click', () => ($('help').hidden = true));
$('chat-btn').addEventListener('click', () => {
  $('menu').hidden = true;
  const box = $<HTMLInputElement>('chat-input');
  box.hidden = false;
  box.focus();
});

$('help-btn').addEventListener('click', () => {
  $('menu').hidden = true;
  $('help').hidden = !$('help').hidden;
});
$('actions').addEventListener('click', (ev) => {
  const button = (ev.target as HTMLElement).closest('button');
  if (!button) return;
  focusButton(button);
  // A press-and-hold only showed the details; it does not also use the button.
  if (pressShown) return void (pressShown = false);
  if (button.classList.contains('locked')) return;
  const { build, train, cancel, eject, sell, buy } = button.dataset;
  if (sell) send({ type: 'trade', building: Number(button.dataset.at), res: sell as Res, buy: false });
  if (buy) send({ type: 'trade', building: Number(button.dataset.at), res: buy as Res, buy: true });
  if (eject) send({ type: 'eject', building: Number(eject) });
  if (build) placing = build as Kind;
  if (train) send({ type: 'train', building: Number(button.dataset.at), kind: train });
  if (cancel) send({ type: 'cancel', building: Number(cancel) });
});

// The minimap shows the map as the same diamond as the main view.
function miniScale(): [number, number] {
  return [minimap.width / (2 * map!.size), minimap.height / (2 * map!.size)];
}

function minimapTile(ev: MouseEvent): [number, number] {
  const r = minimap.getBoundingClientRect();
  const [a, b] = miniScale();
  const u = ((ev.clientX - r.left) * (minimap.width / r.width) - minimap.width / 2) / a;
  const v = ((ev.clientY - r.top) * (minimap.height / r.height)) / b;
  return [(u + v) / 2, (v - u) / 2];
}

let minimapDrag = false;
minimap.addEventListener('mousedown', (ev) => {
  if (!map || me < 0) return;
  const [tx, ty] = minimapTile(ev);
  if (ev.button === 2) {
    // Right-click sends the selected units there (Ctrl: attack-move), or sets a building's gathering point.
    if (tx < 0 || ty < 0 || tx >= map.size || ty >= map.size) return;
    const ids = ownSelectedUnits().map((v) => v.id);
    const building = [...selected].map((id) => views.get(id)).find((v) => v && v.owner === me && DEFS[v.kind].trains);
    if (ids.length > 0) send(ev.ctrlKey || ev.metaKey ? { type: 'amove', ids, x: tx, y: ty } : { type: 'move', ids, x: tx, y: ty });
    else if (building) send({ type: 'rally', building: building.id, x: Math.floor(tx), y: Math.floor(ty) });
    else return;
    minimapPing = { x: tx, y: ty, t: performance.now() };
    return;
  }
  if (ev.button !== 0) return;
  minimapDrag = true;
  [cam.x, cam.y] = tileToWorld(tx, ty);
  clampCamera();
});
minimap.addEventListener('mousemove', (ev) => {
  // Holding the left button drags the view across the minimap.
  if (!minimapDrag || !map || !(ev.buttons & 1)) return void (minimapDrag = false);
  [cam.x, cam.y] = tileToWorld(...minimapTile(ev));
  clampCamera();
});
minimap.addEventListener('contextmenu', (ev) => ev.preventDefault());
/** Where an order was just given on the minimap. */
let minimapPing: { x: number; y: number; t: number } | undefined;

function resize(): void {
  canvas.width = Math.ceil(window.innerWidth / zoom);
  canvas.height = Math.ceil(window.innerHeight / zoom);
}
function setZoom(value: number): void {
  zoom = Math.max(0.6, Math.min(3, value));
  resize();
  clampCamera();
}
window.addEventListener('resize', resize);
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  setZoom(zoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });
resize();

// --- HUD -------------------------------------------------------------------

function costText(cost: Cost): string {
  return RESOURCES.filter((r) => cost[r]).map((r) => `${cost[r]} ${r}`).join(', ') || 'free';
}

interface PanelButton {
  label: string;
  cost?: Cost;
  /** Not available yet; `short` says why in a word or two. */
  locked?: boolean;
  short?: string;
  /** What pressing it brings in (market sales). */
  gain?: Cost;
  /** Icon id, see icons.ts. */
  icon: string;
  detail: Detail;
  data: Record<string, string>;
}

/** What the selection card shows. */
interface SelCard {
  name: string;
  sub: string;
  portrait: string;
  owner: number;
  /** Health (or building progress when `building` is set) as [value, max]. */
  bar?: [number, number];
  building?: boolean;
  stats: [string, string][];
  /** Training or research queue: icon ids, the first with its progress 0-100. */
  queue: string[];
  progress: number;
  /** Several units: one entry each. */
  group: View[];
}

const TILE_NAMES: Record<number, string> = { [Tile.Forest]: 'Tree', [Tile.Berries]: 'Berry bush', [Tile.Gold]: 'Gold mine', [Tile.Stone]: 'Stone mine' };
const TILE_HINTS: Record<number, string> = {
  [Tile.Forest]: 'Villagers chop it for wood. A lumber camp at the edge of the forest saves walking.',
  [Tile.Berries]: 'Villagers pick it for food. A mill next to the bushes saves walking.',
  [Tile.Gold]: 'Villagers mine it for gold. Build a mining camp right next to it.',
  [Tile.Stone]: 'Villagers mine it for stone. Build a mining camp right next to it.',
};
const TIPS = [
  'Select a unit or building to see what it can do.',
  'Keep your town centre busy training villagers: more villagers, more of everything.',
  'Build houses before your population counter turns red.',
  'Your king is safest inside the castle. Right-click the castle with him selected.',
  'Spearmen beat riders, riders beat archers, archers beat spearmen.',
  'A mill, lumber camp or mining camp next to a resource saves your villagers a long walk.',
];

/** Button whose details stay in the box until something else is selected. */
let focusKey = '';
let focusSelection = '';
let panelSignature = '';
let lastButtons = '';
let detailSignature = '';
let currentButtons: PanelButton[] = [];
let currentDefault: Detail | undefined;
const buttonKey = (b: PanelButton) => JSON.stringify(b.data);

function renderPanel(): void {
  const chosen = [...selected].map((id) => views.get(id)).filter((v): v is View => !!v);
  const mine = chosen.filter((v) => v.owner === me);
  const my = players.get(me);
  const age = my?.age ?? 1;
  const has = hasOf(me);
  const card: SelCard = { name: '', sub: '', portrait: '', owner: me, stats: [], queue: [], progress: 0, group: [] };
  let detail: Detail = { title: 'Kingsfall', icon: 'crown', stats: [], lines: [TIPS[Math.floor(gameTick / 150) % TIPS.length]] };
  const buttons: PanelButton[] = [];
  const lockedShort = (kind: Kind) => (ageAllows(kind) ? undefined : AGE_NAMES[DEFS[kind].age ?? 1].replace(' Age', ''));
  if (selected.size > 0 || (selectedTile >= 0 && !props.has(selectedTile))) selectedTile = -1;

  if (placing) {
    card.name = `Placing ${DEFS[placing].label}`;
    card.sub = placing === 'wall' ? 'Drag a line and release · Shift for more · Esc cancels' : 'Click to build · Shift for several · Esc or right-click cancels';
    card.portrait = icon(placing, me);
    detail = describeKind(placing, has, age);
  } else if (selectedTile >= 0 && map) {
    // A resource: what it is and how much is left.
    const tile = map.tiles[selectedTile];
    const res = TILE_RESOURCE[tile as Tile]!.res;
    card.name = TILE_NAMES[tile];
    card.sub = `${map.amount[selectedTile]} ${res} left`;
    card.portrait = icon(res);
    card.bar = [map.amount[selectedTile], TILE_RESOURCE[tile as Tile]!.amount];
    card.building = true;
    detail = { title: TILE_NAMES[tile], icon: res, stats: [[res, `${map.amount[selectedTile]} left`]], lines: [TILE_HINTS[tile]] };
  } else if (chosen.length === 1) {
    const v = chosen[0];
    const def = DEFS[v.kind];
    const theirs = hasOf(v.owner);
    card.owner = v.owner;
    card.name = def.label;
    card.portrait = icon(v.kind, v.owner);
    card.sub = v.owner === me ? (roster.find((p) => p.slot === me)?.name ?? '') : `${roster.find((p) => p.slot === v.owner)?.name ?? 'Enemy'}${isEnemy(v.owner) ? ' · enemy' : ' · ally'}`;
    detail = describeKind(v.kind, theirs, players.get(v.owner)?.age ?? 1);
    detail.warn = undefined;
    if (isBuilding(v.kind) && v.extra < 100) {
      card.bar = [v.extra, 100];
      card.building = true;
      card.sub = `Under construction · ${v.extra}%`;
    } else card.bar = [v.hp, maxHp(v)];
    if (def.attack) card.stats.push(['sword', String(attackOf(v.kind, theirs))]);
    if ((def.range ?? 0) > 2) card.stats.push(['bow', String(rangeOf(v.kind, theirs))]);
    if (!isBuilding(v.kind) || def.attack) card.stats.push(['shield', String(armorOf(v.kind, theirs))]);
    if (!isBuilding(v.kind) && v.extra % 100 > 0) card.stats.push([RESOURCES[Math.floor(v.extra / 100)], `carrying ${v.extra % 100}`]);
    if (v.kind === 'castle' && v.extra >= 100) {
      card.sub = v.task === 1 ? 'The king is inside' : v.owner === me ? 'Right-click it with your king to shelter him' : card.sub;
      if (v.task === 1 && v.owner === me) buttons.push({ label: 'Send king out', icon: 'eject', detail: describeAction('eject'), data: { eject: String(v.id) } });
    }
    const queue = v.owner === me ? queues.get(v.id) : undefined;
    if (queue) {
      card.queue = queue.slice(1).map((i) => QUEUE_ITEMS[i]);
      card.progress = queue[0];
    }
    if (v.owner === me && isBuilding(v.kind) && v.extra >= 100) {
      const at = String(v.id);
      for (const kind of def.trains ?? []) {
        buttons.push({ label: DEFS[kind].label, icon: kind, cost: DEFS[kind].cost, locked: !ageAllows(kind), short: lockedShort(kind),
          detail: describeKind(kind, has, age), data: { train: kind, at } });
      }
      for (const id of TECH_IDS) {
        const tech = TECHS[id];
        if (tech.at !== v.kind || has(id) || ((my?.researching ?? 0) >> TECH_IDS.indexOf(id)) & 1) continue;
        if (id === 'age3' && age < 2) continue;
        const d = describeTech(id, has, age);
        const short = tech.age > age ? AGE_NAMES[tech.age].replace(' Age', '') : d.warn ? 'locked' : undefined;
        buttons.push({ label: tech.label, icon: id, cost: tech.cost, locked: !!d.warn, short, detail: d, data: { train: id, at } });
      }
      if (v.kind === 'market') {
        for (const r of TRADE_GOODS) buttons.push({ label: `Sell ${r}`, icon: `sell.${r}`, gain: { gold: TRADE_SELL }, locked: (my?.res[r] ?? 0) < 100, short: `100 ${r}`, detail: describeAction(`sell.${r}`), data: { sell: r, at } });
        for (const r of TRADE_GOODS) buttons.push({ label: `Buy ${r}`, icon: `buy.${r}`, cost: { gold: TRADE_BUY }, detail: describeAction(`buy.${r}`), data: { buy: r, at } });
      }
      if (queue) buttons.push({ label: 'Cancel last', icon: 'cancel', detail: describeAction('cancel'), data: { cancel: at } });
      if (def.trains) detail.lines.push('Right-click the map to set a gathering point.');
    }
  } else if (chosen.length > 1) {
    const counts = new Map<Kind, number>();
    for (const v of chosen) counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    card.name = `${chosen.length} selected`;
    const many = (k: Kind, c: number) => (c === 1 ? DEFS[k].label : DEFS[k].label.endsWith('man') ? DEFS[k].label.replace(/man$/, 'men') : `${DEFS[k].label}s`);
    card.sub = [...counts].map(([k, c]) => `${c} ${many(k, c)}`).join(' · ');
    card.portrait = icon(top, chosen[0].owner);
    card.group = chosen.slice(0, 30);
    detail = { title: card.name, icon: top, stats: [...counts].map(([k, c]) => [k, `${c} ${many(k, c)}`] as [string, string]),
      lines: ['Click one to select only it. Shift + 1–9 stores this group, 1–9 brings it back.'] };
  }
  if (!placing && mine.some((v) => v.kind === 'villager')) {
    for (const kind of BUILDABLE) {
      buttons.push({ label: DEFS[kind].label, icon: kind, cost: DEFS[kind].cost, locked: !ageAllows(kind), short: lockedShort(kind),
        detail: describeKind(kind, has, age), data: { build: kind } });
    }
  }

  // A new selection forgets the button that was looked at last.
  const selKey = [...selected].join() + '|' + selectedTile + '|' + (placing ?? '') + '|' + me;
  if (selKey !== focusSelection) {
    focusSelection = selKey;
    focusKey = '';
  }
  currentButtons = buttons;
  currentDefault = detail;
  renderDetails();

  const signature = JSON.stringify([card, card.group.map((v) => [v.id, v.hp])]);
  if (signature !== panelSignature) {
    panelSignature = signature;
    renderCard(card);
  }
  const buttonSignature = JSON.stringify([me, buttons.map((b) => [buttonKey(b), b.label, b.locked, b.cost && !canAfford(b.cost)])]);
  if (buttonSignature === lastButtons) return;
  lastButtons = buttonSignature;
  renderButtons(buttons);
  // The panel may have grown; things floating above it follow.
  document.documentElement.style.setProperty('--bottom-h', `${$('bottom').offsetHeight}px`);
}

function costChips(cost: Cost, sign = ''): HTMLElement[] {
  return RESOURCES.filter((r) => cost[r]).map((r) => {
    const part = document.createElement('span');
    part.className = 'res';
    const img = document.createElement('img');
    img.src = icon(r);
    img.alt = r;
    part.append(img, `${sign}${cost[r]}`);
    if (!sign && (players.get(me)?.res[r] ?? 0) < (cost[r] ?? 0)) part.classList.add('short');
    return part;
  });
}

function statChip(iconId: string, text: string): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'st';
  const img = document.createElement('img');
  img.src = icon(iconId, me);
  img.alt = '';
  chip.append(img, text);
  return chip;
}

function renderCard(card: SelCard): void {
  const pic = $<HTMLImageElement>('portrait');
  pic.style.visibility = card.portrait ? 'visible' : 'hidden';
  if (card.portrait) pic.src = card.portrait;
  $('sel-name').textContent = card.name || 'Nothing selected';
  $('sel-sub').textContent = card.sub;
  const bar = $('hpbar');
  bar.hidden = !card.bar;
  if (card.bar) {
    bar.classList.toggle('build', !!card.building);
    (bar.firstElementChild as HTMLElement).style.width = `${Math.max(0, Math.min(100, (card.bar[0] / card.bar[1]) * 100))}%`;
    bar.lastElementChild!.textContent = card.building && card.bar[1] === 100 ? `${card.bar[0]}%` : `${card.bar[0]} / ${card.bar[1]}`;
  }
  const stats = $('sel-stats');
  stats.textContent = '';
  for (const [i, t] of card.stats) stats.append(statChip(i, t));
  const queue = $('queue');
  queue.textContent = '';
  card.queue.forEach((id, n) => {
    const slot = document.createElement('span');
    slot.className = 'slot';
    const img = document.createElement('img');
    img.src = icon(id, me);
    img.alt = '';
    slot.append(img);
    if (n === 0) {
      const prog = document.createElement('i');
      prog.style.width = `${card.progress}%`;
      slot.append(prog);
    }
    queue.append(slot);
  });
  const group = $('group');
  group.textContent = '';
  group.hidden = card.group.length === 0;
  for (const v of card.group) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.only = String(v.id);
    const img = document.createElement('img');
    img.src = icon(v.kind, v.owner);
    img.alt = DEFS[v.kind].label;
    const hp = document.createElement('i');
    const k = v.hp / maxHp(v);
    hp.style.width = `${k * 100}%`;
    hp.style.background = k > 0.6 ? '#4ad04a' : k > 0.3 ? '#e8c440' : '#e0503a';
    b.append(img, hp);
    group.append(b);
  }
}

/**
 * Shows the command buttons. When only costs or states change, the existing buttons are updated in place
 * instead of being replaced, so that clicking quickly never lands on a button that is being swapped out.
 */
function renderButtons(buttons: PanelButton[]): void {
  const actions = $('actions');
  const keys = buttons.map(buttonKey);
  const current = [...actions.children] as HTMLElement[];
  const same = current.length === keys.length && current.every((el, i) => el.dataset.key === keys[i]);
  if (!same) {
    actions.textContent = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.type = 'button';
      Object.assign(el.dataset, b.data);
      el.dataset.key = buttonKey(b);
      const img = document.createElement('img');
      img.className = 'pic';
      img.alt = '';
      const label = document.createElement('span');
      label.className = 'lbl';
      const last = document.createElement('span');
      last.className = 'cost';
      el.append(img, label, last);
      actions.append(el);
    }
  }
  buttons.forEach((b, i) => {
    const el = actions.children[i] as HTMLElement;
    const img = el.querySelector('img.pic') as HTMLImageElement;
    const src = icon(b.icon, me);
    if (img.src !== src) img.src = src;
    // "Spearman: Pikes" is shown as "Pikes"; the icon already shows the spearman.
    (el.querySelector('.lbl') as HTMLElement).textContent = b.label.split(': ').pop()!;
    const last = el.querySelector('.cost') as HTMLElement;
    last.textContent = '';
    if (b.locked && b.short) last.textContent = b.short;
    else last.append(...costChips(b.gain ?? b.cost ?? {}, b.gain ? '+' : ''));
    el.classList.toggle('locked', !!b.locked);
    el.classList.toggle('poor', !b.locked && !!b.cost && !canAfford(b.cost));
    el.classList.toggle('focus', el.dataset.key === focusKey);
  });
}

/** Fills the details box: the button last pointed at, or else the selection itself. */
function renderDetails(): void {
  const b = currentButtons.find((x) => buttonKey(x) === focusKey);
  const d = b?.detail ?? currentDefault;
  if (!d) return;
  const signature = JSON.stringify([d, focusKey, RESOURCES.map((r) => (d.cost?.[r] ?? 0) > (players.get(me)?.res[r] ?? 0))]);
  if (signature === detailSignature) return;
  detailSignature = signature;
  const title = $('d-title');
  title.textContent = '';
  const img = document.createElement('img');
  img.src = icon(d.icon, me);
  img.alt = '';
  const name = document.createElement('span');
  name.textContent = d.title;
  title.append(img, name);
  const cost = $('d-cost');
  cost.textContent = '';
  if (d.gain) cost.append(...costChips(d.cost ?? {}), ' → ', ...costChips(d.gain, '+'));
  else if (d.cost && Object.keys(d.cost).length) cost.append(...costChips(d.cost));
  cost.hidden = !cost.childElementCount;
  const stats = $('d-stats');
  stats.textContent = '';
  for (const [i, t] of d.stats) stats.append(statChip(i, t));
  stats.hidden = d.stats.length === 0;
  const body = $('d-body');
  body.textContent = '';
  for (const line of d.lines) {
    const p = document.createElement('p');
    p.textContent = line;
    body.append(p);
  }
  if (d.warn) {
    const p = document.createElement('p');
    p.className = 'warn';
    p.textContent = d.warn;
    body.append(p);
  }
  for (const el of $('actions').children) el.classList.toggle('focus', (el as HTMLElement).dataset.key === focusKey);
}

function focusButton(el: HTMLElement | null): void {
  const key = el?.dataset.key ?? '';
  if (!key || key === focusKey) return;
  focusKey = key;
  renderDetails();
}

$('actions').addEventListener('mouseover', (ev) => focusButton((ev.target as HTMLElement).closest('button')));
// On touch screens, pressing and holding a button shows its details without using it.
let pressTimer = 0;
let pressShown = false;
$('actions').addEventListener('touchstart', (ev) => {
  const el = (ev.target as HTMLElement).closest('button');
  pressShown = false;
  clearTimeout(pressTimer);
  pressTimer = window.setTimeout(() => {
    focusButton(el);
    pressShown = true;
    $('details').classList.add('open');
  }, 450);
}, { passive: true });
$('actions').addEventListener('touchend', () => clearTimeout(pressTimer));
$('actions').addEventListener('touchmove', () => clearTimeout(pressTimer), { passive: true });
$('details').addEventListener('click', () => $('details').classList.remove('open'));
$('group').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest('button');
  if (!b?.dataset.only) return;
  selected.clear();
  selected.add(Number(b.dataset.only));
});

let hudSignature = '';
function renderHud(): void {
  const p = players.get(me);
  if (!p) return;
  const idle = [...views.values()].filter((v) => v.owner === me && v.kind === 'villager' && v.act === 0).length;
  const seconds = Math.floor(gameTick / 10);
  const signature = [p.res.food, p.res.wood, p.res.gold, p.res.stone, p.pop, p.cap, idle, p.defeated, winner, p.age, seconds,
    ...RESOURCES.map((r) => p.workers[r])].join();
  if (signature === hudSignature) return;
  hudSignature = signature;
  const el = $('resources');
  el.textContent = '';
  const stat = (iconId: string, value: string, title: string, note = ''): HTMLElement => {
    const box = document.createElement('span');
    box.className = 'stat';
    box.title = title;
    if (iconId) {
      const img = document.createElement('img');
      img.src = icon(iconId, me);
      img.alt = title;
      box.append(img);
    }
    const b = document.createElement('b');
    b.textContent = value;
    box.append(b);
    if (note) {
      const small = document.createElement('small');
      small.textContent = note;
      box.append(small);
    }
    el.append(box);
    return box;
  };
  for (const r of RESOURCES) stat(r, String(p.res[r]), `${r[0].toUpperCase()}${r.slice(1)} — ${p.workers[r] ?? 0} villagers gathering it`, String(p.workers[r] ?? 0));
  // Housing is full: nothing more can be trained until a house is built.
  const pop = stat('house', `${p.pop}/${p.cap}`, 'Population / housing');
  if (p.pop >= p.cap && p.cap < 60) pop.classList.add('warn');
  stat('', AGE_NAMES[p.age] ?? '', 'Your age').classList.add('age');
  stat('', `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, 'Game time');

  const banner = $('banner');
  let text = '';
  const who = me === myOwnSlot ? 'Your' : `${roster.find((q) => q.slot === me)?.name ?? 'This player'}'s`;
  const myTeam = teamOf(me);
  const allies = roster.filter((q) => q.team === myTeam).length > 1;
  if (winner === myTeam) text = me !== myOwnSlot ? 'This side has won.' : allies ? 'Victory! Your team has the last king standing.' : 'Victory! Yours is the last king standing.';
  else if (p.defeated) text = `${who} king has fallen. ${me === myOwnSlot ? 'You are' : 'This side is'} out of the game.`;
  if (winner >= 0 && winner !== myTeam) text += ` ${roster.filter((q) => q.team === winner).map((q) => q.name).join(' and ') || 'Another team'} won.`;
  banner.textContent = text.trim();
  banner.hidden = !text;
}

let minimapTime = 0;
function renderMinimap(): void {
  if (!map || !miniTerrain) return;
  // Redrawn about six times a second; that is plenty for a map this small.
  const t = performance.now();
  if (t - minimapTime < 160) return;
  minimapTime = t;
  const [a, b] = miniScale();
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, minimap.width, minimap.height);
  mctx.imageSmoothingEnabled = false;
  mctx.setTransform(a, b, -a, b, minimap.width / 2, 0);
  mctx.drawImage(miniTerrain, 0, 0);
  const dots = [...views.values()].filter(canSee);
  for (const [id, ghost] of remembered) if (!dots.some((v) => v.id === id)) dots.push(ghost);
  for (const v of dots) {
    mctx.fillStyle = PLAYER_COLORS[v.owner];
    const s = isBuilding(v.kind) ? sizeOf(v.kind) + 0.5 : v.kind === 'king' ? 2.2 : 1.6;
    const [cx, cy] = centreOf(v);
    mctx.fillRect(cx - s / 2, cy - s / 2, s, s);
  }
  if (fogMini && !revealAll) mctx.drawImage(fogMini, 0, 0);
  if (minimapPing) {
    const k = (performance.now() - minimapPing.t) / 600;
    if (k > 1) minimapPing = undefined;
    else {
      mctx.strokeStyle = `rgba(255,255,255,${1 - k})`;
      mctx.lineWidth = 1;
      mctx.strokeRect(minimapPing.x - 1 - k * 3, minimapPing.y - 1 - k * 3, 2 + k * 6, 2 + k * 6);
    }
  }
  if (alert && performance.now() - alert.t < 6000) {
    // A pulsing ring where the player was attacked.
    const k = ((performance.now() - alert.t) % 1000) / 1000;
    mctx.strokeStyle = `rgba(255,70,70,${1 - k})`;
    mctx.lineWidth = 1.5;
    mctx.strokeRect(alert.x - 2 - k * 5, alert.y - 2 - k * 5, 4 + k * 10, 4 + k * 10);
  }
  // The visible part of the world is an upright rectangle in minimap space.
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  const sx = (a / HW) * (cam.x - canvas.width / 2) + minimap.width / 2;
  const sy = (b / HH) * (cam.y - canvas.height / 2);
  mctx.strokeStyle = '#fff';
  mctx.lineWidth = 1;
  mctx.strokeRect(sx + 0.5, sy + 0.5, (a / HW) * canvas.width, (b / HH) * canvas.height);
}

// --- render ----------------------------------------------------------------

function updateCamera(dt: number): void {
  // The view scrolls while the cursor rests near an edge of the window, faster the closer it is.
  const zone = 22;
  const push = (distance: number) => (mouse.inside && !mouse.onButton && distance < zone ? 0.35 + 0.65 * (1 - Math.max(0, distance) / zone) : 0);
  let dx = push(canvas.width - mouse.x) - push(mouse.x);
  let dy = push(canvas.height - mouse.y) - push(mouse.y);
  if (keys.has('a') || keys.has('arrowleft')) dx = -1;
  if (keys.has('d') || keys.has('arrowright')) dx = 1;
  if (keys.has('w') || keys.has('arrowup')) dy = -1;
  if (keys.has('s') || keys.has('arrowdown')) dy = 1;
  cam.x += dx * 1000 * dt;
  cam.y += dy * 1000 * dt;
  clampCamera();
}

function bar(x: number, y: number, w: number, fraction: number, color: string): void {
  ctx.fillStyle = '#2a0c0c';
  ctx.fillRect(Math.round(x - w / 2), Math.round(y), w, 3);
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x - w / 2), Math.round(y), Math.round(w * Math.max(0, Math.min(1, fraction))), 3);
}

function diamond(tx: number, ty: number, s: number): void {
  const pts = [tileToScreen(tx, ty), tileToScreen(tx + s, ty), tileToScreen(tx + s, ty + s), tileToScreen(tx, ty + s)];
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
}

function drawBuildingView(v: View): void {
  const s = sizeOf(v.kind);
  const def = DEFS[v.kind];
  const [sx, sy] = tileToScreen(v.x, v.y);
  if (selected.has(v.id)) {
    diamond(v.x, v.y, s);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  drawBuilding(ctx, v.kind, v.owner, v.id, sx, sy, { built: v.extra / 100, kingInside: v.task === 1, now: performance.now() });
  if ((v.kind === 'farm' || v.kind === 'wall') && v.extra >= 100 && v.hp >= def.hp && !selected.has(v.id)) return;
  // Bars sit above the roof line of tall buildings.
  const top = sy - (v.kind === 'tower' ? 52 : v.kind === 'castle' || v.kind === 'towncenter' ? 32 : 14);
  if (v.extra < 100) bar(sx, top, 14 + s * 12, v.extra / 100, '#e0c12f');
  else if (v.hp < def.hp || selected.has(v.id)) bar(sx, top, 14 + s * 12, v.hp / def.hp, '#4ad04a');
  const queue = queues.get(v.id);
  if (queue && v.owner === me) bar(sx, top + 5, 14 + s * 12, queue[0] / 100, '#6ab0ff');
  const now = performance.now();
  // Badly damaged buildings burn, more so the closer they are to falling.
  if (v.extra >= 100 && v.kind !== 'farm' && v.hp < def.hp * 0.6) {
    const fires = v.hp < def.hp * 0.3 ? 3 : v.hp < def.hp * 0.45 ? 2 : 1;
    for (let i = 0; i < Math.min(fires, s + 1); i++) {
      drawFlame(sx + (hash(v.id, i) - 0.5) * s * HW * 0.9, sy + s * HH - 8 - hash(i, v.id) * 14, now, v.id + i);
    }
  }
  if (now >= v.hurt && now - v.hurt < 160) drawImpact(sx, sy + s * HH - 16, (now - v.hurt) / 160);
  const rally = selected.has(v.id) && v.owner === me ? rallies.get(v.id) : undefined;
  if (rally) {
    // Gathering point: a line from the building to a small flag.
    const [rx, ry] = tileToScreen(rally[0] + 0.5, rally[1] + 0.5);
    ctx.strokeStyle = 'rgba(255,255,255,.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(sx, sy + s * HH);
    ctx.lineTo(rx, ry);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#3a2a1a';
    ctx.fillRect(rx - 1, ry - 18, 2, 18);
    ctx.fillStyle = PLAYER_COLORS[v.owner];
    ctx.fillRect(rx + 1, ry - 18, 9, 6);
  }
}

function drawFlame(x: number, y: number, now: number, seed: number): void {
  const f = Math.sin(now / 70 + seed * 2.1) * 2;
  for (let i = 0; i < 3; i++) {
    // Smoke drifting up.
    const k = ((now / 900 + i / 3 + seed * 0.37) % 1);
    ctx.fillStyle = `rgba(40,40,40,${0.35 * (1 - k)})`;
    ctx.beginPath();
    ctx.arc(x + k * 8, y - 12 - k * 26, 3 + k * 5, 0, Math.PI * 2);
    ctx.fill();
  }
  const tongue = (w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - w, y);
    ctx.quadraticCurveTo(x - w * 0.6, y - h * 0.5, x + f * 0.6, y - h);
    ctx.quadraticCurveTo(x + w * 0.6, y - h * 0.5, x + w, y);
    ctx.closePath();
    ctx.fill();
  };
  tongue(6, 15 + f, '#e2571c');
  tongue(4, 10 + f * 0.7, '#f5a623');
  tongue(2, 6, '#ffe45c');
}

/** A short burst of sparks where a blow lands. `k` runs 0..1. */
function drawImpact(x: number, y: number, k: number): void {
  ctx.strokeStyle = `rgba(255,${Math.round(240 - k * 120)},${Math.round(200 - k * 200)},${1 - k})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4;
    ctx.moveTo(x + Math.cos(a) * (3 + k * 4), y + Math.sin(a) * (3 + k * 4));
    ctx.lineTo(x + Math.cos(a) * (6 + k * 8), y + Math.sin(a) * (6 + k * 8));
  }
  ctx.stroke();
}

/** Marks what is being attacked: a red ring under a unit's feet, a red outline around a building. */
function drawTargetMark(v: View, alpha: number, width: number): void {
  ctx.strokeStyle = `rgba(255,60,50,${alpha})`;
  ctx.lineWidth = width;
  if (isBuilding(v.kind)) {
    diamond(v.x, v.y, sizeOf(v.kind));
    ctx.stroke();
    return;
  }
  const [x, y] = unitScreen(v);
  const big = v.kind === 'rider' || v.kind === 'scout' || v.kind === 'ram';
  ctx.beginPath();
  ctx.ellipse(x, y, big ? 17 : 13, big ? 8.5 : 6.5, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function drawUnitView(v: View, x: number, y: number, now: number): void {
  let [sx, sy] = tileToScreen(x + v.ox, y + v.oy);
  if (selected.has(v.id)) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(sx, sy, 13, 6.5, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Walking bobs up and down; working and fighting are a quicker, smaller motion.
  const bob = v.act === 1 ? Math.abs(Math.sin(now / 90 + v.id)) * 2 : v.act >= 2 ? Math.abs(Math.sin(now / 60 + v.id)) * 1.5 : 0;
  const spot = workSpot(v, now);
  let work;
  if (spot && v.act === 2) {
    const dir = v.task === 5 ? (Math.floor(now / 2600 + v.id) % 2 ? 1 : -1) : tileToScreen(spot[0], spot[1])[0] >= sx ? 1 : -1;
    const period = v.task === 2 ? 900 : 700;
    work = { task: v.task, dir, phase: ((now + v.id * 137) % period) / period };
  }
  // A blow: the attacker lunges at its target and the weapon leaves a streak.
  const swing = (now - v.struck) / 320;
  const foe = v.task === 7 ? views.get(v.target) : undefined;
  let slash: { dir: number; k: number } | undefined;
  if (foe && swing >= 0 && swing < 1) {
    const [fx, fy] = tileToScreen(...centreOf(foe));
    const d = Math.hypot(fx - sx, fy - sy) || 1;
    const ranged = (DEFS[v.kind].range ?? 0) > 2;
    const reach = Math.sin(swing * Math.PI) * (ranged ? -2 : v.kind === 'ram' ? 9 : 6);
    sx += ((fx - sx) / d) * reach;
    sy += ((fy - sy) / d) * reach;
    if (!ranged && v.kind !== 'ram') slash = { dir: fx >= sx ? 1 : -1, k: swing };
  }
  // Fighters keep facing whoever they are attacking.
  let foeDir = 0;
  if (foe && v.act === 3) {
    foeDir = tileToScreen(...centreOf(foe))[0] >= sx ? 1 : -1;
  }
  const carried = v.kind === 'villager' && v.extra % 100 > 0 ? Math.floor(v.extra / 100) : -1;
  drawUnit(ctx, v.kind, v.owner, sx, sy, work ? 0 : bob, work, carried, v.act, now, slash ? slash.dir : foeDir || v.face);
  if (slash) {
    ctx.strokeStyle = `rgba(255,255,255,${0.9 * (1 - slash.k)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    const from = -1.9 + slash.k * 1.2;
    if (slash.dir > 0) ctx.arc(sx + 6, sy - 13, 12, from, from + 1.5);
    else ctx.arc(sx - 6, sy - 13, 12, Math.PI - from - 1.5, Math.PI - from);
    ctx.stroke();
  }
  if (now >= v.hurt && now - v.hurt < 160) drawImpact(sx, sy - 13, (now - v.hurt) / 160);
  const full = maxHp(v);
  if (v.hp < full || selected.has(v.id)) bar(sx, sy - (v.kind === 'king' ? 34 : 30), 22, v.hp / full, '#4ad04a');
}

/** A map generated for the background of the start menu and waiting room, with a small town on it. */
let lobbyMap: GameMap | undefined;
let lobbyTown: { kind: Kind; x: number; y: number }[] = [];
const lobbyStart = performance.now();

function drawLobbyScene(now: number): void {
  if (!lobbyMap) {
    lobbyMap = generateMap((Math.random() * 0xffffffff) >>> 0, 80);
    const [sx, sy] = lobbyMap.starts[0];
    lobbyTown = [
      { kind: 'towncenter', x: sx - 4, y: sy - 2 }, { kind: 'castle', x: sx + 1, y: sy - 2 }, { kind: 'house', x: sx - 4, y: sy + 2 },
      { kind: 'house', x: sx - 7, y: sy - 1 }, { kind: 'mill', x: sx - 1, y: sy + 3 }, { kind: 'farm', x: sx + 2, y: sy + 3 },
      { kind: 'farm', x: sx + 4, y: sy + 3 }, { kind: 'barracks', x: sx - 8, y: sy + 2 }, { kind: 'tower', x: sx + 6, y: sy - 4 },
    ];
  }
  if (map !== lobbyMap) {
    map = lobbyMap;
    buildTerrain(map);
  }
  revealAll = true;
  // The view drifts slowly around the town.
  const t = (now - lobbyStart) / 1000;
  const [sx, sy] = map.starts[0];
  [cam.x, cam.y] = tileToWorld(sx + Math.sin(t / 23) * 7, sy + 2 + Math.cos(t / 31) * 5);
  drawGround();
  const items: { depth: number; draw: () => void }[] = [];
  for (const [index, tile] of props) {
    const tx = index % map.size;
    const ty = Math.floor(index / map.size);
    const [x, y] = tileToScreen(tx + 0.5, ty + 0.5);
    if (x < -40 || y < -10 || x > canvas.width + 40 || y > canvas.height + 60) continue;
    items.push({ depth: tx + ty + 1, draw: () => drawProp(ctx, tile, x, y, Math.floor(hash(tx, ty) * 3), now) });
  }
  for (const b of lobbyTown) {
    const s = sizeOf(b.kind);
    const [x, y] = tileToScreen(b.x, b.y);
    items.push({ depth: b.kind === 'farm' ? -1e9 : b.x + b.y + s, draw: () => drawBuilding(ctx, b.kind, 0, b.x * 31 + b.y, x, y, { built: 1, kingInside: true, now }) });
  }
  items.sort((a, b) => a.depth - b.depth);
  for (const item of items) item.draw();
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  requestAnimationFrame(frame);
  ctx.fillStyle = '#0b0e0a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (me < 0) return drawLobbyScene(now);
  if (!map) return;
  updateCamera(dt);
  if (explored.length !== map.size * map.size) explored = new Uint8Array(map.size * map.size);
  updateWorkOffsets(now, dt);
  updateFog(now);

  drawGround();

  if (placing) {
    // Ghost of the footprint; a wall shows the whole line being dragged.
    const spots = placing === 'wall' && wallStart ? lineTiles(wallStart, placementSpot()) : [placementSpot()];
    for (const [px, py] of spots) {
      const ok = canPlace(map, placing, px, py) && canAfford(DEFS[placing].cost);
      diamond(px, py, sizeOf(placing));
      ctx.fillStyle = ok ? 'rgba(120,255,120,.35)' : 'rgba(255,90,90,.4)';
      ctx.fill();
    }
  }

  // Resource tiles are outlined when pointed at, and flash when villagers are sent there.
  const outline = (tile: number, color: string, width: number) => {
    diamond(tile % map!.size, Math.floor(tile / map!.size), 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  const hovered = mouse.onMap && !placing && !drag ? resourceTileAt(mouse.x, mouse.y) : -1;
  if (selectedTile >= 0 && props.has(selectedTile)) outline(selectedTile, '#ffffff', 2);
  if (hovered >= 0) outline(hovered, ownSelectedUnits().some((v) => v.kind === 'villager') ? '#ffe45c' : 'rgba(255,255,255,.75)', 2);
  if (tileFlash) {
    const age = (now - tileFlash.t) / 900;
    if (age > 1 || !props.has(tileFlash.tile)) tileFlash = undefined;
    else outline(tileFlash.tile, `rgba(255,228,92,${1 - age * age})`, 2 + 2 * Math.abs(Math.sin(age * Math.PI * 3)));
  }

  // Red rings on the ground under whatever the selected units are attacking, were just sent
  // to attack, or would attack. Drawn before the units so the ring lies under their feet.
  const marked = new Set<number>();
  for (const v of ownSelectedUnits()) if (v.task === 7) marked.add(v.target);
  for (const id of marked) {
    const t = views.get(id);
    if (t && canSee(t)) drawTargetMark(t, 0.85, 2);
  }
  if (attackFlash) {
    const age = (now - attackFlash.t) / 800;
    const t = views.get(attackFlash.id);
    if (age > 1 || !t) attackFlash = undefined;
    else if (canSee(t)) drawTargetMark(t, 1 - age * 0.5, 2 + 3 * Math.abs(Math.sin(age * Math.PI * 3)));
  }
  if (mouse.onMap && !placing && !drag && ownSelectedUnits().some((v) => DEFS[v.kind].attack)) {
    const over = unitAt(mouse.x, mouse.y) ?? buildingAt(mouse.x, mouse.y);
    if (over && isEnemy(over.owner) && !marked.has(over.id)) drawTargetMark(over, 0.6, 1.5);
  }

  // Fields lie flat on the ground, so they are drawn before anything that stands.
  const shown = [...views.values()].filter(canSee);
  for (const [id, ghost] of remembered) if (!shown.some((v) => v.id === id)) shown.push(ghost);
  for (const v of shown) {
    if (v.kind !== 'farm') continue;
    const [x, y] = tileToScreen(v.x + 1, v.y + 1);
    if (x > -100 && x < canvas.width + 100 && y > -100 && y < canvas.height + 100) drawBuildingView(v);
  }

  // Everything standing on the ground shares one depth-sorted pass.
  const alpha = Math.min(1, (now - snapTime) / TICK_MS);
  const drawables: { depth: number; draw: () => void }[] = [];
  for (const [index, tile] of props) {
    const tx = index % map.size;
    const ty = Math.floor(index / map.size);
    const [sx, sy] = tileToScreen(tx + 0.5, ty + 0.5);
    if (sx < -40 || sy < -10 || sx > canvas.width + 40 || sy > canvas.height + 60 || !explored[index]) continue;
    drawables.push({ depth: tx + ty + 1, draw: () => drawProp(ctx, tile, sx, sy, Math.floor(hash(tx, ty) * 3), now) });
  }
  const onScreen = (tx: number, ty: number, margin: number) => {
    const [x, y] = tileToScreen(tx, ty);
    return x > -margin && x < canvas.width + margin && y > -margin && y < canvas.height + margin * 2;
  };
  for (const v of shown) {
    if (v.kind === 'farm') continue;
    if (!onScreen(...centreOf(v), isBuilding(v.kind) ? 80 + sizeOf(v.kind) * 40 : 40)) continue;
    if (isBuilding(v.kind)) {
      drawables.push({ depth: v.x + v.y + sizeOf(v.kind), draw: () => drawBuildingView(v) });
    } else {
      const [x, y] = viewPos(v, alpha);
      drawables.push({ depth: x + v.ox + y + v.oy, draw: () => drawUnitView(v, x, y, now) });
    }
  }
  drawables.sort((a, b) => a.depth - b.depth);
  for (const d of drawables) d.draw();

  // Arrows in flight.
  shots = shots.filter((s) => now - s.t < 220);
  ctx.strokeStyle = '#f1ead9';
  ctx.lineWidth = 2;
  for (const s of shots) {
    const k = (now - s.t) / 220;
    const [ax, ay] = tileToScreen(...s.from);
    const [bx, by] = tileToScreen(...s.to);
    const at = (f: number): [number, number] => [ax + (bx - ax) * f, ay - 16 + (by - ay) * f - Math.sin(f * Math.PI) * 14];
    const [x0, y0] = at(Math.max(0, k - 0.15));
    const [x1, y1] = at(k);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  // Dust where something fell.
  puffs = puffs.filter((p) => now - p.t < 700);
  for (const p of puffs) {
    const k = (now - p.t) / 700;
    const [px, py] = tileToScreen(p.x, p.y);
    for (let i = 0; i < (p.big ? 7 : 3); i++) {
      const a = i * 2.4 + p.x;
      const r = (p.big ? 26 : 9) * k;
      ctx.fillStyle = `rgba(150,140,120,${0.55 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(px + Math.cos(a) * r * 1.4, py - 8 + Math.sin(a) * r * 0.6 - k * 10, (p.big ? 12 : 5) * (0.5 + k), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawFog();

  // The marker where units were sent is drawn over the fog, so it shows on unexplored ground too.
  if (marker) {
    const age = (now - marker.t) / 500;
    if (age > 1) marker = undefined;
    else {
      const [mx, my] = tileToScreen(marker.x, marker.y);
      ctx.strokeStyle = `rgba(255,255,255,${1 - age})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(mx, my, 6 + age * 14, 3 + age * 7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }


  if (drag && (Math.abs(mouse.x - drag.x) > 4 || Math.abs(mouse.y - drag.y) > 4)) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(drag.x + 0.5, drag.y + 0.5, mouse.x - drag.x, mouse.y - drag.y);
  }

  renderPanel();
  renderHud();
  renderIdle();
  renderMinimap();
}
document.documentElement.style.setProperty('--lock-icon', `url(${icon('lock')})`);
void loadSprites().then(() => {
  // Icons may come from the sprite pack, so draw them again once it is in.
  clearIcons();
  panelSignature = hudSignature = detailSignature = idleSignature = '';
});
requestAnimationFrame(frame);

// Handles for automated tests in development builds.
if (import.meta.env.DEV) {
  Object.assign(window, { __spawn: spawn, __game: { setZoom: (z: number) => setZoom(z), getZoom: () => zoom, getFog: () => ({ visible, explored }), views, players, props, queues, cam, selected, tileToScreen, getMap: () => map, getMe: () => me, getSession: () => session } });
}
