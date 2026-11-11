import { DEFS, Kind } from '@kingsfall/shared';
import { drawSprite, findSprite } from './assets';
import { HH, HW, PLAYER_COLORS, shade } from './sprites';

type Ctx = CanvasRenderingContext2D;
type Pt = [number, number];

// The sun stands to the upper left: a point z pixels above the ground throws its
// shadow this many tiles along u and v (to the right and slightly down on screen).
const SHADOW_U = 0.0205;
const SHADOW_V = -0.0088;

const STONE = '#9c9ca4';
const STONE_DARK = '#84848e';
const PLASTER = '#e4d8b8';
const TIMBER = '#6b4a2b';
const WOOD = '#9a6b3f';
const THATCH = '#cfae58';
const ROOF_TILE = '#a5522f';
const DARK = '#2a2018';
const HAY = '#d6b85a';

function hull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Pt[]) => {
    const out: Pt[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half(pts.reverse())];
}

// --- surface textures -------------------------------------------------------------------------

type Material = 'stone' | 'ashlar' | 'flags' | 'plaster' | 'wood' | 'boards' | 'thatch' | 'tiles' | 'slate' | 'dirt';

/** Which texture a colour of the designs gets. Colours not listed (windows, cloth, team colours) stay plain. */
const MATERIALS: Record<string, Material> = {
  [STONE]: 'stone', [STONE_DARK]: 'stone', '#a8a8b0': 'stone', '#857a6a': 'stone', '#7d7468': 'stone', '#85898f': 'stone',
  '#8d8674': 'ashlar', '#cbbfa4': 'ashlar', '#b9ad92': 'ashlar', '#c2b699': 'ashlar',
  '#6f6f78': 'flags', '#74747e': 'flags',
  [PLASTER]: 'plaster', '#d9c8a0': 'plaster', '#cbb98f': 'plaster', '#d8cfae': 'plaster',
  [WOOD]: 'wood', [TIMBER]: 'wood', '#a8824a': 'wood', '#b89358': 'wood', '#7a5230': 'wood',
  '#3a2a1a': 'boards', '#22160c': 'boards',
  '#7d5a34': 'boards', '#5f4326': 'boards',
  [THATCH]: 'thatch', [HAY]: 'thatch',
  [ROOF_TILE]: 'tiles', '#7a3b2a': 'tiles',
  '#3d4450': 'slate', '#45505c': 'slate',
  '#9a8f7c': 'dirt', '#b59a6a': 'dirt', '#c9b98f': 'dirt', '#a58d62': 'dirt', '#8a7350': 'dirt',
};

