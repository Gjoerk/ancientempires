import type { Kind } from '@kingsfall/shared';

/**
 * Built-in art for units and resources, painted from parts at one screen pixel per art pixel.
 * Shapes are filled with flat colour letters; each area then gets a darker lower-right edge and an
 * outline in a darker shade of the colour next to it, which keeps things readable on the grass.
 *
 * Units face right with the feet on the bottom row. Frames: 0 standing, 1 and 2 walking.
 * Every unit has its own outline: straw hat, big shield, tall spear, hood and bow, robe and staff,
 * crown and cape, light horse, armoured horse with lance, and the ram's shed.
 */

/** Base colours of units. Upper case letters are the same colours darker. */
export const UNIT_COLORS: Record<string, string> = {
  s: '#e8b98f', e: '#2a1f18', l: '#6b4a2b', d: '#33241a', h: '#5a3b1e', m: '#a3aab3', a: '#646b74', w: '#eef0f3',
  k: '#8a5a30', n: '#4a2e18', o: '#8f5f36', u: '#c99a62', g: '#4d7a3f', c: '#7a2d8a', y: '#f0c93a', r: '#c8302f',
  b: '#f4efe2', f: '#dcb75e',
};

/** Base colours of trees, bushes and rocks. */
export const PROP_COLORS: Record<string, string> = {
  a: '#24512a', b: '#33703a', c: '#4f9244', v: '#6fae4f', p: '#3b6b2a', q: '#5c8f33', x: '#7fa83c',
  k: '#6a4426', n: '#3f2816', w: '#f3f1e8', r: '#c92f45', j: '#7d2350', z: '#ff8aa0',
  s: '#9a8a68', t: '#bfae88', y: '#f2c93a', o: '#ffe680', m: '#878c93', i: '#a9aeb5', l: '#cdd1d6', e: '#23201c',
};

class Pen {
  readonly g: string[][];
  constructor(readonly w: number, readonly h: number) {
    this.g = Array.from({ length: h }, () => Array<string>(w).fill('.'));
  }
  dot(x: number, y: number, c: string): void {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix >= 0 && iy >= 0 && ix < this.w && iy < this.h) this.g[iy][ix] = c;
  }
  get(x: number, y: number): string {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.g[y][x] : '.';
  }
  rect(x: number, y: number, w: number, h: number, c: string): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.dot(x + i, y + j, c);
  }
  /** Fills an ellipse; `paint` may pick the letter per pixel from its position in the ellipse (-1..1). */
  ellipse(cx: number, cy: number, rx: number, ry: number, paint: string | ((dx: number, dy: number, x: number, y: number) => string)): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / (rx + 0.35);
        const dy = (y - cy) / (ry + 0.35);
        if (dx * dx + dy * dy <= 1) this.dot(x, y, typeof paint === 'string' ? paint : paint(dx, dy, x, y));
      }
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, c: string, thick = 1): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const y = y0 + ((y1 - y0) * i) / n;
      this.dot(x, y, c);
      if (thick > 1) this.dot(x + 1, y, c);
    }
  }
}

const darker = (c: string) => (c >= 'a' && c <= 'z' ? c.toUpperCase() : c);

/** Shading and outline, then cropped around the content: the feet (or base) row stays at the bottom, centred on `cx`. */
function finish(p: Pen, cx: number, base: number, shadeEdges = true): string[] {
  const g = p.g;
  const { w, h } = p;
  if (shadeEdges) {
    // Light from the upper left: the lower right edge of each area is darker.
    const copy = g.map((r) => r.slice());
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const c = copy[y][x];
        if (c === '.' || c === 'e' || c < 'a' || c > 'z') continue;
        const edge = copy[y][x + 1] !== c || copy[y + 1][x] !== c;
        const thick = copy[y][x - 1] === c && copy[y - 1][x] === c;
        if (edge && thick) g[y][x] = darker(c);
      }
    }
  }
  const copy = g.map((r) => r.slice());
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (copy[y][x] !== '.') continue;
      const near = [copy[y - 1]?.[x], copy[y + 1]?.[x], copy[y][x - 1], copy[y][x + 1]].find((c) => c && c !== '.');
      if (near) g[y][x] = near === 'e' ? 'e' : darker(near.toLowerCase());
    }
  }
  let minX = w;
  let maxX = 0;
  let minY = h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (g[y][x] === '.') continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
    }
  }
  const half = Math.max(cx - minX, maxX + 1 - cx);
  return g.slice(minY, base + 2).map((r) => r.slice(cx - half, cx + half).join(''));
}

