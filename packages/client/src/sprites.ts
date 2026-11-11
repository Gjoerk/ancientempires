import { PROP_COLORS, PROP_VARIANTS, PropName, propArt, UNIT_COLORS, unitArt } from './pixelart';
import { Kind, Tile } from '@kingsfall/shared';
import { drawSprite, findSprite } from './assets';

export const PLAYER_COLORS = ['#3b6fd4', '#d43b3b', '#3bb85a', '#e0c12f'];

// Isometric tile half-width and half-height in screen pixels.
export const HW = 32;
export const HH = 16;

type Ctx = CanvasRenderingContext2D;

/** Pre-drawn sprites, per pixel grid and per palette object. */
const blitCache = new WeakMap<string[], WeakMap<object, Map<string, HTMLCanvasElement>>>();

/**
 * Draws rows of palette characters with the bottom centre at (x, y).
 * `flip` mirrors the sprite; `step` (1 or 2) lifts one leg for a walking frame.
 * Each combination is drawn pixel by pixel once and then reused as an image.
 * Palettes must be long-lived objects for the cache to work.
 */
function blit(
  ctx: Ctx, rows: string[], palette: Record<string, string>, x: number, y: number, px = 2, flip = false, step = 0,
): void {
  const w = rows[0].length;
  let byPalette = blitCache.get(rows);
  if (!byPalette) blitCache.set(rows, (byPalette = new WeakMap()));
  let byVariant = byPalette.get(palette);
  if (!byVariant) byPalette.set(palette, (byVariant = new Map()));
  const key = `${px}|${flip ? 1 : 0}|${step}`;
  let img = byVariant.get(key);
  if (!img) {
    img = document.createElement('canvas');
    img.width = w * px;
    img.height = rows.length * px + px;
    const c = img.getContext('2d')!;
    for (let r = 0; r < rows.length; r++) {
      const legs = step > 0 && r >= rows.length - 3;
      for (let col = 0; col < w; col++) {
        const color = palette[rows[r][col]];
        if (!color) continue;
        // While walking, the legs on one half of the sprite are drawn a pixel higher, alternating.
        const lift = legs && (col < w / 2) === (step === 1) ? px : 0;
        c.fillStyle = color;
        c.fillRect((flip ? w - 1 - col : col) * px, px + r * px - lift, px, px);
      }
    }
    byVariant.set(key, img);
  }
  ctx.drawImage(img, Math.round(x - (w * px) / 2), Math.round(y - rows.length * px) - px);
}

function shadow(ctx: Ctx, x: number, y: number, rx: number, ry: number): void {
  ctx.fillStyle = 'rgba(0,0,0,.28)';
  ctx.beginPath();
  ctx.ellipse(x + rx * 0.45, y + 1, rx * 1.15, ry * 0.8, 0.12, 0, Math.PI * 2);
  ctx.fill();
}

export interface Work {
  /** 1 wood, 2 berries, 3 gold, 4 stone, 5 farm, 6 build. */
  task: number;
  /** -1 when the work is to the left on screen, 1 when to the right. */
  dir: number;
  /** 0..1 position in the swing; 0 is the moment of impact. */
  phase: number;
}

const WORK_NAMES = ['', 'wood', 'berries', 'gold', 'stone', 'farm', 'build'];
const CHIP_COLORS = ['', '#d8b070', '#d43b5a', '#f2cf3a', '#c4c8cf', '#6e4f2c', '#d8cfae'];
export const CARRY_COLORS = ['#d43b5a', '#8a5a33', '#f2cf3a', '#b4b8bf'];

