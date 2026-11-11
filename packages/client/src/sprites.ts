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

// Palette letters: s skin, e eye, t team colour, l leg, d boot, h hair, m metal,
// w blade/bowstring, k wood, g hood, c cape, y gold, o horse, n horse dark.
const UNIT_SPRITES: Partial<Record<Kind, string[]>> = {
  villager: [
    '..hhhh..',
    '..ssss..',
    '..sees..',
    '..ssss..',
    '.tttttt.',
    'sttttts.',
    'sttdtts.',
    '.tttttt.',
    '..l..l..',
    '..l..l..',
    '..d..d..',
  ],
  king: [
    '..y.y.y...',
    '..yyyyy...',
    '..sssss...',
    '..sesse...',
    '..sssss...',
    '.wwwwwww..',
    'cttttttwc.',
    'cttyttttc.',
    'cttttttcc.',
    'cctttttcc.',
    'cc.l.l.cc.',
    '...l.l....',
    '...d.d....',
  ],
  swordsman: [
    '..mmmm..w.',
    '..mssm..w.',
    '..sees..w.',
    '..ssss..w.',
    '.tttttt.w.',
    'stttttskkk',
    'sttmttt.k.',
    '.tttttt...',
    '..m..m....',
    '..m..m....',
    '..d..d....',
  ],
  spearman: [
    '........w.',
    '..mmmm..w.',
    '..ssss..k.',
    '..sees..k.',
    '..ssss..k.',
    '.tttttt.k.',
    'sttttttsk.',
    'sttttts.k.',
    '.tttttt.k.',
    '..l..l..k.',
    '..l..l....',
    '..d..d....',
  ],
  archer: [
    '..gggg..k.',
    '.gssssgk.w',
    '..sees.k.w',
    '..ssss.k.w',
    '.ttttttk.w',
    'stttttsk.w',
    'sttttt.k.w',
    '.tttttt.kw',
    '..l..l....',
    '..l..l....',
    '..d..d....',
  ],
  ram: [
    '...kkkkkkkkk....',
    '..ktttttttttk...',
    '.kkkkkkkkkkkkk..',
    '.k.ooooooooommm.',
    '.k.ooooooooommm.',
    '.kkkkkkkkkkkkk..',
    '..nn......nn....',
    '..nn......nn....',
  ],
  monk: [
    '...oo....',
    '..oooo...',
    '..osso.k.',
    '..oseo.k.',
    '.oooooo.k',
    'oootttoowk',
    'oooooooo.k',
    '.oooooo..k',
    '.oooooo..k',
    '.oooooo..k',
    '..o..o...k',
    '..d..d...k',
  ].map((r) => r.padEnd(10, '.')),
  scout: [
    '....hhhh......',
    '....ssss......',
    '....sees......',
    '...tttttt..nn.',
    '..sttttts.oooo',
    '..ooooooooooeo',
    '.oootttoooooo.',
    'noooooooooo...',
    'n.ooooooooo...',
    '..oo.....oo...',
    '..oo.....oo...',
    '..nn.....nn...',
  ],
  rider: [
    '....mmmm......',
    '....ssss......',
    '....sees......',
    '...tttttt..nn.',
    '..sttttts.oooo',
    '..ooooooooooeo',
    '.oooottoooooo.',
    'noooottoooo...',
    'n.ooooooooo...',
    '..oo.....oo...',
    '..oo.....oo...',
    '..nn.....nn...',
  ],
};

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

const unitPalettes = new Map<number, Record<string, string>>();
function unitPalette(owner: number): Record<string, string> {
  let palette = unitPalettes.get(owner);
  if (!palette) {
    palette = {
      s: '#e2b48c', e: '#2a2018', l: '#6b4a2b', d: '#3a2a1a', h: '#5a3b1e', m: '#9aa0a8', w: '#e6e9ee', k: '#7a5230',
      g: '#3f6b3a', c: '#7a2d8a', y: '#f2cf3a', o: '#8a5a33', n: '#4a2e18', t: PLAYER_COLORS[owner % PLAYER_COLORS.length],
    };
    unitPalettes.set(owner, palette);
  }
  return palette;
}