// --- units -----------------------------------------------------------------------------------

const HEAD = 3;
const TORSO = 10;
const WIDTH = 7;
const LEGS = 10;
const HORSE_RX = 9;
const HORSE_RY = 4;
const HORSE_LEGS = 8;

const UW = 48;
const UH = 60;
const CX = 24;
const GY = UH - 3;

interface Figure {
  hip: number;
  top: number;
  headX: number;
  headY: number;
  handX: number;
  handY: number;
  left: number;
  right: number;
}

/** A person standing on the ground: legs, torso, front arm and a bare head. */
function person(p: Pen, frame: number, cloth: string, opts: { legs?: string; robe?: boolean; scale?: number } = {}): Figure {
  const k = opts.scale ?? 1;
  const legs = Math.round(LEGS * k);
  const torso = Math.round(TORSO * k);
  const width = WIDTH + (k > 1 ? 2 : 0);
  const hip = GY - legs + 1;
  const top = hip - torso;
  const left = CX - Math.floor(width / 2);
  const right = left + width - 1;
  if (opts.robe) {
    // A robe down to the ground, widening at the hem; the feet peek out in turn while walking.
    for (let y = top; y <= GY; y++) {
      const grow = Math.floor(((y - top) / (GY - top)) * 2);
      p.rect(left - grow, y, width + grow * 2, 1, cloth);
    }
    if (frame === 1) p.rect(right, GY, 2, 1, 'd');
    if (frame === 2) p.rect(left - 2, GY, 2, 1, 'd');
  } else {
    const back = [CX - 3, GY];
    const front = [CX + 1, GY];
    if (frame === 1) {
      back[0] -= 1;
      front[0] += 1;
    } else if (frame === 2) {
      back[0] += 1;
      back[1] -= 1;
      front[0] -= 1;
    }
    for (const [x, foot] of [back, front]) {
      p.rect(x, hip, 2, foot - hip + 1, opts.legs ?? 'l');
      p.rect(x, foot - 1, x === front[0] ? 3 : 2, 2, 'd');
    }
    p.rect(left, top, width, torso, cloth);
  }
  p.dot(left, top, '.');
  p.dot(right, top, '.');
  if (!opts.robe) p.rect(left, hip - 2, width, 1, 'n');
  const headX = CX + 0.5;
  const headY = top - HEAD + 0.5;
  p.ellipse(headX, headY, HEAD, HEAD, 's');
  p.dot(Math.round(headX + HEAD - 1), Math.round(headY), 'e');
  const handY = top + Math.max(3, torso - 3);
  p.rect(right, top + 1, 2, handY - top - 1, cloth.toUpperCase());
  p.rect(right, handY, 2, 2, 's');
  return { hip, top, headX, headY, handX: right + 1, handY, left, right };
}

function hair(p: Pen, f: Figure, c = 'h'): void {
  for (let y = Math.floor(f.headY - HEAD); y <= f.headY; y++) {
    for (let x = Math.floor(f.headX - HEAD); x <= f.headX + HEAD; x++) {
      if (p.get(x, y) !== 's') continue;
      if (y < f.headY - HEAD + 2 || x < f.headX - 1) p.dot(x, y, c);
    }
  }
}

