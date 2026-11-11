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
  MAX_TEAMS,
  Res,
  RELIC_ATTACK,
  RELIC_MAX,
  Stance,
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
import { clearBuildingCache, drawBuilding } from './buildings';
import { clearIcons, icon, setIconAge } from './icons';
import { installMenuArt } from './menu-art';
import { paintGround } from './ground';
import { Breeze } from './breeze';
import { installCursorLock } from './cursor-lock';
import { Detail, describeAction, describeKind, describeTech } from './describe';
import { effectsState, musicState, nextTrack, play, playFirstFile, setEffectsVolume, setMusicVolume, toggleMusic, toggleMute, unlockSound } from './sound';
import { drawProp, drawRelic, drawUnit, HH, HW, PLAYER_COLORS, setPlayerColors, TEAM_COLORS, TEAM_NAMES, unitHeight } from './sprites';

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
  /** The town bell has called the villagers in. */
  bell: boolean;
}

/** Relics: [x, y, carrying monk or -1, keeping monastery or -1, bit mask of the players who have seen it]. */
let relics: [number, number, number, number, number][] = [];

/** Relics kept by a player, as they count for the attack bonus. */
function relicsKept(owner: number): number {
  return Math.min(RELIC_MAX, relics.filter((r) => r[3] >= 0 && views.get(r[3])?.owner === owner).length);
}

/** The relic lying on the ground near a point on screen, if any. */
function relicAt(sx: number, sy: number): number {
  let best = -1;
  let bestD = 16;
  relics.forEach(([x, y, carrier, monastery], i) => {
    if (carrier >= 0 || monastery >= 0 || !map || !explored[Math.floor(y) * map.size + Math.floor(x)]) return;
    const [rx, ry] = tileToScreen(x, y);
    const d = Math.hypot(rx - sx, ry - 6 - sy);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
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
/** Monks at work: green sparkles for healing, rings for converting. */
let blessings: { from: number; to: number; kind: number; t: number }[] = [];
let shots: { from: [number, number]; to: [number, number]; t: number }[] = [];
let winner = -1;
/** Highest population anyone may reach in this game. */
let popLimit = 100;
/** Villagers that were given orders, most recent last, for copying a job with T. */
const orderedVillagers: number[] = [];
/** The building a villager was last told to put up, by villager id, while that is their latest order. */
const placedBy = new Map<number, Kind>();
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

/** While painting the menu background into a picture, drawing goes there and the view has the picture's size. */
let drawingTarget: CanvasRenderingContext2D | undefined;
let sceneSize: [number, number] | undefined;
/**
 * The view in world pixels, and the scale it is drawn at. Zoomed in, the canvas is smaller than the
 * window and stretched, which keeps the pixel art crisp; zoomed out, it stays the size of the window
 * and the drawing is scaled down instead, so no more pixels are filled than the screen shows.
 */
let worldW = window.innerWidth;
let worldH = window.innerHeight;
let drawScale = 1;
const viewW = () => sceneSize?.[0] ?? worldW;
const viewH = () => sceneSize?.[1] ?? worldH;

function worldToScreen(wx: number, wy: number): [number, number] {
  return [wx - cam.x + viewW() / 2, wy - cam.y + viewH() / 2];
}

function tileToScreen(tx: number, ty: number): [number, number] {
  return worldToScreen(...tileToWorld(tx, ty));
}

function screenToTile(sx: number, sy: number): [number, number] {
  const wx = sx + cam.x - viewW() / 2;
  const wy = sy + cam.y - viewH() / 2;
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
  if (!map || v.task === 0 || v.task > 6 || v.act !== 2 || isBuilding(v.kind)) return undefined;
  if (v.task <= 4) {
    const spot: [number, number] = [(v.target % map.size) + 0.5, Math.floor(v.target / map.size) + 0.5];
    // Only a unit standing right beside its resource leans in; one pausing elsewhere (say, at a drop-off) stays put.
    return Math.hypot(spot[0] - v.x, spot[1] - v.y) < 1.6 ? spot : undefined;
  }
  const b = views.get(v.target);
  if (!b) return undefined;
  const s = sizeOf(b.kind);
  const nx = Math.max(b.x, Math.min(b.x + s, v.x));
  const ny = Math.max(b.y, Math.min(b.y + s, v.y));
  if (Math.hypot(nx - v.x, ny - v.y) > (v.task === 5 ? 0.05 : 1.2)) return undefined;
  if (v.task === 5) {
    // Farmers stand on their field and move slowly up and down their furrow.
    const fx = Math.max(b.x + 0.3, Math.min(b.x + s - 0.3, v.x + Math.cos(now / 4000 + v.id) * 0.35));
    const fy = Math.max(b.y + 0.3, Math.min(b.y + s - 0.3, v.y + Math.sin(now / 3100 + v.id * 2) * 0.2));
    return [fx, fy];
  }
  return [nx, ny];
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
      staleChunk(c);
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
  const k = drawScale;
  ctx.setTransform(HW * k, HH * k, -HW * k, HH * k, (viewW() / 2 - cam.x) * k, (viewH() / 2 - cam.y) * k);
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

/**
 * Mist beyond the edge of the map: light clouds that begin right at the border, so the world ends
 * in soft weather instead of black while every tile of the map stays clear. Painted once per map
 * in tile units, a few pixels per tile, and stretched over the view like the fog.
 */
let edgeMist: HTMLCanvasElement | undefined;
const MIST_PAD = 14;
const MIST_RES = 4;
const MIST_COLOR = '#4a5a53';

function paintEdgeMist(n: number, seed: number): HTMLCanvasElement {
  const size = (n + MIST_PAD * 2) * MIST_RES;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  const noise = (x: number, y: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const h = (a: number, b: number) => hash(a + seed * 7, b - seed * 3);
    const a = h(ix, iy);
    const b = h(ix + 1, iy);
    const c2 = h(ix, iy + 1);
    const d = h(ix + 1, iy + 1);
    return a + (b - a) * sx + (c2 - a) * sy + (a - b - c2 + d) * sx * sy;
  };
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = px / MIST_RES - MIST_PAD;
      const v = py / MIST_RES - MIST_PAD;
      // How far inside the map this point is (negative outside it).
      const inside = Math.min(u, v, n - u, n - v);
      const cloud = noise(u / 5, v / 5) * 0.6 + noise(u / 2.2 + 40, v / 2.2) * 0.4;
      // The mist begins right at the border, with a short soft edge, and never reaches onto the map.
      const k = inside >= 0 ? 0 : Math.max(0, Math.min(1, (-inside + (cloud - 0.5) * 0.3) / 0.7));
      const alpha = k * k * (3 - 2 * k);
      // Lighter puffs of cloud, which settle into the plain mist colour at the outer rim.
      const puff = cloud * 30 * Math.max(0, 1 - Math.max(0, -inside) / MIST_PAD);
      const o = (py * size + px) * 4;
      img.data[o] = 74 + puff * 1.1;
      img.data[o + 1] = 90 + puff * 1.15;
      img.data[o + 2] = 83 + puff * 1.2;
      img.data[o + 3] = Math.round(alpha * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Draws the mist around the edge of the map, on the ground beyond the border. */
function drawEdgeMist(): void {
  if (!map || !edgeMist) return;
  const k = drawScale;
  ctx.save();
  ctx.setTransform(HW * k, HH * k, -HW * k, HH * k, (viewW() / 2 - cam.x) * k, (viewH() / 2 - cam.y) * k);
  ctx.imageSmoothingEnabled = true;
  // Only the band along each side has mist in it; the middle of the picture is clear, so it is skipped.
  const n = map.size + MIST_PAD * 2;
  const band = MIST_PAD + 2;
  const r = MIST_RES;
  for (const [u, v, w, h] of [[0, 0, n, band], [0, n - band, n, band], [0, band, band, n - band * 2], [n - band, band, band, n - band * 2]]) {
    ctx.drawImage(edgeMist, u * r, v * r, w * r, h * r, u - MIST_PAD, v - MIST_PAD, w, h);
  }
  ctx.restore();
}

/** Water tiles, with how far a wave may stray from the middle of each (less next to the shore). */
let waterTiles: { index: number; room: number }[] = [];

function buildTerrain(m: GameMap): void {
  edgeMist = paintEdgeMist(m.size, m.size * 31 + (m.starts[0]?.[0] ?? 0));
  waterTiles = [];
  const n = m.size;
  for (let i = 0; i < m.tiles.length; i++) {
    if (m.tiles[i] !== Tile.Water) continue;
    const x = i % n;
    const y = Math.floor(i / n);
    const open = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => {
      const tx = x + dx;
      const ty = y + dy;
      return tx < 0 || ty < 0 || tx >= n || ty >= n || m.tiles[ty * n + tx] === Tile.Water;
    });
    waterTiles.push({ index: i, room: open ? 1 : 0.45 });
  }
  chunks.clear();
  farSquares.clear();
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
  const corners = [screenToTile(0, 0), screenToTile(viewW(), 0), screenToTile(0, viewH()), screenToTile(viewW(), viewH())];
  return [
    Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))) - 1), Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))) - 1),
    Math.min(n - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))) + 1), Math.min(n - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))) + 1),
  ];
}

