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
  generateMap,
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
  TRADE_SELL,
} from '@kingsfall/shared';
import { hostGame, joinGame, normaliseCode, Session } from './net';
import { loadSprites } from './assets';
import { drawBuilding } from './buildings';
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
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('game');
const ctx = canvas.getContext('2d')!;
const minimap = $<HTMLCanvasElement>('minimap');
const mctx = minimap.getContext('2d')!;

let session: Session | undefined;
let me = -1;
let map: GameMap | undefined;
let terrain: HTMLCanvasElement | undefined;
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
    // Farmers wander slowly around their field.
    return [b.x + s / 2 + Math.cos(now / 5000 + v.id) * 0.55, b.y + s / 2 + Math.sin(now / 3700 + v.id * 2) * 0.55];
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
  for (let i = 0; i < n * n; i++) img.data[i * 4 + 3] = visible[i] ? 0 : explored[i] ? 110 : 255;
  g.putImageData(img, 0, 0);
}

/** Darkens what is not in sight and blacks out what was never seen, for the tiles on screen. */
function drawFog(): void {
  if (!map || revealAll) return;
  const n = map.size;
  const corners = [screenToTile(0, 0), screenToTile(canvas.width, 0), screenToTile(0, canvas.height), screenToTile(canvas.width, canvas.height)];
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))) - 1);
  const x1 = Math.min(n - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))) + 1);
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))) - 1);
  const y1 = Math.min(n - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))) + 1);
  for (const pass of [0, 1]) {
    ctx.beginPath();
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const i = ty * n + tx;
        if (visible[i] || (pass === 0) !== (explored[i] === 0)) continue;
        const [cx, cy] = tileToScreen(tx, ty);
        if (cx < -HW || cx > canvas.width + HW || cy < -HH * 4 || cy > canvas.height + HH) continue;
        ctx.moveTo(cx, cy - 0.5);
        ctx.lineTo(cx + HW + 0.5, cy + HH);
        ctx.lineTo(cx, cy + HH * 2 + 0.5);
        ctx.lineTo(cx - HW - 0.5, cy + HH);
        ctx.closePath();
      }
    }
    ctx.fillStyle = pass === 0 ? '#0b0e0a' : 'rgba(8,12,8,.45)';
    ctx.fill();
  }
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
  [Tile.Berries]: '#b8506a', [Tile.Gold]: '#f2cf3a',
};

function paintTile(m: GameMap, index: number): void {
  const n = m.size;
  const x = index % n;
  const y = Math.floor(index / n);
  const tile = m.tiles[index];
  const r = hash(x, y);
  const grass = ['#4f8a3a', '#55913d', '#4a8436', '#5a9642'];
  const palette = tile === Tile.Water ? ['#2f6fa8', '#2b68a0', '#3476b0'] : tile === Tile.Forest ? ['#3d6e2e', '#396a2b'] : grass;
  const t = terrain!.getContext('2d')!;
  const cx = (x - y) * HW + n * HW;
  const cy = (x + y) * HH;
  t.fillStyle = palette[Math.floor(r * palette.length)];
  t.beginPath();
  t.moveTo(cx, cy);
  t.lineTo(cx + HW, cy + HH);
  t.lineTo(cx, cy + HH * 2);
  t.lineTo(cx - HW, cy + HH);
  t.closePath();
  t.fill();
  if (tile === Tile.Grass && r > 0.8) {
    t.fillStyle = '#6aa64c';
    t.fillRect(cx - 8 + (Math.floor(r * 60) % 16), cy + 10 + (Math.floor(r * 90) % 10), 2, 2);
  }
  const mt = miniTerrain!.getContext('2d')!;
  mt.fillStyle = MINI_COLORS[tile];
  mt.fillRect(x, y, 1, 1);
  if (TILE_RESOURCE[tile as Tile]) props.set(index, tile);
  else props.delete(index);
}

