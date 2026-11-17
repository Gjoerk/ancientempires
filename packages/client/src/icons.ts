import { DEFS, isTech, Kind, KINDS, TechId } from '@kingsfall/shared';
import { findSprite } from './assets';
import { drawBuilding } from './buildings';
import { drawUnit, PLAYER_COLORS, unitHeight, unitWidth } from './sprites';

// Icons for buttons, resources and upgrades. Every icon is drawn by code into a small
// canvas, and each one can be replaced by an image through the sprite pack (`icon.<id>`).

const SIZE = 48;

// Palette letters: w steel, k wood, t team colour, b dark edge, r red, g gold, y light gold,
// e green, s stone, l light stone, o brown, c cream.
const PALETTE: Record<string, string> = {
  w: '#e3e7ec', k: '#7a5230', b: '#2a2018', r: '#c8402f', g: '#e0b030', y: '#f7df7a',
  e: '#5f9a3a', d: '#a86a14', n: '#3d6b25', p: '#7e1f22', s: '#85898f', l: '#c4c8cf', o: '#5a3b1e', c: '#efe6cf', m: '#9aa0a8', i: '#8fd0ff', j: '#eaf8ff',
  // The finer resource icons and the crown: wood, gold, stone, gems and pearls.
  A: '#f0d49a', C: '#c8965a', D: '#9a6634', E: '#74481f', F: '#4e2e12',
  Y: '#fff1a0', G: '#f2c23a', H: '#c8891c', I: '#8a5810',
  W: '#f0f2f4', L: '#c6cad0', S: '#9096a0', T: '#5e646e',
  R: '#c8302a', U: '#2f6fd4', P: '#fbf3dc', Q: '#cbbd98',
  // The crown's velvet cap and its emeralds.
  V: '#9a1f2a', X: '#661420', Z: '#c9343e', J: '#2fa85a',
};