function villager(p: Pen, frame: number): void {
  const f = person(p, frame, 't');
  hair(p, f);
  // A wide straw hat: the villager's mark.
  const brim = Math.round(f.headY - HEAD + 1);
  p.rect(Math.round(f.headX - HEAD - 2), brim, HEAD * 2 + 5, 1, 'f');
  p.ellipse(f.headX, brim - 1, HEAD - 1, 1.2, 'f');
  p.rect(Math.round(f.headX - HEAD + 1), brim, HEAD * 2 - 1, 1, 'F');
  // A brown apron over the tunic and a pouch on the belt.
  p.rect(CX - 1, f.hip - 4, 3, 4, 'o');
  p.rect(f.left, f.hip - 1, 2, 2, 'o');
}

function king(p: Pen, frame: number): void {
  // The cape hangs behind him, down to the heels.
  const top = GY - Math.round(LEGS * 1.1) + 1 - Math.round(TORSO * 1.1);
  p.rect(CX - Math.floor((WIDTH + 2) / 2) - 2, top, 4, GY - top, 'c');
  const f = person(p, frame, 't', { scale: 1.1 });
  // Ermine collar.
  p.rect(f.left, f.top, f.right - f.left + 1, 2, 'b');
  for (let x = f.left + 1; x < f.right; x += 3) p.dot(x, f.top + 1, 'e');
  hair(p, f, 'u');
  p.rect(Math.round(f.headX), Math.round(f.headY + HEAD - 1), HEAD, 2, 'u');
  // Crown with three points and a jewel.
  const cy = Math.round(f.headY - HEAD);
  const cx0 = Math.round(f.headX - HEAD);
  p.rect(cx0, cy - 1, HEAD * 2 + 1, 2, 'y');
  for (let i = 0; i <= 2; i++) p.dot(cx0 + i * HEAD, cy - 2, 'y');
  p.dot(Math.round(f.headX), cy - 1, 'r');
  // Sceptre.
  p.line(f.handX + 1, f.handY + 2, f.handX + 1, f.handY - 6, 'y');
  p.ellipse(f.handX + 1, f.handY - 7, 1, 1, 'r');
}

function swordsman(p: Pen, frame: number): void {
  const f = person(p, frame, 'm', { legs: 'a' });
  p.rect(CX - 2, f.top + 1, 5, f.hip - f.top - 1, 't');
  // Helmet with a nose guard.
  for (let y = Math.floor(f.headY - HEAD); y <= f.headY; y++) {
    for (let x = Math.floor(f.headX - HEAD); x <= f.headX + HEAD; x++) if (p.get(x, y) === 's' && (y < f.headY || x < f.headX)) p.dot(x, y, 'm');
  }
  p.rect(Math.round(f.headX + HEAD - 1), Math.round(f.headY - 1), 1, 3, 'm');
  p.dot(Math.round(f.headX + HEAD - 2), Math.round(f.headY), 'e');
  // Sword raised in the front hand.
  p.line(f.handX, f.handY - 1, f.handX, f.handY - 1 - (TORSO + 2), 'w');
  p.rect(f.handX - 1, f.handY - 1, 3, 1, 'y');
  // A big kite shield in team colours covers the body: the swordsman's mark.
  const sx = f.left - 1;
  const sy = f.top;
  const sw = 8;
  const sh = f.hip - f.top + 2;
  for (let j = 0; j < sh; j++) {
    const narrow = j > sh - 4 ? j - (sh - 4) : 0;
    p.rect(sx - 1 + narrow, sy + j, sw - narrow * 2, 1, 'm');
    if (j > 0 && j < sh - 1) p.rect(sx + narrow, sy + j, sw - 2 - narrow * 2, 1, 't');
  }
  p.dot(sx + 2, sy + Math.floor(sh / 2) - 1, 'y');
}

