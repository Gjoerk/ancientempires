// Pixel art for the start menu and waiting room: background patterns, frames, arrows and gems.
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

/** Harlequin diamonds in two greens with a lighter edge and a gold pin in each. */
function harlequinPattern(): string {
  const n = 16;
  return paint(n, n, 2, (x, y) => {
    const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
    if (Math.abs(d - 7.5) < 0.6) return '#1e4a35';
    if (d < 7) return x === 7 && (y === 7 || y === 8) ? '#7a6524' : '#0f2b1e';
    return '#0a2016';
  });
}

/** A woven cloth: threads going over and under. */
function weavePattern(): string {
  return paint(8, 8, 2, (x, y) => {
    const over = ((x >> 1) + (y >> 1)) % 2 === 0;
    if ((over ? y : x) % 2 === 1) return '#0d2318';
    return over ? '#143425' : '#11301f';
  });
}

/** Border band for the tapestry: gold diamonds on crimson between two gold lines. */
function bandPattern(): string {
  return paint(12, 8, 2, (x, y) => {
    if (y === 0 || y === 7) return '#c9a54a';
    if (y === 1 || y === 6) return '#3a120e';
    const d = Math.abs(x - 5.5) + Math.abs(y - 3.5);
    if (d < 1.5) return '#f3d77e';
    if (d < 3) return '#c9a54a';
    return '#6b1f17';
  });
}

/** A 9-slice pixel frame with stepped corners: dark outline, gold rim lit from the top left, dark inner line. */
function pixelFrame(): string {
  const n = 12;
  return paint(n, n, 2, (x, y) => {
    const ex = Math.min(x, n - 1 - x);
    const ey = Math.min(y, n - 1 - y);
    if (ex + ey < 2) return undefined;
    const ring = Math.min(ex, ey);
    if (ring === 0) return '#050c08';
    if (ring === 1) return x + y < n - 1 ? '#f3d77e' : '#a8801f';
    if (ring === 2) return '#c9a54a';
    if (ring === 3) return '#050c08';
    return undefined;
  });
}

/** A 9-slice bevelled pixel button face. `inset` turns the light round for pressed buttons and inputs. */
function bevel(face: string, light: string, dark: string, inset = false): string {
  const n = 9;
  return paint(n, n, 2, (x, y) => {
    const ex = Math.min(x, n - 1 - x);
    const ey = Math.min(y, n - 1 - y);
    if (ex + ey < 1) return undefined;
    const ring = Math.min(ex, ey);
    if (ring === 0) return '#050c08';
    const lit = x + y < n - 1;
    if (ring === 1) return lit !== inset ? light : dark;
    return face;
  });
}

function arrow(color: string, shade: string): string {
  return paint(7, 5, 2, fromRows(['xxxxxxx', 'oxxxxxo', '.oxxxo.', '..oxo..', '...o...'], { x: color, o: shade }));
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

function pointer(): string {
  return paint(5, 7, 2, fromRows(['x....', 'xx...', 'xyx..', 'xyyx.', 'xyx..', 'xx...', 'x....'], { x: '#050c08', y: '#f3d77e' }));
}

export function installMenuArt(): void {
  const root = document.documentElement.style;
  const set = (name: string, value: string) => root.setProperty(name, value);
  set('--pat-fleur', fleurPattern());
  set('--pat-harlequin', harlequinPattern());
  set('--pat-weave', weavePattern());
  set('--pat-band', bandPattern());
  set('--frame-px', pixelFrame());
  set('--bevel-gold', bevel('#d9ad3c', '#fbe9a6', '#8a6417'));
  set('--bevel-gold-down', bevel('#c99a2e', '#fbe9a6', '#8a6417', true));
  set('--bevel-green', bevel('#1f4a36', '#3f7a5c', '#0b2017'));
  set('--bevel-green-down', bevel('#1a3f2e', '#3f7a5c', '#0b2017', true));
  set('--inset-px', bevel('#081a12', '#2e5a45', '#030904', true));
  set('--arrow-gold', arrow('#f3d77e', '#a8801f'));
  set('--arrow-shield', shieldArrow());
  set('--gem-red', gem('#d8413a', '#6b1f17'));
  set('--gem-green', gem('#4ed08a', '#145a35'));
  set('--pointer', pointer());
}
