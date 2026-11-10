import { DEFS, isTech, Kind, KINDS, TechId } from '@kingsfall/shared';
import { findSprite } from './assets';
import { drawBuilding } from './buildings';
import { drawUnit, PLAYER_COLORS } from './sprites';

// Icons for buttons, resources and upgrades. Every icon is drawn by code into a small
// canvas, and each one can be replaced by an image through the sprite pack (`icon.<id>`).

const SIZE = 48;

// Palette letters: w steel, k wood, t team colour, b dark edge, r red, g gold, y light gold,
// e green, s stone, l light stone, o brown, c cream.
const PALETTE: Record<string, string> = {
  w: '#e3e7ec', k: '#7a5230', b: '#2a2018', r: '#c8402f', g: '#e0b030', y: '#f7df7a',
  e: '#5f9a3a', s: '#85898f', l: '#c4c8cf', o: '#5a3b1e', c: '#efe6cf', m: '#9aa0a8',
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
  crown: [
    '....gg....',
    '...gggg...',
    '..gggggg..',
    '....gg....',
    '....gg....',
    'y...yy...y',
    'yy.yyyy.yy',
    'yyyyyyyyyy',
    'yrygyygyry',
    'yyyyyyyyyy',
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
    '.....e....',
    '....ee....',
    '..rr.rrr..',
    '.rrrrrrrr.',
    '.rcrrrrrr.',
    '.rcrrrrrr.',
    '.rrrrrrrr.',
    '.rrrrrrrr.',
    '..rrrrrr..',
    '...rr.rr..',
  ],
  wood: [
    '..........',
    '..........',
    '.kkkkkkkc.',
    'kookookcoc',
    'kkkkkkkcoc',
    'kookookcoc',
    'kkkkkkk.c.',
    '.kkkkkk...',
    '..........',
    '..........',
  ],
  gold: [
    '..........',
    '...gggg...',
    '..gyyyyg..',
    '.gyyggyyg.',
    '.gyygyyyg.',
    '.gyygyyyg.',
    '.gyyggyyg.',
    '..gyyyyg..',
    '...gggg...',
    '..........',
  ],
  stone: [
    '..........',
    '....ss....',
    '...sllss..',
    '..slllsss.',
    '.sllssssss',
    '.slsssssss',
    'ssssssbsss',
    'sssssbssss',
    '.ssssssss.',
    '..........',
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

/** Forget all drawn icons, e.g. after the sprite pack has loaded. */
export function clearIcons(): void {
  cache.clear();
}

function glyph(c: CanvasRenderingContext2D, name: string, team: string, x: number, y: number, px: number): void {
  const rows = GLYPHS[name];
  if (!rows) return;
  for (let r = 0; r < rows.length; r++) {
    for (let col = 0; col < rows[r].length; col++) {
      const ch = rows[r][col];
      const color = ch === 't' ? team : PALETTE[ch];
      if (!color) continue;
      c.fillStyle = color;
      c.fillRect(x + col * px, y + r * px, px, px);
    }
  }
}

function thing(c: CanvasRenderingContext2D, kind: Kind, owner: number, box: number, left: number, top: number): void {
  c.save();
  if (DEFS[kind].building) {
    const s = DEFS[kind].size ?? 1;
    const scale = Math.min(1, (box - 4) / (s * 64 + 6), (box - 2) / (s * 32 + (kind === 'tower' ? 66 : kind === 'castle' ? 60 : 44)));
    c.translate(left + box / 2, top + box - 3 - s * 32 * scale);
    c.scale(scale, scale);
    drawBuilding(c, kind, owner, 1, 0, 0, { built: 1, kingInside: false, now: 0 });
  } else {
    const wide = kind === 'rider' || kind === 'scout' || kind === 'ram';
    const scale = (box / 48) * (wide ? 1.3 : 1.55);
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
  const team = PLAYER_COLORS[owner % PLAYER_COLORS.length];
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
  } else if (id === 'eject') {
    thing(c, 'king', owner, SIZE, 0, 0);
  } else {
    glyph(c, id === 'cancel' ? 'cross' : id === 'rally' ? 'flag' : id, team, 4, 4, 4);
  }
  const url = canvas.toDataURL();
  cache.set(key, url);
  return url;
}
