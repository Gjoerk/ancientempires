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
// Village Age: rough timber.
const LOG = '#7d5532';
const SHINGLE = '#6a5236';
const FIELDSTONE = '#8e8a80';
// Kingdom Age: brick with dressed stone.
const BRICK = '#a5492f';
const DRESSED = '#c9c2b2';
const SLATE = '#45505c';
/** The dark cobblestone of the forges. */
const COBBLE = '#7d7468';

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

type Material = 'stone' | 'ashlar' | 'flags' | 'plaster' | 'wood' | 'boards' | 'thatch' | 'tiles' | 'slate' | 'dirt' | 'logs' | 'shingles' | 'brick';

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
  [LOG]: 'logs', [SHINGLE]: 'shingles', [FIELDSTONE]: 'stone', [BRICK]: 'brick', [DRESSED]: 'ashlar',
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
  if (mat === 'logs') {
    // Round logs laid one on another: a shadow under each, a lit crown on top, knots here and there.
    for (let r = Math.floor(t0 / 4); r * 4 < t1; r++) {
      const y = r * 4;
      rect(s0, y, w, 1, DARKEN(0.38));
      rect(s0, y + 2.6, w, 0.9, LIGHTEN(0.16));
      for (let x = Math.floor(s0); x < s1; x += 4) {
        const g = grain(x, r, salt);
        if (g < 0.12) rect(x, y + 1.2, 1.6, 1.4, DARKEN(0.3));
        else if (g < 0.45) rect(x, y + 1.6, 3 + g * 4, 0.6, DARKEN(0.12));
      }
    }
    return;
  }
  if (mat === 'shingles') {
    // Split-wood shingles in overlapping rows, each a little different.
    for (let r = Math.floor(t0 / 3.5); r * 3.5 < t1; r++) {
      const y = r * 3.5;
      rect(s0, y, w, 0.9, DARKEN(0.32));
      for (let x = Math.floor(s0 / 3) * 3 - (r % 2) * 1.5; x < s1; x += 3) {
        const g = grain(x, r, salt);
        rect(x, y, 0.7, 3.5, DARKEN(0.22));
        if (g < 0.3) rect(x + 0.7, y + 0.9, 2.3, 2.6, DARKEN(0.1));
        else if (g > 0.8) rect(x + 0.7, y + 0.9, 2.3, 2.6, LIGHTEN(0.1));
      }
    }
    return;
  }
  if (mat === 'brick') {
    // Small bricks in running bond with pale mortar, a few darker burnt ones.
    for (let r = Math.floor(t0 / 3); r * 3 < t1; r++) {
      const y = r * 3;
      rect(s0, y, w, 0.8, 'rgba(225,215,195,.45)');
      for (let x = Math.floor(s0 / 6) * 6 - (r % 2) * 3; x < s1; x += 6) {
        const g = grain(x, r, salt);
        rect(x, y, 0.8, 3, 'rgba(225,215,195,.4)');
        if (g < 0.22) rect(x + 0.8, y + 0.8, 5.2, 2.2, DARKEN(0.16));
        else if (g > 0.85) rect(x + 0.8, y + 0.8, 5.2, 2.2, LIGHTEN(0.1));
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

  // Dark cobblestone forge with a slate roof, a glowing hearth and an anvil outside.
  blacksmith(pen, team) {
    pen.box(0.25, 0.25, 1.75, 1.75, 0, 16, COBBLE);
    pen.onU(1.75, 0.25, 1.75, 12, 16, team);
    pen.onU(1.75, 0.8, 1.25, 0, 11, '#22160c');
    pen.onU(1.75, 0.9, 1.15, 0, 6, '#f5a623');
    pen.onU(1.75, 0.97, 1.08, 0, 4, '#ffe45c');
    pen.onV(1.75, 0.6, 0.9, 6, 12, '#39404c');
    pen.gable(0.12, 0.12, 1.88, 1.88, 16, 13, '#3d4450', COBBLE, false);
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

/** A palisade of sharpened stakes along one side, from (u0, v0) to (u1, v1). */
function palisade(pen: Pen, u0: number, v0: number, u1: number, v1: number, height: number): void {
  const n = Math.max(2, Math.round(Math.hypot(u1 - u0, v1 - v0) / 0.13));
  for (let i = 0; i <= n; i++) {
    const u = u0 + ((u1 - u0) * i) / n;
    const v = v0 + ((v1 - v0) * i) / n;
    const h = height - (i % 3) * 1.5;
    pen.box(u - 0.05, v - 0.05, u + 0.05, v + 0.05, 0, h, LOG);
    pen.pyramid(u - 0.05, v - 0.05, u + 0.05, v + 0.05, h, 4, LOG);
  }
}

/** Corner stones and a base course in dressed stone on a brick box. */
function quoins(pen: Pen, u0: number, v0: number, u1: number, v1: number, z0: number, z1: number): void {
  for (let z = z0; z < z1 - 2; z += 6) {
    pen.onV(v1, u0, u0 + 0.12, z, z + 3, DRESSED);
    pen.onV(v1, u1 - 0.12, u1, z + 3, z + 6, DRESSED);
    pen.onU(u1, v0, v0 + 0.12, z, z + 3, DRESSED);
    pen.onU(u1, v1 - 0.12, v1, z + 3, z + 6, DRESSED);
  }
}

/** A window with a stone sill and lintel, on the wall facing left (`v` wall) or right (`u` wall). */
function framedWindow(pen: Pen, side: 'u' | 'v', at: number, a: number, z: number, h = 7): void {
  const put = side === 'v' ? pen.onV.bind(pen) : pen.onU.bind(pen);
  put(at, a - 0.04, a + 0.26, z - 1.5, z, DRESSED);
  put(at, a, a + 0.22, z, z + h, '#39404c');
  put(at, a - 0.04, a + 0.26, z + h, z + h + 1.5, DRESSED);
}

/**
 * Buildings as they look in the Village Age (1) and the Kingdom Age (3); the Town Age uses DESIGNS.
 * Only buildings that exist in the Village Age have a look for it: those that can be built then,
 * and the town centre everyone starts with. The castle looks the same in every age.
 */
const AGE_DESIGNS: Record<1 | 3, Partial<Record<Kind, Design>>> = {
  1: {
    // A log cabin with a shingle roof and a fieldstone chimney.
    house(pen, team) {
      pen.box(0.35, 0.35, 1.65, 1.65, 0, 12, LOG);
      pen.onU(1.65, 0.85, 1.15, 0, 9, '#3a2a1a');
      pen.onU(1.65, 0.88, 1.12, 6, 9, team);
      pen.onV(1.65, 0.6, 0.85, 5, 9, DARK);
      pen.gable(0.2, 0.2, 1.8, 1.8, 12, 14, SHINGLE, LOG, true);
      // A squat fieldstone chimney coming up through the roof just behind the ridge.
      pen.box(0.55, 1.02, 0.8, 1.27, 20, 31, FIELDSTONE);
      pen.box(0.52, 0.99, 0.83, 1.3, 31, 33, '#76726a');
    },
    // A long log hall under a deep thatch roof, with a lookout on stilts.
    towncenter(pen, team) {
      pen.ground(0.1, 0.1, 2.9, 2.9, '#8a7350');
      pen.box(0.35, 0.5, 2.65, 2.5, 0, 16, LOG);
      pen.onU(2.65, 1.2, 1.8, 0, 12, '#3a2a1a');
      for (const u of [0.8, 1.6]) pen.onV(2.5, u, u + 0.3, 7, 11, DARK);
      pen.onV(2.5, 2.0, 2.4, 11, 15, team);
      pen.gable(0.15, 0.3, 2.85, 2.7, 16, 24, THATCH, LOG, true);
      // The lookout: four posts, a floor, a little roof and the owner's banner.
      for (const [u, v] of [[1.15, 1.15], [1.75, 1.15], [1.15, 1.75], [1.75, 1.75]]) pen.box(u, v, u + 0.1, v + 0.1, 30, 58, LOG);
      pen.box(1.05, 1.05, 1.95, 1.95, 52, 55, WOOD);
      pen.pyramid(1.0, 1.0, 2.0, 2.0, 60, 11, SHINGLE);
      pen.onU(1.95, 1.3, 1.7, 44, 52, team);
    },
    // A log hall inside a palisade, with a straw training dummy.
    barracks(pen, team) {
      pen.ground(0.1, 0.1, 2.9, 2.9, '#8a7350');
      palisade(pen, 0.15, 0.15, 2.85, 0.15, 16);
      palisade(pen, 0.15, 0.15, 0.15, 2.85, 16);
      pen.box(0.5, 0.5, 2.1, 1.7, 0, 15, LOG);
      pen.onU(2.1, 0.9, 1.3, 0, 11, '#3a2a1a');
      pen.gable(0.38, 0.38, 2.22, 1.82, 15, 12, SHINGLE, LOG, true);
      pen.onU(2.1, 1.35, 1.6, 4, 13, team);
      pen.box(2.3, 2.1, 2.38, 2.18, 0, 14, TIMBER);
      pen.box(2.22, 2.05, 2.46, 2.23, 7, 12, HAY);
      pen.disc(pen.p(2.34, 2.14, 15), 2.5, HAY);
      palisade(pen, 0.15, 2.85, 2.85, 2.85, 16);
      palisade(pen, 2.85, 0.15, 2.85, 2.85, 16);
    },
    // A timber post mill with a shingle cap.
    mill(pen, team, state) {
      pen.box(1.3, 1.35, 1.7, 1.7, 0, 5, HAY);
      pen.box(0.55, 0.45, 1.45, 1.35, 0, 30, LOG);
      pen.onU(1.45, 0.78, 1.02, 0, 11, '#3a2a1a');
      pen.onU(1.45, 0.45, 1.35, 26, 30, team);
      pen.gable(0.45, 0.35, 1.55, 1.45, 30, 13, SHINGLE, LOG, false);
      if (state.now >= 0) millSails(pen, state.now);
    },
    // A lean-to of rough logs over stacked timber, with a chopping stump and axe.
    lumbercamp(pen, team) {
      pen.ground(0.12, 0.12, 1.88, 1.88, '#8a7350');
      for (const [u, v] of [[0.2, 0.2], [1.7, 0.2], [0.2, 1.7]]) pen.box(u, v, u + 0.1, v + 0.1, 0, 16, LOG);
      for (let i = 0; i < 3; i++) pen.box(0.45, 0.45 + i * 0.22, 1.5, 0.65 + i * 0.22, 0, 5, LOG);
      for (let i = 0; i < 2; i++) pen.box(0.5, 0.56 + i * 0.22, 1.45, 0.76 + i * 0.22, 5, 10, LOG);
      pen.gable(0.06, 0.06, 1.94, 1.94, 16, 7, SHINGLE, LOG, false);
      pen.box(1.2, 1.25, 1.45, 1.5, 0, 6, LOG);
      pen.line(pen.p(1.32, 1.37, 6), pen.p(1.5, 1.25, 14), TIMBER, 2);
      pen.box(1.72, 1.72, 1.8, 1.8, 0, 16, LOG);
      pen.onU(1.8, 0.85, 1.15, 8, 15, team);
    },
    // A log shelter by the ore heaps, with a wheelbarrow.
    miningcamp(pen, team) {
      pen.ground(0.1, 0.1, 1.9, 1.9, '#9a8f7c');
      pen.box(0.25, 0.25, 1.3, 1.0, 0, 11, LOG);
      pen.onV(1.0, 0.55, 0.9, 0, 8, '#22160c');
      pen.onU(1.3, 0.35, 0.9, 7, 11, team);
      pen.gable(0.15, 0.15, 1.42, 1.12, 11, 7, SHINGLE, LOG, true);
      pen.box(1.5, 0.45, 1.85, 0.8, 0, 6, '#85898f');
      pen.box(1.56, 0.5, 1.8, 0.74, 6, 9, '#a6aab0');
      pen.box(0.3, 1.3, 0.7, 1.7, 0, 6, '#7a6f5a');
      pen.box(0.36, 1.36, 0.64, 1.64, 6, 9, '#f2cf3a');
      pen.box(1.05, 1.35, 1.45, 1.65, 2, 6, WOOD);
      pen.disc(pen.p(1.5, 1.5, 2), 2.5, '#3a2a1a');
      pen.line(pen.p(1.05, 1.42, 5), pen.p(0.85, 1.42, 7), TIMBER, 2);
    },
  },
  3: {
    // The town cottage, now under a red clay-tile roof with a brick chimney.
    house(pen, team) {
      pen.box(0.3, 0.3, 1.7, 1.7, 0, 15, PLASTER);
      for (const [a, b] of [[0.3, 0.4], [0.95, 1.05], [1.6, 1.7]]) pen.onV(1.7, a, b, 0, 15, TIMBER);
      pen.onV(1.7, 0.3, 1.7, 13, 15, TIMBER);
      pen.onV(1.7, 0.55, 0.82, 5, 11, '#39404c');
      for (const [a, b] of [[0.3, 0.4], [1.6, 1.7]]) pen.onU(1.7, a, b, 0, 15, TIMBER);
      pen.onU(1.7, 0.3, 1.7, 13, 15, TIMBER);
      pen.onU(1.7, 0.82, 1.18, 0, 10, team);
      pen.gable(0.12, 0.12, 1.88, 1.88, 15, 18, ROOF_TILE, PLASTER, true);
      pen.box(0.5, 1.15, 0.72, 1.37, 20, 33, BRICK);
      pen.box(0.47, 1.12, 0.75, 1.4, 33, 35, DRESSED);
    },
    // A brick hall on a stone plinth, a slate roof and a clock tower.
    towncenter(pen, team) {
      pen.box(0.08, 0.08, 2.92, 2.92, 0, 5, DRESSED);
      pen.box(0.3, 0.3, 2.7, 2.7, 5, 27, BRICK);
      quoins(pen, 0.3, 0.3, 2.7, 2.7, 5, 27);
      pen.onV(2.7, 0.3, 2.7, 22, 24, DRESSED);
      pen.onU(2.7, 0.3, 2.7, 22, 24, DRESSED);
      for (const u of [0.6, 1.35, 2.05]) framedWindow(pen, 'v', 2.7, u, 11, 8);
      pen.onU(2.7, 1.15, 1.85, 5, 19, '#3a2a1a');
      pen.onU(2.7, 1.1, 1.9, 19, 21, DRESSED);
      pen.onU(2.7, 1.2, 1.8, 5, 18, team);
      framedWindow(pen, 'u', 2.7, 0.5, 11, 8);
      framedWindow(pen, 'u', 2.7, 2.25, 11, 8);
      pen.pyramid(0.1, 0.1, 2.9, 2.9, 27, 18, SLATE);
      pen.box(1.1, 1.1, 1.9, 1.9, 34, 58, BRICK);
      quoins(pen, 1.1, 1.1, 1.9, 1.9, 34, 58);
      // The clock.
      const face = pen.p(1.9, 1.5, 49);
      pen.disc(face, 5.5, DRESSED);
      pen.disc(face, 4.2, '#f4efe2');
      pen.line(face, [face[0], face[1] - 3.5], DARK, 1);
      pen.line(face, [face[0] + 2.5, face[1]], DARK, 1);
      framedWindow(pen, 'v', 1.9, 1.39, 40, 5);
      pen.pyramid(1.0, 1.0, 2.0, 2.0, 58, 13, team);
    },
    // A brick drill hall with stone battlements, a keep and banners.
    barracks(pen, team) {
      pen.box(0.2, 0.2, 2.8, 2.8, 0, 4, DRESSED);
      pen.box(0.2, 0.2, 2.8, 2.8, 4, 24, BRICK, '#6f6f78');
      quoins(pen, 0.2, 0.2, 2.8, 2.8, 4, 24);
      pen.crenels(0.2, 0.2, 2.8, 2.8, 24, DRESSED);
      for (const u of [0.55, 1.4, 2.25]) framedWindow(pen, 'v', 2.8, u, 11, 7);
      pen.onU(2.8, 1.2, 1.8, 4, 17, '#3a2a1a');
      pen.onU(2.8, 1.15, 1.85, 17, 19, DRESSED);
      pen.onU(2.8, 0.7, 0.98, 6, 22, team);
      pen.onU(2.8, 2.02, 2.3, 6, 22, team);
      pen.box(0.2, 0.2, 1.2, 1.2, 24, 42, BRICK, '#6f6f78');
      quoins(pen, 0.2, 0.2, 1.2, 1.2, 24, 42);
      pen.crenels(0.2, 0.2, 1.2, 1.2, 42, DRESSED);
    },
    // A stone-footed brick tower with stone battlements and a slate spire.
    tower(pen, team) {
      pen.box(0.18, 0.18, 0.82, 0.82, 0, 8, DRESSED);
      pen.box(0.22, 0.22, 0.78, 0.78, 8, 42, BRICK);
      quoins(pen, 0.22, 0.22, 0.78, 0.78, 8, 42);
      pen.onU(0.78, 0.44, 0.56, 22, 32, DARK);
      pen.onV(0.78, 0.44, 0.56, 22, 32, DARK);
      pen.box(0.12, 0.12, 0.88, 0.88, 42, 47, DRESSED);
      pen.crenels(0.12, 0.12, 0.88, 0.88, 47, DRESSED);
      pen.pyramid(0.24, 0.24, 0.76, 0.76, 47, 18, team);
    },
    // A brick tower mill with a tiled cap.
    mill(pen, team, state) {
      pen.box(0.3, 1.2, 0.75, 1.65, 0, 6, BRICK);
      pen.box(1.3, 1.35, 1.7, 1.7, 0, 5, HAY);
      pen.box(0.45, 0.35, 1.55, 1.45, 0, 4, DRESSED);
      pen.box(0.5, 0.4, 1.5, 1.4, 4, 30, BRICK);
      quoins(pen, 0.5, 0.4, 1.5, 1.4, 4, 30);
      pen.onU(1.5, 0.78, 1.02, 4, 14, '#3a2a1a');
      framedWindow(pen, 'v', 1.4, 0.85, 15, 6);
      pen.onU(1.5, 0.4, 1.4, 26, 28, team);
      pen.pyramid(0.4, 0.3, 1.6, 1.5, 30, 16, ROOF_TILE);
      if (state.now >= 0) millSails(pen, state.now);
    },
    // A master smithy: a dressed-stone forge hall with a cobblestone upper storey, twin chimneys,
    // and a tiled lean-to over the anvil with blades on the wall and a quenching barrel.
    blacksmith(pen, team) {
      pen.box(0.2, 0.2, 1.5, 1.8, 0, 3, DRESSED);
      pen.box(0.25, 0.25, 1.45, 1.75, 3, 14, DRESSED);
      pen.box(0.25, 0.25, 1.45, 1.75, 14, 26, COBBLE);
      quoins(pen, 0.25, 0.25, 1.45, 1.75, 14, 26);
      pen.onV(1.75, 0.25, 1.45, 13, 15, '#aaa497');
      pen.onU(1.45, 0.25, 1.75, 13, 15, '#aaa497');
      // The great forge mouth, glowing, under a stone lintel on the front wall.
      pen.onV(1.75, 0.45, 1.1, 3, 11, '#22160c');
      pen.onV(1.75, 0.4, 1.15, 11, 13, DRESSED);
      pen.onV(1.75, 0.55, 1.0, 3, 7, '#f5a623');
      pen.onV(1.75, 0.68, 0.87, 3, 5, '#ffe45c');
      framedWindow(pen, 'v', 1.75, 0.45, 18, 5);
      framedWindow(pen, 'v', 1.75, 0.95, 18, 5);
      framedWindow(pen, 'u', 1.45, 0.5, 17, 5);
      framedWindow(pen, 'u', 1.45, 1.3, 17, 5);
      pen.gable(0.12, 0.12, 1.58, 1.88, 26, 14, SLATE, COBBLE, false);
      for (const v of [0.35, 1.35]) {
        pen.box(0.4, v, 0.72, v + 0.32, 30, 48, COBBLE);
        pen.box(0.36, v - 0.04, 0.76, v + 0.36, 48, 50, DRESSED);
      }
      // The lean-to on posts, with the anvil, a weapon rack and a barrel beneath.
      for (const [u, v] of [[1.88, 0.3], [1.88, 1.7]]) pen.box(u, v, u + 0.08, v + 0.08, 0, 14, TIMBER);
      pen.box(1.45, 0.25, 1.96, 1.85, 14, 15, TIMBER);
      pen.gable(1.45, 0.2, 2.0, 1.9, 15, 3, ROOF_TILE, TIMBER, false);
      pen.box(1.6, 1.1, 1.74, 1.4, 0, 3, DRESSED);
      pen.box(1.56, 1.05, 1.78, 1.45, 3, 7, '#3a3d44');
      pen.box(1.62, 0.45, 1.84, 0.67, 0, 7, WOOD);
      pen.box(1.65, 0.48, 1.81, 0.64, 7, 7.5, '#3c6f93');
      for (const v of [0.85, 0.95]) pen.line(pen.p(1.46, v, 3), pen.p(1.46, v, 11), '#d9dde3', 1);
      pen.onU(1.45, 1.5, 1.7, 15, 24, team);
    },
    // A brick-backed timber shed under clay tiles, with sawn planks and a saw horse.
    lumbercamp(pen, team) {
      pen.box(0.12, 0.12, 1.88, 1.88, 0, 2, DRESSED);
      pen.box(0.2, 0.2, 1.8, 0.4, 2, 19, BRICK);
      pen.box(0.2, 0.2, 0.4, 1.8, 2, 19, BRICK);
      for (let i = 0; i < 4; i++) pen.box(0.55, 0.55 + i * 0.2, 1.55, 0.7 + i * 0.2, 2, 4 + (i % 2) * 2, WOOD);
      for (let i = 0; i < 2; i++) pen.box(0.55, 0.6 + i * 0.3, 1.5, 0.85 + i * 0.3, 6, 11, TIMBER);
      for (const [u, v] of [[1.7, 0.2], [0.2, 1.7], [1.7, 1.7]]) pen.box(u, v, u + 0.1, v + 0.1, 2, 20, TIMBER);
      pen.gable(0.04, 0.04, 1.96, 1.96, 20, 10, ROOF_TILE, BRICK, false);
      pen.box(1.2, 1.25, 1.5, 1.35, 2, 7, TIMBER);
      pen.box(1.22, 1.45, 1.48, 1.55, 2, 7, TIMBER);
      pen.onU(1.8, 0.85, 1.15, 9, 17, team);
    },
    // A brick pithead with a slate roof, a winding wheel and ore carts.
    miningcamp(pen, team) {
      pen.ground(0.1, 0.1, 1.9, 1.9, '#9a8f7c');
      pen.box(0.25, 0.25, 1.4, 1.05, 0, 3, DRESSED);
      pen.box(0.25, 0.25, 1.4, 1.05, 3, 15, BRICK);
      quoins(pen, 0.25, 0.25, 1.4, 1.05, 3, 15);
      pen.onV(1.05, 0.6, 1.0, 3, 11, '#22160c');
      pen.onU(1.4, 0.35, 0.95, 10, 14, team);
      pen.gable(0.15, 0.15, 1.5, 1.15, 15, 8, SLATE, BRICK, true);
      for (const v of [0.3, 0.95]) pen.box(0.5, v, 0.58, v + 0.08, 15, 32, TIMBER);
      const hub = pen.p(0.54, 0.66, 30);
      pen.disc(hub, 6, TIMBER);
      pen.disc(hub, 4, '#4a2e18');
      pen.box(1.5, 0.45, 1.85, 0.8, 0, 6, '#85898f');
      pen.box(1.56, 0.5, 1.8, 0.74, 6, 9, '#a6aab0');
      pen.box(0.3, 1.3, 0.7, 1.7, 0, 6, '#7a6f5a');
      pen.box(0.36, 1.36, 0.64, 1.64, 6, 9, '#f2cf3a');
      pen.box(1.0, 1.35, 1.6, 1.7, 3, 9, '#55585e');
      pen.box(1.06, 1.4, 1.54, 1.65, 9, 11, '#85898f');
      pen.disc(pen.p(1.1, 1.72, 3), 4, '#3a2a1a');
      pen.disc(pen.p(1.5, 1.72, 3), 4, '#3a2a1a');
    },
    // A brick-walled range with a tiled shooting gallery and painted targets.
    range(pen, team) {
      pen.ground(0.08, 0.08, 2.92, 2.92, '#c9b98f');
      pen.box(0.08, 0.08, 2.92, 0.2, 0, 10, BRICK);
      pen.box(0.08, 0.08, 0.2, 2.92, 0, 10, BRICK);
      pen.box(0.3, 0.3, 2.7, 1.05, 0, 3, DRESSED);
      pen.box(0.3, 0.3, 2.7, 1.05, 3, 16, BRICK);
      quoins(pen, 0.3, 0.3, 2.7, 1.05, 3, 16);
      for (const u of [0.5, 1.2, 1.9]) pen.onV(1.05, u, u + 0.5, 3, 12, DARK);
      pen.gable(0.2, 0.2, 2.8, 1.25, 16, 10, ROOF_TILE, BRICK, true);
      pen.onU(2.7, 0.4, 0.9, 5, 14, team);
      for (const u of [0.7, 1.75]) {
        pen.box(u - 0.06, 2.26, u + 0.06, 2.38, 0, 8, DRESSED);
        const at = pen.p(u, 2.3, 15);
        pen.disc(at, 9, '#efe6cf');
        pen.disc(at, 6, team);
        pen.disc(at, 3, '#efe6cf');
        pen.disc(at, 1.2, '#c8402f');
      }
      pen.box(0.08, 2.8, 2.92, 2.92, 0, 8, BRICK);
      pen.box(2.8, 0.08, 2.92, 2.92, 0, 8, BRICK);
    },
    // A brick stable with stone-framed stall doors, a tiled roof and a hay loft.
    stable(pen, team) {
      pen.box(0.2, 0.55, 2.8, 2.35, 0, 3, DRESSED);
      pen.box(0.2, 0.55, 2.8, 2.35, 3, 18, BRICK);
      quoins(pen, 0.2, 0.55, 2.8, 2.35, 3, 18);
      for (let i = 0; i < 3; i++) {
        const u = 0.42 + i * 0.8;
        pen.onV(2.35, u - 0.04, u + 0.6, 3, 14, DRESSED);
        pen.onV(2.35, u, u + 0.56, 3, 12, '#22160c');
        pen.onV(2.35, u, u + 0.56, 3, 7, '#7a5230');
      }
      pen.onU(2.8, 1.2, 1.7, 3, 13, '#3a2a1a');
      pen.onU(2.8, 0.7, 1.0, 6, 16, team);
      pen.gable(0.05, 0.4, 2.95, 2.5, 18, 15, ROOF_TILE, BRICK, true);
      pen.box(0.3, 2.5, 0.75, 2.82, 0, 7, HAY);
      pen.box(0.08, 2.86, 2.92, 2.92, 0, 6, BRICK);
      pen.box(2.86, 2.4, 2.92, 2.92, 0, 6, BRICK);
    },
    // A brick market hall on arches under clay tiles, with stalls in front.
    market(pen, team) {
      pen.ground(0.08, 0.08, 2.92, 2.92, '#c9b98f');
      pen.box(0.3, 0.3, 1.9, 1.5, 0, 2, DRESSED);
      for (const [u, v] of [[0.3, 0.3], [1.0, 0.3], [1.72, 0.3], [0.3, 1.32], [1.0, 1.32], [1.72, 1.32]]) pen.box(u, v, u + 0.18, v + 0.18, 2, 14, BRICK);
      pen.box(0.3, 0.3, 1.9, 1.5, 14, 22, BRICK);
      quoins(pen, 0.3, 0.3, 1.9, 1.5, 14, 22);
      for (const u of [0.6, 1.3]) framedWindow(pen, 'v', 1.5, u, 16, 4);
      pen.onU(1.9, 0.6, 1.2, 15, 21, team);
      pen.gable(0.2, 0.2, 2.0, 1.6, 22, 12, ROOF_TILE, BRICK, true);
      const stall = (u: number, v: number, cloth: string) => {
        pen.box(u, v, u + 0.8, v + 0.55, 0, 7, WOOD);
        for (const [a, b] of [[u, v + 0.47], [u + 0.72, v + 0.47]]) pen.box(a, b, a + 0.08, b + 0.08, 0, 15, TIMBER);
        pen.gable(u - 0.06, v - 0.06, u + 0.86, v + 0.61, 15, 6, cloth, cloth, true);
      };
      stall(2.1, 0.5, team);
      stall(0.4, 2.1, '#b8473a');
      pen.box(1.8, 1.9, 2.2, 2.3, 0, 9, '#b89358');
      pen.box(2.3, 2.0, 2.65, 2.35, 0, 7, '#a8824a');
    },
    // A brick workshop with great doors, a slate roof and a crane over the yard.
    workshop(pen, team) {
      pen.ground(0.08, 0.08, 2.92, 2.92, '#a58d62');
      pen.box(0.2, 0.2, 2.8, 1.35, 0, 3, DRESSED);
      pen.box(0.2, 0.2, 2.8, 1.35, 3, 23, BRICK);
      quoins(pen, 0.2, 0.2, 2.8, 1.35, 3, 23);
      pen.onV(1.35, 0.5, 2.5, 3, 18, '#22160c');
      pen.onV(1.35, 0.45, 2.55, 18, 20, DRESSED);
      pen.onU(2.8, 0.3, 1.25, 18, 22, team);
      pen.gable(0.08, 0.08, 2.92, 1.5, 23, 13, SLATE, BRICK, true);
      // The crane: a mast, a jib and a hanging beam.
      pen.box(2.45, 1.7, 2.55, 1.8, 0, 34, TIMBER);
      pen.line(pen.p(2.5, 1.75, 32), pen.p(1.7, 2.3, 30), TIMBER, 2);
      pen.line(pen.p(1.7, 2.3, 30), pen.p(1.7, 2.3, 14), '#3a3d44', 1);
      pen.box(1.4, 2.25, 2.0, 2.35, 11, 14, TIMBER);
      pen.box(0.4, 2.2, 1.3, 2.4, 0, 4, TIMBER);
      pen.box(0.45, 2.42, 1.35, 2.62, 0, 4, WOOD);
      pen.box(1.55, 2.5, 2.6, 2.66, 3, 7, '#7a5230');
      pen.disc(pen.p(1.75, 2.75, 4), 5, '#3a2a1a');
      pen.disc(pen.p(2.45, 2.75, 4), 5, '#3a2a1a');
    },
    // A brick church with stone trim, a slate roof and a tall bell tower with a spire.
    monastery(pen, team) {
      pen.box(0.15, 0.15, 2.85, 2.85, 0, 3, DRESSED);
      pen.box(1.15, 0.45, 2.7, 2.6, 3, 24, BRICK);
      quoins(pen, 1.15, 0.45, 2.7, 2.6, 3, 24);
      for (const u of [1.4, 1.9, 2.4]) {
        pen.onV(2.6, u - 0.16, u + 0.16, 8, 20, DRESSED);
        pen.onV(2.6, u - 0.12, u + 0.12, 9, 19, '#2c3440');
      }
      pen.onU(2.7, 1.2, 1.9, 3, 17, DRESSED);
      pen.onU(2.7, 1.25, 1.85, 3, 16, '#3a2a1a');
      pen.disc(pen.p(2.7, 1.55, 21), 2.5, '#e3b84e');
      pen.onU(2.7, 0.55, 0.85, 12, 21, team);
      pen.gable(1.05, 0.35, 2.8, 2.7, 24, 15, SLATE, BRICK, false);
      pen.box(0.3, 1.1, 1.15, 2.6, 3, 17, BRICK);
      pen.gable(0.25, 1.05, 1.2, 2.65, 17, 8, SLATE, BRICK, false);
      pen.box(0.3, 0.3, 1.05, 1.05, 3, 56, BRICK);
      quoins(pen, 0.3, 0.3, 1.05, 1.05, 3, 56);
      framedWindow(pen, 'u', 1.05, 0.56, 40, 9);
      framedWindow(pen, 'v', 1.05, 0.56, 40, 9);
      pen.box(0.24, 0.24, 1.11, 1.11, 56, 59, DRESSED);
      pen.pyramid(0.28, 0.28, 1.07, 1.07, 59, 26, SLATE);
    },
    // A brick wall on a stone footing, with stone battlements.
    wall(pen) {
      pen.box(0, 0, 1, 1, 0, 4, DRESSED);
      pen.box(0.04, 0.04, 0.96, 0.96, 4, 20, BRICK, '#74747e');
      pen.crenels(0.04, 0.04, 0.96, 0.96, 20, DRESSED);
    },
    // A brick gatehouse with a stone arch and doors in the owner's colour.
    gate(pen, team) {
      pen.box(0, 0, 1, 1, 0, 4, DRESSED);
      pen.box(0.02, 0.02, 0.98, 0.98, 4, 27, BRICK, '#74747e');
      for (const side of ['u', 'v'] as const) {
        const put = side === 'u' ? pen.onU.bind(pen) : pen.onV.bind(pen);
        put(0.98, 0.16, 0.84, 0, 19, DRESSED);
        put(0.98, 0.2, 0.8, 0, 17, '#22160c');
        put(0.98, 0.26, 0.74, 0, 14, team);
        put(0.98, 0.48, 0.52, 0, 14, '#22160c');
      }
      pen.crenels(0.02, 0.02, 0.98, 0.98, 27, DRESSED);
    },
  },
};

/** Preview: draws one building as it looks in an age, with shadow and textures, at (sx, sy). */
export function drawBuildingAge(ctx: Ctx, kind: Kind, age: number, owner: number, sx: number, sy: number): void {
  const team = PLAYER_COLORS[owner % PLAYER_COLORS.length];
  const design = (age === 1 || age === 3 ? AGE_DESIGNS[age][kind] : undefined) ?? DESIGNS[kind] ?? DESIGNS.house!;
  const state: BuildingState = { built: 1, kingInside: false, now: -1 };
  const shadowPen = new Pen(ctx, sx, sy, true);
  design(shadowPen, team, state);
  shadowPen.fillShadows();
  const pen = new Pen(ctx, sx, sy, false);
  pen.textured = true;
  design(pen, team, state);
  if (kind === 'mill') millSails(pen, 900);
}

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
