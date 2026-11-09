import { DEFS, Kind, Tile } from '@kingsfall/shared';

export const PLAYER_COLORS = ['#3b6fd4', '#d43b3b', '#3bb85a', '#e0c12f'];

// Isometric tile half-width and half-height in screen pixels.
export const HW = 32;
export const HH = 16;

type Ctx = CanvasRenderingContext2D;

/** Draws rows of palette characters with the bottom centre at (x, y). */
function blit(ctx: Ctx, rows: string[], palette: Record<string, string>, x: number, y: number, px = 2): void {
  const w = rows[0].length;
  const ox = Math.round(x - (w * px) / 2);
  const oy = Math.round(y - rows.length * px);
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < w; c++) {
      const color = palette[rows[r][c]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(ox + c * px, oy + r * px, px, px);
    }
  }
}

function shadow(ctx: Ctx, x: number, y: number, rx: number, ry: number): void {
  ctx.fillStyle = 'rgba(0,0,0,.28)';
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
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

export function drawUnit(ctx: Ctx, kind: Kind, owner: number, x: number, y: number, bob: number): void {
  const big = kind === 'king' || kind === 'rider';
  shadow(ctx, x, y, big ? 12 : 8, big ? 5 : 4);
  const palette = {
    s: '#e2b48c', e: '#2a2018', l: '#6b4a2b', d: '#3a2a1a', h: '#5a3b1e', m: '#9aa0a8', w: '#e6e9ee', k: '#7a5230',
    g: '#3f6b3a', c: '#7a2d8a', y: '#f2cf3a', o: '#8a5a33', n: '#4a2e18', t: PLAYER_COLORS[owner % PLAYER_COLORS.length],
  };
  blit(ctx, UNIT_SPRITES[kind] ?? UNIT_SPRITES.villager!, palette, x, y - bob);
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

/** Draws the thing standing on a resource tile, with (x, y) at the tile centre. */
export function drawProp(ctx: Ctx, tile: number, x: number, y: number, variant: number): void {
  if (tile === Tile.Forest) {
    shadow(ctx, x, y + 4, 10, 5);
    const greens = [['#2f6b2c', '#3f8a37'], ['#28602f', '#37803f'], ['#356e25', '#4a9030']][variant % 3];
    blit(ctx, TREE, { a: greens[0], b: greens[1], k: '#5a3b1e' }, x, y + 4);
  } else if (tile === Tile.Berries) {
    shadow(ctx, x, y + 5, 12, 5);
    blit(ctx, BUSH, { a: '#2f6b2c', b: '#4a9030', r: '#d43b5a' }, x, y + 7, 3);
  } else if (tile === Tile.Gold) {
    shadow(ctx, x, y + 5, 13, 5);
    blit(ctx, ROCK, { s: '#7a6f5a', y: '#f2cf3a' }, x, y + 7, 3);
  } else if (tile === Tile.Stone) {
    shadow(ctx, x, y + 5, 13, 5);
    blit(ctx, ROCK, { s: '#85898f', y: '#c4c8cf' }, x, y + 7, 3);
  }
}

interface Look {
  wall: string;
  roof: string;
  /** Wall height and roof height in pixels. A roof height of 0 gives a flat top. */
  h: number;
  roofH: number;
}

const LOOKS: Partial<Record<Kind, Look>> = {
  towncenter: { wall: '#b9a98a', roof: '#8a4a2f', h: 26, roofH: 26 },
  house: { wall: '#c9b08a', roof: '#9a4a2f', h: 14, roofH: 16 },
  storehouse: { wall: '#8a6a45', roof: '#5f4326', h: 14, roofH: 9 },
  barracks: { wall: '#9a8f80', roof: '#5c2e2e', h: 20, roofH: 14 },
  range: { wall: '#a89070', roof: '#3f6b3a', h: 18, roofH: 14 },
  stable: { wall: '#a07850', roof: '#b08a3a', h: 18, roofH: 12 },
  tower: { wall: '#9c9c9c', roof: '#7c7c7c', h: 46, roofH: 0 },
};

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

function poly(ctx: Ctx, color: string, pts: number[]): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draws a building whose footprint's top corner is at (sx, sy) on screen.
 * `built` is 0..1; unfinished buildings are drawn as a low, see-through shell.
 */
export function drawBuilding(ctx: Ctx, kind: Kind, owner: number, sx: number, sy: number, built: number): void {
  const s = DEFS[kind].size ?? 1;
  const team = PLAYER_COLORS[owner % PLAYER_COLORS.length];
  const m = kind === 'farm' ? 0.06 : 0.14;
  const at = (u: number, v: number): [number, number] => [sx + (u - v) * HW, sy + (u + v) * HH];
  const T = at(m, m);
  const R = at(s - m, m);
  const B = at(s - m, s - m);
  const L = at(m, s - m);

  if (kind === 'farm') {
    poly(ctx, built < 1 ? '#7a6a4a' : '#8a6a3a', [...T, ...R, ...B, ...L]);
    ctx.strokeStyle = built < 1 ? '#6a5a3e' : '#b89a4a';
    ctx.lineWidth = 2;
    for (let i = 1; i < 6; i++) {
      const a = at(m + ((s - 2 * m) * i) / 6, m);
      const b = at(m + ((s - 2 * m) * i) / 6, s - m);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    ctx.fillStyle = team;
    ctx.fillRect(T[0] - 2, T[1] - 10, 4, 12);
    return;
  }

  const look = LOOKS[kind] ?? LOOKS.house!;
  const done = built >= 1;
  const h = done ? look.h : Math.max(4, look.h * built);
  ctx.globalAlpha = done ? 1 : 0.75;
  shadow(ctx, sx + 6, sy + s * HH + 4, s * HW * 0.9, s * HH * 0.9);
  poly(ctx, shade(look.wall, 0.72), [...L, ...B, B[0], B[1] - h, L[0], L[1] - h]);
  poly(ctx, shade(look.wall, 0.92), [...B, ...R, R[0], R[1] - h, B[0], B[1] - h]);
  const top = [T[0], T[1] - h, R[0], R[1] - h, B[0], B[1] - h, L[0], L[1] - h];
  if (!done || look.roofH === 0) {
    poly(ctx, done ? look.roof : shade(look.wall, 1.1), top);
  } else {
    const ax = sx;
    const ay = sy + s * HH - h - look.roofH;
    poly(ctx, shade(look.roof, 0.8), [top[0], top[1], top[2], top[3], ax, ay]);
    poly(ctx, shade(look.roof, 0.8), [top[0], top[1], top[6], top[7], ax, ay]);
    poly(ctx, shade(look.roof, 0.78), [top[6], top[7], top[4], top[5], ax, ay]);
    poly(ctx, look.roof, [top[4], top[5], top[2], top[3], ax, ay]);
  }
  ctx.globalAlpha = 1;
  if (!done) return;

  // Door on the right wall, and a flag in the owner's colour.
  if (kind !== 'tower') {
    const d = at(s - m, s / 2);
    ctx.fillStyle = '#3a2a1a';
    ctx.fillRect(d[0] - 4, d[1] - 12, 8, 12);
  } else {
    ctx.fillStyle = shade(look.wall, 0.6);
    for (const [px, py] of [L, B, R]) ctx.fillRect(px - 3, py - h - 5, 6, 5);
    ctx.fillStyle = '#2a2018';
    ctx.fillRect(sx + 6, sy + HH - h + 14, 3, 8);
  }
  const fx = sx;
  const fy = sy + s * HH - h - look.roofH;
  ctx.fillStyle = '#3a2a1a';
  ctx.fillRect(fx - 1, fy - 16, 2, 16);
  ctx.fillStyle = team;
  ctx.fillRect(fx + 1, fy - 16, 10, 7);
}