function grain(x: number, y: number, salt: number): number {
  let h = (Math.floor(x) * 374761393 + Math.floor(y) * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const DARKEN = (a: number) => `rgba(20,12,6,${a})`;
const LIGHTEN = (a: number) => `rgba(255,248,230,${a})`;

/**
 * Paints a material's pattern in texture space: s runs along the face, t up it (or up the slope
 * of a roof), both in pixels. The caller has clipped to the face and set the transform.
 */
function paintMaterial(c: Ctx, mat: Material, s0: number, s1: number, t0: number, t1: number, salt: number): void {
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    c.fillStyle = color;
    c.fillRect(x, y, w, h);
  };
  const w = s1 - s0;
  if (mat === 'stone' || mat === 'ashlar' || mat === 'flags') {
    // Courses of blocks with mortar between them, each block a slightly different shade.
    const course = mat === 'ashlar' ? 6 : mat === 'flags' ? 7 : 5;
    const long = mat === 'ashlar' ? 13 : mat === 'flags' ? 8 : 9;
    for (let r = Math.floor(t0 / course); r * course < t1; r++) {
      const y = r * course;
      rect(s0, y, w, 0.9, DARKEN(0.26));
      let x = Math.floor(s0 / long) * long - (r % 2) * Math.floor(long / 2);
      while (x < s1) {
        const g = grain(x, r, salt);
        const len = long - 2 + Math.floor(g * 5);
        rect(x, y, 0.9, course, DARKEN(0.22));
        if (g < 0.35) rect(x + 1, y + 1, len - 1, course - 1, DARKEN(0.08));
        else if (g > 0.75) rect(x + 1, y + 1, len - 1, course - 1, LIGHTEN(0.09));
        // A lit upper edge on each block.
        rect(x + 1, y + course - 1.6, len - 1.5, 0.7, LIGHTEN(0.1));
        x += len;
      }
    }
    return;
  }
  if (mat === 'plaster' || mat === 'dirt') {
    // Rough render: fine speckles and a few soft stains.
    const step = mat === 'dirt' ? 2.5 : 3;
    for (let y = Math.floor(t0); y < t1; y += step) {
      for (let x = Math.floor(s0); x < s1; x += step) {
        const g = grain(x, y, salt);
        if (g < 0.16) rect(x, y, 1, 1, DARKEN(0.13));
        else if (g > 0.9) rect(x, y, 1, 1, LIGHTEN(0.16));
      }
    }
    for (let i = 0; i < w * (t1 - t0) / 260; i++) {
      const g = grain(i, salt, 7);
      rect(s0 + g * w, t0 + grain(salt, i, 9) * (t1 - t0), 4 + g * 5, 2 + g * 3, DARKEN(0.05));
    }
    return;
  }
  if (mat === 'wood' || mat === 'boards') {
    // Upright boards with dark gaps and streaks of grain.
    const board = mat === 'boards' ? 3 : 4;
    for (let x = Math.floor(s0 / board) * board; x < s1; x += board) {
      rect(x, t0, 0.8, t1 - t0, DARKEN(0.3));
      rect(x + 0.8, t0, 0.6, t1 - t0, LIGHTEN(0.07));
      for (let y = Math.floor(t0); y < t1; y += 3) {
        const g = grain(x, y, salt);
        if (g < 0.22) rect(x + 1.5 + g * 4, y, 0.6, 2 + g * 6, DARKEN(0.16));
        if (g > 0.93) rect(x + 2, y, 1.2, 1.2, DARKEN(0.35));
      }
    }
    return;
  }
  if (mat === 'thatch') {
    // Layers of straw running down the slope, each layer's lower edge in shadow.
    for (let r = Math.floor(t0 / 6); r * 6 < t1; r++) {
      const y = r * 6;
      rect(s0, y, w, 1.2, DARKEN(0.22));
      for (let x = Math.floor(s0); x < s1; x += 1.5) {
        const g = grain(x * 2, r, salt);
        rect(x, y + 1.2, 0.7, 2 + g * 4, g < 0.5 ? DARKEN(0.12) : LIGHTEN(0.13));
      }
    }
    return;
  }
  // Roof tiles and slates: rows with joints, every tile lit along its top.
  const row = mat === 'slate' ? 3.5 : 4;
  const tile = mat === 'slate' ? 5 : 6;
  for (let r = Math.floor(t0 / row); r * row < t1; r++) {
    const y = r * row;
    rect(s0, y, w, 1, DARKEN(0.3));
    for (let x = Math.floor(s0 / tile) * tile - (r % 2) * (tile / 2); x < s1; x += tile) {
      const g = grain(x, r, salt);
      rect(x, y, 0.8, row, DARKEN(0.2));
      rect(x + 1, y + row - 1.5, tile - 2, 0.8, LIGHTEN(mat === 'slate' ? 0.1 : 0.16));
      if (g < 0.2) rect(x + 1, y + 1, tile - 1.5, row - 1.5, DARKEN(0.1));
    }
  }
}

/**
 * Draws simple solids in the isometric view. u and v are tile coordinates inside
 * the building's footprint, z is height in pixels. In shadow mode the same calls
 * collect the ground shadow of each solid instead of drawing it.
 */
class Pen {
  private shadows: Pt[][] = [];

  /** Surfaces get textures: only in the pictures that are kept, so live drawing stays cheap. */
  textured = false;

  constructor(private ctx: Ctx, private sx: number, private sy: number, private shadowMode: boolean) {}

  /**
   * Fills a face, then lays its material over it. `o` is a corner of the face in (u, v, z), `ds` and
   * `dt` the steps in (u, v, z) of one texture pixel along the face and up it.
   */
  face(color: string, pts: Pt[], mat: Material | undefined, o: [number, number, number], ds: [number, number, number], dt: [number, number, number]): void {
    this.poly(color, pts);
    if (!mat || !this.textured || this.shadowMode) return;
    const c = this.ctx;
    const [ox, oy] = this.p(...o);
    const sp = this.p(o[0] + ds[0], o[1] + ds[1], o[2] + ds[2]);
    const tp = this.p(o[0] + dt[0], o[1] + dt[1], o[2] + dt[2]);
    const a = sp[0] - ox;
    const b = sp[1] - oy;
    const cc = tp[0] - ox;
    const d = tp[1] - oy;
    const det = a * d - b * cc;
    if (Math.abs(det) < 1e-6) return;
    // The face's corners in texture space give the area to cover.
    let s0 = Infinity;
    let s1 = -Infinity;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const [x, y] of pts) {
      const dx = x - ox;
      const dy = y - oy;
      const s = (d * dx - cc * dy) / det;
      const t = (-b * dx + a * dy) / det;
      s0 = Math.min(s0, s);
      s1 = Math.max(s1, s);
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
    }
    c.save();
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) c.lineTo(x, y);
    c.closePath();
    c.clip();
    c.transform(a, b, cc, d, ox, oy);
    paintMaterial(c, mat, s0, s1, t0, t1, Math.round(o[0] * 7 + o[1] * 13 + o[2]));
    c.restore();
  }

  p(u: number, v: number, z = 0): Pt {
    return [this.sx + (u - v) * HW, this.sy + (u + v) * HH - z];
  }

  private cast(points: [number, number, number][]): void {
    this.shadows.push(hull(points.map(([u, v, z]) => this.p(u + z * SHADOW_U, v + z * SHADOW_V))));
  }

  fillShadows(): void {
    const c = this.ctx;
    c.fillStyle = 'rgba(0,0,0,.3)';
    c.beginPath();
    for (const poly of this.shadows) {
      c.moveTo(poly[0][0], poly[0][1]);
      for (const [x, y] of poly.slice(1)) c.lineTo(x, y);
      c.closePath();
    }
    // One fill for all solids, so overlapping shadows do not get darker.
    c.fill('nonzero');
  }

  poly(color: string, pts: Pt[]): void {
    if (this.shadowMode) return;
    const c = this.ctx;
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) c.lineTo(x, y);
    c.closePath();
    c.fill();
  }

  box(u0: number, v0: number, u1: number, v1: number, z0: number, z1: number, color: string, top?: string): void {
    if (this.shadowMode) {
      this.cast([[u0, v0, z0], [u1, v0, z0], [u1, v1, z0], [u0, v1, z0], [u0, v0, z1], [u1, v0, z1], [u1, v1, z1], [u0, v1, z1]]);
      return;
    }
    const mat = MATERIALS[color];
    const px = 1 / HW;
    // Texture rows run from the ground up; t grows upwards, so it starts at the bottom edge.
    this.face(shade(color, 0.7), [this.p(u0, v1, z0), this.p(u1, v1, z0), this.p(u1, v1, z1), this.p(u0, v1, z1)], mat, [u0, v1, z0], [px, 0, 0], [0, 0, 1]);
    this.face(shade(color, 0.9), [this.p(u1, v1, z0), this.p(u1, v0, z0), this.p(u1, v0, z1), this.p(u1, v1, z1)], mat, [u1, v0, z0], [0, px, 0], [0, 0, 1]);
    const topMat = top ? MATERIALS[top] : mat === 'stone' || mat === 'ashlar' ? 'flags' : mat === 'wood' ? 'boards' : mat;
    this.face(top ?? shade(color, 1.1), [this.p(u0, v0, z1), this.p(u1, v0, z1), this.p(u1, v1, z1), this.p(u0, v1, z1)], topMat, [u0, v0, z1], [px, 0, 0], [0, px, 0]);
  }

  /** Pitched roof. The ridge runs along u when `alongU`, otherwise along v. */
  gable(u0: number, v0: number, u1: number, v1: number, z: number, h: number, color: string, end: string, alongU: boolean): void {
    const um = (u0 + u1) / 2;
    const vm = (v0 + v1) / 2;
    if (this.shadowMode) {
      const ridge: [number, number, number][] = alongU ? [[u0, vm, z + h], [u1, vm, z + h]] : [[um, v0, z + h], [um, v1, z + h]];
      this.cast([[u0, v0, z], [u1, v0, z], [u1, v1, z], [u0, v1, z], ...ridge]);
      return;
    }
    const mat = MATERIALS[color];
    const endMat = MATERIALS[end];
    const px = 1 / HW;
    // One texture pixel up the slope, from the eave towards the ridge.
    const up = (dv: number, du: number) => {
      const len = Math.hypot((du + dv) * HW * 0.7, h) || 1;
      return [du / len, dv / len, h / len] as [number, number, number];
    };
    if (alongU) {
      this.face(shade(color, 1.1), [this.p(u0, v0, z), this.p(u1, v0, z), this.p(u1, vm, z + h), this.p(u0, vm, z + h)], mat, [u0, v0, z], [px, 0, 0], up(vm - v0, 0));
      this.face(shade(color, 0.78), [this.p(u0, v1, z), this.p(u1, v1, z), this.p(u1, vm, z + h), this.p(u0, vm, z + h)], mat, [u0, v1, z], [px, 0, 0], up(vm - v1, 0));
      this.face(shade(end, 0.9), [this.p(u1, v0, z), this.p(u1, v1, z), this.p(u1, vm, z + h)], endMat, [u1, v0, z], [0, px, 0], [0, 0, 1]);
    } else {
      this.face(shade(color, 0.7), [this.p(u0, v0, z), this.p(u0, v1, z), this.p(um, v1, z + h), this.p(um, v0, z + h)], mat, [u0, v0, z], [0, px, 0], up(0, um - u0));
      this.face(color, [this.p(u1, v0, z), this.p(u1, v1, z), this.p(um, v1, z + h), this.p(um, v0, z + h)], mat, [u1, v0, z], [0, px, 0], up(0, um - u1));
      this.face(shade(end, 0.7), [this.p(u0, v1, z), this.p(u1, v1, z), this.p(um, v1, z + h)], endMat, [u0, v1, z], [px, 0, 0], [0, 0, 1]);
    }
  }

  pyramid(u0: number, v0: number, u1: number, v1: number, z: number, h: number, color: string): void {
    const um = (u0 + u1) / 2;
    const vm = (v0 + v1) / 2;
    if (this.shadowMode) {
      this.cast([[u0, v0, z], [u1, v0, z], [u1, v1, z], [u0, v1, z], [um, vm, z + h]]);
      return;
    }
    const apex = this.p(um, vm, z + h);
    // Team-coloured spires are tiled too.
    const mat = MATERIALS[color] ?? (PLAYER_COLORS.includes(color) ? 'tiles' : undefined);
    const px = 1 / HW;
    const up = (du: number, dv: number) => {
      const len = Math.hypot((du + dv) * HW * 0.7, h) || 1;
      return [du / len, dv / len, h / len] as [number, number, number];
    };
    this.face(shade(color, 1.1), [this.p(u0, v0, z), this.p(u1, v0, z), apex], mat, [u0, v0, z], [px, 0, 0], up(0, vm - v0));
    this.face(shade(color, 0.85), [this.p(u0, v0, z), this.p(u0, v1, z), apex], mat, [u0, v0, z], [0, px, 0], up(um - u0, 0));
    this.face(shade(color, 0.72), [this.p(u0, v1, z), this.p(u1, v1, z), apex], mat, [u0, v1, z], [px, 0, 0], up(0, vm - v1));
    this.face(color, [this.p(u1, v1, z), this.p(u1, v0, z), apex], mat, [u1, v0, z], [0, px, 0], up(um - u1, 0));
  }

  /** Flat rectangle on the left-facing wall plane v = const. */
  onV(v: number, uA: number, uB: number, zA: number, zB: number, color: string): void {
    this.face(shade(color, 0.8), [this.p(uA, v, zA), this.p(uB, v, zA), this.p(uB, v, zB), this.p(uA, v, zB)], MATERIALS[color], [uA, v, zA], [1 / HW, 0, 0], [0, 0, 1]);
  }

  /** Flat rectangle on the right-facing wall plane u = const. */
  onU(u: number, vA: number, vB: number, zA: number, zB: number, color: string): void {
    this.face(color, [this.p(u, vA, zA), this.p(u, vB, zA), this.p(u, vB, zB), this.p(u, vA, zB)], MATERIALS[color], [u, vA, zA], [0, 1 / HW, 0], [0, 0, 1]);
  }

  ground(u0: number, v0: number, u1: number, v1: number, color: string): void {
    this.face(color, [this.p(u0, v0), this.p(u1, v0), this.p(u1, v1), this.p(u0, v1)], MATERIALS[color], [u0, v0, 0], [1 / HW, 0, 0], [0, 1 / HW, 0]);
  }

  /** Battlements around the top edge of a wall or tower. */
  crenels(u0: number, v0: number, u1: number, v1: number, z: number, color: string): void {
    if (this.shadowMode) return;
    const w = 0.12;
    const count = Math.max(2, Math.round((u1 - u0) / 0.3));
    const stepU = (u1 - u0 - w) / (count - 1);
    const stepV = (v1 - v0 - w) / (count - 1);
    for (let i = 0; i < count; i++) this.box(u0 + i * stepU, v0, u0 + i * stepU + w, v0 + w, z, z + 5, color);
    for (let i = 1; i < count; i++) this.box(u0, v0 + i * stepV, u0 + w, v0 + i * stepV + w, z, z + 5, color);
    for (let i = 1; i < count; i++) this.box(u0 + i * stepU, v1 - w, u0 + i * stepU + w, v1, z, z + 5, color);
    for (let i = 1; i < count - 1; i++) this.box(u1 - w, v0 + i * stepV, u1, v0 + i * stepV + w, z, z + 5, color);
  }

  flag(base: Pt, team: string, now: number): void {
    if (!this.shadowMode) drawRoyalFlag(this.ctx, base, team, now);
  }

  line(a: Pt, b: Pt, color: string, width: number): void {
    if (this.shadowMode) return;
    const c = this.ctx;
    c.strokeStyle = color;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(a[0], a[1]);
    c.lineTo(b[0], b[1]);
    c.stroke();
  }

  disc(at: Pt, r: number, color: string): void {
    if (this.shadowMode) return;
    const c = this.ctx;
    c.fillStyle = color;
    c.beginPath();
    c.ellipse(at[0], at[1], r * 0.8, r, 0, 0, Math.PI * 2);
    c.fill();
  }
}