/** The tool a villager swings, drawn over the sprite. */
function drawTool(ctx: Ctx, x: number, y: number, w: Work): void {
  const raise = Math.sin(w.phase * Math.PI);
  if (w.task === 2) {
    // Picking berries: a basket at the feet and a hand reaching into the bush.
    ctx.fillStyle = '#8a5a33';
    ctx.fillRect(Math.round(x + w.dir * 9 - 4), Math.round(y - 5), 8, 5);
    ctx.fillStyle = '#b07a45';
    ctx.fillRect(Math.round(x + w.dir * 9 - 4), Math.round(y - 5), 8, 1);
    ctx.fillStyle = '#e2b48c';
    ctx.fillRect(Math.round(x + w.dir * (7 + 4 * raise) - 1), Math.round(y - 15 + 5 * (1 - raise)), 3, 3);
    if (w.phase > 0.7) {
      ctx.fillStyle = '#d43b5a';
      ctx.fillRect(Math.round(x + w.dir * 8), Math.round(y - 12 + (w.phase - 0.7) * 20), 2, 2);
    }
    return;
  }
  const hx = x + w.dir * 5;
  const hy = y - 12;
  // The tool swings from raised behind the head down to the point of impact.
  const angle = (w.task === 5 ? 0.75 : 0.45) - (w.task === 5 ? 1.7 : 2.3) * raise;
  const len = 13;
  const tx = hx + w.dir * Math.cos(angle) * len;
  const ty = hy + Math.sin(angle) * len;
  ctx.strokeStyle = '#7a5230';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  // Head: perpendicular to the handle.
  const nx = -Math.sin(angle) * w.dir;
  const ny = Math.cos(angle);
  ctx.strokeStyle = w.task === 6 ? '#55585e' : '#b9bec6';
  ctx.lineWidth = w.task === 1 || w.task === 6 ? 4 : 2;
  ctx.beginPath();
  if (w.task === 1) {
    // Axe blade on one side.
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx + nx * 5, ty + ny * 5);
  } else if (w.task === 5) {
    // Hoe blade pointing down.
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx + nx * 4, ty + ny * 4);
  } else if (w.task === 6) {
    ctx.moveTo(tx - nx * 3, ty - ny * 3);
    ctx.lineTo(tx + nx * 3, ty + ny * 3);
  } else {
    // Pickaxe: a head across the handle.
    ctx.moveTo(tx - nx * 6, ty - ny * 6);
    ctx.lineTo(tx + nx * 6, ty + ny * 6);
  }
  ctx.stroke();
  // Chips fly off right after the blow lands.
  if (w.phase < 0.25) {
    const k = w.phase / 0.25;
    ctx.fillStyle = CHIP_COLORS[w.task];
    for (let i = 0; i < 3; i++) {
      const fx = x + w.dir * (15 + k * (4 + i * 4));
      const fy = y - 8 - k * (10 - i * 3) + k * k * 12;
      ctx.fillRect(Math.round(fx), Math.round(fy), 2, 2);
    }
  }
}

/** How tall a unit is drawn, for placing its health bar above it. */
export function unitHeight(kind: Kind): number {
  return unitArt(kind, 0).length;
}

/** How wide a unit is drawn, for fitting it into a portrait. */
export function unitWidth(kind: Kind): number {
  return unitArt(kind, 0)[0].length;
}

const unitPalettes = new Map<number, Record<string, string>>();
function unitPalette(owner: number): Record<string, string> {
  let palette = unitPalettes.get(owner);
  if (!palette) {
    palette = { ...UNIT_COLORS, t: PLAYER_COLORS[owner % PLAYER_COLORS.length] };
    for (const [key, color] of Object.entries(palette)) palette[key.toUpperCase()] = shade(color, 0.72);
    unitPalettes.set(owner, palette);
  }
  return palette;
}

export function drawUnit(
  ctx: Ctx, kind: Kind, owner: number, x: number, y: number, bob: number, work?: Work, carry = -1, activity = 0, now = 0,
  face = 1,
): void {
  const big = kind === 'king' || kind === 'rider' || kind === 'scout' || kind === 'ram';
  // Sprites are drawn facing right and mirrored to face left.
  const flip = (work ? work.dir : face) < 0;
  const step = activity === 1 ? 1 + (Math.floor(now / 140) % 2) : 0;
  // A sprite pack may provide this unit, optionally with separate images per activity.
  const state = work ? `work.${WORK_NAMES[work.task]}` : ['idle', 'walk', 'work', 'attack'][activity] ?? 'idle';
  const custom = findSprite([`unit.${kind}.${state}`, `unit.${kind}.${state.split('.')[0]}`, `unit.${kind}`]);
  if (custom) {
    if (custom.def.shadow !== false) shadow(ctx, x, y, big ? 12 : 8, big ? 5 : 4);
    drawSprite(ctx, custom, PLAYER_COLORS[owner % PLAYER_COLORS.length], x, y - bob, now, flip);
    // Without a dedicated working image, the built-in tool is swung over the sprite.
    if (work && !custom.key.includes('.work')) drawTool(ctx, x, y - bob, work);
    return;
  }
  shadow(ctx, x, y, big ? 12 : 8, big ? 5 : 4);
  const palette = unitPalette(owner);
  if (carry >= 0 && !work) {
    // A bundle of whatever is being carried home, on the back.
    ctx.fillStyle = CARRY_COLORS[carry];
    const bx = flip ? 5 : -11;
    ctx.fillRect(Math.round(x + bx), Math.round(y - 17 - bob), 6, 6);
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.fillRect(Math.round(x + bx), Math.round(y - 12 - bob), 6, 1);
  }
  blit(ctx, unitArt(kind, step), palette, x, y - bob, 1, flip, 0);
  if (work) drawTool(ctx, x, y - bob, work);
}

const PROP_NAMES: Record<number, string> = { [Tile.Forest]: 'tree', [Tile.Berries]: 'berries', [Tile.Gold]: 'gold', [Tile.Stone]: 'stone' };