/** Tiles per side of a pre-drawn block of ground. */
const CHUNK = 8;
/** Pre-drawn blocks of ground, by block index; a block is dropped when something in it changes. */
interface Block {
  img: HTMLCanvasElement;
  used: number;
  /** Painted with full detail, or only flat colours while there was no time for more. */
  detailed: boolean;
  /** Something in it changed: it is painted again when there is time, and shown as it was until then. */
  stale: boolean;
}
const chunks = new Map<number, Block>();
/**
 * Zoomed out, the view is put together from square pictures of the world, ground and trees and
 * rocks in one, at a reduced scale: a few dozen opaque copies per frame instead of thousands of
 * small ones. Keyed by square; each covers FAR_SIZE × FAR_SIZE world pixels.
 */
const farSquares = new Map<number, Block & { scale: number }>();
const FAR_SIZE = 512;
/** World y where the squares start: trees on the top tiles stand above the map's top corner. */
const FAR_Y0 = -128;
/** Below this zoom the far squares are used. */
const FAR_ZOOM = 0.95;
/** Time each frame may spend painting blocks, in milliseconds; whatever is left waits for the next frame. */
const PAINT_BUDGET = 7;
let paintDeadline = 0;

function staleChunk(key: number): void {
  const a = chunks.get(key);
  if (a) a.stale = true;
  if (!map || farSquares.size === 0) return;
  // Every square the block's ground or the trees standing on it reach into.
  const blocks = Math.ceil(map.size / CHUNK);
  const [wx, wy] = tileToWorld((key % blocks) * CHUNK, Math.floor(key / blocks) * CHUNK);
  const [r0, c0] = farSquareAt(wx - CHUNK * HW - 48, wy - 110);
  const [r1, c1] = farSquareAt(wx + CHUNK * HW + 48, wy + CHUNK * HH * 2 + 24);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const b = farSquares.get(r * 1000 + c);
    if (b) b.stale = true;
  }
}

/** [row, column] of the far square holding a world point. */
function farSquareAt(wx: number, wy: number): [number, number] {
  return [Math.floor((wy - FAR_Y0) / FAR_SIZE), Math.floor((wx + map!.size * HW) / FAR_SIZE)];
}
let chunkSeen = new Int32Array(0);
let frameNo = 0;

function paintChunk(bx: number, by: number, detailed: boolean): HTMLCanvasElement {
  const n = map!.size;
  const img = document.createElement('canvas');
  img.width = CHUNK * HW * 2 + 2;
  img.height = CHUNK * HH * 2 + 2;
  const c = img.getContext('2d')!;
  const x0 = bx * CHUNK;
  const y0 = by * CHUNK;
  if (detailed) {
    const m = map!;
    paintGround(c, { size: n, tiles: m.tiles, seen: (i) => revealAll || explored[i] === 1 }, x0, y0, CHUNK, HW, HH);
    return img;
  }
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

/** The ground block, painted now if missing; with time to spare, a flat or outdated block is painted again in detail. */
function groundBlock(bx: number, by: number, key: number): Block {
  let chunk = chunks.get(key);
  const time = performance.now() < paintDeadline;
  // A missing block is needed now: without time for detail it gets flat colours first.
  if (!chunk || ((!chunk.detailed || chunk.stale) && time)) {
    chunk = { img: paintChunk(bx, by, time), used: 0, detailed: time, stale: false };
    chunks.set(key, chunk);
  }
  chunk.used = frameNo;
  return chunk;
}

/** A far square: the ground blocks and the trees and rocks reaching into it, back to front. Returns whether all ground had detail. */
function paintFarSquare(row: number, col: number, scale: number, img: HTMLCanvasElement): boolean {
  const n = map!.size;
  const blocks = Math.ceil(n / CHUNK);
  const left = col * FAR_SIZE - n * HW;
  const top = row * FAR_SIZE + FAR_Y0;
  img.width = img.height = Math.ceil(FAR_SIZE * scale);
  const c = img.getContext('2d')!;
  c.setTransform(scale, 0, 0, scale, -left * scale, -top * scale);
  c.imageSmoothingEnabled = true;
  // Off the map is mist, the same as around the near view.
  c.fillStyle = MIST_COLOR;
  c.fillRect(left, top, FAR_SIZE, FAR_SIZE);
  let detailed = true;
  for (let by = 0; by < blocks; by++) {
    for (let bx = 0; bx < blocks; bx++) {
      const [wx, wy] = tileToWorld(bx * CHUNK, by * CHUNK);
      const bl = wx - CHUNK * HW - 1;
      if (bl > left + FAR_SIZE || bl + CHUNK * HW * 2 + 2 < left || wy - 1 > top + FAR_SIZE || wy + CHUNK * HH * 2 + 1 < top) continue;
      const block = groundBlock(bx, by, by * blocks + bx);
      detailed &&= block.detailed;
      c.drawImage(block.img, bl, wy - 1);
    }
  }
  const standing: [number, number, number][] = [];
  for (const [index, tile] of props) {
    if (!revealAll && !explored[index]) continue;
    const tx = index % n;
    const ty = Math.floor(index / n);
    const [wx, wy] = tileToWorld(tx + 0.5, ty + 0.5);
    if (wx + 48 < left || wx - 48 > left + FAR_SIZE || wy + 24 < top || wy - 110 > top + FAR_SIZE) continue;
    standing.push([tx + ty, index, tile]);
  }
  standing.sort((a, b) => a[0] - b[0]);
  for (const [, index, tile] of standing) {
    const tx = index % n;
    const ty = Math.floor(index / n);
    const [wx, wy] = tileToWorld(tx + 0.5, ty + 0.5);
    drawProp(c, tile, wx, wy, Math.floor(hash(tx, ty) * 6));
  }
  return detailed;
}

/** Zoomed out far enough that trees and rocks are part of the ground blocks. */
const farView = () => !drawingTarget && zoom < FAR_ZOOM;

/** Gusts of wind with flying leaves now and then. */
const breeze = new Breeze();

/** Crowns of the trees on screen that are in sight, in world pixels; a sample when there are very many. */
function treesOnScreen(): [number, number][] {
  if (!map) return [];
  const out: [number, number][] = [];
  const n = map.size;
  const left = cam.x - viewW() / 2 - 40;
  const right = cam.x + viewW() / 2 + 40;
  const top = cam.y - viewH() / 2;
  const bottom = cam.y + viewH() / 2 + 60;
  for (const [index, tile] of props) {
    if (tile !== Tile.Forest || !visible[index]) continue;
    const [wx, wy] = tileToWorld((index % n) + 0.5, Math.floor(index / n) + 0.5);
    if (wx < left || wx > right || wy < top || wy > bottom) continue;
    out.push([wx, wy - 52]);
  }
  // Plenty for a gust; more would only cost time, so a spread-out sample is kept.
  if (out.length <= 260) return out;
  const step = out.length / 260;
  return Array.from({ length: 260 }, (_, i) => out[Math.floor(i * step + Math.random() * step)]);
}

/** The zoomed-out view from far squares; squares not painted yet are filled in over the next frames. */
function drawFar(scale: number, target: CanvasRenderingContext2D): void {
  const [r0, c0] = farSquareAt(cam.x - viewW() / 2, cam.y - viewH() / 2);
  const [r1, c1] = farSquareAt(cam.x + viewW() / 2, cam.y + viewH() / 2);
  const toScreen = (wx: number, wy: number) => worldToScreen(wx, wy);
  const n = map!.size;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const key = r * 1000 + c;
      let square = farSquares.get(key);
      const time = performance.now() < paintDeadline;
      if (!square || square.scale !== scale || ((square.stale || !square.detailed) && time)) {
        if (time || !square) {
          const img = square?.img ?? document.createElement('canvas');
          const detailed = paintFarSquare(r, c, scale, img);
          square = { img, used: 0, detailed, stale: false, scale };
          farSquares.set(key, square);
        }
      }
      square.used = frameNo;
      const [sx, sy] = toScreen(c * FAR_SIZE - n * HW, r * FAR_SIZE + FAR_Y0);
      // A hair larger, so that no seams show between squares.
      target.drawImage(square.img, Math.floor(sx), Math.floor(sy), FAR_SIZE + 1, FAR_SIZE + 1);
    }
  }
}