const GLYPHS: Record<string, string[]> = {
  heart: [
    '..........',
    '.rr...rr..',
    'rrrr.rrrr.',
    'rcrrrrrrr.',
    'rcrrrrrrr.',
    'rrrrrrrrr.',
    '.rrrrrrr..',
    '..rrrrr...',
    '...rrr....',
    '....r.....',
  ],
  hourglass: [
    'kkkkkkkkkk',
    '.cyyyyyyc.',
    '..cyyyyc..',
    '...cyyc...',
    '....yc....',
    '....cc....',
    '...c..c...',
    '..c.yy.c..',
    '.cyyyyyyc.',
    'kkkkkkkkkk',
  ],
  boot: [
    '...oooo...',
    '...oooo...',
    '...oooo...',
    '...oooo...',
    '...oooo...',
    '...ooooo..',
    '...oooooo.',
    '...ooooooo',
    '...kkkkkkk',
    '..........',
  ],
  lock: [
    '...bbbb...',
    '..b....b..',
    '..b....b..',
    '..b....b..',
    '.gggggggg.',
    '.gyyyyyyg.',
    '.gyybbyyg.',
    '.gyybbyyg.',
    '.gyyyyyyg.',
    '.gggggggg.',
  ],
  sword: [
    '........ww',
    '.......www',
    '......www.',
    '.....www..',
    '.g..www...',
    '.ggwww....',
    '..ggw.....',
    '.kggg.....',
    'kk..g.....',
    'k.........',
  ],
  shield: [
    '.bbbbbbbb.',
    '.bttttccb.',
    '.btttcctb.',
    '.bttccttb.',
    '.btccgttb.',
    '.bccgtttb.',
    '..bgtttb..',
    '..btttbb..',
    '...bbbb...',
    '....bb....',
  ],
  bow: [
    '..kk......',
    '.k..c.....',
    'k....c....',
    'k.....c...',
    'kooooooww.',
    'k.....c...',
    'k....c....',
    '.k..c.....',
    '..kk......',
    '..........',
  ],
  bolt: [
    '.....yy...',
    '....yy....',
    '...yy.....',
    '..yyyyy...',
    '....yy....',
    '...yy.....',
    '..yy......',
    '.yy.......',
    '.y........',
    '..........',
  ],
  bell: [
    '....bb....',
    '...byyb...',
    '..byyyyb..',
    '..byyyyb..',
    '..byyyyb..',
    '.byyyyyyb.',
    '.byyyyyyb.',
    'bggggggggb',
    '.bbbbbbbb.',
    '....bb....',
  ],
  relic: [
    '....y.....',
    '...yyy....',
    '....y.....',
    '..iiii....',
    '.iijjii...',
    '.ijiiiii..',
    'yyyyyyyyy.',
    '.iiiiiii..',
    '..iiiii...',
    '...lll....',
  ],
  crown: [
    '...........b...........',
    '..........bGb..........',
    '.........bGYGb.........',
    '..........bGb..........',
    '.........bGYGb.........',
    '.bb......bYGGb......bb.',
    'bPPb....bbGGHbb....bPPb',
    'bPPb..bbVVVVVVVbb..bPPb',
    'bYYb.bVVVVVGVVVVVb.bHGb',
    'bYYbbVVZZZZGVVVVVVbbHGb',
    'bYYbbVZZZZYGGVXVVVbbHGb',
    'bYYGVVZZZZYGGVXXXVVGHGb',
    'bYYGGVVZZYYGGGXXXXGGHGb',
    'bYYGGVVVVYYGGGXXXXGGHGb',
    'bYYGGGVVYYYGGGGXXGGGHGb',
    'bYYGGGGVYYYGGGGXGGGGHGb',
    'bYYGGGGYYYYGGGGGGGGGHGb',
    'bYYYYYYYYYYYYYYYYYYYYYb',
    'bHHHPRHHPHPUUHPHHPRHHHb',
    'bHHHRRHHJHUUUHJHHRRHHHb',
    'bIIIIIIIIIIIIIIIIIIIIIb',
    '.bbbbbbbbbbbbbbbbbbbbb.',
  ],
  spool: [
    '..kkkkkk..',
    '..kkkkkk..',
    '...rrrr...',
    '..rrcrrr..',
    '..rrrcrr..',
    '..rcrrrr..',
    '..rrrcrr..',
    '...rrrr...',
    '..kkkkkk..',
    '..kkkkkk..',
  ],
  cart: [
    '..........',
    'k.........',
    'kk........',
    '.kkkkkkkk.',
    '.koooooook',
    '.koooooook',
    '.kkkkkkkk.',
    '..bb..bb..',
    '.bmmb.....',
    '..bb......',
  ],
  wheat: [
    '....y.....',
    '...yyy....',
    '..y.y.y...',
    '...yyy....',
    '..y.y.y...',
    '...yyy....',
    '..y.e.y...',
    '....e.....',
    '....e.....',
    '....e.....',
  ],
  axe: [
    '......mm..',
    '.....mwwm.',
    '....kwwwm.',
    '...kkmwm..',
    '...kk.m...',
    '..kk......',
    '..kk......',
    '.kk.......',
    '.kk.......',
    'kk........',
  ],
  pick: [
    '..mmmmm...',
    '.mm..kmm..',
    'm...kk.mm.',
    '...kk...m.',
    '...kk.....',
    '..kk......',
    '..kk......',
    '.kk.......',
    '.kk.......',
    'kk........',
  ],
  food: [
    '....nn.nnn....',
    '..neen.nneen..',
    '.neen.n..neen.',
    'nee...rr...een',
    '..rr.rjrr.rr..',
    '.rjrrrrrprjrr.',
    '.rrrp.pp.rrrp.',
    '..pprr..rrpp..',
    '...rjrrrjrr...',
    '.rrrrrprrrprr.',
    'rjrrpprrpprjrr',
    'rrrp.rjrr.rrrp',
    '.pp..rrrp..pp.',
    '......pp......',
  ],
  wood: [
    '...bbbbbbbbbb.',
    '..bDDDDDDDDCCb',
    '..bEEEEDEFEACb',
    '..bEEFEEEEECAb',
    '..bFFFFFFFFCCb',
    '.bbbbbbbbbbFb.',
    'bDDDDDDDDDCCb.',
    'bEEEEDEFEEACb.',
    'bEEFEEEEEECAb.',
    'bFFFFFFFFFCCb.',
    '.bFbbbbbbbbb..',
    '..b...........',
  ],
  gold: [
    '......bb......',
    '....bbHHbb....',
    '...bHHHHHHb...',
    '..bHYYYGGGHb..',
    '.bHYYGGGGGGHb.',
    '.bHYGYYGGGGHb.',
    'bHHYGYGGGGGHHb',
    'bHHGGGGGGGGHHb',
    '.bHGGGGGGGHHb.',
    '.bHGGGGGGGHIb.',
    '..bHGGGGHHIb..',
    '...bHHHHHIb...',
    '....bbHHbb....',
    '......bb......',
  ],
  stone: [
    '.....bbbbb....',
    '....bSSSSSbb..',
    '...bLWWLLSSSb.',
    '..bLWWWLLLSSSb',
    '.bSLLLLLLLSSSb',
    '.bSLLLLLSTSSSb',
    '.bSSLLLSTSSSSb',
    '.bSSSSSSSTSSTb',
    '.bbSSSSSSSSSTb',
    'bLLLSSSSTSTTTb',
    'bLSLTTTTTTTTTb',
    '.bbbbbbbbbbbb.',
  ],
  cross: [
    '..........',
    '.rr....rr.',
    '.rrr..rrr.',
    '..rrrrrr..',
    '...rrrr...',
    '...rrrr...',
    '..rrrrrr..',
    '.rrr..rrr.',
    '.rr....rr.',
    '..........',
  ],
  flag: [
    '.k........',
    '.ktttttt..',
    '.kttttttt.',
    '.ktttttt..',
    '.kttttt...',
    '.k........',
    '.k........',
    '.k........',
    '.k........',
    'kkk.......',
  ],
};

