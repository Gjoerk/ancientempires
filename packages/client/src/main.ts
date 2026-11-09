import {
  ClientMessage,
  GameMap,
  generateMap,
  PlayerInfo,
  ServerMessage,
  Tile,
  TICK_MS,
  tileAt,
  UNIT_KINDS,
  UNIT_STATS,
  UnitKind,
} from '@kingsfall/shared';
import { hostGame, joinGame, normaliseCode, Session } from './net';
import { drawTree, drawUnit, PLAYER_COLORS } from './sprites';

// Isometric tile half-width and half-height in screen pixels.
const HW = 32;
const HH = 16;

interface View {
  id: number;
  owner: number;
  kind: UnitKind;
  hp: number;
  moving: boolean;
  // Position at the previous snapshot and at the latest one, for interpolation.
  px: number;
  py: number;
  x: number;
  y: number;
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
let trees: [number, number][] = [];
const views = new Map<number, View>();
const selected = new Set<number>();
let snapTime = 0;
let centred = false;
const cam = { x: 0, y: 0 };
const keys = new Set<string>();
const mouse = { x: 0, y: 0, inside: false };
let drag: { x: number; y: number } | undefined;
let marker: { x: number; y: number; t: number } | undefined;

// --- coordinates -----------------------------------------------------------

function tileToWorld(tx: number, ty: number): [number, number] {
  return [(tx - ty) * HW, (tx + ty) * HH];
}

function worldToScreen(wx: number, wy: number): [number, number] {
  return [wx - cam.x + canvas.width / 2, wy - cam.y + canvas.height / 2];
}

function screenToTile(sx: number, sy: number): [number, number] {
  const wx = sx + cam.x - canvas.width / 2;
  const wy = sy + cam.y - canvas.height / 2;
  return [(wx / HW + wy / HH) / 2, (wy / HH - wx / HW) / 2];
}

function viewPos(v: View, alpha: number): [number, number] {
  return [v.px + (v.x - v.px) * alpha, v.py + (v.y - v.py) * alpha];
}

// --- terrain ---------------------------------------------------------------

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function buildTerrain(m: GameMap): void {
  const n = m.size;
  terrain = document.createElement('canvas');
  terrain.width = n * HW * 2;
  terrain.height = n * HH * 2;
  const t = terrain.getContext('2d')!;
  const grass = ['#4f8a3a', '#55913d', '#4a8436', '#5a9642'];
  const water = ['#2f6fa8', '#2b68a0', '#3476b0'];
  const floor = ['#3d6e2e', '#396a2b'];
  trees = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const tile = tileAt(m, x, y);
      const r = hash(x, y);
      const palette = tile === Tile.Water ? water : tile === Tile.Forest ? floor : grass;
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
        t.fillRect(cx - 8 + Math.floor(r * 60) % 16, cy + 10 + Math.floor(r * 90) % 10, 2, 2);
      }
      if (tile === Tile.Forest) trees.push([x, y]);
    }
  }

  miniTerrain = document.createElement('canvas');
  miniTerrain.width = miniTerrain.height = n;
  const mt = miniTerrain.getContext('2d')!;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const tile = tileAt(m, x, y);
      mt.fillStyle = tile === Tile.Water ? '#1c3f66' : tile === Tile.Forest ? '#2a5a26' : '#4f8a3a';
      mt.fillRect(x, y, 1, 1);
    }
  }
}

// --- network ---------------------------------------------------------------

function send(msg: ClientMessage): void {
  session?.send(msg);
}

function renderPlayers(players: PlayerInfo[]): void {
  const el = $('players');
  el.textContent = '';
  for (const p of players) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = PLAYER_COLORS[p.slot];
    const label = document.createElement('span');
    label.textContent = p.name + (p.slot === me ? ' (you)' : '');
    label.style.marginRight = '14px';
    el.append(chip, label);
  }
}