export function drawUnit(
  ctx: Ctx, kind: Kind, owner: number, x: number, y: number, bob: number, work?: Work, carry = -1, activity = 0, now = 0,
  face = 1,
): void {
  const big = kind === 'king' || kind === 'rider' || kind === 'scout' || kind === 'ram';
  // The monk's robe is brown, so his palette uses the horse colour for it.
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
  blit(ctx, UNIT_SPRITES[kind] ?? UNIT_SPRITES.villager!, palette, x, y - bob, 2, flip, step);
  if (work) drawTool(ctx, x, y - bob, work);
}

const TREE = [
  '....aa....',
  '...aaba...',
  '..aabbaa..',
  '..abbbba..',
  '.aabbbbaa.',
  '.abbbbbba.',
  'aabbbbbbaa',
  '.abbbbbba.',
  '..aabbaa..',
  '....kk....',
  '....kk....',
  '....kk....',
];
const BUSH = [
  '..aaaa..',
  '.arabaa.',
  'aabaaraa',
  'araabaab',
  '.aaraaa.',
];
const ROCK = [
  '...ss...',
  '..sysss.',
  '.ssyssys',
  'sysssyss',
  'ssssysss',
];

const PROP_NAMES: Record<number, string> = { [Tile.Forest]: 'tree', [Tile.Berries]: 'berries', [Tile.Gold]: 'gold', [Tile.Stone]: 'stone' };

/** Draws the thing standing on a resource tile, with (x, y) at the tile centre. */
export function drawProp(ctx: Ctx, tile: number, x: number, y: number, variant: number, now = 0): void {
  const name = PROP_NAMES[tile];
  const custom = findSprite([`resource.${name}.${variant}`, `resource.${name}`]);
  if (custom) {
    if (custom.def.shadow !== false) shadow(ctx, x, y + 5, 12, 5);
    drawSprite(ctx, custom, '#ffffff', x, y, now);
    return;
  }
  // Shadow and sprite together are drawn once per kind and variant, then reused.
  const key = tile * 10 + (tile === Tile.Forest ? variant % 3 : 0);
  let img = propCache.get(key);
  if (!img) {
    img = document.createElement('canvas');
    img.width = 48;
    img.height = 48;
    const c = img.getContext('2d')!;
    const [cx, cy] = [24, 36];
    if (tile === Tile.Forest) {
      shadow(c, cx, cy + 4, 10, 5);
      blit(c, TREE, TREE_PALETTES[variant % 3], cx, cy + 4);
    } else if (tile === Tile.Berries) {
      shadow(c, cx, cy + 5, 12, 5);
      blit(c, BUSH, BUSH_PALETTE, cx, cy + 7, 3);
    } else if (tile === Tile.Gold) {
      shadow(c, cx, cy + 5, 13, 5);
      blit(c, ROCK, GOLD_PALETTE, cx, cy + 7, 3);
    } else if (tile === Tile.Stone) {
      shadow(c, cx, cy + 5, 13, 5);
      blit(c, ROCK, STONE_PALETTE, cx, cy + 7, 3);
    }
    propCache.set(key, img);
  }
  ctx.drawImage(img, Math.round(x) - 24, Math.round(y) - 36);
}

const propCache = new Map<number, HTMLCanvasElement>();
const TREE_PALETTES = [['#2f6b2c', '#3f8a37'], ['#28602f', '#37803f'], ['#356e25', '#4a9030']].map(([a, b]) => ({ a, b, k: '#5a3b1e' }));
const BUSH_PALETTE = { a: '#2f6b2c', b: '#4a9030', r: '#d43b5a' };
const GOLD_PALETTE = { s: '#7a6f5a', y: '#f2cf3a' };
const STONE_PALETTE = { s: '#85898f', y: '#c4c8cf' };

export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
