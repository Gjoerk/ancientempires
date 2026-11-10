import { PLAYER_COLORS, shade } from './sprites';

// Pixel art for the start menu and waiting room: the fleur-de-lis pattern, the shield arrow and gems.
// Everything is drawn once into small images and handed to the page as CSS variables.

type Px = (x: number, y: number) => string | undefined;

function paint(w: number, h: number, scale: number, pixel: Px): string {
  const c = document.createElement('canvas');
  c.width = w * scale;
  c.height = h * scale;
  const g = c.getContext('2d')!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const color = pixel(x, y);
      if (!color) continue;
      g.fillStyle = color;
      g.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  return `url(${c.toDataURL()})`;
}

function fromRows(rows: string[], palette: Record<string, string>): Px {
  return (x, y) => palette[rows[y]?.[x] ?? '.'];
}

const FLEUR = [
  '.....x.....',
  '....xxx....',
  '....xxx....',
  '.x..xxx..x.',
  'xx..xxx..xx',
  'x.x.xxx.x.x',
  'x..xxxxx..x',
  '.xx.xxx.xx.',
  '...xxxxx...',
  '....x.x....',
  '...xx.xx...',
];

/** Dark green with fleurs-de-lis in a half-drop repeat and a tiny gold dot between them. */
function fleurPattern(): string {
  const n = 24;
  return paint(n, n, 2, (x, y) => {
    for (const [ox, oy] of [[1, 1], [13, 13]]) {
      const ch = FLEUR[(y - oy + n) % n]?.[(x - ox + n) % n];
      if (ch === 'x') return '#173a2b';
    }
    if ((x === 18 && y === 6) || (x === 6 && y === 18)) return '#5d5a26';
    return undefined;
  });
}

/** A little heraldic shield with a chevron pointing down, for dropdowns on the banner. */
function shieldArrow(): string {
  return paint(9, 10, 2, fromRows([
    'ggggggggg', 'gdddddddg', 'gdyddddyg', 'gddyddydg', 'gdddyyddg', 'gdddddddg', '.gdddddg.', '..gdddg..', '...gdg...', '....g....',
  ].map((r) => r.padEnd(9, '.')), { g: '#c9a54a', d: '#173a2b', y: '#f3d77e' }));
}

function gem(core: string, rim: string): string {
  return paint(7, 7, 2, fromRows(['...r...', '..rcr..', '.rcwcr.', 'rcwcccr', '.rcccr.', '..rcr..', '...r...'], { r: rim, c: core, w: '#ffffff' }));
}

export function installMenuArt(): void {
  const root = document.documentElement.style;
  root.setProperty('--pat-fleur', fleurPattern());
  root.setProperty('--arrow-shield', shieldArrow());
  // One gem per player and team colour, numbered like the teams.
  PLAYER_COLORS.forEach((color, i) => root.setProperty(`--gem-${i}`, gem(color, shade(color, 0.45))));
}