/**
 * Little wave crests on the water: each rises and sinks, drifting slowly to and fro, so the water
 * moves gently all the time. Only water on screen that has been seen is looked at.
 */
function drawWaves(now: number): void {
  if (!map || waterTiles.length === 0) return;
  const n = map.size;
  const w = viewW();
  const h = viewH();
  const pick: [number, number, number][] = [];
  for (const { index, room } of waterTiles) {
    if (!revealAll && !explored[index]) continue;
    const tx = index % n;
    const ty = Math.floor(index / n);
    const [sx, sy] = tileToScreen(tx + 0.5, ty + 0.5);
    if (sx < -40 || sy < -20 || sx > w + 40 || sy > h + 20) continue;
    pick.push([sx, sy, index * 2 + room]);
  }
  // A lot of water in view (zoomed out): fewer crests per tile.
  const crests = pick.length > 1500 ? 1 : pick.length > 700 ? 2 : 3;
  for (const [sx, sy, key] of pick) {
    const index = Math.floor(key / 2);
    const room = key - index * 2;
    const tx = index % n;
    const ty = Math.floor(index / n);
    for (let k = 0; k < crests; k++) {
      const a = hash(tx * 3 + k, ty * 7 + 1);
      const b = hash(ty * 5 + k, tx * 11 + 2);
      const rise = Math.sin(now / 1500 + a * 40);
      if (rise <= 0.05) continue;
      const x = Math.round(sx + (a - 0.5) * 34 * room + Math.sin(now / 2100 + b * 9) * 5 * room);
      const y = Math.round(sy + (b - 0.5) * 14 * room);
      const len = 3 + Math.floor(b * 3);
      // A crest: a lit hump with a darker trough under it, like a small wave.
      ctx.fillStyle = `rgba(205,232,250,${(rise * 0.62).toFixed(3)})`;
      ctx.fillRect(x - len - 1, y, 2, 1);
      ctx.fillRect(x - len + 1, y - 1, len * 2 - 2, 1);
      ctx.fillRect(x + len - 1, y, 2, 1);
      ctx.fillStyle = `rgba(20,55,100,${(rise * 0.3).toFixed(3)})`;
      ctx.fillRect(x - len + 1, y + 1, len * 2 - 2, 1);
    }
  }
}

/** Draws the ground from pre-drawn blocks, only those that can be on screen. */
function drawGround(): void {
  const n = map!.size;
  const blocks = Math.ceil(n / CHUNK);
  const [x0, y0, x1, y1] = visibleTiles();
  frameNo++;
  // The menu background is painted once, so it gets all the time it needs.
  paintDeadline = drawingTarget ? Infinity : performance.now() + PAINT_BUDGET;
  const far = farView();
  // Squares are kept at a few scales; each is drawn at most a little larger or smaller than it was painted.
  const scale = zoom <= 0.68 ? 0.6 : zoom <= 0.8 ? 0.72 : 0.88;
  const target = drawingTarget ?? ctx;
  if (far) {
    drawFar(scale, target);
  } else {
    for (let by = Math.floor(y0 / CHUNK); by <= Math.floor(y1 / CHUNK); by++) {
      for (let bx = Math.floor(x0 / CHUNK); bx <= Math.floor(x1 / CHUNK); bx++) {
        if (bx < 0 || by < 0 || bx >= blocks || by >= blocks) continue;
        const [sx, sy] = tileToScreen(bx * CHUNK, by * CHUNK);
        const left = Math.round(sx) - CHUNK * HW - 1;
        const top = Math.round(sy) - 1;
        if (left > viewW() || top > viewH() || left + CHUNK * HW * 2 < 0 || top + CHUNK * HH * 2 < 0) continue;
        target.drawImage(groundBlock(bx, by, by * blocks + bx).img, left, top);
      }
    }
  }
  // Keep memory in check: forget the blocks that have not been on screen for the longest.
  for (const [store, most] of [[chunks, 320], [farSquares, 160]] as const) {
    if (store.size <= most) continue;
    const old = [...store].sort((a, b) => a[1].used - b[1].used).slice(0, store.size - most * 0.75);
    for (const [key] of old) store.delete(key);
  }
}

function setTile(index: number, tile: number): void {
  if (!map) return;
  map.tiles[index] = tile;
  paintTile(map, index);
  const blocks = Math.ceil(map.size / CHUNK);
  staleChunk(Math.floor(Math.floor(index / map.size) / CHUNK) * blocks + Math.floor((index % map.size) / CHUNK));
}

function setBlocked(v: View, value: number): void {
  if (!map || !isBuilding(v.kind)) return;
  markBuilding(map, v.x, v.y, sizeOf(v.kind), DEFS[v.kind].walkable === true, value);
}

// --- network ---------------------------------------------------------------

function send(cmd: Command): void {
  const msg: ClientMessage = { t: 'cmd', cmd };
  session?.send(msg);
  // Remember which villager got an order, so that T can give another one the same job.
  if ('ids' in cmd && cmd.type !== 'copy') {
    const v = cmd.ids.map((id) => views.get(id)).find((u) => u?.kind === 'villager');
    if (v) {
      if (cmd.type === 'place') placedBy.set(v.id, cmd.kind);
      else placedBy.delete(v.id);
      const at = orderedVillagers.indexOf(v.id);
      if (at >= 0) orderedVillagers.splice(at, 1);
      orderedVillagers.push(v.id);
      if (orderedVillagers.length > 8) orderedVillagers.shift();
    }
  }
}

/** T: the selected villagers take on the job of the villager that was given an order last. */
function copyLastJob(): void {
  const ids = ownSelectedUnits().filter((v) => v.kind === 'villager').map((v) => v.id);
  if (ids.length === 0) return;
  // T on the villager that just placed a building: place the next one of the same.
  const own = ids.find((id) => placedBy.has(id));
  const from = own ?? [...orderedVillagers].reverse().find((id) => !ids.includes(id) && views.get(id)?.owner === me);
  if (from === undefined) return;
  // The last villager was sent to put up a new building: the next one gets to place one of those too.
  const kind = placedBy.get(from);
  if (kind) {
    const full = !!DEFS[kind].housing && housingNow() >= popLimit;
    if (!ageAllows(kind) || !canAfford(DEFS[kind].cost) || full) return void play('error', 250);
    placing = kind;
    play('order.copy');
    return;
  }
  send({ type: 'copy', ids, from });
  play('order.copy');
}