function buildTerrain(m: GameMap): void {
  terrain = document.createElement('canvas');
  terrain.width = m.size * HW * 2;
  terrain.height = m.size * HH * 2;
  miniTerrain = document.createElement('canvas');
  miniTerrain.width = miniTerrain.height = m.size;
  props.clear();
  for (let i = 0; i < m.tiles.length; i++) paintTile(m, i);
}

function setTile(index: number, tile: number): void {
  if (!map) return;
  map.tiles[index] = tile;
  paintTile(map, index);
}

function setBlocked(v: View, value: number): void {
  if (!map || !isBuilding(v.kind)) return;
  const s = sizeOf(v.kind);
  for (let y = v.y; y < v.y + s; y++) for (let x = v.x; x < v.x + s; x++) map.blocked[y * map.size + x] = value;
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
    renderRoom(msg.room, msg.you, msg.host, msg.settings.quick);
    history.replaceState(null, '', `?room=${msg.room}`);
    $('lobby').style.display = 'none';
    $('waiting').style.display = '';
  } else if (msg.t === 'start') {
    resetGame();
    me = myOwnSlot = msg.you;
    map = generateMap(msg.seed);
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
        if (hp < v.hp && v.owner === me) underAttack(v, now);
        if (v.owner === me && isBuilding(v.kind) && v.extra < 100 && extra >= 100) play('built', 400);
        Object.assign(v, { x, y, hp, act, extra, task, target });
      } else {
        const created: View = { id, owner, kind: KINDS[kindIdx], hp, act, extra, task, target, ox: 0, oy: 0, struck: 0, hurt: 0, px: x, py: y, x, y };
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
    for (const [slot, food, wood, gold, pop, cap, defeated, age, techs, researching] of msg.players) {
      const old = players.get(slot);
      if (old?.defeated !== (defeated === 1)) defeatChanged = true;
      if (slot === me && old) {
        if (age > old.age) play('age');
        else if (techs !== old.techs) play('research');
        if (defeated === 1 && !old.defeated) play('defeat');
      }
      players.set(slot, { res: { food, wood, gold }, pop, cap, defeated: defeated === 1, age, techs, researching });
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
  } else if (msg.t === 'error') {
    $('lobby-msg').textContent = msg.message;
  }
}