/**
 * Draws the thing standing on a resource tile, with (x, y) at the tile centre. `lean` moves the top
 * of a tree sideways by that many pixels, for the wind: the picture is cut into bands that shift by
 * whole pixels, more towards the top, so the pixel art stays sharp.
 */
export function drawProp(ctx: Ctx, tile: number, x: number, y: number, variant: number, now = 0, lean = 0): void {
  const name = PROP_NAMES[tile];
  const custom = findSprite([`resource.${name}.${variant % 3}`, `resource.${name}`]);
  if (custom) {
    if (custom.def.shadow !== false) shadow(ctx, x, y + 5, 12, 5);
    drawSprite(ctx, custom, '#ffffff', x, y, now);
    return;
  }
  // Shadow and sprite together are drawn once per kind and variant, then reused.
  const art = propArt(name as PropName, variant);
  const key = `${name}|${variant % PROP_VARIANTS[name as PropName]}`;
  let img = propCache.get(key);
  if (!img) {
    const w = art[0].length;
    const h = art.length;
    // Room below the base for the shadow, which falls to the lower right like the buildings'.
    img = document.createElement('canvas');
    img.width = w + 16;
    img.height = h + 8;
    const c = img.getContext('2d')!;
    const tall = name === 'tree';
    shadow(c, w / 2 + 2, h - 1, tall ? 22 : 14, tall ? 9 : 5);
    blit(c, art, PROP_PALETTE, w / 2, h + 1, 1);
    propCache.set(key, img);
  }
  // The base sits a little in front of the tile centre.
  const left = Math.round(x - (img.width - 16) / 2);
  const top = Math.round(y + PROP_BASE[name] - (img.height - 8));
  if (Math.abs(lean) < 0.5) {
    ctx.drawImage(img, left, top);
    return;
  }
  // The trunk and shadow stay put; the crown above moves in up to three steps.
  const keep = Math.round(img.height * 0.42);
  ctx.drawImage(img, 0, img.height - keep, img.width, keep, left, top + img.height - keep, img.width, keep);
  const bands = Math.abs(lean) >= 2 ? 3 : 2;
  const rest = img.height - keep;
  for (let i = 0; i < bands; i++) {
    const y0 = Math.round((rest * (bands - 1 - i)) / bands);
    const y1 = Math.round((rest * (bands - i)) / bands);
    const dx = Math.round((lean * (i + 1)) / bands);
    ctx.drawImage(img, 0, y0, img.width, y1 - y0, left + dx, top + y0, img.width, y1 - y0);
  }
}

const PROP_BASE: Record<string, number> = { tree: 5, berries: 6, gold: 7, stone: 7 };
const propCache = new Map<string, HTMLCanvasElement>();
const PROP_PALETTE: Record<string, string> = (() => {
  const palette: Record<string, string> = { ...PROP_COLORS };
  for (const [key, color] of Object.entries(PROP_COLORS)) palette[key.toUpperCase()] = shade(color, 0.72);
  return palette;
})();

/** A colour made lighter (f > 1) or darker (f < 1); takes '#rrggbb' or 'rgb(r,g,b)'. */
export function shade(color: string, f: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  if (color.startsWith('rgb')) {
    const [r, g, b] = color.slice(color.indexOf('(') + 1).split(',').map((v) => parseFloat(v));
    return `rgb(${c(r)},${c(g)},${c(b)})`;
  }
  const n = parseInt(color.slice(1), 16);
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

// A relic: a small golden shrine with a cross and a red gem, glinting now and then.
const RELIC = [
  '.....w.....',
  '....www....',
  '.....w.....',
  '..ooooooo..',
  '.oyyyyyyyo.',
  'oyyyyryyyyo',
  'oyYyyyyyYyo',
  'oyYyyyyyYyo',
  'oYYYYYYYYYo',
  '.ooooooooo.',
];
const RELIC_PALETTE: Record<string, string> = { o: '#6b4a1a', y: '#f2c93a', Y: '#c99a20', r: '#c8302f', w: '#fff4c2' };

/** Draws a relic with its foot at (x, y); `carried` draws it smaller, held up by a monk. */
export function drawRelic(ctx: Ctx, x: number, y: number, now: number, carried: boolean): void {
  if (!carried) shadow(ctx, x, y, 7, 3);
  blit(ctx, RELIC, RELIC_PALETTE, x, y + (carried ? 0 : Math.sin(now / 600) * 1.2 - 1), carried ? 1 : 2);
  // A glint that sweeps across now and then.
  const k = (now % 2600) / 2600;
  if (k < 0.25) {
    ctx.fillStyle = `rgba(255,255,230,${(Math.sin((k / 0.25) * Math.PI) * 0.9).toFixed(3)})`;
    const s = carried ? 1 : 2;
    ctx.fillRect(Math.round(x - 4 * s + k * 32 * s), Math.round(y - 8 * s), s, 3 * s);
  }
}