/** What the built-in icon of a technology shows: a glyph, optionally with the unit it improves. */
const TECH_ART: Record<TechId, [string, Kind?]> = {
  age2: ['crown'], age3: ['crown'], loom: ['spool'], handcart: ['cart'], ploughs: ['wheat'], axes: ['axe'], picks: ['pick'],
  weapons: ['sword'], armour: ['shield'],
  pikes: ['sword', 'spearman'], jacks: ['shield', 'spearman'], blades: ['sword', 'swordsman'], shields: ['shield', 'swordsman'],
  longbows: ['bow', 'archer'], quickdraw: ['bolt', 'archer'], lances: ['sword', 'rider'], barding: ['shield', 'rider'],
  ironhead: ['sword', 'ram'], arrowslits: ['bow', 'tower'],
};

const cache = new Map<string, string>();

/** The crown alone, at a whole number of screen pixels per pixel, for the emblem on the menus. */
export function crownImage(scale = 3): string {
  const rows = GLYPHS.crown;
  const n = Math.max(rows.length, ...rows.map((r) => r.length));
  const cv = document.createElement('canvas');
  cv.width = cv.height = n * scale;
  const c = cv.getContext('2d')!;
  const top = Math.floor((n - rows.length) / 2);
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    const color = PALETTE[ch];
    if (!color) return;
    c.fillStyle = color;
    c.fillRect(x * scale, (y + top) * scale, scale, scale);
  }));
  return cv.toDataURL();
}

/** Forget all drawn icons, e.g. after the sprite pack has loaded. */
export function clearIcons(): void {
  cache.clear();
}

/** The age building pictures on buttons are shown in: the player's own. */
let iconAge = 1;
export function setIconAge(age: number): void {
  if (age === iconAge) return;
  iconAge = age;
  cache.clear();
}