function spearman(p: Pen, frame: number): void {
  const f = person(p, frame, 't', { legs: 'l' });
  p.rect(f.left, f.top, 3, 2, 'm');
  // Kettle hat with a wide brim.
  hair(p, f);
  const hy = Math.round(f.headY - HEAD + 1);
  p.ellipse(f.headX, hy - 1, HEAD, 1.4, 'm');
  p.rect(Math.round(f.headX - HEAD - 2), hy, HEAD * 2 + 5, 1, 'a');
  // A spear far taller than the man, with a team pennant: the spearman's mark.
  const sx = f.handX + 1;
  const topY = Math.round(f.headY - HEAD) - 10;
  p.line(sx, GY - 1, sx, topY + 3, 'k');
  p.rect(sx, topY, 1, 3, 'w');
  p.dot(sx, topY - 1, 'w');
  p.rect(sx + 1, topY + 4, 4, 2, 't');
  p.rect(sx + 1, topY + 6, 2, 1, 't');
}

function archer(p: Pen, frame: number): void {
  const f = person(p, frame, 't', { legs: 'n' });
  p.rect(f.left, f.hip - 5, f.right - f.left, 3, 'o');
  // Quiver on the back with fletchings.
  p.rect(f.left - 2, f.top - 2, 2, 7, 'n');
  p.rect(f.left - 3, f.top - 4, 1, 2, 'w');
  p.rect(f.left - 1, f.top - 4, 1, 2, 'r');
  // A pointed green hood: the archer's mark.
  for (let y = Math.floor(f.headY - HEAD - 1); y <= f.headY + HEAD; y++) {
    for (let x = Math.floor(f.headX - HEAD - 1); x <= f.headX + HEAD + 1; x++) {
      const dx = x - f.headX;
      const dy = y - f.headY;
      const inHood = dx * dx + dy * dy <= (HEAD + 1.2) ** 2;
      const face = dx > -0.5 && dy > -HEAD + 1.5 && p.get(x, y) === 's';
      if (inHood && !face) p.dot(x, y, 'g');
    }
  }
  p.line(f.headX - HEAD - 1, f.headY - 1, f.headX - HEAD - 3, f.headY + 2, 'g');
  // A bow held in front, taller than the body.
  const bx = f.handX + 2;
  for (let i = -TORSO; i <= TORSO; i++) p.dot(bx + Math.round(Math.cos((i / TORSO) * (Math.PI / 2)) * 3), f.handY + i, 'k');
  p.line(bx, f.handY - TORSO, bx, f.handY + TORSO, 'w');
}

function monk(p: Pen, frame: number): void {
  const f = person(p, frame, 'o', { robe: true });
  p.rect(f.left, f.top + Math.round(TORSO * 0.55), WIDTH, 1, 'y');
  p.rect(CX, f.top, 2, GY - f.top - 2, 't');
  // Hood lying on the shoulders and a tonsure.
  p.rect(f.left, f.top - 1, 4, 3, 'O');
  for (let y = Math.floor(f.headY - HEAD); y <= f.headY; y++) {
    for (let x = Math.floor(f.headX - HEAD); x <= f.headX + HEAD; x++) {
      if (p.get(x, y) !== 's') continue;
      if (Math.abs(y - (f.headY - HEAD + 2)) < 1 || (x < f.headX - 1 && y > f.headY - HEAD + 1)) p.dot(x, y, 'h');
    }
  }
  // A tall staff with a cross.
  const sx = f.handX + 1;
  const topY = Math.round(f.headY - HEAD) - 4;
  p.line(sx, GY, sx, topY, 'k');
  p.rect(sx - 1, topY + 1, 3, 1, 'y');
  p.rect(sx, topY - 1, 1, 2, 'y');
}