/** Four sails on a hub in front of the windmill tower. */
function millSails(pen: Pen, now: number): void {
  const hub = pen.p(1.55, 0.9, 30);
  const turn = now / 1400;
  for (let i = 0; i < 4; i++) {
    const a = turn + (i * Math.PI) / 2;
    const tip: Pt = [hub[0] + Math.cos(a) * 26, hub[1] + Math.sin(a) * 26];
    const side: Pt = [Math.cos(a + Math.PI / 2) * 5, Math.sin(a + Math.PI / 2) * 5];
    const from: Pt = [hub[0] + Math.cos(a) * 6, hub[1] + Math.sin(a) * 6];
    pen.poly('#efe6cf', [from, tip, [tip[0] + side[0], tip[1] + side[1]], [from[0] + side[0], from[1] + side[1]]]);
    pen.line(hub, tip, TIMBER, 2);
  }
  pen.disc(hub, 3, '#3a2a1a');
}

export interface BuildingState {
  /** Construction progress 0..1. */
  built: number;
  /** A king is sheltering inside (town centres and castles). */
  kingInside: boolean;
  /** Someone is sheltering inside: the building flies a flag. */
  occupied?: boolean;
  /** Time for animations; -1 while drawing the still picture that is kept and reused. */
  now: number;
}

