/**
 * Wind in the forests. Trees sway a little all the time; now and then a slow gust runs across the
 * view, the trees it passes lean with it, a few leaves tumble away and soft wisps of wind drift
 * along. Between gusts only the sway is worked out; during one, only the trees on screen are
 * looked at and the number of leaves is capped.
 */

interface Leaf {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  spin: number;
  turn: number;
  look: number;
}

/** A wisp of wind: its head runs along a wavy path that makes one loose loop; a fading tail follows. */
interface Wisp {
  x: number;
  y: number;
  born: number;
  life: number;
  phase: number;
  loopAt: number;
  size: number;
}

interface Gust {
  start: number;
  /** World x where the front starts and ends, and its speed in world pixels per second. */
  from: number;
  to: number;
  speed: number;
  /** Crowns of the trees on screen when the gust began, in world pixels, with a spare chance each. */
  trees: [number, number, number][];
}

const MAX_LEAVES = 50;
/** Width of the band of trees the gust is bending at any moment, in world pixels. */
const BAND = 160;

// Little leaves, a few shapes and colours: drawn once, then turned and flipped as they fly.
const LEAF_SHAPES = [
  ['..ggg..', '.ggGgg.', 'gggGggg', '.ggGgg.', '..gGg..', '...s...'],
  ['...gg..', '..ggGg.', '.ggGgg.', 'ggGgg..', '.gGg...', 's......'],
  ['..g.g..', '.ggGgg.', 'gggGggg', '.gGGGg.', '..gsg..'],
];
const LEAF_COLORS = [['#a9d96c', '#6f9e3d'], ['#c8e27a', '#86a745'], ['#f0d266', '#b89a3a'], ['#eea458', '#b56e2c'], ['#8fcb5e', '#5a8a33']];
let leafPictures: HTMLCanvasElement[] | undefined;

function leaves(): HTMLCanvasElement[] {
  if (leafPictures) return leafPictures;
  leafPictures = [];
  for (const shape of LEAF_SHAPES) {
    for (const [light, dark] of LEAF_COLORS) {
      const c = document.createElement('canvas');
      c.width = shape[0].length;
      c.height = shape.length;
      const g = c.getContext('2d')!;
      shape.forEach((row, y) => [...row].forEach((ch, x) => {
        if (ch === '.') return;
        g.fillStyle = ch === 'g' ? light : ch === 'G' ? dark : '#6b4a2b';
        g.fillRect(x, y, 1, 1);
      }));
      leafPictures.push(c);
    }
  }
  return leafPictures;
}

export class Breeze {
  private gust: Gust | undefined;
  next = performance.now() + 9000 + Math.random() * 12000;
  private leaves: Leaf[] = [];
  private wisps: Wisp[] = [];
  private nextWisp = 0;

  /** Starts gusts and moves leaves and wisps; `trees` lists the crowns on screen, asked for only when a gust begins. */
  update(now: number, dt: number, view: { left: number; right: number; top: number; bottom: number }, trees: () => [number, number][]): void {
    if (!this.gust && now >= this.next) {
      const list = trees();
      this.next = now + 24000 + Math.random() * 26000;
      if (list.length > 0) {
        this.gust = {
          start: now,
          from: view.left - BAND * 2,
          to: view.right + BAND * 2,
          speed: 110 + Math.random() * 40,
          trees: list.map(([x, y]) => [x, y, Math.random()]),
        };
        this.nextWisp = now;
      }
    }
    const g = this.gust;
    if (g) {
      const front = this.front(now)!;
      if (front > g.to) this.gust = undefined;
      else {
        if (now >= this.nextWisp && g.trees.length > 0) {
          this.nextWisp = now + 900 + Math.random() * 900;
          const t = g.trees[Math.floor(Math.random() * g.trees.length)];
          this.wisps.push({
            x: front - 30, y: t[1] + Math.random() * 40, born: now, life: 3200 + Math.random() * 1200,
            phase: Math.random() * 6, loopAt: 0.35 + Math.random() * 0.3, size: 7 + Math.random() * 4,
          });
        }
        // Trees just reached by the front let go of a leaf or two.
        for (const t of g.trees) {
          const d = front - t[0];
          if (d < 0 || d > g.speed * dt * 1.5) continue;
          if (t[2] > 0.5 || this.leaves.length >= MAX_LEAVES) continue;
          const n = t[2] < 0.12 ? 2 : 1;
          for (let i = 0; i < n; i++) {
            this.leaves.push({
              x: t[0] + (Math.random() - 0.5) * 26,
              y: t[1] + Math.random() * 22,
              vx: 22 + Math.random() * 18,
              vy: -5 - Math.random() * 6,
              born: now,
              life: 3800 + Math.random() * 2400,
              spin: Math.random() * 6,
              turn: (Math.random() < 0.5 ? -1 : 1) * (1.2 + Math.random() * 1.6),
              look: Math.floor(Math.random() * LEAF_SHAPES.length * LEAF_COLORS.length),
            });
          }
        }
      }
    }
    if (this.wisps.length) this.wisps = this.wisps.filter((w) => now - w.born < w.life);
    if (this.leaves.length === 0) return;
    this.leaves = this.leaves.filter((l) => now - l.born < l.life);
    for (const l of this.leaves) {
      const age = (now - l.born) / 1000;
      // Carried by the wind, slowing down, drifting down and swinging gently from side to side.
      l.vx *= 1 - 0.25 * dt;
      l.vy = Math.min(9, l.vy + 7 * dt);
      l.x += (l.vx + Math.sin(age * 2.1 + l.spin) * 8) * dt;
      l.y += (l.vy + Math.cos(age * 2.7 + l.spin) * 6) * dt;
    }
  }