/** A horse with a rider seated on it. */
function mounted(p: Pen, frame: number, coat: string, armoured: boolean): Figure {
  const rx = HORSE_RX;
  const ry = HORSE_RY;
  const cx = CX - 2;
  const cy = GY - HORSE_LEGS - ry + 1;
  // Legs: hind pair and fore pair, moving in turn.
  [cx - rx + 1, cx - rx + 3, cx + rx - 4, cx + rx - 2].forEach((x, i) => {
    const lifted = frame !== 0 && (i % 2 === 0) === (frame === 1);
    const dx = frame === 0 ? 0 : lifted ? 1 : -1;
    const foot = GY - (lifted ? 1 : 0);
    p.rect(x + dx, cy, 2, foot - cy + 1, i % 2 ? coat : coat.toUpperCase());
    p.rect(x + dx, foot, 2, 1, 'n');
  });
  p.line(cx - rx, cy - 1, cx - rx - 2, cy + 2, 'n');
  p.line(cx - rx - 1, cy - 1, cx - rx - 3, cy + 3, 'n');
  p.ellipse(cx, cy, rx, ry, coat);
  // The neck rises forward from the chest; the head slopes down to the muzzle.
  const hx = cx + rx - 1;
  const hy = cy - ry - 4;
  for (let i = 0; i <= cy - hy; i++) p.rect(cx + rx - 4 + Math.round(i * 0.55), cy - i, 4, 1, coat);
  for (let i = 0; i <= 4; i++) p.rect(hx + i, hy + Math.round(i * 0.7), 3, i === 4 ? 2 : 3, coat);
  p.rect(hx + 5, hy + 3, 2, 2, 'n');
  p.dot(hx, hy - 1, coat);
  p.dot(hx + 1, hy - 2, coat);
  p.dot(hx + 2, hy + 1, 'e');
  p.line(cx + rx - 5, cy - 1, hx - 1, hy, 'n');
  p.line(cx + rx - 4, cy - 2, hx, hy - 1, 'n');
  if (armoured) {
    // Team barding over the body, trimmed in gold, and a steel chamfron on the head.
    for (let y = Math.round(cy - ry + 1); y <= cy + ry; y++) {
      for (let x = cx - rx; x <= cx + rx; x++) if (p.get(x, y) === coat) p.dot(x, y, y === cy + ry ? 'y' : 't');
    }
    p.rect(hx + 1, hy, 3, 2, 'm');
  }
  // The rider.
  const seat = Math.round(cy - ry + 1);
  const torso = TORSO - 2;
  const top = seat - torso;
  const left = cx - 3;
  const width = 6;
  p.rect(left, top, width, torso, armoured ? 'm' : 't');
  if (armoured) p.rect(left + 2, top + 1, 3, torso - 1, 't');
  p.rect(left + 2, seat - 1, 2, ry + 2, armoured ? 'a' : 'l');
  p.rect(left + 2, seat + ry, 3, 2, 'd');
  p.dot(left, top, '.');
  const headX = left + width / 2;
  const headY = top - HEAD + 0.5;
  p.ellipse(headX, headY, HEAD, HEAD, 's');
  p.dot(Math.round(headX + HEAD - 1), Math.round(headY), 'e');
  const handX = left + width;
  const handY = top + 3;
  p.rect(left + width - 1, top + 1, 2, 2, armoured ? 'M' : 'T');
  p.rect(handX, handY, 2, 2, 's');
  return { hip: seat, top, headX, headY, handX, handY, left, right: left + width - 1 };
}

function scout(p: Pen, frame: number): void {
  const f = mounted(p, frame, 'u', false);
  hair(p, f);
  // A light cap with a long feather: quick and unarmoured.
  const cy = Math.round(f.headY - HEAD + 1);
  p.ellipse(f.headX, cy - 1, HEAD, 1.3, 'g');
  p.line(f.headX - 1, cy - 2, f.headX - 5, cy - 5, 'w');
  p.line(f.headX - 2, cy - 2, f.headX - 6, cy - 4, 'w');
  p.rect(f.left - 1, f.hip - 2, 3, 2, 'y');
}

function rider(p: Pen, frame: number): void {
  const f = mounted(p, frame, 'o', true);
  // A great helm with an eye slit and a team plume.
  p.ellipse(f.headX, f.headY, HEAD, HEAD, 'm');
  p.rect(Math.round(f.headX), Math.round(f.headY - 1), HEAD, 1, 'e');
  p.rect(Math.round(f.headX - 1), Math.round(f.headY - HEAD - 2), 2, 2, 't');
  p.dot(Math.round(f.headX - 2), Math.round(f.headY - HEAD - 2), 't');
  // A long lance couched forward, with a pennant.
  const x1 = f.handX + 14;
  const y1 = f.handY - 9;
  p.line(f.left - 4, f.handY + 3, x1, y1, 'k');
  p.line(x1, y1, x1 + 2, y1 - 2, 'w');
  p.rect(x1 - 4, y1 - 1, 3, 2, 't');
}