type Design = (pen: Pen, team: string, state: BuildingState) => void;

function hash(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

const DESIGNS: Partial<Record<Kind, Design>> = {
  // Half-timbered cottage with a thatched roof and a chimney.
  house(pen, team) {
    pen.box(0.3, 0.3, 1.7, 1.7, 0, 15, PLASTER);
    for (const [a, b] of [[0.3, 0.4], [0.95, 1.05], [1.6, 1.7]]) pen.onV(1.7, a, b, 0, 15, TIMBER);
    pen.onV(1.7, 0.3, 1.7, 13, 15, TIMBER);
    pen.onV(1.7, 0.55, 0.82, 5, 11, '#39404c');
    for (const [a, b] of [[0.3, 0.4], [1.6, 1.7]]) pen.onU(1.7, a, b, 0, 15, TIMBER);
    pen.onU(1.7, 0.3, 1.7, 13, 15, TIMBER);
    pen.onU(1.7, 0.82, 1.18, 0, 10, team);
    pen.gable(0.12, 0.12, 1.88, 1.88, 15, 18, THATCH, PLASTER, true);
    pen.box(0.5, 1.15, 0.72, 1.37, 20, 33, STONE_DARK);
  },

  // Large hall on a stone plinth with a tiled roof and a watch turret in the owner's colour.
  towncenter(pen, team) {
    pen.box(0.08, 0.08, 2.92, 2.92, 0, 5, '#8d8674');
    pen.box(0.3, 0.3, 2.7, 2.7, 5, 24, '#d9c8a0');
    pen.onV(2.7, 0.3, 2.7, 20, 24, team);
    pen.onU(2.7, 0.3, 2.7, 20, 24, team);
    for (const u of [0.6, 1.35, 2.1]) pen.onV(2.7, u, u + 0.3, 10, 17, '#39404c');
    pen.onU(2.7, 1.15, 1.85, 5, 19, '#3a2a1a');
    pen.onU(2.7, 0.5, 0.8, 10, 17, '#39404c');
    pen.onU(2.7, 2.2, 2.5, 10, 17, '#39404c');
    pen.pyramid(0.1, 0.1, 2.9, 2.9, 24, 20, ROOF_TILE);
    pen.box(1.12, 1.12, 1.88, 1.88, 34, 56, '#cbb98f');
    pen.onU(1.88, 1.4, 1.6, 42, 51, '#39404c');
    pen.onV(1.88, 1.4, 1.6, 42, 51, '#39404c');
    pen.pyramid(1.0, 1.0, 2.0, 2.0, 56, 15, team);
  },

  // Open-sided shed with stacked logs and a chopping block.
  lumbercamp(pen, team) {
    pen.box(0.12, 0.12, 1.88, 1.88, 0, 2, '#8a7350');
    pen.box(0.2, 0.2, 1.8, 0.32, 2, 17, WOOD);
    pen.box(0.2, 0.2, 0.32, 1.8, 2, 17, WOOD);
    for (let i = 0; i < 3; i++) pen.box(0.45, 0.45 + i * 0.22, 1.5, 0.65 + i * 0.22, 2, 7, i % 2 ? shade(TIMBER, 1.25) : TIMBER);
    for (let i = 0; i < 2; i++) pen.box(0.5, 0.56 + i * 0.22, 1.45, 0.76 + i * 0.22, 7, 12, i % 2 ? TIMBER : shade(TIMBER, 1.25));
    pen.box(0.5, 1.25, 0.85, 1.6, 2, 8, '#a8824a');
    pen.box(1.15, 1.2, 1.4, 1.45, 2, 7, shade(TIMBER, 1.1));
    pen.line(pen.p(1.27, 1.32, 7), pen.p(1.45, 1.2, 17), '#7a5230', 2);
    for (const [u, v] of [[1.7, 0.2], [0.2, 1.7], [1.7, 1.7]]) pen.box(u, v, u + 0.1, v + 0.1, 2, 18, TIMBER);
    pen.gable(0.04, 0.04, 1.96, 1.96, 18, 9, '#7d5a34', '#7d5a34', false);
    pen.onU(1.8, 0.85, 1.15, 9, 17, team);
  },

  // Low stone-and-timber hut with heaps of ore and a cart.
  miningcamp(pen, team) {
    pen.ground(0.1, 0.1, 1.9, 1.9, '#9a8f7c');
    pen.box(0.25, 0.25, 1.4, 1.05, 0, 13, '#857a6a');
    pen.onV(1.05, 0.6, 1.0, 0, 10, '#22160c');
    pen.onU(1.4, 0.25, 1.05, 9, 13, team);
    pen.gable(0.15, 0.15, 1.5, 1.15, 13, 8, '#5f4326', '#857a6a', true);
    pen.box(1.5, 0.45, 1.85, 0.8, 0, 6, '#85898f');
    pen.box(1.56, 0.5, 1.8, 0.74, 6, 9, '#a6aab0');
    pen.box(0.3, 1.3, 0.7, 1.7, 0, 6, '#7a6f5a');
    pen.box(0.36, 1.36, 0.64, 1.64, 6, 9, '#f2cf3a');
    pen.box(1.0, 1.35, 1.6, 1.7, 3, 9, WOOD);
    pen.box(1.06, 1.4, 1.54, 1.65, 9, 11, '#85898f');
    pen.disc(pen.p(1.1, 1.72, 3), 4, '#3a2a1a');
    pen.disc(pen.p(1.5, 1.72, 3), 4, '#3a2a1a');
  },

  // Round stone windmill with turning sails.
  mill(pen, team, state) {
    pen.box(0.3, 1.2, 0.75, 1.65, 0, 6, '#d8cfae');
    pen.box(1.3, 1.35, 1.7, 1.7, 0, 5, HAY);
    pen.box(0.5, 0.4, 1.5, 1.4, 0, 30, '#d9c8a0');
    pen.onU(1.5, 0.78, 1.02, 0, 12, '#3a2a1a');
    pen.onV(1.4, 0.85, 1.05, 14, 21, '#39404c');
    pen.onU(1.5, 0.4, 1.4, 26, 30, team);
    pen.pyramid(0.4, 0.3, 1.6, 1.5, 30, 16, '#7a3b2a');
    // The sails turn, so they are drawn every frame rather than kept in the picture of the mill.
    if (state.now >= 0) millSails(pen, state.now);
  },

  // Stone drill hall with battlements, a corner turret and banners by the gate.
  barracks(pen, team) {
    pen.box(0.2, 0.2, 2.8, 2.8, 0, 22, STONE, '#6f6f78');
    pen.crenels(0.2, 0.2, 2.8, 2.8, 22, STONE);
    for (const u of [0.55, 1.4, 2.25]) pen.onV(2.8, u, u + 0.12, 9, 17, DARK);
    pen.onU(2.8, 1.2, 1.8, 0, 15, '#3a2a1a');
    pen.onU(2.8, 0.7, 0.98, 7, 20, team);
    pen.onU(2.8, 2.02, 2.3, 7, 20, team);
    pen.box(0.2, 0.2, 1.15, 1.15, 22, 37, STONE_DARK, '#6f6f78');
    pen.crenels(0.2, 0.2, 1.15, 1.15, 37, STONE_DARK);
  },

  // Fenced practice yard with straw targets and a cloth-roofed shelter.
  range(pen, team) {
    pen.ground(0.08, 0.08, 2.92, 2.92, '#b59a6a');
    pen.box(0.08, 0.08, 2.92, 0.15, 0, 8, TIMBER);
    pen.box(0.08, 0.08, 0.15, 2.92, 0, 8, TIMBER);
    pen.box(0.3, 0.3, 2.7, 1.05, 0, 14, WOOD);
    pen.onV(1.05, 0.5, 2.5, 0, 11, DARK);
    pen.gable(0.2, 0.2, 2.8, 1.25, 14, 9, team, WOOD, true);
    pen.box(2.25, 1.45, 2.7, 1.9, 0, 8, HAY);
    for (const u of [0.7, 1.75]) {
      pen.box(u - 0.04, 2.26, u + 0.04, 2.34, 0, 10, TIMBER);
      const at = pen.p(u, 2.3, 15);
      pen.disc(at, 9, '#efe6cf');
      pen.disc(at, 6, '#c8402f');
      pen.disc(at, 3, '#efe6cf');
      pen.disc(at, 1.2, '#c8402f');
    }
    pen.box(0.08, 2.85, 2.92, 2.92, 0, 7, TIMBER);
    pen.box(2.85, 0.08, 2.92, 2.92, 0, 7, TIMBER);
  },

  // Long wooden barn with open stalls, hay and a paddock fence.
  stable(pen, team) {
    pen.box(0.2, 0.55, 2.8, 2.35, 0, 16, WOOD);
    for (let i = 0; i < 3; i++) {
      const u = 0.42 + i * 0.8;
      pen.onV(2.35, u, u + 0.56, 0, 12, '#22160c');
      pen.onV(2.35, u, u + 0.56, 0, 5, '#7a5230');
    }
    pen.onU(2.8, 0.55, 2.35, 12, 16, team);
    pen.onU(2.8, 1.2, 1.7, 0, 11, '#3a2a1a');
    pen.gable(0.05, 0.4, 2.95, 2.5, 16, 15, '#7a3b2a', WOOD, true);
    pen.box(0.3, 2.5, 0.75, 2.82, 0, 7, HAY);
    pen.box(1.3, 2.55, 2.2, 2.72, 0, 4, TIMBER);
    pen.box(0.08, 2.87, 2.92, 2.92, 0, 7, TIMBER);
    pen.box(2.87, 2.4, 2.92, 2.92, 0, 7, TIMBER);
  },

  // Tall stone tower with a jutting platform and a pointed roof in the owner's colour.
  tower(pen, team) {
    pen.box(0.22, 0.22, 0.78, 0.78, 0, 40, STONE);
    pen.onU(0.78, 0.46, 0.54, 18, 28, DARK);
    pen.onV(0.78, 0.46, 0.54, 18, 28, DARK);
    pen.box(0.13, 0.13, 0.87, 0.87, 40, 46, STONE_DARK);
    pen.crenels(0.13, 0.13, 0.87, 0.87, 46, STONE_DARK);
    pen.pyramid(0.26, 0.26, 0.74, 0.74, 46, 15, team);
  },

  // Stone forge with a slate roof, a glowing hearth and an anvil outside.
  blacksmith(pen, team) {
    pen.box(0.25, 0.25, 1.75, 1.75, 0, 16, '#7d7468');
    pen.onU(1.75, 0.25, 1.75, 12, 16, team);
    pen.onU(1.75, 0.8, 1.25, 0, 11, '#22160c');
    pen.onU(1.75, 0.9, 1.15, 0, 6, '#f5a623');
    pen.onU(1.75, 0.97, 1.08, 0, 4, '#ffe45c');
    pen.onV(1.75, 0.6, 0.9, 6, 12, '#39404c');
    pen.gable(0.12, 0.12, 1.88, 1.88, 16, 13, '#3d4450', '#7d7468', false);
    pen.box(0.45, 0.45, 0.8, 0.8, 20, 38, STONE_DARK);
    pen.box(1.82, 1.5, 1.98, 1.8, 0, 3, TIMBER);
    pen.box(1.8, 1.45, 2.0, 1.85, 3, 7, '#3a3d44');
  },

  // Open square with three cloth-roofed stalls and stacked goods.
  market(pen, team) {
    pen.ground(0.08, 0.08, 2.92, 2.92, '#c9b98f');
    const stall = (u: number, v: number, cloth: string) => {
      pen.box(u, v, u + 1.0, v + 0.7, 0, 7, WOOD);
      pen.box(u + 0.1, v + 0.1, u + 0.9, v + 0.6, 7, 10, '#d8cfae');
      for (const [a, b] of [[u, v + 0.62], [u + 0.92, v + 0.62], [u + 0.92, v]]) pen.box(a, b, a + 0.08, b + 0.08, 0, 18, TIMBER);
      pen.gable(u - 0.08, v - 0.08, u + 1.08, v + 0.78, 18, 8, cloth, cloth, true);
    };
    stall(0.3, 0.3, team);
    stall(1.7, 0.3, '#d8cfae');
    stall(0.3, 1.7, '#b8473a');
    pen.box(1.8, 1.7, 2.2, 2.1, 0, 9, '#b89358');
    pen.box(2.25, 1.75, 2.6, 2.1, 0, 7, '#a8824a');
    pen.box(1.9, 2.2, 2.3, 2.6, 0, 6, HAY);
    pen.disc(pen.p(2.5, 2.45, 5), 5, '#7a5230');
  },

  // Timber shed with a half-built siege frame and lumber in the yard.
  workshop(pen, team) {
    pen.ground(0.08, 0.08, 2.92, 2.92, '#a58d62');
    pen.box(0.2, 0.2, 2.8, 1.35, 0, 20, WOOD);
    pen.onV(1.35, 0.5, 2.5, 0, 15, '#22160c');
    pen.onU(2.8, 0.2, 1.35, 16, 20, team);
    pen.gable(0.08, 0.08, 2.92, 1.5, 20, 12, '#5f4326', WOOD, true);
    pen.box(0.4, 2.2, 1.3, 2.4, 0, 4, TIMBER);
    pen.box(0.45, 2.42, 1.35, 2.62, 0, 4, shade(TIMBER, 1.2));
    pen.box(0.5, 2.25, 1.25, 2.5, 4, 8, shade(TIMBER, 1.1));
    for (const [a, b] of [[1.7, 1.8], [2.5, 1.8], [1.7, 2.5], [2.5, 2.5]]) pen.box(a, b, a + 0.08, b + 0.08, 0, 16, TIMBER);
    pen.box(1.55, 2.1, 2.75, 2.26, 8, 12, '#7a5230');
    pen.box(2.7, 2.08, 2.85, 2.28, 7, 13, '#55585e');
    pen.disc(pen.p(1.8, 2.6, 4), 5, '#3a2a1a');
    pen.disc(pen.p(2.5, 2.6, 4), 5, '#3a2a1a');
  },

  // One tile of stone wall; neighbouring tiles join into a continuous wall.
  wall(pen) {
    pen.box(0, 0, 1, 1, 0, 18, STONE, '#74747e');
    pen.crenels(0, 0, 1, 1, 18, STONE);
  },

  // A wall tile with an archway; the doors carry the owner's colour.
  gate(pen, team) {
    pen.box(0, 0, 1, 1, 0, 24, STONE, '#74747e');
    pen.onU(1, 0.2, 0.8, 0, 17, '#22160c');
    pen.onU(1, 0.26, 0.74, 0, 14, team);
    pen.onU(1, 0.48, 0.52, 0, 14, '#22160c');
    pen.onV(1, 0.2, 0.8, 0, 17, '#22160c');
    pen.onV(1, 0.26, 0.74, 0, 14, team);
    pen.onV(1, 0.48, 0.52, 0, 14, '#22160c');
    pen.crenels(0, 0, 1, 1, 24, STONE);
  },

  // A stone hall with a slate roof and a bell tower, arched windows and a banner in the owner's colour.
  monastery(pen, team) {
    pen.box(0.15, 0.15, 2.85, 2.85, 0, 3, '#8d8674');
    pen.box(1.15, 0.45, 2.7, 2.6, 3, 22, '#cbbfa4');
    for (const u of [1.4, 1.9, 2.4]) {
      pen.onV(2.6, u - 0.12, u + 0.12, 9, 17, '#2c3440');
      pen.onV(2.6, u - 0.07, u + 0.07, 17, 19, '#2c3440');
    }
    pen.onU(2.7, 1.25, 1.85, 3, 16, '#3a2a1a');
    pen.onU(2.7, 0.55, 0.85, 12, 20, team);
    pen.gable(1.05, 0.35, 2.8, 2.7, 22, 14, '#45505c', '#cbbfa4', false);
    pen.box(0.3, 1.1, 1.15, 2.6, 3, 16, '#b9ad92');
    pen.gable(0.25, 1.05, 1.2, 2.65, 16, 8, '#45505c', '#b9ad92', false);
    pen.box(0.3, 0.3, 1.05, 1.05, 3, 52, '#c2b699');
    pen.onU(1.05, 0.55, 0.8, 38, 48, '#2c3440');
    pen.onV(1.05, 0.55, 0.8, 38, 48, '#2c3440');
    pen.disc(pen.p(1.05, 0.68, 41), 3, '#e3b84e');
    pen.pyramid(0.22, 0.22, 1.13, 1.13, 52, 20, '#45505c');
  },

  // Walled keep with four corner towers. A flag flies only while a king is inside.
  castle(pen, team, state) {
    const tower = (u: number, v: number) => {
      pen.box(u, v, u + 0.9, v + 0.9, 0, 38, STONE_DARK, '#6f6f78');
      pen.onU(u + 0.9, v + 0.4, v + 0.5, 20, 30, DARK);
      pen.onV(v + 0.9, u + 0.4, u + 0.5, 20, 30, DARK);
      pen.crenels(u, v, u + 0.9, v + 0.9, 38, STONE_DARK);
    };
    tower(0.1, 0.1);
    pen.box(1, 0.3, 3, 0.6, 0, 24, STONE);
    pen.box(0.3, 1, 0.6, 3, 0, 24, STONE);
    pen.box(1.2, 1.2, 2.8, 2.8, 0, 50, '#a8a8b0', '#74747e');
    pen.onV(2.8, 1.5, 1.65, 28, 40, DARK);
    pen.onV(2.8, 2.35, 2.5, 28, 40, DARK);
    pen.onU(2.8, 1.75, 2.25, 24, 44, team);
    pen.crenels(1.2, 1.2, 2.8, 2.8, 50, '#a8a8b0');
    tower(3.0, 0.1);
    tower(0.1, 3.0);
    pen.box(1, 3.3, 3, 3.6, 0, 24, STONE, '#6f6f78');
    pen.crenels(1, 3.3, 3, 3.6, 24, STONE);
    pen.box(3.3, 1, 3.6, 3, 0, 24, STONE, '#6f6f78');
    pen.onU(3.6, 1.65, 2.35, 0, 17, '#3a2a1a');
    pen.crenels(3.3, 1, 3.6, 3, 24, STONE);
    tower(3.0, 3.0);
    if (state.kingInside && state.now >= 0) pen.flag(pen.p(2, 2, 50), team, state.now);
  },
};

/** A plain flag in the owner's colour: villagers are sheltering inside. */
export function drawTeamFlag(ctx: Ctx, base: Pt, team: string, now: number): void {
  const top: Pt = [base[0], base[1] - 24];
  ctx.strokeStyle = '#3a2a1a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(base[0], base[1]);
  ctx.lineTo(top[0], top[1]);
  ctx.stroke();
  const wave = (k: number) => Math.sin(now / 180 + k) * 2;
  ctx.fillStyle = team;
  ctx.beginPath();
  ctx.moveTo(top[0], top[1]);
  ctx.lineTo(top[0] + 9, top[1] + 1 + wave(0));
  ctx.lineTo(top[0] + 17, top[1] + wave(1.5));
  ctx.lineTo(top[0] + 17, top[1] + 9 + wave(1.5));
  ctx.lineTo(top[0] + 9, top[1] + 10 + wave(0));
  ctx.lineTo(top[0], top[1] + 9);
  ctx.closePath();
  ctx.fill();
}

/** The royal flag with a crown, rippling in the wind. `base` is the foot of the pole. */
export function drawRoyalFlag(ctx: Ctx, base: Pt, team: string, now: number): void {
  const top: Pt = [base[0], base[1] - 30];
  const fill = (color: string, pts: Pt[]) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
  };
  ctx.strokeStyle = '#3a2a1a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(base[0], base[1]);
  ctx.lineTo(top[0], top[1]);
  ctx.stroke();
  const wave = (k: number) => Math.sin(now / 180 + k) * 2;
  fill(team, [top, [top[0] + 11, top[1] + 2 + wave(0)], [top[0] + 22, top[1] + 1 + wave(1.5)],
    [top[0] + 22, top[1] + 13 + wave(1.5)], [top[0] + 11, top[1] + 14 + wave(0)], [top[0], top[1] + 12]]);
  fill('#f2cf3a', [[top[0] + 6, top[1] + 9 + wave(0)], [top[0] + 6, top[1] + 4 + wave(0)], [top[0] + 9, top[1] + 7 + wave(0)],
    [top[0] + 11, top[1] + 4 + wave(0)], [top[0] + 13, top[1] + 7 + wave(0)], [top[0] + 16, top[1] + 4 + wave(0)], [top[0] + 16, top[1] + 9 + wave(0)]]);
}

