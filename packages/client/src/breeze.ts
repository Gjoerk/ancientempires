/**
 * Now and then a gust of wind runs across the view: the trees it passes lean with it for a moment
 * and shed a few leaves that flutter away. Between gusts this costs nothing; during one, only the
 * trees on screen are looked at and the number of leaves is capped.
 */

interface Leaf {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  spin: number;
  color: string;
}

/** A faint curl of wind drawn along with a gust. */
interface Curl {
  x: number;
  y: number;
  born: number;
  size: number;
}

interface Gust {
  start: number;
  /** World x where the front starts and ends, and its speed in world pixels per second. */
  from: number;
  to: number;
  speed: number;
  /** Trees on screen when the gust began, as world points at the top of their crowns, with a spare chance each. */
  trees: [number, number, number][];
}

const LEAF_COLORS = ['#b4e07a', '#9fd16a', '#d7ec8a', '#f2d66b', '#f0a858'];
const MAX_LEAVES = 70;
/** Half the width of the band of trees the gust is bending at any moment, in world pixels. */
const BAND = 170;

export class Breeze {
  private gust: Gust | undefined;
  next = performance.now() + 9000 + Math.random() * 12000;
  private leaves: Leaf[] = [];
  private curls: Curl[] = [];
  private nextCurl = 0;

  /** Starts gusts and moves leaves; `trees` lists the crowns on screen, asked for only when a gust begins. */
  update(now: number, dt: number, view: { left: number; right: number; top: number; bottom: number }, trees: () => [number, number][]): void {
    if (!this.gust && now >= this.next) {
      const list = trees();
      this.next = now + 22000 + Math.random() * 26000;
      if (list.length > 0) {
        this.gust = {
          start: now,
          from: view.left - BAND * 2,
          to: view.right + BAND * 2,
          speed: 260 + Math.random() * 90,
          trees: list.map(([x, y]) => [x, y, Math.random()]),
        };
      }
    }
    const g = this.gust;
    if (g) {
      const front = this.front(now)!;
      if (front > g.to) this.gust = undefined;
      else {
        // Now and then a little curl of wind rides along with the front.
        if (now >= this.nextCurl && g.trees.length > 0) {
          this.nextCurl = now + 450 + Math.random() * 500;
          const t = g.trees[Math.floor(Math.random() * g.trees.length)];
          this.curls.push({ x: front - 40, y: t[1] + 10 + Math.random() * 30, born: now, size: 7 + Math.random() * 5 });
        }
        // Trees just reached by the front let go of a leaf or two.
        for (const t of g.trees) {
          const d = front - t[0];
          if (d < 0 || d > g.speed * dt * 1.5) continue;
          if (t[2] > 0.55 || this.leaves.length >= MAX_LEAVES) continue;
          const n = t[2] < 0.15 ? 2 : 1;
          for (let i = 0; i < n; i++) {
            this.leaves.push({
              x: t[0] + (Math.random() - 0.5) * 26,
              y: t[1] + Math.random() * 22,
              vx: 50 + Math.random() * 40,
              vy: -8 - Math.random() * 10,
              born: now,
              life: 2600 + Math.random() * 1800,
              spin: Math.random() * 6,
              color: LEAF_COLORS[Math.floor(Math.random() * LEAF_COLORS.length)],
            });
          }
        }
      }
    }
    if (this.curls.length) this.curls = this.curls.filter((c) => now - c.born < 1400);
    for (const c of this.curls) c.x += (g?.speed ?? 300) * 0.8 * dt;
    if (this.leaves.length === 0) return;
    this.leaves = this.leaves.filter((l) => now - l.born < l.life);
    for (const l of this.leaves) {
      const age = (now - l.born) / 1000;
      // Carried by the wind, slowing down, and drifting slowly down while swinging from side to side.
      l.vx *= 1 - 0.35 * dt;
      l.vy = Math.min(16, l.vy + 14 * dt);
      l.x += (l.vx + Math.sin(age * 3.1 + l.spin) * 12) * dt;
      l.y += (l.vy + Math.cos(age * 4.3 + l.spin) * 9) * dt;
    }
  }

  private front(now: number): number | undefined {
    const g = this.gust;
    return g ? g.from + ((now - g.start) / 1000) * g.speed : undefined;
  }

  /** How far a tree at world x leans right now: a skew factor, 0 when still. */
  sway(wx: number, now: number): number {
    const front = this.front(now);
    if (front === undefined) return 0;
    const d = (front - wx) / BAND;
    if (d < -1.2 || d > 2.5) return 0;
    // Bends as the front arrives, springs back a little past upright, and settles.
    const lean = d < 0 ? Math.exp(-d * d * 4) : Math.exp(-d * 1.6) * Math.cos(d * 2.4);
    return lean * 0.07;
  }

  get active(): boolean {
    return this.gust !== undefined || this.leaves.length > 0 || this.curls.length > 0;
  }

  /** Draws the leaves; `toScreen` turns a world point into a screen point. */
  draw(ctx: CanvasRenderingContext2D, now: number, toScreen: (x: number, y: number) => [number, number]): void {
    // Wind curls: a stroke that sweeps along and ends in a small loop, fading in and out.
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    for (const c of this.curls) {
      const k = (now - c.born) / 1400;
      const [x, y] = toScreen(c.x, c.y);
      ctx.strokeStyle = `rgba(255,255,245,${(Math.sin(k * Math.PI) * 0.38).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(x - c.size * 3, y + 1);
      ctx.quadraticCurveTo(x - c.size, y + 2, x, y);
      ctx.arc(x, y - c.size / 2, c.size / 2, Math.PI / 2, Math.PI / 2 - Math.PI * 1.6 * Math.min(1, k * 2), true);
      ctx.stroke();
    }
    for (const l of this.leaves) {
      const age = now - l.born;
      const k = age / l.life;
      // A leaf turning over: it looks narrower as it shows its edge.
      const flip = Math.abs(Math.cos(age / 170 + l.spin));
      const [x, y] = toScreen(l.x, l.y);
      ctx.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : Math.min(1, age / 200);
      ctx.fillStyle = l.color;
      const w = Math.max(1, Math.round(4 * flip));
      ctx.fillRect(Math.round(x), Math.round(y), w, 3);
      // A darker edge and stem, so the leaf reads against the trees.
      ctx.fillStyle = 'rgba(50,70,25,.6)';
      ctx.fillRect(Math.round(x), Math.round(y) + 2, w, 1);
      if (flip > 0.5) ctx.fillRect(Math.round(x) + w, Math.round(y) + 1, 1, 1);
    }
    ctx.globalAlpha = 1;
  }
}