/** Tells the player when something of theirs is attacked where they are not looking. */
function underAttack(v: View, now: number): void {
  if (alert && now - alert.t < 7000) return;
  const [cx, cy] = centreOf(v);
  const [sx, sy] = tileToScreen(cx, cy);
  if (sx > 0 && sy > 40 && sx < canvas.width && sy < canvas.height - 170) return;
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
  hudSignature = panelSignature = '';
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
function renderRoom(room: string, you: number, host: number, quick: boolean): void {
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
  quickBox.checked = quick;
  quickBox.disabled = !hosting;
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

canvas.addEventListener('mousedown', (ev) => {
  if (me < 0) return;
  if (ev.button === 2) {
    if (placing) placing = wallStart = undefined;
    else rightClick(ev.clientX, ev.clientY, ev.ctrlKey || ev.metaKey);
    return;
  }
  if (ev.button !== 0) return;
  if (placing === 'wall') {
    // Walls are dragged out as a line and placed on release.
    wallStart = placementSpot();
    return;
  }
  if (placing) {
    const [x, y] = placementSpot();
    const ids = ownSelectedUnits().filter((v) => v.kind === 'villager').map((v) => v.id);
    if (map && canPlace(map, placing, x, y) && canAfford(DEFS[placing].cost)) {
      send({ type: 'place', ids, kind: placing, x, y });
      if (!ev.shiftKey) placing = undefined;
    }
    return;
  }
  drag = { x: ev.clientX, y: ev.clientY };
});

window.addEventListener('mouseup', (ev) => {
  if (ev.button === 0 && wallStart && placing === 'wall' && map) {
    const ids = ownSelectedUnits().filter((v) => v.kind === 'villager').map((v) => v.id);
    for (const [x, y] of lineTiles(wallStart, placementSpot())) {
      if (canPlace(map, 'wall', x, y)) send({ type: 'place', ids, kind: 'wall', x, y });
    }
    wallStart = undefined;
    if (!ev.shiftKey) placing = undefined;
    return;
  }
  if (ev.button !== 0 || !drag) return;
  const box = { x0: Math.min(drag.x, ev.clientX), y0: Math.min(drag.y, ev.clientY),
    x1: Math.max(drag.x, ev.clientX), y1: Math.max(drag.y, ev.clientY) };
  const isClick = box.x1 - box.x0 < 5 && box.y1 - box.y0 < 5;
  drag = undefined;
  if (!ev.shiftKey) selected.clear();
  if (isClick) {
    const v = unitAt(ev.clientX, ev.clientY) ?? buildingAt(ev.clientX, ev.clientY);
    if (v) selected.add(v.id);
    // Selecting something of a test opponent hands control to that side.
    if (v && v.owner !== me && controllable().includes(v.owner)) {
      selected.clear();
      selected.add(v.id);
      switchTeam(v.owner, true);
    }
    return;
  }
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
});

// Double-click selects every unit of that kind on screen.
canvas.addEventListener('dblclick', (ev) => {
  const hit = unitAt(ev.clientX, ev.clientY);
  if (!hit || hit.owner !== me) return;
  for (const v of views.values()) {
    if (v.owner !== me || v.kind !== hit.kind) continue;
    const [x, y] = tileToScreen(v.x, v.y);
    if (x >= 0 && y >= 0 && x <= canvas.width && y <= canvas.height) selected.add(v.id);
  }
});

window.addEventListener('mousemove', (ev) => {
  mouse.x = ev.clientX;
  mouse.y = ev.clientY;
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
  if (key === '.') {
    // Jump to the next villager with nothing to do.
    const idle = [...views.values()].filter((v) => v.owner === me && v.kind === 'villager' && v.act === 0);
    if (idle.length === 0) return;
    const current = idle.findIndex((v) => selected.has(v.id));
    const next = idle[(current + 1) % idle.length];
    selected.clear();
    selected.add(next.id);
    [cam.x, cam.y] = tileToWorld(next.x, next.y);
  }
});
window.addEventListener('keyup', (ev) => keys.delete(ev.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => undefined);
}
$('full-btn').addEventListener('click', toggleFullscreen);
$('mute-btn').textContent = isMuted() ? 'Sound off (M)' : 'Sound on (M)';
$('mute-btn').addEventListener('click', () => ($('mute-btn').textContent = toggleMute() ? 'Sound off (M)' : 'Sound on (M)'));
window.addEventListener('pointerdown', unlockSound);
window.addEventListener('keydown', unlockSound);
$('help-btn').addEventListener('click', () => ($('help').hidden = !$('help').hidden));
$('actions').addEventListener('click', (ev) => {
  const button = (ev.target as HTMLElement).closest('button');
  if (!button) return;
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
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// --- HUD -------------------------------------------------------------------

function costText(cost: Cost): string {
  return RESOURCES.filter((r) => cost[r]).map((r) => `${cost[r]} ${r}`).join(', ') || 'free';
}

interface PanelButton {
  label: string;
  sub?: string;
  cost?: Cost;
  /** Not available yet; `sub` says why. */
  locked?: boolean;
  data: Record<string, string>;
}

let panelSignature = '';
function renderPanel(): void {
  const chosen = [...selected].map((id) => views.get(id)).filter((v): v is View => !!v);
  const mine = chosen.filter((v) => v.owner === me);
  const my = players.get(me);
  const age = my?.age ?? 1;
  const has = hasOf(me);
  let info = 'Nothing selected';
  const buttons: PanelButton[] = [];

  if (placing) {
    info = placing === 'wall'
      ? 'Placing Wall — drag a line and release, hold Shift for more, Esc to cancel'
      : `Placing ${DEFS[placing].label} — click to build, hold Shift for several, Esc to cancel`;
  } else if (chosen.length === 1) {
    const v = chosen[0];
    const def = DEFS[v.kind];
    const theirs = hasOf(v.owner);
    const ownerName = v.owner === me ? '' : ` · ${roster.find((p) => p.slot === v.owner)?.name ?? 'enemy'}`;
    info = `${def.label}${ownerName} · HP ${v.hp}/${maxHp(v)}`;
    if (def.attack) info += ` · attack ${attackOf(v.kind, theirs)}`;
    if (!isBuilding(v.kind) || def.attack) info += ` · armour ${armorOf(v.kind, theirs)}`;
    if (isBuilding(v.kind) && v.extra < 100) info += ` · under construction ${v.extra}%`;
    else if (!isBuilding(v.kind) && v.extra % 100 > 0) info += ` · carrying ${v.extra % 100} ${RESOURCES[Math.floor(v.extra / 100)]}`;
    if (v.kind === 'castle' && v.extra >= 100) {
      info += v.task === 1 ? ' · the king is inside' : v.owner === me ? ' · right-click it with your king to shelter him' : '';
      if (v.task === 1 && v.owner === me) buttons.push({ label: 'Send king out', data: { eject: String(v.id) } });
    }
    const queue = v.owner === me ? queues.get(v.id) : undefined;
    if (queue) {
      const first = QUEUE_ITEMS[queue[1]];
      const name = isTech(first) ? TECHS[first].label : DEFS[first as Kind].label;
      info += ` · ${isTech(first) ? 'researching' : 'training'} ${name} ${queue[0]}%${queue.length > 2 ? ` (+${queue.length - 2} queued)` : ''}`;
    }
    if (v.owner === me && isBuilding(v.kind) && v.extra >= 100) {
      const at = String(v.id);
      for (const kind of def.trains ?? []) {
        const locked = !ageAllows(kind);
        buttons.push({ label: DEFS[kind].label, cost: DEFS[kind].cost, locked, sub: locked ? `needs ${AGE_NAMES[DEFS[kind].age ?? 1]}` : undefined, data: { train: kind, at } });
      }
      for (const id of TECH_IDS) {
        const tech = TECHS[id];
        if (tech.at !== v.kind || has(id) || ((my?.researching ?? 0) >> TECH_IDS.indexOf(id)) & 1) continue;
        if (id === 'age3' && age < 2) continue;
        const missing = tech.age > age ? `needs ${AGE_NAMES[tech.age]}` : tech.requires && !has(tech.requires) ? `needs ${TECHS[tech.requires].label}` : '';
        buttons.push({ label: tech.label, cost: tech.cost, locked: !!missing, sub: missing || tech.effect, data: { train: id, at } });
      }
      if (v.kind === 'market') {
        for (const r of ['food', 'wood']) buttons.push({ label: `Sell 100 ${r}`, sub: `for ${TRADE_SELL} gold`, locked: (my?.res[r] ?? 0) < 100, data: { sell: r, at } });
        for (const r of ['food', 'wood']) buttons.push({ label: `Buy 100 ${r}`, sub: `for ${TRADE_BUY} gold`, locked: (my?.res.gold ?? 0) < TRADE_BUY, data: { buy: r, at } });
      }
      if (queue) buttons.push({ label: 'Cancel last', data: { cancel: at } });
      if (def.trains && !queue) info += ' · right-click the map to set a gathering point';
    }
  } else if (chosen.length > 1) {
    const counts = new Map<Kind, number>();
    for (const v of chosen) counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1);
    info = [...counts].map(([k, c]) => `${c} × ${DEFS[k].label}`).join(' · ');
  }
  if (!placing && mine.some((v) => v.kind === 'villager')) {
    for (const kind of BUILDABLE) {
      const locked = !ageAllows(kind);
      buttons.push({ label: DEFS[kind].label, cost: DEFS[kind].cost, locked, sub: locked ? `needs ${AGE_NAMES[DEFS[kind].age ?? 1]}` : undefined, data: { build: kind } });
    }
  }

  const signature = info + '|' + buttons.map((b) => b.label + (b.locked ? '#' : '') + (b.cost && !canAfford(b.cost) ? '!' : '')).join(',');
  if (signature === panelSignature) return;
  panelSignature = signature;
  $('info').textContent = info;
  const actions = $('actions');
  actions.textContent = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.textContent = b.label;
    Object.assign(el.dataset, b.data);
    const small = document.createElement('small');
    small.textContent = b.locked && b.sub ? b.sub : b.cost ? costText(b.cost) : b.sub ?? '';
    if (b.sub && !b.locked) el.title = b.sub;
    if (small.textContent) el.append(small);
    if (b.locked) el.className = 'locked';
    else if (b.cost && !canAfford(b.cost)) el.className = 'poor';
    actions.append(el);
  }
}

let hudSignature = '';
function renderHud(): void {
  const p = players.get(me);
  if (!p) return;
  const idle = [...views.values()].filter((v) => v.owner === me && v.kind === 'villager' && v.act === 0).length;
  const signature = [p.res.food, p.res.wood, p.res.gold, p.pop, p.cap, idle, p.defeated, winner, p.age].join();
  if (signature === hudSignature) return;
  hudSignature = signature;
  const el = $('resources');
  el.textContent = '';
  const add = (label: string, value: string) => {
    const span = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = value;
    span.append(`${label} `, b);
    el.append(span);
  };
  for (const r of RESOURCES) add(r[0].toUpperCase() + r.slice(1), String(p.res[r]));
  add('Pop', `${p.pop}/${p.cap}`);
  add('', AGE_NAMES[p.age] ?? '');
  if (idle > 0) add('Idle villagers (.)', String(idle));

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

function renderMinimap(): void {
  if (!map || !miniTerrain) return;
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
  const big = v.kind === 'rider' || v.kind === 'ram';
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
  const carried = v.kind === 'villager' && v.extra % 100 > 0 ? Math.floor(v.extra / 100) : -1;
  drawUnit(ctx, v.kind, v.owner, sx, sy, work ? 0 : bob, work, carried, v.act, now);
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

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  requestAnimationFrame(frame);
  ctx.fillStyle = '#10140f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!map || !terrain || me < 0) return;
  updateCamera(dt);
  if (explored.length !== map.size * map.size) explored = new Uint8Array(map.size * map.size);
  updateWorkOffsets(now, dt);
  updateFog(now);

  const [ox, oy] = worldToScreen(-map.size * HW, 0);
  ctx.drawImage(terrain, Math.round(ox), Math.round(oy));

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

  // Resource tiles are outlined when pointed at, and flash when villagers are sent there.
  const outline = (tile: number, color: string, width: number) => {
    diamond(tile % map!.size, Math.floor(tile / map!.size), 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  const hovered = mouse.onMap && !placing && !drag ? resourceTileAt(mouse.x, mouse.y) : -1;
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
  for (const v of shown) if (v.kind === 'farm') drawBuildingView(v);

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
  for (const v of shown) {
    if (v.kind === 'farm') continue;
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

  if (drag && (Math.abs(mouse.x - drag.x) > 4 || Math.abs(mouse.y - drag.y) > 4)) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(drag.x + 0.5, drag.y + 0.5, mouse.x - drag.x, mouse.y - drag.y);
  }

  renderPanel();
  renderHud();
  renderMinimap();
}
void loadSprites();
requestAnimationFrame(frame);

// Handles for automated tests in development builds.
if (import.meta.env.DEV) {
  Object.assign(window, { __spawn: spawn, __game: { getFog: () => ({ visible, explored }), views, players, props, queues, cam, selected, tileToScreen, getMap: () => map, getMe: () => me, getSession: () => session } });
}