function drawFarm(pen: Pen, team: string, state: BuildingState, seed: number): void {
  const done = state.built >= 1;
  pen.ground(0.04, 0.04, 1.96, 1.96, done ? '#6e4f2c' : '#7d6a4c');
  const rows = 8;
  for (let i = 0; i < rows; i++) {
    const v0 = 0.12 + (i * 1.76) / rows;
    if (i % 2 === 0) pen.ground(0.12, v0, 1.88, v0 + 1.76 / rows, done ? '#7d5a33' : '#8a7654');
  }
  if (done) {
    // Crops in every furrow, at different stages of ripeness.
    for (let i = 0; i < rows; i++) {
      const v = 0.12 + ((i + 0.5) * 1.76) / rows;
      for (let k = 0; k < 11; k++) {
        const r = hash(seed * 31 + i * 17 + k);
        const [x, y] = pen.p(0.2 + k * 0.16 + (r - 0.5) * 0.05, v);
        const tall = 3 + Math.floor(r * 4);
        pen.poly(r > 0.55 ? '#d8c45a' : r > 0.25 ? '#8fb04a' : '#5f9a3a', [[x - 1, y], [x + 1, y], [x + 1, y - tall], [x - 1, y - tall]]);
      }
    }
  }
  // Fence: posts joined by two rails.
  const fence = (from: [number, number], to: [number, number]) => {
    const n = 5;
    for (let i = 0; i <= n; i++) {
      const u = from[0] + ((to[0] - from[0]) * i) / n;
      const v = from[1] + ((to[1] - from[1]) * i) / n;
      pen.line(pen.p(u, v), pen.p(u, v, 8), TIMBER, 2);
    }
    for (const z of [3, 6]) pen.line(pen.p(from[0], from[1], z), pen.p(to[0], to[1], z), shade(TIMBER, 1.25), 1);
  };
  fence([0.04, 0.04], [1.96, 0.04]);
  fence([0.04, 0.04], [0.04, 1.96]);
  if (done) {
    // Scarecrow wearing the owner's colour.
    const foot = pen.p(0.45, 0.45);
    pen.line(foot, [foot[0], foot[1] - 20], TIMBER, 2);
    pen.line([foot[0] - 7, foot[1] - 14], [foot[0] + 7, foot[1] - 14], TIMBER, 2);
    pen.poly(team, [[foot[0] - 4, foot[1] - 15], [foot[0] + 4, foot[1] - 15], [foot[0] + 3, foot[1] - 7], [foot[0] - 3, foot[1] - 7]]);
    pen.disc([foot[0], foot[1] - 19], 3, '#e2c58c');
    pen.poly(THATCH, [[foot[0] - 5, foot[1] - 21], [foot[0] + 5, foot[1] - 21], [foot[0], foot[1] - 27]]);
  }
  fence([0.04, 1.96], [1.96, 1.96]);
  fence([1.96, 0.04], [1.96, 1.96]);
}