function glyph(c: CanvasRenderingContext2D, name: string, team: string, x: number, y: number, px: number): void {
  const rows = GLYPHS[name];
  if (!rows) return;
  // Glyphs are drawn on a 10 × 10 grid; a more detailed one gets whole pixels of a smaller size,
  // as large as fit (it may reach a little into the margin round the square).
  const n = Math.max(10, rows.length, ...rows.map((row) => row.length));
  const p = n === 10 ? px : Math.max(1, Math.floor((px * 12) / n));
  const ox = Math.round(x + (px * 10 - Math.max(...rows.map((row) => row.length)) * p) / 2);
  const oy = Math.round(y + (px * 10 - rows.length * p) / 2);
  const at = (o: number, i: number) => Math.round(o + i * p);
  for (let r = 0; r < rows.length; r++) {
    for (let col = 0; col < rows[r].length; col++) {
      const ch = rows[r][col];
      const color = ch === 't' ? team : PALETTE[ch];
      if (!color) continue;
      c.fillStyle = color;
      c.fillRect(at(ox, col), at(oy, r), at(ox, col + 1) - at(ox, col), at(oy, r + 1) - at(oy, r));
    }
  }
}

function thing(c: CanvasRenderingContext2D, kind: Kind, owner: number, box: number, left: number, top: number): void {
  c.save();
  if (DEFS[kind].building) {
    const s = DEFS[kind].size ?? 1;
    const scale = Math.min(1, (box - 4) / (s * 64 + 6), (box - 2) / (s * 32 + (kind === 'tower' ? 66 : kind === 'castle' ? 60 : kind === 'catapulttower' ? 66 : 44)));
    c.translate(left + box / 2, top + box - 3 - s * 32 * scale);
    c.scale(scale, scale);
    drawBuilding(c, kind, owner, 1, 0, 0, { built: 1, kingInside: false, now: 0, age: iconAge });
  } else {
    // As large as fits, in whole steps of a half so the pixels stay even.
    const fit = Math.min((box - 6) / unitHeight(kind), (box - 2) / unitWidth(kind));
    const scale = Math.max(0.5, Math.floor(fit * 2) / 2);
    c.translate(left + box / 2, top + box - 5);
    c.scale(scale, scale);
    drawUnit(c, kind, owner, 0, 0, 0);
  }
  c.restore();
}

/**
 * Returns an image URL for an icon. Ids: a unit or building kind, a technology id,
 * a resource name, or one of `cancel`, `eject`, `rally`, `sell.<res>`, `buy.<res>`.
 */
