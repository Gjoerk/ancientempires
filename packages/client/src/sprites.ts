import type { UnitKind } from '@kingsfall/shared';

export const PLAYER_COLORS = ['#3b6fd4', '#d43b3b', '#3bb85a', '#e0c12f'];

/** One sprite pixel in screen pixels. */
const PX = 2;

type Ctx = CanvasRenderingContext2D;

/** Draws rows of palette characters with the bottom centre at (x, y). */
function blit(ctx: Ctx, rows: string[], palette: Record<string, string>, x: number, y: number): void {
  const w = rows[0].length;
  const ox = Math.round(x - (w * PX) / 2);
  const oy = Math.round(y - rows.length * PX);
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < w; c++) {
      const color = palette[rows[r][c]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(ox + c * PX, oy + r * PX, PX, PX);
    }
  }
}

const VILLAGER = [
  '..hhhh..',
  '..ssss..',
  '..sees..',
  '..ssss..',
  '.tttttt.',
  'sttttts.',
  'sttbtts.',
  '.tttttt.',
  '..l..l..',
  '..l..l..',
  '..d..d..',
];

const KING = [
  '..g.g.g...',
  '..ggggg...',
  '..sssss...',
  '..sesse...',
  '..sssss...',
  '.wwwwwww..',
  'cttttttwc.',
  'cttgttttc.',
  'cttttttcc.',
  'cctttttcc.',
  'cc.l.l.cc.',
  '...l.l....',
  '...d.d....',
];

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

export function drawUnit(ctx: Ctx, kind: UnitKind, owner: number, x: number, y: number, bob: number): void {
  ctx.fillStyle = 'rgba(0,0,0,.3)';
  ctx.beginPath();
  ctx.ellipse(x, y, kind === 'king' ? 11 : 8, kind === 'king' ? 5 : 4, 0, 0, Math.PI * 2);
  ctx.fill();
  const team = PLAYER_COLORS[owner % PLAYER_COLORS.length];
  const base = { s: '#e2b48c', e: '#2a2018', l: '#6b4a2b', d: '#3a2a1a', h: '#5a3b1e', b: '#3a2a1a' };
  if (kind === 'king') {
    blit(ctx, KING, { ...base, t: team, c: '#7a2d8a', g: '#f2cf3a', w: '#f1ead9' }, x, y - bob);
  } else {
    blit(ctx, VILLAGER, { ...base, t: team }, x, y - bob);
  }
}

export function drawTree(ctx: Ctx, x: number, y: number, variant: number): void {
  ctx.fillStyle = 'rgba(0,0,0,.25)';
  ctx.beginPath();
  ctx.ellipse(x, y, 10, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  const greens = [['#2f6b2c', '#3f8a37'], ['#28602f', '#37803f'], ['#356e25', '#4a9030']][variant % 3];
  blit(ctx, TREE, { a: greens[0], b: greens[1], k: '#5a3b1e' }, x, y);
}