/** Draws a building whose footprint's top corner is at (sx, sy) on screen. */
export function drawBuilding(ctx: Ctx, kind: Kind, owner: number, seed: number, sx: number, sy: number, state: BuildingState): void {
  const team = PLAYER_COLORS[owner % PLAYER_COLORS.length];
  const s = DEFS[kind].size ?? 1;
  // A sprite pack may provide this building; its anchor sits on the centre of the footprint.
  const done = state.built >= 1;
  const custom = findSprite(done
    ? [...(state.kingInside ? [`building.${kind}.king`] : []), `building.${kind}`]
    : [`building.${kind}.site`, 'building.site', `building.${kind}`]);
  if (custom) {
    const ghost = !done && custom.key === `building.${kind}`;
    if (ghost) ctx.globalAlpha = 0.3 + 0.6 * state.built;
    const [left, top] = drawSprite(ctx, custom, team, sx, sy + s * HH, state.now);
    ctx.globalAlpha = 1;
    if (done && state.kingInside && custom.def.flag && !custom.key.endsWith('.king')) {
      const k = custom.def.scale ?? 1;
      drawRoyalFlag(ctx, [left + custom.def.flag[0] * k, top + custom.def.flag[1] * k], team, state.now);
    }
    return;
  }
  if (done) {
    // Finished buildings are drawn once into a picture and then copied; only moving parts are drawn live.
    const key = `${kind}|${owner}|${kind === 'farm' ? seed : 0}`;
    let img = buildingCache.get(key);
    if (!img) {
      img = document.createElement('canvas');
      img.width = s * HW * 2 + CACHE_LEFT + CACHE_RIGHT;
      img.height = s * HH * 2 + CACHE_TOP + CACHE_BOTTOM;
      paintBuilding(img.getContext('2d')!, kind, team, seed, s * HW + CACHE_LEFT, CACHE_TOP, { built: 1, kingInside: false, now: -1 });
      buildingCache.set(key, img);
    }
    ctx.drawImage(img, Math.round(sx) - s * HW - CACHE_LEFT, Math.round(sy) - CACHE_TOP);
    if (kind === 'mill') millSails(new Pen(ctx, sx, sy, false), state.now);
    // A flag flies while someone shelters inside: the royal one when it is the king.
    const pole = kind === 'castle' ? [2, 2, 50] : kind === 'towncenter' ? [1.5, 1.5, 71] : undefined;
    if (pole && (state.kingInside || state.occupied)) {
      const base = new Pen(ctx, sx, sy, false).p(pole[0], pole[1], pole[2]);
      if (state.kingInside) drawRoyalFlag(ctx, base, team, state.now);
      else drawTeamFlag(ctx, base, team, state.now);
    }
    return;
  }
  paintBuilding(ctx, kind, team, seed, sx, sy, state);
}