  private front(now: number): number | undefined {
    const g = this.gust;
    return g ? g.from + ((now - g.start) / 1000) * g.speed : undefined;
  }

  /** How many pixels the top of a tree at world (x, y) leans right now. */
  lean(wx: number, wy: number, now: number): number {
    // A light breeze that never stops, rolling across the forest in slow waves.
    let px = Math.sin(now / 1500 + wx * 0.011 + wy * 0.017) * 0.55 + Math.sin(now / 2300 + wx * 0.004) * 0.45;
    const front = this.front(now);
    if (front !== undefined) {
      const d = (front - wx) / BAND;
      // Bends as the front arrives, springs back a little past upright, and settles.
      if (d > -1.2 && d < 2.5) px += (d < 0 ? Math.exp(-d * d * 4) : Math.exp(-d * 1.4) * Math.cos(d * 2.2)) * 3.6;
    }
    return px;
  }

  get active(): boolean {
    return this.gust !== undefined || this.leaves.length > 0 || this.wisps.length > 0;
  }

  /** Draws leaves and wisps; `toScreen` turns a world point into a screen point. */
  draw(ctx: CanvasRenderingContext2D, now: number, toScreen: (x: number, y: number) => [number, number]): void {
    ctx.lineCap = 'round';
    for (const w of this.wisps) this.drawWisp(ctx, w, now, toScreen);
    const pictures = leaves();
    for (const l of this.leaves) {
      const age = now - l.born;
      const k = age / l.life;
      const [x, y] = toScreen(l.x, l.y);
      ctx.globalAlpha = k > 0.8 ? (1 - k) / 0.2 : Math.min(1, age / 250);
      // Tumbling: the leaf turns round and, flipping over, looks narrower when edge-on.
      const angle = l.spin + (age / 1000) * l.turn;
      const flip = Math.cos(age / 420 + l.spin);
      ctx.save();
      ctx.translate(Math.round(x), Math.round(y));
      ctx.rotate(angle);
      ctx.scale(Math.abs(flip) < 0.2 ? 0.2 * Math.sign(flip || 1) : flip, 1);
      const pic = pictures[l.look % pictures.length];
      ctx.drawImage(pic, -pic.width / 2, -pic.height / 2);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * A wisp: the head moves along a gently waving path that winds once into a soft loop; the path
   * behind it is drawn as a thin stroke that fades towards its tail, and the whole wisp fades in
   * and out over its life.
   */
  private drawWisp(ctx: CanvasRenderingContext2D, w: Wisp, now: number, toScreen: (x: number, y: number) => [number, number]): void {
    const life = (now - w.born) / w.life;
    const head = life * 1.25;
    const point = (u: number): [number, number] => {
      // One loop, centred on `loopAt` along the path, eased in and out.
      const t = Math.min(1, Math.max(0, (u - w.loopAt) / 0.22));
      const turn = t * t * (3 - 2 * t) * Math.PI * 2;
      const x = w.x + u * 150 + Math.sin(turn) * w.size;
      const y = w.y + Math.sin(u * 5 + w.phase) * 4 - (1 - Math.cos(turn)) * w.size * 0.9;
      return toScreen(x, y);
    };
    const tail = 0.42;
    const steps = 16;
    const fade = Math.sin(Math.min(1, life) * Math.PI);
    let prev = point(Math.max(0, head - tail));
    for (let i = 1; i <= steps; i++) {
      const u = Math.max(0, head - tail + (tail * i) / steps);
      const p = point(u);
      const along = i / steps;
      ctx.strokeStyle = `rgba(250,252,240,${(fade * along * 0.42).toFixed(3)})`;
      ctx.lineWidth = 0.6 + along * 1.1;
      ctx.beginPath();
      ctx.moveTo(prev[0], prev[1]);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      prev = p;
    }
  }
}