function onMessage(msg: ServerMessage): void {
  if (msg.t === 'welcome') {
    me = msg.you;
    map = generateMap(msg.seed);
    buildTerrain(map);
    $('room-code').textContent = msg.room;
    history.replaceState(null, '', `?room=${msg.room}`);
    renderPlayers(msg.players);
    $('lobby').style.display = 'none';
    $('top').hidden = false;
    $('bottom').hidden = false;
  } else if (msg.t === 'players') {
    renderPlayers(msg.players);
  } else if (msg.t === 'snap') {
    const now = performance.now();
    const alpha = Math.min(1, (now - snapTime) / TICK_MS);
    const seen = new Set<number>();
    for (const [id, owner, kindIdx, x, y, hp, moving] of msg.ents) {
      seen.add(id);
      const v = views.get(id);
      if (v) {
        // Continue from wherever the unit is currently drawn, so motion stays smooth.
        [v.px, v.py] = viewPos(v, alpha);
        v.x = x;
        v.y = y;
        v.hp = hp;
        v.moving = moving === 1;
      } else {
        views.set(id, { id, owner, kind: UNIT_KINDS[kindIdx], hp, moving: moving === 1, px: x, py: y, x, y });
      }
    }
    for (const id of views.keys()) {
      if (!seen.has(id)) {
        views.delete(id);
        selected.delete(id);
      }
    }
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
  views.clear();
  selected.clear();
  $('lobby').style.display = '';
  $('top').hidden = true;
  $('bottom').hidden = true;
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

// --- input -----------------------------------------------------------------

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
    const [x, y] = worldToScreen(...tileToWorld(v.x, v.y));
    const d = Math.hypot(x - sx, y - 10 - sy);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

canvas.addEventListener('mousedown', (ev) => {
  if (me < 0) return;
  if (ev.button === 0) {
    drag = { x: ev.clientX, y: ev.clientY };
  } else if (ev.button === 2 && selected.size > 0) {
    const [tx, ty] = screenToTile(ev.clientX, ev.clientY);
    send({ t: 'cmd', cmd: { type: 'move', ids: [...selected], x: tx, y: ty } });
    marker = { x: tx, y: ty, t: performance.now() };
  }
});

window.addEventListener('mouseup', (ev) => {
  if (ev.button !== 0 || !drag) return;
  const box = { x0: Math.min(drag.x, ev.clientX), y0: Math.min(drag.y, ev.clientY),
    x1: Math.max(drag.x, ev.clientX), y1: Math.max(drag.y, ev.clientY) };
  const isClick = box.x1 - box.x0 < 5 && box.y1 - box.y0 < 5;
  drag = undefined;
  if (!ev.shiftKey) selected.clear();
  if (isClick) {
    const v = unitAt(ev.clientX, ev.clientY);
    if (v && v.owner === me) selected.add(v.id);
    return;
  }
  for (const v of views.values()) {
    if (v.owner !== me) continue;
    const [x, y] = worldToScreen(...tileToWorld(v.x, v.y));
    if (x >= box.x0 && x <= box.x1 && y - 10 >= box.y0 && y - 10 <= box.y1) selected.add(v.id);
  }
});

window.addEventListener('mousemove', (ev) => {
  mouse.x = ev.clientX;
  mouse.y = ev.clientY;
  mouse.inside = true;
});
document.addEventListener('mouseleave', () => (mouse.inside = false));
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
window.addEventListener('keydown', (ev) => {
  if ((ev.target as HTMLElement).tagName !== 'INPUT') keys.add(ev.key.toLowerCase());
});
window.addEventListener('keyup', (ev) => keys.delete(ev.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

minimap.addEventListener('mousedown', (ev) => {
  if (!map) return;
  const r = minimap.getBoundingClientRect();
  const tx = ((ev.clientX - r.left) / r.width) * map.size;
  const ty = ((ev.clientY - r.top) / r.height) * map.size;
  [cam.x, cam.y] = tileToWorld(tx, ty);
});

function resize(): void {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// --- render ----------------------------------------------------------------

function updateCamera(dt: number): void {
  const speed = 900 * dt;
  const edge = 10;
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

function renderSelectionPanel(): void {
  const el = $('selection');
  const counts = new Map<UnitKind, number>();
  let single: View | undefined;
  for (const id of selected) {
    const v = views.get(id);
    if (!v) continue;
    counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1);
    single = v;
  }
  let text = 'Nothing selected';
  if (selected.size === 1 && single) {
    text = `${single.kind[0].toUpperCase()}${single.kind.slice(1)} · HP ${single.hp}/${UNIT_STATS[single.kind].hp}`;
  } else if (selected.size > 1) {
    text = [...counts].map(([k, c]) => `${c} × ${k}`).join(' · ');
  }
  if (el.textContent !== text) el.textContent = text;
}

function renderMinimap(): void {
  if (!map || !miniTerrain) return;
  const s = minimap.width / map.size;
  mctx.imageSmoothingEnabled = false;
  mctx.drawImage(miniTerrain, 0, 0, minimap.width, minimap.height);
  for (const v of views.values()) {
    mctx.fillStyle = PLAYER_COLORS[v.owner];
    const size = v.kind === 'king' ? 4 : 3;
    mctx.fillRect(v.x * s - size / 2, v.y * s - size / 2, size, size);
  }
  const [cx, cy] = screenToTile(canvas.width / 2, canvas.height / 2);
  mctx.strokeStyle = '#fff';
  mctx.strokeRect(cx * s - 8, cy * s - 8, 16, 16);
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

  const [ox, oy] = worldToScreen(-map.size * HW, 0);
  ctx.drawImage(terrain, Math.round(ox), Math.round(oy));

  if (marker) {
    const age = (now - marker.t) / 500;
    if (age > 1) marker = undefined;
    else {
      const [mx, my] = worldToScreen(...tileToWorld(marker.x, marker.y));
      ctx.strokeStyle = `rgba(255,255,255,${1 - age})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(mx, my, 6 + age * 14, 3 + age * 7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Trees and units share one depth-sorted pass so units can walk behind trees.
  const alpha = Math.min(1, (now - snapTime) / TICK_MS);
  const drawables: { depth: number; draw: () => void }[] = [];
  for (const [tx, ty] of trees) {
    const [sx, sy] = worldToScreen(...tileToWorld(tx + 0.5, ty + 0.5));
    if (sx < -40 || sy < -10 || sx > canvas.width + 40 || sy > canvas.height + 60) continue;
    drawables.push({ depth: tx + ty + 1, draw: () => drawTree(ctx, sx, sy + 4, Math.floor(hash(tx, ty) * 3)) });
  }
  for (const v of views.values()) {
    const [x, y] = viewPos(v, alpha);
    const [sx, sy] = worldToScreen(...tileToWorld(x, y));
    drawables.push({
      depth: x + y,
      draw: () => {
        if (selected.has(v.id)) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.ellipse(sx, sy, 13, 6.5, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        const bob = v.moving ? Math.abs(Math.sin(now / 90 + v.id)) * 2 : 0;
        drawUnit(ctx, v.kind, v.owner, sx, sy, bob);
        if (selected.has(v.id)) {
          const w = 22;
          const top = sy - (v.kind === 'king' ? 34 : 30);
          ctx.fillStyle = '#300';
          ctx.fillRect(sx - w / 2, top, w, 3);
          ctx.fillStyle = '#4ad04a';
          ctx.fillRect(sx - w / 2, top, w * (v.hp / UNIT_STATS[v.kind].hp), 3);
        }
      },
    });
  }
  drawables.sort((a, b) => a.depth - b.depth);
  for (const d of drawables) d.draw();

  if (drag && (Math.abs(mouse.x - drag.x) > 4 || Math.abs(mouse.y - drag.y) > 4)) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(drag.x + 0.5, drag.y + 0.5, mouse.x - drag.x, mouse.y - drag.y);
  }

  renderSelectionPanel();
  renderMinimap();
}
requestAnimationFrame(frame);
