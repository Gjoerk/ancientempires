import {
  BUILDABLE,
  canPlace,
  ClientMessage,
  Command,
  Cost,
  DEFS,
  GameMap,
  generateMap,
  Kind,
  KINDS,
  PlayerInfo,
  RESOURCES,
  ServerMessage,
  Tile,
  TICK_MS,
  TILE_RESOURCE,
} from '@kingsfall/shared';
import { hostGame, joinGame, normaliseCode, Session } from './net';
import { drawBuilding } from './buildings';
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
const mouse = { x: 0, y: 0, inside: false, onMap: false };
let drag: { x: number; y: number } | undefined;
let marker: { x: number; y: number; t: number } | undefined;
/** Resource tile that was just targeted, outlined for a moment. */
let tileFlash: { tile: number; t: number } | undefined;
/** Building kind the player is about to place, if any. */
let placing: Kind | undefined;

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
  if (!map || v.task === 0 || isBuilding(v.kind)) return undefined;
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

// --- terrain ---------------------------------------------------------------

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const MINI_COLORS: Record<number, string> = {
  [Tile.Grass]: '#4f8a3a', [Tile.Water]: '#1c3f66', [Tile.Forest]: '#2a5a26',
  [Tile.Berries]: '#b8506a', [Tile.Gold]: '#f2cf3a', [Tile.Stone]: '#9aa0a8',
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
    label.textContent = p.name + (p.slot === me ? ' (you)' : '');
    label.style.marginRight = '14px';
    if (players.get(p.slot)?.defeated) label.style.textDecoration = 'line-through';
    el.append(chip, label);
  }
}