function renderPlayers(): void {
  const el = $('players');
  el.textContent = '';
  for (const p of roster) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.setProperty('--gem', `var(--gem-${p.team})`);
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
    play('start');
    me = myOwnSlot = msg.you;
    map = generateMap(msg.seed, msg.size);
    popLimit = msg.popLimit;
    buildTerrain(map);
    roster = msg.players;
    // Every player plays in their team's colour.
    setPlayerColors(new Map(roster.map((p) => [p.slot, p.team])));
    clearBuildingCache();
    clearIcons();
    $('room-code').textContent = msg.room;
    renderPlayers();
    $('lobby').style.display = 'none';
    $('waiting').style.display = 'none';
    $('top').hidden = false;
    // In a game the music controls sit in the top bar, next to the menu.
    $('top').insertBefore($('music'), $('menu-btn'));
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
        if (v.owner === me && isBuilding(v.kind) && v.extra < 100 && extra >= 100) play(`built.${v.kind}`, 400);
        // A monk may have converted it, so the owner can change too.
        Object.assign(v, { owner, x, y, hp, act, extra, task, target });
      } else {
        const created: View = { id, owner, kind: KINDS[kindIdx], hp, act, extra, task, target, ox: 0, oy: 0, struck: 0, hurt: 0, face: 1, px: x, py: y, x, y };
        views.set(id, created);
        setBlocked(created, 1);
        if (owner === me && !isBuilding(created.kind) && msg.tick > 20) play(`trained.${created.kind}`, 300);
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
    for (const [from, to, kind] of msg.blessings) {
      const a = views.get(from);
      const b = views.get(to);
      if (a && b && (canSee(a) || canSee(b))) {
        blessings.push({ from, to, kind, t: now });
        // Healing and converting go on for a while: the sound comes now and then, not with every pulse.
        if (kind === 1) play('heal', 1500);
        else play('convert', 2500);
      }
    }
    for (const [kindIdx, x, y, owner] of msg.deaths) {
      const kind = KINDS[kindIdx];
      const half = isBuilding(kind) ? sizeOf(kind) / 2 : 0;
      const seen = revealAll || tileSeen(Math.floor(x + half), Math.floor(y + half));
      if (seen) puffs.push({ x: x + half, y: y + half, t: now, big: isBuilding(kind) });
      // Losses of your own are always heard, wherever you are looking.
      if (seen || owner === me) play(isBuilding(kind) ? `collapse.${kind}` : `death.${kind}`, 150);
    }
    rallies.clear();
    for (const [id, x, y] of msg.rallies) rallies.set(id, [x, y]);
    queues.clear();
    for (const [id, ...rest] of msg.queues) queues.set(id, rest);
    let defeatChanged = false;
    gameTick = msg.tick;
    // Everyone hears when a player first sets eyes on the relic, when a monk picks it up, and when it is brought home.
    msg.relics.forEach(([, , carrier, monastery, foundBy], i) => {
      const before = relics[i];
      if (!before) return;
      const fresh = foundBy & ~before[4];
      for (const p of roster) {
        if (!((fresh >> p.slot) & 1)) continue;
        showNotice(p.slot, 'found the relic!');
        play('relic', 500);
      }
      if (carrier >= 0 && before[2] < 0) {
        const monk = views.get(carrier);
        if (monk) {
          showNotice(monk.owner, 'picked up the relic.');
          play('relic', 500);
        }
      }
      if (monastery >= 0 && before[3] < 0) {
        const home = views.get(monastery);
        if (home) {
          showNotice(home.owner, `brought the relic to their monastery (+${RELIC_ATTACK} attack).`);
          play('relic', 500);
        }
      }
    });
    relics = msg.relics;
    for (const [slot, food, wood, gold, stone, pop, cap, defeated, age, techs, researching, w0, w1, w2, w3, bell] of msg.players) {
      const old = players.get(slot);
      if (old?.defeated !== (defeated === 1)) defeatChanged = true;
      // Everyone hears when another player reaches a new age.
      if (old && age > old.age) {
        showNotice(slot, `has reached the ${AGE_NAMES[age] ?? 'next age'}.`);
        // Your own new age has its fanfare below; someone else's is heard too.
        if (slot !== me) play(`age.${age}`);
      }
      if (old && age > old.age) {
        // A new age: the player's buildings change to its style, each in a puff of dust.
        for (const b of views.values()) {
          if (b.owner !== slot || !isBuilding(b.kind) || !canSee(b)) continue;
          const half = sizeOf(b.kind) / 2;
          puffs.push({ x: b.x + half, y: b.y + half, t: now, big: true });
        }
        if (slot === me) setIconAge(age);
      }
      if (slot === me && !old) setIconAge(age);
      if (slot === me && old) {
        if (age > old.age) play(`age.${age}`);
        else if (techs !== old.techs) {
          // The upgrade just finished: the lowest bit that is new.
          const fresh = techs & ~old.techs;
          const id = TECH_IDS.find((_, i) => (fresh >> i) & 1);
          play(id ? `research.${id}` : 'research');
        }
        if (defeated === 1 && !old.defeated) play('defeat');
      }
      players.set(slot, {
        res: { food, wood, gold, stone }, pop, cap, defeated: defeated === 1, age, techs, researching,
        workers: { food: w0, wood: w1, gold: w2, stone: w3 }, bell: bell === 1,
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
  } else if (msg.t === 'pause') {
    showPause(msg);
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
  play('chat', 0);
}

/** The pause dialog: a request to answer, or a paused game waiting for everyone to continue. */
let pauseState: Extract<ServerMessage, { t: 'pause' }> | undefined;
function showPause(msg: Extract<ServerMessage, { t: 'pause' }>): void {
  const was = pauseState?.phase ?? 'off';
  pauseState = msg;
  const name = (slot: number) => roster.find((p) => p.slot === slot)?.name ?? 'Someone';
  const names = (slots: number[]) => slots.map(name).join(', ');
  const mine = msg.waiting.includes(myOwnSlot);
  document.body.classList.toggle('paused', msg.phase === 'paused');
  $('pause-btn').toggleAttribute('disabled', msg.phase !== 'off');
  if (msg.phase === 'off') {
    $('pause').hidden = true;
    if (msg.declinedBy >= 0) showNotice(msg.declinedBy, 'declined the pause.');
    else if (was === 'paused') showNotice(-1, 'The game continues.');
    return;
  }
  if (was !== msg.phase) play('chat', 0);
  if (msg.phase === 'paused' && was !== 'paused') showNotice(msg.by, 'paused the game.');
  $('pause').hidden = false;
  const asking = msg.phase === 'asking';
  $('pause-title').textContent = asking ? 'Pause?' : 'Game paused';
  $('pause-text').textContent = asking
    ? msg.by === myOwnSlot
      ? `Waiting for ${names(msg.waiting)} to accept the pause…`
      : mine
        ? `${name(msg.by)} would like to pause the game.`
        : `Waiting for ${names(msg.waiting)}…`
    : mine
      ? 'Press continue when you are ready to play on.'
      : `Waiting for ${names(msg.waiting)} to continue…`;
  $('pause-yes').textContent = asking ? 'Accept' : 'Continue';
  $('pause-yes').hidden = !mine;
  $('pause-no').hidden = !(mine && asking);
}

/** A line in the chat from the game itself, such as another player reaching a new age. */
function showNotice(from: number, text: string): void {
  const line = document.createElement('div');
  line.className = 'notice';
  const who = document.createElement('b');
  who.textContent = roster.find((p) => p.slot === from)?.name ?? 'Someone';
  who.style.color = PLAYER_COLORS[from] ?? '';
  if (from < 0) line.append(text);
  else line.append(who, ` ${text}`);
  $('chat-log').append(line);
  setTimeout(() => line.remove(), 12000);
}

/** Tells the player when something of theirs is attacked where they are not looking. */
function underAttack(v: View, now: number): void {
  if (alert && now - alert.t < 7000) return;
  const [cx, cy] = centreOf(v);
  const [sx, sy] = tileToScreen(cx, cy);
  if (sx > 0 && sy > 40 && sx < viewW() && sy < viewH() - 230 / zoom) return;
  alert = { x: cx, y: cy, t: now };
  play('alarm');
  const toast = $('toast');
  toast.textContent = `Your ${DEFS[v.kind].label.toLowerCase()} is under attack! (Space to look)`;
  toast.hidden = false;
  setTimeout(() => (toast.hidden = true), 4000);
}

/** Clears everything that belongs to a running game. */
function resetGame(): void {
  setIconAge(1);
  pauseState = undefined;
  $('pause').hidden = true;
  document.body.classList.remove('paused');
  $('pause-btn').removeAttribute('disabled');
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
  document.body.append($('music'));
  $('bottom').hidden = true;
  $('banner').hidden = true;
  $('end').hidden = true;
  endShown = false;
  relics = [];
}

function showLobby(message: string): void {
  if (document.pointerLockElement) document.exitPointerLock();
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
    chip.className = 'gem';
    chip.style.setProperty('--gem', `var(--gem-${p.team})`);
    const tags = [
      p.slot === you ? 'you' : '', p.slot === host ? 'host' : '', p.test ? 'played by the host' : '', p.ai ? 'computer' : '',
    ].filter(Boolean);
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = p.name + (tags.length ? ` (${tags.join(', ')})` : '');
    // Everyone picks their own team colour, and the host can set anyone's; same team means allies.
    const team = document.createElement('select');
    for (let t = 0; t < MAX_TEAMS; t++) {
      const option = new Option(`● Team ${t + 1} · ${TEAM_NAMES[t]}`, String(t));
      option.style.color = TEAM_COLORS[t];
      option.style.fontWeight = '700';
      team.add(option);
    }
    team.value = String(p.team);
    team.className = 'team';
    team.style.setProperty('--gem', `var(--gem-${p.team})`);
    team.disabled = !hosting && p.slot !== you;
    team.title = team.disabled ? 'Team (each player picks their own)' : 'Pick your team colour; players with the same one are allies';
    team.style.color = TEAM_COLORS[p.team];
    team.addEventListener('change', () => {
      team.style.setProperty('--gem', `var(--gem-${team.value})`);
      team.style.color = TEAM_COLORS[Number(team.value)];
      chip.style.setProperty('--gem', `var(--gem-${team.value})`);
      if (session?.host) session.host.setTeam(p.slot, Number(team.value));
      else session?.send({ t: 'team', team: Number(team.value) });
    });
    li.append(chip, name);
    // Remove sits before the team dropdown, so that every row's dropdown lines up on the right.
    if ((p.test || p.ai) && hosting) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => session?.host?.removeExtra(p.slot));
      li.append(remove);
    }
    li.append(team);
    list.append(li);
  }
  $('room-host').hidden = !hosting;
  $('room-wait').hidden = hosting;
  $<HTMLButtonElement>('add-ai-btn').disabled = roster.length >= 4;
  const quickBox = $<HTMLInputElement>('quick-box');
  quickBox.checked = settings.quick;
  quickBox.disabled = !hosting;
  const sizeBox = $<HTMLSelectElement>('size-select');
  sizeBox.value = settings.mapSize;
  sizeBox.disabled = !hosting;
  const popBox = $<HTMLSelectElement>('pop-select');
  popBox.value = String(settings.popLimit);
  popBox.disabled = !hosting;
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
$('add-ai-btn').addEventListener('click', () => session?.host?.addComputer());
$('pop-select').addEventListener('change', (ev) => session?.host?.setPopLimit(Number((ev.target as HTMLSelectElement).value)));
$('size-select').addEventListener('change', (ev) => session?.host?.setMapSize((ev.target as HTMLSelectElement).value));
$('quick-box').addEventListener('change', (ev) => session?.host?.setQuickStart((ev.target as HTMLInputElement).checked));
$('leave-btn').addEventListener('click', () => session?.close());
$('switch-btn').addEventListener('click', () => switchTeam());
$('rematch-btn').addEventListener('click', () => {
  // The same players and settings on a new map, at once.
  session?.host?.backToLobby();
  session?.host?.start();
});
$('newgame-btn').addEventListener('click', () => session?.host?.backToLobby());
$('exit-btn').addEventListener('click', () => session?.close());
$('end-look').addEventListener('click', () => ($('end').hidden = true));
$('end-btn').addEventListener('click', () => {
  if (confirm('End this game for everyone and go back to the lobby?')) session?.host?.backToLobby();
});
$('room-link').addEventListener('click', (ev) => (ev.target as HTMLInputElement).select());
$('copy-link-btn').addEventListener('click', async () => {
  const box = $<HTMLInputElement>('room-link');
  const button = $('copy-link-btn');
  try {
    await navigator.clipboard.writeText(box.value);
  } catch {
    // Older browsers, or a page without clipboard permission: copy the selected text instead.
    box.select();
    document.execCommand('copy');
  }
  button.textContent = 'Copied!';
  setTimeout(() => (button.textContent = 'Copy'), 1500);
});

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
    // The whole figure counts, from the feet up to the head, even where a building is drawn over it.
    const [x, y] = unitScreen(v);
    const dx = Math.abs(x - sx);
    const dy = sy - y;
    if (dx > 13 || dy > 6 || dy < -34) continue;
    const d = Math.hypot(dx, (dy + 14) / 2);
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

const MOUNTED = new Set<Kind>(['rider', 'scout']);

/**
 * The sound for sending these units somewhere: foot soldiers, horsemen, or a mixed army each have
 * their own; villagers alone use the general order sound.
 */
function moveSound(units: View[]): `order.move${string}` {
  const troops = units.filter((v) => v.kind !== 'villager');
  if (troops.length === 0) return 'order.move';
  const horses = troops.filter((v) => MOUNTED.has(v.kind)).length;
  const foot = troops.filter((v) => !MOUNTED.has(v.kind) && v.kind !== 'ram').length;
  if (troops.length === units.length && horses === troops.length) return 'order.move.horse';
  if (troops.length === units.length && foot === troops.length) return 'order.move.soldier';
  return 'order.move.army';
}

/** The resource on a tile, for naming gather sounds. */
const PROP_NAME: Partial<Record<number, string>> = { [Tile.Forest]: 'wood', [Tile.Berries]: 'berries', [Tile.Gold]: 'gold', [Tile.Stone]: 'stone' };

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
  // Monks sent to a relic pick it up; the others just go there.
  const relic = relicAt(sx, sy);
  const monks = units.filter((v) => v.kind === 'monk');
  if (relic >= 0 && monks.length > 0 && !attackMove) {
    send({ type: 'fetch', ids: monks.map((v) => v.id), relic });
    const rest = units.filter((v) => v.kind !== 'monk');
    if (rest.length) send({ type: 'move', ids: rest.map((v) => v.id), x: relics[relic][0], y: relics[relic][1] });
    marker = { x: relics[relic][0], y: relics[relic][1], t: performance.now() };
    play('order');
    return;
  }
  marker = { x: tx, y: ty, t: performance.now() };
  if (attackMove) {
    send({ type: 'amove', ids, x: tx, y: ty });
    play('order.attack');
    return;
  }
  const target = unitAt(sx, sy) ?? buildingAt(sx, sy);
  if (target && (target.owner !== me || isBuilding(target.kind))) {
    send({ type: 'interact', ids, target: target.id });
    marker = undefined;
    if (isEnemy(target.owner)) attackFlash = { id: target.id, t: performance.now() };
    // What the order means: attack, help build, farm, or go inside.
    const action = isEnemy(target.owner) ? 'attack' : target.extra < 100 && isBuilding(target.kind) ? 'build' : target.kind === 'farm' ? 'farm' : 'enter';
    play(`order.${action}`);
    return;
  }
  const tile = resourceTileAt(sx, sy);
  play(tile >= 0 && map ? `order.gather.${PROP_NAME[map.tiles[tile]] ?? 'wood'}` : moveSound(units));
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
  if (!canPlace(map, placing, x, y) || !canAfford(DEFS[placing].cost)) return void play('error', 250);
  // With Shift the site goes on the villagers' list instead of replacing what they are building.
  send({ type: 'place', ids, kind: placing, x, y, queue: keep });
  play(`order.place.${placing}`);
  if (!keep) placing = undefined;
}