function ram(p: Pen, frame: number): void {
  const left = CX - 13;
  const right = CX + 9;
  const floor = GY - 4;
  // Wheels, spokes turning while it rolls.
  for (const wx of [left + 4, right - 4]) {
    p.ellipse(wx, GY - 2, 2.6, 2.6, 'n');
    const a = frame * 1.1;
    p.dot(wx + Math.round(Math.cos(a) * 1.5), GY - 2 + Math.round(Math.sin(a) * 1.5), 'y');
    p.dot(wx, GY - 2, 'k');
  }
  // Frame and a sloped roof covered with team-coloured hides.
  p.rect(left, floor - 2, right - left + 1, 3, 'k');
  p.rect(left + 1, floor - 9, 2, 8, 'k');
  p.rect(right - 2, floor - 9, 2, 8, 'k');
  for (let i = 0; i < 6; i++) p.rect(left - 1 + i, floor - 9 - i, right - left + 3 - i * 2, 1, i % 2 ? 'T' : 't');
  p.rect(left - 1, floor - 9, right - left + 3, 1, 'n');
  // The log with its iron head, sticking out at the front.
  p.rect(left + 2, floor - 5, right - left + 6, 2, 'o');
  p.rect(right + 6, floor - 6, 3, 4, 'a');
  p.dot(right + 9, floor - 5, 'm');
}

const UNITS: Partial<Record<Kind, (p: Pen, frame: number) => void>> = {
  villager, king, swordsman, spearman, archer, monk, scout, rider, ram,
};

const unitCache = new Map<string, string[]>();

/** The rows of a unit's sprite for frame 0 (standing), 1 or 2 (walking). */
export function unitArt(kind: Kind, frame: number): string[] {
  const key = `${kind}|${frame}`;
  let rows = unitCache.get(key);
  if (!rows) {
    const p = new Pen(UW, UH);
    (UNITS[kind] ?? villager)(p, frame);
    rows = finish(p, CX, GY);
    unitCache.set(key, rows);
  }
  return rows;
}

// --- resources -------------------------------------------------------------------------------

/** A small repeatable random generator, so every variant always looks the same. */
function random(seed: number): () => number {
  let s = seed * 2654435761 + 1013904223;
  return () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s / 4294967296;
  };
}

/** Leaves lit from the upper left: light on that side, dark below, with a few speckles. */
function foliage(rnd: () => number, light: string, mid: string, dark: string, glint: string) {
  return (dx: number, dy: number): string => {
    const lit = -dx * 0.55 - dy * 0.85 + (rnd() - 0.5) * 0.5;
    if (lit > 0.75 && rnd() < 0.35) return glint;
    if (lit > 0.3) return light;
    if (lit < -0.55) return dark;
    return mid;
  };
}

const PW = 90;
const PH = 110;
const PCX = 45;
const PGY = PH - 4;

function trunk(p: Pen, x: number, height: number, width: number, bark = 'k'): void {
  p.rect(x - Math.floor(width / 2), PGY - height, width, height + 1, bark);
  p.rect(x - Math.floor(width / 2), PGY - height, 1, height + 1, darker(bark));
  // Roots spreading at the foot.
  p.dot(x - Math.floor(width / 2) - 1, PGY, bark);
  p.dot(x + Math.ceil(width / 2), PGY, bark);
}