// Room around a building's footprint in its kept picture: roofs and towers rise above it, shadows fall to the right.
const CACHE_LEFT = 24;
const CACHE_RIGHT = 96;
const CACHE_TOP = 120;
const CACHE_BOTTOM = 40;
const buildingCache = new Map<string, HTMLCanvasElement>();

function paintBuilding(ctx: Ctx, kind: Kind, team: string, seed: number, sx: number, sy: number, state: BuildingState): void {
  const s = DEFS[kind].size ?? 1;
  if (kind === 'farm') {
    drawFarm(new Pen(ctx, sx, sy, false), team, state, seed);
    return;
  }
  const design = DESIGNS[kind] ?? DESIGNS.house!;
  if (state.built < 1) {
    // Building site: bare earth, a growing shell and scaffolding poles.
    const pen = new Pen(ctx, sx, sy, false);
    pen.ground(0.1, 0.1, s - 0.1, s - 0.1, '#8a7654');
    ctx.globalAlpha = 0.25 + 0.6 * state.built;
    design(pen, team, state);
    ctx.globalAlpha = 1;
    for (const [u, v] of [[0.15, 0.15], [s - 0.15, 0.15], [0.15, s - 0.15], [s - 0.15, s - 0.15]]) {
      pen.line(pen.p(u, v), pen.p(u, v, 26), TIMBER, 2);
    }
    pen.line(pen.p(0.15, s - 0.15, 18), pen.p(s - 0.15, s - 0.15, 18), TIMBER, 2);
    pen.line(pen.p(s - 0.15, 0.15, 18), pen.p(s - 0.15, s - 0.15, 18), TIMBER, 2);
    return;
  }
  const shadowPen = new Pen(ctx, sx, sy, true);
  design(shadowPen, team, state);
  shadowPen.fillShadows();
  const pen = new Pen(ctx, sx, sy, false);
  pen.textured = state.now < 0;
  design(pen, team, state);
}