/** Places the wall line that was dragged out. */
function finishWall(keep: boolean): void {
  if (!wallStart || !map) return;
  const ids = ownSelectedUnits().filter((v) => v.kind === 'villager').map((v) => v.id);
  // The pieces of a wall go onto the builders' list one after the other.
  let first = !keep;
  for (const [x, y] of lineTiles(wallStart, placementSpot())) {
    if (!canPlace(map, 'wall', x, y)) continue;
    send({ type: 'place', ids, kind: 'wall', x, y, queue: !first });
    first = false;
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
  // Clicking your own building plays its sound: its own select sound if there is one, else the one for finishing it.
  if (v.owner === me) playFirstFile(isBuilding(v.kind) ? [`select.${v.kind}`, `built.${v.kind}`, 'select', 'built'] : [`select.${v.kind}`, 'select']);
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
    if (x >= 0 && y >= 0 && x <= viewW() && y <= viewH()) selected.add(v.id);
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
  if (key === 'm') switchEffects();
  if (key === 'x') send({ type: 'stop', ids: ownSelectedUnits().map((v) => v.id) });
  if (key === 't') copyLastJob();
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
const allSoldiers = () => [...views.values()].filter((v) => v.owner === me && !isBuilding(v.kind) && v.kind !== 'villager' && v.kind !== 'king');

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

/** Selects the whole army, busy or not (everyone but villagers and the king). */
function selectIdleSoldiers(): void {
  const idle = allSoldiers();
  if (idle.length === 0) return;
  selected.clear();
  selectedTile = -1;
  for (const v of idle) selected.add(v.id);
}

$('idle-vil-btn').addEventListener('click', nextIdleVillager);
$('idle-vil-btn').addEventListener('dblclick', () => {
  const idle = idleVillagers();
  if (idle.length === 0) return;
  selected.clear();
  selectedTile = -1;
  for (const v of idle) selected.add(v.id);
});
$('idle-mil-btn').addEventListener('click', selectIdleSoldiers);

let idleSignature = '';
function renderIdle(): void {
  const vil = idleVillagers().length;
  const mil = allSoldiers().length;
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
// Interface buttons click when pressed; the action buttons in the bottom bar have their own sounds.
document.addEventListener('click', (ev) => {
  const button = (ev.target as HTMLElement).closest?.('button');
  if (button && !button.closest('#actions')) play('click', 60);
});
// Music and sound effects: each has a button to switch it on and off and a slider for how loud it is.
function showAudio(): void {
  const music = musicState();
  const effects = effectsState();
  $('music-grp').classList.toggle('off', music.muted);
  $<HTMLInputElement>('music-vol').value = String(Math.round(music.volume * 100));
  $('music-btn').title = music.muted ? 'Music off: click to play' : 'Music on: click to mute';
  $('sfx-grp').classList.toggle('off', effects.muted);
  $<HTMLInputElement>('sfx-vol').value = String(Math.round(effects.volume * 100));
  $('sfx-btn').title = effects.muted ? 'Sounds off: click to turn on (M)' : 'Sounds on: click to mute (M)';
  $('mute-btn').textContent = effects.muted ? 'Sound off (M)' : 'Sound on (M)';
}
function switchEffects(): void {
  toggleMute();
  showAudio();
}
$('music-btn').addEventListener('click', () => {
  toggleMusic();
  showAudio();
});
$('music-vol').addEventListener('input', () => {
  const v = Number($<HTMLInputElement>('music-vol').value) / 100;
  setMusicVolume(v);
  // Turning the volume up switches muted music back on.
  if (musicState().muted && v > 0) toggleMusic();
  showAudio();
});
$('skip-btn').addEventListener('click', () => {
  nextTrack();
  showAudio();
});
$('sfx-btn').addEventListener('click', switchEffects);
$('sfx-vol').addEventListener('input', () => {
  const v = Number($<HTMLInputElement>('sfx-vol').value) / 100;
  setEffectsVolume(v);
  if (effectsState().muted && v > 0) toggleMute();
  showAudio();
});
// A sample, so the new loudness can be heard when the slider is let go.
$('sfx-vol').addEventListener('change', () => play('order', 0));
showAudio();
// In fullscreen the pointer is kept on this screen while playing, so edge scrolling cannot lose it to another monitor.
installCursorLock(canvas, () => !$('bottom').hidden);
$('pause-btn').addEventListener('click', () => {
  $('menu').hidden = true;
  session?.send({ t: 'pause', answer: 'request' });
});
$('pause-yes').addEventListener('click', () => session?.send({ t: 'pause', answer: 'yes' }));
$('pause-no').addEventListener('click', () => session?.send({ t: 'pause', answer: 'no' }));
$('resign-btn').addEventListener('click', () => {
  $('menu').hidden = true;
  if (confirm('Give up? Your king dies and you are out of the game.')) send({ type: 'resign' });
});
// The chat box: Enter sends, Esc closes. Keys typed here never reach the game.
$('chat-input').addEventListener('keydown', (ev) => {
  const box = ev.target as HTMLInputElement;
  if (ev.key === 'Enter' && box.value.trim()) session?.send({ t: 'chat', text: box.value });
  if (ev.key === 'Enter' || ev.key === 'Escape') {
    box.value = '';
    box.hidden = true;
    box.blur();
  }
  ev.stopPropagation();
});
$('menu-btn').addEventListener('click', () => ($('menu').hidden = !$('menu').hidden));
for (const img of document.querySelectorAll<HTMLImageElement>('.card .emblem')) img.src = icon('crown');
installMenuArt();

// Browsers only allow sound after the player has clicked or pressed a key.
window.addEventListener('pointerdown', unlockSound);
window.addEventListener('keydown', unlockSound);
$('mute-btn').addEventListener('click', switchEffects);
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
  if (button.classList.contains('locked')) return void play('error', 250);
  // Not enough resources: nothing is queued or placed.
  if (button.classList.contains('poor') && (button.dataset.train || button.dataset.build)) return void play('error', 250);
  if (!button.dataset.train) play('click', 60);
  const { build, train, cancel, eject, sell, buy, stance, bell } = button.dataset;
  if (bell) {
    send({ type: 'bell' });
    play('bell', 300);
  }
  if (stance) send({ type: 'stance', ids: ownSelectedUnits().map((v) => v.id), stance: stance as Stance });
  if (sell) send({ type: 'trade', building: Number(button.dataset.at), res: sell as Res, buy: false });
  if (buy) send({ type: 'trade', building: Number(button.dataset.at), res: buy as Res, buy: true });
  if (eject) send({ type: 'eject', building: Number(eject) });
  if (build) placing = build as Kind;
  if (train) {
    send({ type: 'train', building: Number(button.dataset.at), kind: train });
    // Queuing a unit or an upgrade sounds like giving an order.
    play(`order.train.${train}`, 120);
  }
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
    if (ids.length > 0) {
      const attack = ev.ctrlKey || ev.metaKey;
      send(attack ? { type: 'amove', ids, x: tx, y: ty } : { type: 'move', ids, x: tx, y: ty });
      play(attack ? 'order.attack' : moveSound(ownSelectedUnits()));
    }
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
  worldW = Math.ceil(window.innerWidth / zoom);
  worldH = Math.ceil(window.innerHeight / zoom);
  drawScale = Math.min(1, zoom);
  canvas.width = Math.ceil(worldW * drawScale);
  canvas.height = Math.ceil(worldH * drawScale);
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
  /** Shown pressed in: the setting that is in effect. */
  active?: boolean;
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

/** Room for people that the player's buildings give, counting those still going up. */
function housingNow(): number {
  let n = 0;
  for (const v of views.values()) if (v.owner === me && isBuilding(v.kind)) n += DEFS[v.kind].housing ?? 0;
  return n;
}

const GATHER_WORDS: Record<number, [string, string]> = {
  1: ['chop wood', 'Chopping wood'], 2: ['pick berries', 'Picking berries'], 3: ['mine gold', 'Mining gold'],
  4: ['mine stone', 'Mining stone'], 5: ['farm', 'Farming'],
};

/** What a unit is doing, in a few words, for its name in the selection card. */
function statusOf(v: View): string {
  const other = views.get(v.target);
  const name = other ? DEFS[other.kind].label : '';
  const queued = Math.floor(v.extra / 1000);
  const more = queued > 0 ? `, ${queued} more to build` : '';
  switch (v.task) {
    case 1: case 2: case 3: case 4: case 5:
      return v.act === 2 ? GATHER_WORDS[v.task][1] : `Going to ${GATHER_WORDS[v.task][0]}`;
    case 6:
      if (!other) return 'Building';
      return `${other.extra < 100 ? 'Building' : 'Repairing'} ${name}${more}`;
    case 7: return other ? `Attacking ${name}` : 'Fighting';
    case 8: return `Taking ${RESOURCES[v.target] ?? 'goods'} home`;
    case 9: return other ? `Going into the ${name}` : 'Going inside';
    case 10: return 'Walking';
    case 11: return other ? `Healing ${name}` : 'Healing';
    case 12: return other ? `Converting ${name}` : 'Converting';
    case 13: return 'Going for the relic';
    case 14: return 'Carrying the relic to the monastery';
    case 15: return 'Following the attack to heal';
    default: return relics.some((r) => r[2] === v.id) ? 'Carrying the relic' : 'Idle';
  }
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
    card.name = isBuilding(v.kind) ? def.label : `${def.label} (${statusOf(v)})`;
    card.portrait = icon(v.kind, v.owner);
    card.sub = v.owner === me ? (roster.find((p) => p.slot === me)?.name ?? '') : `${roster.find((p) => p.slot === v.owner)?.name ?? 'Enemy'}${isEnemy(v.owner) ? ' · enemy' : ' · ally'}`;
    detail = describeKind(v.kind, theirs, players.get(v.owner)?.age ?? 1);
    detail.warn = undefined;
    if (isBuilding(v.kind) && v.extra < 100) {
      card.bar = [v.extra, 100];
      card.building = true;
      card.sub = `Under construction · ${v.extra}%`;
    } else card.bar = [v.hp, maxHp(v)];
    if (def.attack) {
      const extra = v.kind === 'villager' ? 0 : relicsKept(v.owner) * RELIC_ATTACK;
      card.stats.push(['sword', extra ? `${attackOf(v.kind, theirs) + extra} (+${extra} relic)` : String(attackOf(v.kind, theirs))]);
    }
    if ((def.range ?? 0) > 2) card.stats.push(['bow', String(rangeOf(v.kind, theirs))]);
    if (!isBuilding(v.kind) || def.attack) card.stats.push(['shield', String(armorOf(v.kind, theirs))]);
    if (!isBuilding(v.kind) && v.extra % 100 > 0) card.stats.push([RESOURCES[Math.floor(v.extra / 100) % 10], `carrying ${v.extra % 100}`]);
    if (v.kind === 'castle' && v.extra >= 100) {
      card.sub = v.task & 2 ? `The king is inside${v.target > 1 ? ` with ${v.target - 1} more` : ''}` : v.owner === me ? 'Right-click it with your king to shelter him' : card.sub;
    }
    // The bell comes first, so that buttons coming and going never move it.
    if (v.kind === 'towncenter' && v.owner === me && v.extra >= 100) {
      const rung = players.get(me)?.bell === true;
      buttons.push({ label: rung ? 'Back to work' : 'Ring the bell', icon: rung ? 'allclear' : 'bell', detail: describeAction(rung ? 'allclear' : 'bell'), data: { bell: '1' } });
    }
    if (DEFS[v.kind].garrison && v.extra >= 100) {
      if (v.task === 1) card.sub = `${v.target} sheltering inside`;
      if (v.task && v.owner === me) buttons.push({ label: 'Send everyone out', icon: 'eject', detail: describeAction('eject'), data: { eject: String(v.id) } });
    }
    if (v.kind === 'monastery' && v.extra >= 100) {
      const kept = relics.filter((r) => r[3] === v.id).length;
      if (kept) card.stats.push(['relic', `Relic: +${RELIC_ATTACK} attack`]);
      card.sub = kept ? `Keeps the relic: +${relicsKept(v.owner) * RELIC_ATTACK} attack for the whole army` : v.owner === me ? 'Bring the relic here with a monk for +2 attack' : card.sub;
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
        // Upgrades only appear once the age they belong to is reached.
        if ((id === 'age3' && age < 2) || tech.age > age) continue;
        const d = describeTech(id, has, age);
        const short = d.warn ? 'locked' : undefined;
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
    const housed = housingNow();
    for (const kind of BUILDABLE) {
      const d = describeKind(kind, has, age);
      const full = !!DEFS[kind].housing && housed >= popLimit;
      if (DEFS[kind].housing) d.lines.push(`The population limit in this game is ${popLimit}; you have room for ${Math.min(housed, popLimit)}.`);
      if (full) d.warn = `Your houses already make room for the population limit of ${popLimit}.`;
      buttons.push({ label: DEFS[kind].label, icon: kind, cost: DEFS[kind].cost, locked: !ageAllows(kind) || full, short: full ? 'limit' : lockedShort(kind),
        detail: d, data: { build: kind } });
    }
  }

  // Soldiers can be told to go for anything they see, or to stand their ground until struck.
  const fighters = mine.filter((v) => !isBuilding(v.kind) && DEFS[v.kind].attack && v.kind !== 'villager' && v.kind !== 'king');
  if (!placing && fighters.length > 0) {
    const defensive = fighters.filter((v) => v.extra >= 10000).length;
    for (const stance of ['aggressive', 'defensive'] as const) {
      buttons.push({ label: stance === 'aggressive' ? 'Aggressive' : 'Defensive', icon: `stance.${stance}`, detail: describeAction(`stance.${stance}`),
        data: { stance }, active: stance === 'defensive' ? defensive === fighters.length : defensive === 0 });
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
  const buttonSignature = JSON.stringify([me, buttons.map((b) => [buttonKey(b), b.label, b.locked, b.active, b.cost && !canAfford(b.cost)])]);
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
    el.classList.toggle('on', !!b.active);
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
  const pop = stat('house', `${p.pop}/${p.cap}`, `Population / housing — at most ${popLimit} in this game`, `max ${popLimit}`);
  if (p.pop >= p.cap && p.cap < popLimit) pop.classList.add('warn');
  const kept = relicsKept(me);
  if (kept) stat('relic', `+${kept * RELIC_ATTACK}`, `The relic is in your monastery: +${kept * RELIC_ATTACK} attack for your troops and towers`);
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
  if (winner >= 0 && !endShown) showEnd(winner === myTeam);
}

/** Whether the end-of-game dialog has been shown for this game (it can be closed to look around). */
let endShown = false;

function showEnd(won: boolean): void {
  endShown = true;
  const names = roster.filter((q) => q.team === winner).map((q) => q.name).join(' and ');
  $('end-title').textContent = won ? 'Victory!' : 'Defeat';
  $('end-text').textContent = won ? 'Yours is the last king standing.' : `${names || 'Another team'} won this time.`;
  // Only the host can start the next game; everyone can leave.
  const host = !!session?.host;
  $('rematch-btn').hidden = !host;
  $('newgame-btn').hidden = !host;
  $('end-wait').hidden = host;
  $('end').hidden = false;
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
  // Relics lying where they have been seen, in gold.
  mctx.fillStyle = '#ffe680';
  for (const [x, y, carrier, monastery] of relics) {
    if (carrier >= 0 || monastery >= 0 || (!revealAll && !explored[Math.floor(y) * map!.size + Math.floor(x)])) continue;
    mctx.fillRect(x - 1, y - 1, 2, 2);
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
  const sx = (a / HW) * (cam.x - viewW() / 2) + minimap.width / 2;
  const sy = (b / HH) * (cam.y - viewH() / 2);
  mctx.strokeStyle = '#fff';
  mctx.lineWidth = 1;
  mctx.strokeRect(sx + 0.5, sy + 0.5, (a / HW) * viewW(), (b / HH) * viewH());
}

// --- render ----------------------------------------------------------------

function updateCamera(dt: number): void {
  // The view scrolls while the cursor rests near an edge of the window, faster the closer it is.
  const zone = 44;
  const push = (distance: number) => (mouse.inside && !mouse.onButton && distance < zone ? 0.35 + 0.65 * (1 - Math.max(0, distance) / zone) : 0);
  let dx = push(viewW() - mouse.x) - push(mouse.x);
  let dy = push(viewH() - mouse.y) - push(mouse.y);
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
  const sheltering = !!DEFS[v.kind].garrison;
  drawBuilding(ctx, v.kind, v.owner, v.id, sx, sy, { built: v.extra / 100, kingInside: sheltering && (v.task & 2) !== 0, occupied: (sheltering || v.kind === 'farm') && (v.task & 1) !== 0, now: performance.now(), age: players.get(v.owner)?.age ?? 1 });
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
  const carried = v.kind === 'villager' && v.extra % 100 > 0 ? Math.floor(v.extra / 100) % 10 : -1;
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
  if (v.hp < full || selected.has(v.id)) bar(sx, sy - Math.max(30, unitHeight(v.kind) + 6), 22, v.hp / full, '#4ad04a');
}

/** A map generated for the background of the start menu and waiting room, with a small town on it. */
let lobbyMap: GameMap | undefined;
let lobbyTown: { kind: Kind; x: number; y: number }[] = [];
const lobbyStart = performance.now();

/** The town on the menu background is painted once into this picture, which then glides as a whole. */
let lobbyPicture: HTMLCanvasElement | undefined;
/** How far the picture drifts each way, in canvas pixels; it is painted this much larger than the screen. */
const DRIFT_X = 150;
const DRIFT_Y = 90;

function drawLobbyScene(now: number): void {
  if (!lobbyMap) {
    // A large map with the town in its middle, so that the view never reaches the edge of the world.
    lobbyMap = generateMap((Math.random() * 0xffffffff) >>> 0, 112);
    const c = Math.floor(lobbyMap.size / 2);
    for (let y = c - 10; y <= c + 10; y++) {
      for (let x = c - 12; x <= c + 10; x++) if (Math.hypot(x - c, y - c) < 9.5) lobbyMap.tiles[y * lobbyMap.size + x] = Tile.Grass;
    }
    lobbyTown = [
      { kind: 'towncenter', x: c - 4, y: c - 2 }, { kind: 'castle', x: c + 1, y: c - 2 }, { kind: 'house', x: c - 4, y: c + 2 },
      { kind: 'house', x: c - 7, y: c - 1 }, { kind: 'mill', x: c - 1, y: c + 3 }, { kind: 'farm', x: c + 2, y: c + 3 },
      { kind: 'farm', x: c + 4, y: c + 3 }, { kind: 'barracks', x: c - 8, y: c + 2 }, { kind: 'tower', x: c + 6, y: c - 4 },
    ];
  }
  if (map !== lobbyMap) {
    map = lobbyMap;
    buildTerrain(map);
    lobbyPicture = undefined;
  }
  revealAll = true;
  const w = viewW() + DRIFT_X * 2;
  const h = viewH() + DRIFT_Y * 2;
  if (!lobbyPicture || lobbyPicture.width !== w || lobbyPicture.height !== h) lobbyPicture = paintLobbyPicture(w, h, now);
  // Fractional offsets are fine here: the whole picture moves together, so nothing shimmers.
  const t = (now - lobbyStart) / 1000;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(lobbyPicture, -DRIFT_X + Math.sin(t / 9) * (DRIFT_X - 6), -DRIFT_Y + Math.cos(t / 13) * (DRIFT_Y - 6));
  ctx.imageSmoothingEnabled = false;
}

/** Paints the menu town and its surroundings into a picture of the given size. */
function paintLobbyPicture(w: number, h: number, now: number): HTMLCanvasElement {
  const picture = document.createElement('canvas');
  picture.width = w;
  picture.height = h;
  // The usual drawing routines are pointed at the picture for a moment.
  const c = picture.getContext('2d')!;
  c.imageSmoothingEnabled = false;
  drawingTarget = c;
  sceneSize = [w, h];
  const centre = Math.floor(map!.size / 2);
  [cam.x, cam.y] = tileToWorld(centre, centre + 1);
  drawGround();
  const items: { depth: number; draw: () => void }[] = [];
  for (const [index, tile] of props) {
    const tx = index % map!.size;
    const ty = Math.floor(index / map!.size);
    const [x, y] = tileToScreen(tx + 0.5, ty + 0.5);
    if (x < -40 || y < -10 || x > w + 40 || y > h + 60) continue;
    items.push({ depth: tx + ty + 1, draw: () => drawProp(c, tile, x, y, Math.floor(hash(tx, ty) * 6), now) });
  }
  for (const b of lobbyTown) {
    const s = sizeOf(b.kind);
    const [x, y] = tileToScreen(b.x, b.y);
    items.push({ depth: b.kind === 'farm' ? -1e9 : b.x + b.y + s, draw: () => drawBuilding(c, b.kind, 0, b.x * 31 + b.y, x, y, { built: 1, kingInside: true, occupied: true, now }) });
  }
  items.sort((a, b) => a.depth - b.depth);
  for (const item of items) item.draw();
  drawingTarget = undefined;
  sceneSize = undefined;
  return picture;
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  requestAnimationFrame(frame);
  ctx.setTransform(drawScale, 0, 0, drawScale, 0, 0);
  // Beyond the mist around the map: more of the same dark mist.
  ctx.fillStyle = me < 0 ? '#0b0e0a' : MIST_COLOR;
  ctx.fillRect(0, 0, viewW(), viewH());
  if (me < 0) return drawLobbyScene(now);
  if (!map) return;
  updateCamera(dt);
  if (explored.length !== map.size * map.size) explored = new Uint8Array(map.size * map.size);
  updateWorkOffsets(now, dt);
  updateFog(now);
  breeze.update(now, dt, { left: cam.x - viewW() / 2, right: cam.x + viewW() / 2, top: cam.y - viewH() / 2, bottom: cam.y + viewH() / 2 }, treesOnScreen);

  drawGround();
  drawWaves(now);
  // The mist beyond the border lies on the ground, behind everything standing on the map, so that
  // tall buildings near the far edges rise in front of it rather than vanishing into it.
  drawEdgeMist();

  if (placing) {
    // A faint grid of tiles around the cursor, fading out with distance, shows where things line up.
    const [gx, gy] = placementSpot();
    const reach = 11;
    ctx.lineWidth = 1;
    for (let ty = gy - reach; ty <= gy + reach; ty++) {
      for (let tx = gx - reach; tx <= gx + reach; tx++) {
        if (tx < 0 || ty < 0 || tx >= map.size || ty >= map.size || !explored[ty * map.size + tx]) continue;
        const fade = 1 - Math.hypot(tx - gx, ty - gy) / reach;
        if (fade <= 0) continue;
        const [ax, ay] = tileToScreen(tx, ty);
        const [bx, by] = tileToScreen(tx + 1, ty);
        const [cx, cy] = tileToScreen(tx, ty + 1);
        ctx.strokeStyle = `rgba(255,250,225,${(0.34 * fade).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(ax, ay);
        ctx.lineTo(cx, cy);
        ctx.stroke();
      }
    }
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
    if (x > -100 && x < viewW() + 100 && y > -100 && y < viewH() + 100) drawBuildingView(v);
  }

  // Everything standing on the ground shares one depth-sorted pass.
  const alpha = Math.min(1, (now - snapTime) / TICK_MS);
  const drawables: { depth: number; draw: () => void }[] = [];
  // Zoomed out, trees and rocks are already part of the ground blocks.
  const far = farView();
  for (const [index, tile] of props) {
    const tx = index % map.size;
    const ty = Math.floor(index / map.size);
    const [sx, sy] = tileToScreen(tx + 0.5, ty + 0.5);
    if (far || sx < -40 || sy < -10 || sx > viewW() + 40 || sy > viewH() + 60 || !explored[index]) continue;
    // Trees sway a little all the time, and lean with a passing gust.
    const lean = tile === Tile.Forest ? breeze.lean(sx + cam.x - viewW() / 2, sy + cam.y - viewH() / 2, now) : 0;
    drawables.push({ depth: tx + ty + 1, draw: () => drawProp(ctx, tile, sx, sy, Math.floor(hash(tx, ty) * 6), now, lean) });
  }
  // Relics: on the ground where seen, held up by the monk carrying them, or floating over their monastery.
  for (const [x, y, carrier, monastery] of relics) {
    if (monastery >= 0) {
      const home = views.get(monastery);
      if (!home || !canSee(home)) continue;
      const [hx, hy] = tileToScreen(home.x + 1.5, home.y + 1.5);
      drawables.push({ depth: home.x + home.y + 3.2, draw: () => drawRelic(ctx, hx, hy - 58, now, true) });
      continue;
    }
    if (carrier >= 0) {
      const monk = views.get(carrier);
      if (!monk || !canSee(monk)) continue;
      const [mx, my] = viewPos(monk, alpha);
      drawables.push({ depth: mx + monk.ox + my + monk.oy + 0.01, draw: () => {
        const [sx, sy] = tileToScreen(mx + monk.ox, my + monk.oy);
        drawRelic(ctx, sx + 7, sy - 27, now, true);
      } });
      continue;
    }
    if (!revealAll && !explored[Math.floor(y) * map.size + Math.floor(x)]) continue;
    const [sx, sy] = tileToScreen(x, y);
    if (sx < -30 || sy < -30 || sx > viewW() + 30 || sy > viewH() + 30) continue;
    drawables.push({ depth: x + y, draw: () => drawRelic(ctx, sx, sy, now, false) });
  }
  const onScreen = (tx: number, ty: number, margin: number) => {
    const [x, y] = tileToScreen(tx, ty);
    return x > -margin && x < viewW() + margin && y > -margin && y < viewH() + margin * 2;
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

  blessings = blessings.filter((b) => now - b.t < 600);
  for (const b of blessings) {
    const monk = views.get(b.from);
    const target = views.get(b.to);
    if (!monk || !target) continue;
    const k = (now - b.t) / 600;
    const [tx, ty] = unitScreen(target);
    if (b.kind === 1) {
      // Healing: green sparkles rising from the wounded unit.
      ctx.fillStyle = `rgba(120,255,150,${1 - k})`;
      for (let i = 0; i < 4; i++) ctx.fillRect(Math.round(tx - 8 + i * 5 + Math.sin(i * 2 + k * 6) * 2), Math.round(ty - 8 - k * 22 - i * 3), 2, 2);
    } else {
      // Converting: rings in the monk's colour close in on the target, joined to the monk by a faint line.
      const [mx, my] = unitScreen(monk);
      ctx.strokeStyle = PLAYER_COLORS[monk.owner];
      ctx.globalAlpha = 0.35 * (1 - k);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mx, my - 16);
      ctx.lineTo(tx, ty - 14);
      ctx.stroke();
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(tx, ty - 12, 16 - k * 10, 20 - k * 12, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

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

  if (breeze.active) breeze.draw(ctx, now, worldToScreen);
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
  Object.assign(window, { __spawn: spawn, __game: { breeze, play, effectsState, setZoom: (z: number) => setZoom(z), getZoom: () => zoom, getFog: () => ({ visible, explored }), views, players, props, queues, cam, selected, tileToScreen, getMap: () => map, getMe: () => me, getSession: () => session } });
}