/** A fir: tiers of needles narrowing to a point. */
function fir(p: Pen, rnd: () => number, size: number): void {
  const height = Math.round(66 * size);
  trunk(p, PCX, 8, 5, 'n');
  const tiers = 5;
  const leaf = foliage(rnd, 'b', 'a', 'A', 'c');
  for (let t = 0; t < tiers; t++) {
    const bottom = PGY - 5 - t * Math.round(height / (tiers + 1));
    const tierH = Math.round(height / (tiers - 0.6));
    const half = Math.round((25 - t * 4) * size);
    for (let j = 0; j < tierH; j++) {
      const y = bottom - j;
      const w = Math.round(half * (1 - j / tierH));
      for (let x = -w; x <= w; x++) {
        // A ragged lower edge so the tiers look like boughs.
        if (j === 0 && rnd() < 0.4) continue;
        p.dot(PCX + x, y, leaf(x / Math.max(1, half), (j / tierH) * -1.6 + 0.6));
      }
    }
  }
  p.dot(PCX, PGY - height - 4, 'c');
}

/** A broad-leafed tree: a lumpy crown of overlapping clumps on a forked trunk. */
function broadleaf(p: Pen, rnd: () => number, size: number, light: string, mid: string, dark: string, glint: string, bark = 'k'): void {
  const height = Math.round(16 * size);
  trunk(p, PCX, height, 6, bark);
  p.line(PCX, PGY - height + 6, PCX - 7, PGY - height - 2, bark, 2);
  p.line(PCX + 1, PGY - height + 4, PCX + 8, PGY - height - 4, bark, 2);
  const cy = PGY - height - Math.round(16 * size);
  const r = 24 * size;
  // Dark clumps behind first, then lighter ones in front and on top.
  const clumps: [number, number, number][] = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + rnd() * 0.6;
    const d = r * (0.45 + rnd() * 0.25);
    clumps.push([PCX + Math.cos(a) * d * 1.1, cy + Math.sin(a) * d * 0.8, r * (0.42 + rnd() * 0.18)]);
  }
  clumps.sort((a, b) => a[1] - b[1]);
  p.ellipse(PCX, cy, r * 0.85, r * 0.7, dark);
  const leaf = foliage(rnd, light, mid, dark, glint);
  for (const [x, y, cr] of clumps) p.ellipse(x, y, cr, cr * 0.85, leaf);
  p.ellipse(PCX - r * 0.15, cy - r * 0.35, r * 0.45, r * 0.38, leaf);
}

/** A slender birch: white bark with dark marks and a narrow, airy crown. */
function birch(p: Pen, rnd: () => number, size: number): void {
  const height = Math.round(26 * size);
  trunk(p, PCX, height, 4, 'w');
  for (let y = PGY - height; y < PGY; y += 3 + Math.floor(rnd() * 3)) p.rect(PCX - 1 + Math.floor(rnd() * 2), y, 2, 1, 'e');
  const cy = PGY - height - Math.round(10 * size);
  const leaf = foliage(rnd, 'x', 'q', 'p', 'v');
  for (let i = 0; i < 8; i++) {
    const y = cy - 24 * size + i * 6 * size;
    const w = (9 + Math.sin((i / 7) * Math.PI) * 11) * size;
    p.ellipse(PCX + (rnd() - 0.5) * 6, y, w, 5 * size, leaf);
  }
}

function tree(p: Pen, variant: number): void {
  const rnd = random(variant + 11);
  const size = [1, 0.95, 0.9, 1.08, 1.05, 0.98][variant % 6];
  if (variant % 3 === 0) fir(p, rnd, size);
  else if (variant % 3 === 1) broadleaf(p, rnd, size, 'c', 'b', 'a', 'v');
  else if (variant % 6 === 2) birch(p, rnd, size);
  else broadleaf(p, rnd, size, 'q', 'p', 'a', 'x');
}