export function icon(id: string, owner = 0): string {
  const key = `${id}|${owner}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const c = canvas.getContext('2d')!;
  c.imageSmoothingEnabled = false;
  const team = PLAYER_COLORS[Math.max(0, owner) % PLAYER_COLORS.length];
  const custom = findSprite([`icon.${id}`]);
  if (custom) {
    const frames = Math.max(1, custom.def.frames ?? 1);
    const fw = custom.image.width / frames;
    const k = Math.min(SIZE / fw, SIZE / custom.image.height);
    c.imageSmoothingEnabled = custom.def.smooth === true;
    c.drawImage(custom.image, 0, 0, fw, custom.image.height, (SIZE - fw * k) / 2, (SIZE - custom.image.height * k) / 2, fw * k, custom.image.height * k);
  } else if ((KINDS as readonly string[]).includes(id)) {
    thing(c, id as Kind, owner, SIZE, 0, 0);
  } else if (isTech(id)) {
    const [name, unit] = TECH_ART[id];
    if (unit) {
      // The unit it improves, with what it gains as a badge in the corner.
      thing(c, unit, owner, 38, -2, 0);
      c.fillStyle = 'rgba(20,14,8,.78)';
      c.fillRect(24, 24, 24, 24);
      glyph(c, name, team, 26, 26, 2);
    } else {
      glyph(c, name, team, 4, 4, 4);
      if (id === 'age3') glyph(c, 'crown', team, 26, 26, 2);
    }
  } else if (id.startsWith('sell.') || id.startsWith('buy.')) {
    // The goods, with a coin showing which way the gold flows.
    const [action, res] = id.split('.');
    glyph(c, res, team, 2, 2, 3);
    glyph(c, 'gold', team, 26, 26, 2);
    c.fillStyle = action === 'buy' ? '#c8402f' : '#5f9a3a';
    c.fillRect(34, 6, 10, 4);
    if (action === 'sell') c.fillRect(37, 3, 4, 10);
  } else if (id === 'stance.aggressive') {
    // Crossed swords: goes for anything in sight.
    glyph(c, 'sword', team, 2, 6, 3);
    c.save();
    c.translate(SIZE, 0);
    c.scale(-1, 1);
    glyph(c, 'sword', team, 2, 6, 3);
    c.restore();
  } else if (id === 'stance.defensive') {
    glyph(c, 'shield', team, 4, 4, 4);
  } else if (id.startsWith('formation.')) {
    // Little soldiers seen from above: dark for swords, light for bows, with an arrow for the way they face.
    const f = id.slice(10);
    const dots: [number, number, boolean][] = [];
    if (f === 'line') for (let k = 0; k < 5; k++) { dots.push([6 + k * 8, 18, false]); dots.push([6 + k * 8, 30, true]); }
    if (f === 'staggered') for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) dots.push([6 + k * 14 + (r % 2) * 7, 12 + r * 12, r === 2]);
    if (f === 'flank') for (let r = 0; r < 2; r++) for (let k = 0; k < 2; k++) { dots.push([4 + k * 8, 18 + r * 12, r === 1]); dots.push([30 + k * 8, 18 + r * 12, r === 1]); }
    // Scattered dots, no arrow: no formation.
    if (f === 'none') for (const [x, y, bow] of [[6, 10, false], [22, 6, false], [36, 14, true], [12, 26, true], [28, 24, false], [40, 34, false], [8, 38, false], [22, 38, true]] as [number, number, boolean][]) dots.push([x, y, bow]);
        if (f === 'box') for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) dots.push([8 + k * 9, 12 + r * 9, r > 0 && r < 3 && k > 0 && k < 3]);
    for (const [x, y, bow] of dots) {
      c.fillStyle = '#1a140c';
      c.fillRect(x - 1, y - 1, 8, 8);
      c.fillStyle = bow ? '#f0d88a' : team;
      c.fillRect(x, y, 6, 6);
    }
    if (f !== 'none') {
      c.fillStyle = '#f0d88a';
      c.beginPath();
      c.moveTo(24, 1);
      c.lineTo(31, 8);
      c.lineTo(17, 8);
      c.closePath();
      c.fill();
    }
  } else if (id === 'back') {
    // A curved arrow pointing back.
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = '#2a2018';
    c.lineWidth = 9;
    const arrow = () => {
      c.beginPath();
      c.moveTo(18, 14);
      c.lineTo(32, 14);
      c.arc(32, 26, 12, -Math.PI / 2, Math.PI / 2);
      c.lineTo(14, 38);
      c.stroke();
      c.beginPath();
      c.moveTo(20, 5);
      c.lineTo(9, 14);
      c.lineTo(20, 23);
      c.stroke();
    };
    arrow();
    c.strokeStyle = '#f0d88a';
    c.lineWidth = 4;
    arrow();
  } else if (id === 'allclear') {
    // The bell with a little arrow: back to work.
    glyph(c, 'bell', team, 4, 2, 4);
    c.fillStyle = '#5f9a3a';
    c.fillRect(30, 34, 14, 4);
    c.fillRect(38, 30, 4, 12);
  } else if (id === 'eject') {
    // A doorway with an arrow leading out of it: everyone comes out.
    c.fillStyle = '#2a2018';
    c.fillRect(6, 8, 18, 32);
    c.fillStyle = '#5a3b1e';
    c.fillRect(9, 11, 12, 29);
    c.fillStyle = '#e0b030';
    c.fillRect(17, 25, 2, 3);
    c.fillStyle = '#2a2018';
    c.fillRect(20, 20, 18, 12);
    c.beginPath();
    c.moveTo(34, 12);
    c.lineTo(46, 26);
    c.lineTo(34, 40);
    c.closePath();
    c.fill();
    c.fillStyle = '#7fd16a';
    c.fillRect(22, 22, 14, 8);
    c.beginPath();
    c.moveTo(35, 16);
    c.lineTo(43, 26);
    c.lineTo(35, 36);
    c.closePath();
    c.fill();
  } else {
    glyph(c, id === 'cancel' ? 'cross' : id === 'rally' ? 'flag' : id, team, 4, 4, 4);
  }
  const url = canvas.toDataURL();
  cache.set(key, url);
  return url;
}
