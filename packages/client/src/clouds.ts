/**
 * A wall of clouds around the map: rows of big, soft, puffy clouds just beyond each edge, lit from
 * above and shaded underneath, drifting very slowly. Along the top edges they rise up and away
 * from the map; along the bottom edges they hang below it, so they never cover a tile that can be
 * used. The clouds are painted once into pictures; each frame only those in view are copied.
 */

export interface Puff {
  /** World position: the middle of the cloud's base (top edges) or of its top (bottom edges). */
  x: number;
  y: number;
  scale: number;
  look: number;
  /** Along a bottom edge of the map: the cloud hangs down from (x, y). */
  hanging: boolean;
  phase: number;
}

const LOOKS = 6;
const W = 170;
const H = 110;
let pictures: HTMLCanvasElement[] | undefined;

function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** One cloud: overlapping round puffs with a flat base, white on top and grey underneath. */
function paintCloud(look: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const rnd = random(look * 977 + 13);
  const base = H - 14;
  g.fillStyle = '#fff';
  // A row of puffs along the base, with a few higher ones on top.
  const puffs: [number, number, number][] = [];
  for (let i = 0; i < 5; i++) puffs.push([22 + i * 31 + (rnd() - 0.5) * 10, base - 12, 18 + rnd() * 8]);
  for (let i = 0; i < 3; i++) puffs.push([45 + i * 38 + (rnd() - 0.5) * 14, base - 32 - rnd() * 10, 22 + rnd() * 10]);
  puffs.push([W / 2 + (rnd() - 0.5) * 30, base - 52 - rnd() * 8, 20 + rnd() * 8]);
  for (const [x, y, r] of puffs) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  g.fillRect(10, base - 14, W - 20, 22);
  // Colour: pale grey tops and darker bellies that fade out softly at the base.
  g.globalCompositeOperation = 'source-in';
  const shade = g.createLinearGradient(0, base - 72, 0, base + 8);
  shade.addColorStop(0, 'rgba(232,238,236,.96)');
  shade.addColorStop(0.5, 'rgba(205,214,212,.94)');
  shade.addColorStop(0.82, 'rgba(160,172,172,.8)');
  shade.addColorStop(1, 'rgba(140,154,154,0)');
  g.fillStyle = shade;
  g.fillRect(0, 0, W, H);
  // Light from the upper left on each puff.
  g.globalCompositeOperation = 'source-atop';
  for (const [x, y, r] of puffs) {
    const glow = g.createRadialGradient(x - r * 0.35, y - r * 0.45, 1, x, y, r);
    glow.addColorStop(0, 'rgba(255,255,255,.4)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = glow;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.globalCompositeOperation = 'source-over';
  return c;
}

/**
 * The clouds for a map of n × n tiles; `toWorld` turns tile coordinates into world pixels. Three
 * rows along each edge, the outer rows bigger, sorted back to front.
 */
export function cloudWall(n: number, seed: number, toWorld: (u: number, v: number) => [number, number]): Puff[] {
  const rnd = random(seed * 31 + 7);
  const puffs: Puff[] = [];
  const rows = [[0.7, 1], [2.9, 1.4], [5.6, 1.85]] as const;
  // Each edge: a point on it at t, the outward direction, and whether it is a bottom edge on screen.
  const edges: [(t: number, d: number) => [number, number], boolean][] = [
    [(t, d) => [-d, t], false],
    [(t, d) => [t, -d], false],
    [(t, d) => [n + d, t], true],
    [(t, d) => [t, n + d], true],
  ];
  for (const [at, hanging] of edges) {
    for (const [d, size] of rows) {
      for (let t = -d - 2; t <= n + d + 2; t += 1.5 + rnd() * 0.6) {
        const [x, y] = toWorld(...at(t, d + rnd() * 0.6));
        puffs.push({ x, y, scale: size * (0.85 + rnd() * 0.3), look: Math.floor(rnd() * LOOKS), hanging, phase: rnd() * 6.3 });
      }
    }
  }
  // Painted from the back (top of the screen) to the front.
  puffs.sort((a, b) => a.y - b.y);
  return puffs;
}

/** Where a cloud's picture lands in world pixels: [left, top, width, height]. */
function boxOf(p: Puff): [number, number, number, number] {
  const cw = W * p.scale;
  const ch = H * p.scale;
  // Along a bottom edge the cloud hangs from its top; elsewhere it stands on its base.
  const top = p.hanging ? p.y - 10 * p.scale : p.y - ch + 14 * p.scale;
  return [p.x - cw / 2, top, cw, ch];
}

/**
 * The clouds are painted once into square pictures of the world, at half resolution (soft
 * clouds lose nothing), and only those along the edges hold any. Each frame copies the few
 * squares in view, so every pixel of cloud is drawn about once.
 */
const SQUARE = 512;
const RES = 0.5;
const squares = new Map<string, { img: HTMLCanvasElement | null; used: number }>();
let squaresFor: Puff[] | undefined;
let frame = 0;

function paintSquare(puffs: Puff[], col: number, row: number): HTMLCanvasElement | null {
  const left = col * SQUARE;
  const top = row * SQUARE;
  const inside = puffs.filter((p) => {
    const [x, y, w, h] = boxOf(p);
    return x < left + SQUARE && x + w > left && y < top + SQUARE && y + h > top;
  });
  if (inside.length === 0) return null;
  const c = document.createElement('canvas');
  c.width = c.height = SQUARE * RES;
  const g = c.getContext('2d')!;
  g.setTransform(RES, 0, 0, RES, -left * RES, -top * RES);
  for (const p of inside) {
    const [x, y, w, h] = boxOf(p);
    g.drawImage(pictures![p.look], x, y, w, h);
  }
  return c;
}

/**
 * Draws the clouds in view. `left` and `top` are the world pixels at the top left of the view,
 * which is `w` × `h` world pixels.
 */
export function drawClouds(ctx: CanvasRenderingContext2D, puffs: Puff[], left: number, top: number, w: number, h: number): void {
  if (puffs.length === 0) return;
  pictures ??= Array.from({ length: LOOKS }, (_, i) => paintCloud(i));
  if (squaresFor !== puffs) {
    // A new map: its clouds start afresh.
    squares.clear();
    squaresFor = puffs;
  }
  frame++;
  const c0 = Math.floor(left / SQUARE);
  const c1 = Math.floor((left + w) / SQUARE);
  const r0 = Math.floor(top / SQUARE);
  const r1 = Math.floor((top + h) / SQUARE);
  // Copied without smoothing: quicker, and the clouds keep the game's chunky pixel look.
  ctx.imageSmoothingEnabled = false;
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const key = `${col},${row}`;
      let sq = squares.get(key);
      if (!sq) {
        sq = { img: paintSquare(puffs, col, row), used: 0 };
        squares.set(key, sq);
      }
      sq.used = frame;
      if (sq.img) ctx.drawImage(sq.img, Math.floor(col * SQUARE - left), Math.floor(row * SQUARE - top), SQUARE + 1, SQUARE + 1);
    }
  }
  // Squares long out of view are let go.
  if (squares.size > 160) {
    for (const [key, sq] of [...squares].sort((a, b) => a[1].used - b[1].used).slice(0, 60)) if (sq.img) squares.delete(key);
  }
}