function bush(p: Pen, variant: number): void {
  const rnd = random(variant + 31);
  const leaf = foliage(rnd, 'c', 'b', 'a', 'v');
  const base = PGY - 9;
  p.ellipse(PCX, base, 15, 8, 'a');
  for (let i = 0; i < 6; i++) p.ellipse(PCX - 11 + i * 4.4 + rnd() * 2, base - 2 - Math.sin((i / 5) * Math.PI) * 5, 6, 5, leaf);
  // Clusters of ripe berries, each with a bright glint.
  for (let i = 0; i < 14; i++) {
    const x = Math.round(PCX - 12 + rnd() * 24);
    const y = Math.round(base - 9 + rnd() * 13);
    if (p.get(x, y) === '.' || p.get(x + 1, y + 1) === '.') continue;
    const c = rnd() < 0.3 ? 'j' : 'r';
    p.rect(x, y, 2, 2, c);
    p.dot(x, y, 'z');
  }
}

/** A heap of boulders; gold heaps have nuggets and glittering veins. */
function rocks(p: Pen, variant: number, gold: boolean): void {
  const rnd = random(variant + (gold ? 71 : 53));
  const [light, mid, dark] = gold ? ['t', 's', 'S'] : ['l', 'i', 'm'];
  const stones: [number, number, number, number][] = [
    [PCX - 7, PGY - 6, 8, 6], [PCX + 6, PGY - 5, 7, 5], [PCX, PGY - 10, 9, 8], [PCX - 12, PGY - 3, 4, 3], [PCX + 13, PGY - 2, 4, 3],
  ];
  for (const [x, y, rx, ry] of stones) {
    const ox = (rnd() - 0.5) * 3;
    // Faceted: a light top face, a mid front and a dark side.
    p.ellipse(x + ox, y, rx, ry, (dx, dy) => (dy < -0.35 && dx < 0.5 ? light : dx > 0.45 ? dark : mid));
    p.line(x + ox - rx * 0.4, y - ry * 0.1, x + ox + rx * 0.3, y + ry * 0.4, dark);
  }
  if (gold) {
    // Veins of gold running through the rock, and nuggets bulging out of it.
    for (let i = 0; i < 6; i++) {
      const x = PCX - 12 + rnd() * 24;
      const y = PGY - 14 + rnd() * 10;
      p.line(x, y, x + 3 + rnd() * 3, y + 1 + rnd() * 3, 'Y');
    }
    for (let i = 0; i < 18; i++) {
      const x = Math.round(PCX - 13 + rnd() * 26);
      const y = Math.round(PGY - 17 + rnd() * 16);
      if (p.get(x, y) === '.') continue;
      const big = rnd() < 0.4;
      p.ellipse(x, y, big ? 2 : 1.2, big ? 1.6 : 1, 'y');
      p.dot(x - 1, y - 1, 'o');
    }
    for (const [x, y] of [[PCX - 16, PGY], [PCX + 17, PGY - 1], [PCX + 2, PGY + 1]]) {
      p.rect(x, y - 1, 2, 2, 'y');
      p.dot(x, y - 1, 'o');
    }
  } else {
    for (let i = 0; i < 5; i++) {
      const x = Math.round(PCX - 10 + rnd() * 20);
      const y = Math.round(PGY - 14 + rnd() * 10);
      if (p.get(x, y) !== '.') p.line(x, y, x + 2, y + 2, 'e');
    }
  }
}

const PROPS = { tree, berries: bush, gold: (p: Pen, v: number) => rocks(p, v, true), stone: (p: Pen, v: number) => rocks(p, v, false) };
export type PropName = keyof typeof PROPS;

/** How many looks each resource has. */
export const PROP_VARIANTS: Record<PropName, number> = { tree: 6, berries: 3, gold: 3, stone: 3 };

const propCache = new Map<string, string[]>();

/** The rows of a resource's sprite; its base is the bottom row, centred. */
export function propArt(name: PropName, variant: number): string[] {
  const v = variant % PROP_VARIANTS[name];
  const key = `${name}|${v}`;
  let rows = propCache.get(key);
  if (!rows) {
    const p = new Pen(PW, PH);
    PROPS[name](p, v);
    rows = finish(p, PCX, PGY, false);
    propCache.set(key, rows);
  }
  return rows;
}