function onMessage(msg: ServerMessage): void {
  if (msg.t === 'welcome') {
    me = msg.you;
    map = generateMap(msg.seed);
    buildTerrain(map);
    for (const [index, tile] of msg.tiles) setTile(index, tile);
    roster = msg.players;
    $('room-code').textContent = msg.room;
    history.replaceState(null, '', `?room=${msg.room}`);
    renderPlayers();
    $('lobby').style.display = 'none';
    $('top').hidden = false;
    $('bottom').hidden = false;
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
        Object.assign(v, { x, y, hp, act, extra, task, target });
      } else {
        const created: View = { id, owner, kind: KINDS[kindIdx], hp, act, extra, task, target, ox: 0, oy: 0, px: x, py: y, x, y };
        views.set(id, created);
        setBlocked(created, 1);
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
      if (a && b) shots.push({ from: centreOf(a), to: centreOf(b), t: now });
    }
    queues.clear();
    for (const [id, ...rest] of msg.queues) queues.set(id, rest);
    let defeatChanged = false;
    for (const [slot, food, wood, gold, stone, pop, cap, defeated] of msg.players) {
      if (players.get(slot)?.defeated !== (defeated === 1)) defeatChanged = true;
      players.set(slot, { res: { food, wood, gold, stone }, pop, cap, defeated: defeated === 1 });
    }
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

function showLobby(message: string): void {
  session = undefined;
  me = -1;
  centred = false;
  placing = undefined;
  winner = -1;
  views.clear();
  players.clear();
  selected.clear();
  $('lobby').style.display = '';
  $('top').hidden = true;
  $('bottom').hidden = true;
  $('banner').hidden = true;
  $('lobby-msg').textContent = message;
}

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
    if (isBuilding(v.kind)) continue;
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
      if (!isBuilding(v.kind)) continue;
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
    if (props.has(index)) return index;
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

function rightClick(sx: number, sy: number): void {
  const units = ownSelectedUnits();
  if (units.length === 0) return;
  const ids = units.map((v) => v.id);
  const [tx, ty] = screenToTile(sx, sy);
  marker = { x: tx, y: ty, t: performance.now() };
  const target = unitAt(sx, sy) ?? buildingAt(sx, sy);
  if (target && (target.owner !== me || isBuilding(target.kind))) {
    send({ type: 'interact', ids, target: target.id });
    return;
  }
  const tile = resourceTileAt(sx, sy);
  if (tile >= 0) {
    send({ type: 'gather', ids, tile });
    tileFlash = { tile, t: performance.now() };
    marker = undefined;
  } else send({ type: 'move', ids, x: tx, y: ty });
}

canvas.addEventListener('mousedown', (ev) => {
  if (me < 0) return;
  if (ev.button === 2) {
    if (placing) placing = undefined;
    else rightClick(ev.clientX, ev.clientY);
    return;
  }
  if (ev.button !== 0) return;
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
  if (ev.button !== 0 || !drag) return;
  const box = { x0: Math.min(drag.x, ev.clientX), y0: Math.min(drag.y, ev.clientY),
    x1: Math.max(drag.x, ev.clientX), y1: Math.max(drag.y, ev.clientY) };
  const isClick = box.x1 - box.x0 < 5 && box.y1 - box.y0 < 5;
  drag = undefined;
  if (!ev.shiftKey) selected.clear();
  if (isClick) {
    const v = unitAt(ev.clientX, ev.clientY) ?? buildingAt(ev.clientX, ev.clientY);
    if (v) selected.add(v.id);
    return;
  }
  for (const v of views.values()) {
    if (v.owner !== me || isBuilding(v.kind)) continue;
    const [x, y] = unitScreen(v);
    if (x >= box.x0 && x <= box.x1 && y - 10 >= box.y0 && y - 10 <= box.y1) selected.add(v.id);
  }
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
});
document.addEventListener('mouseleave', () => (mouse.inside = false));
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
window.addEventListener('keydown', (ev) => {
  if ((ev.target as HTMLElement).tagName === 'INPUT') return;
  const key = ev.key.toLowerCase();
  keys.add(key);
  if (key === 'escape') placing = undefined;
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

$('actions').addEventListener('click', (ev) => {
  const button = (ev.target as HTMLElement).closest('button');
  if (!button) return;
  const { build, train, cancel, eject } = button.dataset;
  if (eject) send({ type: 'eject', building: Number(eject) });
  if (build) placing = build as Kind;
  if (train) send({ type: 'train', building: Number(button.dataset.at), kind: train as Kind });
  if (cancel) send({ type: 'cancel', building: Number(cancel) });
});

// The minimap shows the map as the same diamond as the main view.
function miniScale(): [number, number] {
  return [minimap.width / (2 * map!.size), minimap.height / (2 * map!.size)];
}

minimap.addEventListener('mousedown', (ev) => {
  if (!map) return;
  const r = minimap.getBoundingClientRect();
  const [a, b] = miniScale();
  const u = ((ev.clientX - r.left) * (minimap.width / r.width) - minimap.width / 2) / a;
  const v = ((ev.clientY - r.top) * (minimap.height / r.height)) / b;
  [cam.x, cam.y] = tileToWorld((u + v) / 2, (v - u) / 2);
  clampCamera();
});

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

let panelSignature = '';
function renderPanel(): void {
  const chosen = [...selected].map((id) => views.get(id)).filter((v): v is View => !!v);
  const mine = chosen.filter((v) => v.owner === me);
  let info = 'Nothing selected';
  const buttons: { label: string; cost?: Cost; data: Record<string, string> }[] = [];

  if (placing) {
    info = `Placing ${DEFS[placing].label} — click to build, hold Shift for several, Esc to cancel`;
  } else if (chosen.length === 1) {
    const v = chosen[0];
    const def = DEFS[v.kind];
    const ownerName = v.owner === me ? '' : ` · ${roster.find((p) => p.slot === v.owner)?.name ?? 'enemy'}`;
    info = `${def.label}${ownerName} · HP ${v.hp}/${def.hp}`;
    if (isBuilding(v.kind) && v.extra < 100) info += ` · under construction ${v.extra}%`;
    else if (!isBuilding(v.kind) && v.extra % 100 > 0) info += ` · carrying ${v.extra % 100} ${RESOURCES[Math.floor(v.extra / 100)]}`;
    if (v.kind === 'castle' && v.extra >= 100) {
      info += v.task === 1 ? ' · the king is inside' : v.owner === me ? ' · right-click it with your king to shelter him' : '';
      if (v.task === 1 && v.owner === me) buttons.push({ label: 'Send king out', data: { eject: String(v.id) } });
    }
    const queue = queues.get(v.id);
    if (queue) info += ` · training ${DEFS[KINDS[queue[1]]].label} ${queue[0]}%${queue.length > 2 ? ` (+${queue.length - 2} queued)` : ''}`;
    if (v.owner === me && isBuilding(v.kind) && v.extra >= 100) {
      for (const kind of def.trains ?? []) {
        buttons.push({ label: DEFS[kind].label, cost: DEFS[kind].cost, data: { train: kind, at: String(v.id) } });
      }
      if (queue) buttons.push({ label: 'Cancel last', data: { cancel: String(v.id) } });
    }
  } else if (chosen.length > 1) {
    const counts = new Map<Kind, number>();
    for (const v of chosen) counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1);
    info = [...counts].map(([k, c]) => `${c} × ${DEFS[k].label}`).join(' · ');
  }
  if (!placing && mine.some((v) => v.kind === 'villager')) {
    for (const kind of BUILDABLE) buttons.push({ label: DEFS[kind].label, cost: DEFS[kind].cost, data: { build: kind } });
  }

  const signature = info + '|' + buttons.map((b) => b.label + (b.cost && !canAfford(b.cost) ? '!' : '')).join(',');
  if (signature === panelSignature) return;
  panelSignature = signature;
  $('info').textContent = info;
  const actions = $('actions');
  actions.textContent = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.textContent = b.label;
    Object.assign(el.dataset, b.data);
    if (b.cost) {
      const small = document.createElement('small');
      small.textContent = costText(b.cost);
      el.append(small);
      if (!canAfford(b.cost)) el.className = 'poor';
    }
    actions.append(el);
  }
}

let hudSignature = '';
function renderHud(): void {
  const p = players.get(me);
  if (!p) return;
  const idle = [...views.values()].filter((v) => v.owner === me && v.kind === 'villager' && v.act === 0).length;
  const signature = [p.res.food, p.res.wood, p.res.gold, p.res.stone, p.pop, p.cap, idle, p.defeated, winner].join();
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
  if (idle > 0) add('Idle villagers (.)', String(idle));

  const banner = $('banner');
  let text = '';
  if (winner === me) text = 'Victory! Yours is the last king standing.';
  else if (p.defeated) text = 'Your king has fallen. You are out of the game.';
  if (winner >= 0 && winner !== me) text += ` ${roster.find((q) => q.slot === winner)?.name ?? 'Another player'} wins.`;
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
  for (const v of views.values()) {
    mctx.fillStyle = PLAYER_COLORS[v.owner];
    const s = isBuilding(v.kind) ? sizeOf(v.kind) + 0.5 : v.kind === 'king' ? 2.2 : 1.6;
    const [cx, cy] = centreOf(v);
    mctx.fillRect(cx - s / 2, cy - s / 2, s, s);
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
  const speed = 900 * dt;
  const edge = 6;
  let dx = 0;
  let dy = 0;
  if (keys.has('a') || keys.has('arrowleft') || (mouse.inside && mouse.x < edge)) dx--;
  if (keys.has('d') || keys.has('arrowright') || (mouse.inside && mouse.x > canvas.width - edge)) dx++;
  if (keys.has('w') || keys.has('arrowup') || (mouse.inside && mouse.y < edge)) dy--;
  if (keys.has('s') || keys.has('arrowdown') || (mouse.inside && mouse.y > canvas.height - edge)) dy++;
  cam.x += dx * speed;
  cam.y += dy * speed;
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
  if (v.kind === 'farm' && v.extra >= 100 && v.hp >= def.hp && !selected.has(v.id)) return;
  // Bars sit above the roof line of tall buildings.
  const top = sy - (v.kind === 'tower' ? 52 : v.kind === 'castle' || v.kind === 'towncenter' ? 32 : 14);
  if (v.extra < 100) bar(sx, top, 14 + s * 12, v.extra / 100, '#e0c12f');
  else if (v.hp < def.hp || selected.has(v.id)) bar(sx, top, 14 + s * 12, v.hp / def.hp, '#4ad04a');
  const queue = queues.get(v.id);
  if (queue && v.owner === me) bar(sx, top + 5, 14 + s * 12, queue[0] / 100, '#6ab0ff');
}

function drawUnitView(v: View, x: number, y: number, now: number): void {
  const [sx, sy] = tileToScreen(x + v.ox, y + v.oy);
  const def = DEFS[v.kind];
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
  const carried = v.kind === 'villager' && v.extra % 100 > 0 ? Math.floor(v.extra / 100) : -1;
  drawUnit(ctx, v.kind, v.owner, sx, sy, work ? 0 : bob, work, carried);
  if (v.hp < def.hp || selected.has(v.id)) bar(sx, sy - (v.kind === 'king' ? 34 : 30), 22, v.hp / def.hp, '#4ad04a');
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
  updateWorkOffsets(now, dt);

  const [ox, oy] = worldToScreen(-map.size * HW, 0);
  ctx.drawImage(terrain, Math.round(ox), Math.round(oy));

  if (placing) {
    const [px, py] = placementSpot();
    const ok = canPlace(map, placing, px, py) && canAfford(DEFS[placing].cost);
    diamond(px, py, sizeOf(placing));
    ctx.fillStyle = ok ? 'rgba(120,255,120,.35)' : 'rgba(255,90,90,.4)';
    ctx.fill();
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

  // Fields lie flat on the ground, so they are drawn before anything that stands.
  for (const v of views.values()) if (v.kind === 'farm') drawBuildingView(v);

  // Everything standing on the ground shares one depth-sorted pass.
  const alpha = Math.min(1, (now - snapTime) / TICK_MS);
  const drawables: { depth: number; draw: () => void }[] = [];
  for (const [index, tile] of props) {
    const tx = index % map.size;
    const ty = Math.floor(index / map.size);
    const [sx, sy] = tileToScreen(tx + 0.5, ty + 0.5);
    if (sx < -40 || sy < -10 || sx > canvas.width + 40 || sy > canvas.height + 60) continue;
    drawables.push({ depth: tx + ty + 1, draw: () => drawProp(ctx, tile, sx, sy, Math.floor(hash(tx, ty) * 3)) });
  }
  for (const v of views.values()) {
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

  if (drag && (Math.abs(mouse.x - drag.x) > 4 || Math.abs(mouse.y - drag.y) > 4)) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(drag.x + 0.5, drag.y + 0.5, mouse.x - drag.x, mouse.y - drag.y);
  }

  renderPanel();
  renderHud();
  renderMinimap();
}
requestAnimationFrame(frame);

// Handles for automated tests in development builds.
if (import.meta.env.DEV) {
  Object.assign(window, { __game: { views, players, props, queues, cam, selected, tileToScreen, getMap: () => map, getMe: () => me } });
}
