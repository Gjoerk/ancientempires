// Optional sprite pack. Any unit, building or resource can be replaced by an image
// listed in public/sprites/manifest.json; whatever is not listed keeps its built-in
// drawing. See public/sprites/README.md for the format.

export interface SpriteDef {
  /** Image file, relative to the sprites folder. */
  src: string;
  /** Pixel in one frame that is placed on the ground point. Default: bottom centre. */
  anchor?: [number, number];
  /** Drawing scale. Default 1. */
  scale?: number;
  /** Number of frames laid out left to right in the image. Default 1. */
  frames?: number;
  /** Animation speed in frames per second. Default 8. */
  fps?: number;
  /** Greyscale image of the same size; its opaque pixels are recoloured to the owner's colour. */
  teamMask?: string;
  /** Keep the built-in ground shadow under the sprite. Default: true for units and resources. */
  shadow?: boolean;
  /** Smooth the image when scaling instead of keeping hard pixels. Default false. */
  smooth?: boolean;
  /** Castles: pixel in the frame where the royal flag pole stands while a king is inside. */
  flag?: [number, number];
}

export interface Sprite {
  key: string;
  def: SpriteDef;
  image: HTMLImageElement;
  mask?: HTMLImageElement;
  /** Image with the team mask applied, per colour. */
  tinted: Map<string, HTMLCanvasElement>;
}

const sprites = new Map<string, Sprite>();

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${url}`));
    img.src = url;
  });
}

/** Loads the sprite pack, if there is one. Problems are reported and otherwise ignored. */
export async function loadSprites(): Promise<void> {
  const base = new URL('sprites/', document.baseURI).href;
  let manifest: Record<string, SpriteDef>;
  try {
    const res = await fetch(base + 'manifest.json', { cache: 'no-cache' });
    if (!res.ok) return;
    manifest = await res.json();
  } catch {
    return;
  }
  await Promise.all(Object.entries(manifest).map(async ([key, def]) => {
    if (!def || typeof def.src !== 'string') return;
    try {
      const image = await loadImage(base + def.src);
      const mask = def.teamMask ? await loadImage(base + def.teamMask) : undefined;
      sprites.set(key, { key, def, image, mask, tinted: new Map() });
    } catch (err) {
      console.warn(`Sprite "${key}" skipped:`, err);
    }
  }));
}

/** The first of the given keys that the sprite pack provides. */
export function findSprite(keys: string[]): Sprite | undefined {
  if (sprites.size === 0) return undefined;
  for (const key of keys) {
    const s = sprites.get(key);
    if (s) return s;
  }
  return undefined;
}

function tintedImage(s: Sprite, team: string): CanvasImageSource {
  if (!s.mask) return s.image;
  let canvas = s.tinted.get(team);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = s.image.width;
    canvas.height = s.image.height;
    const c = canvas.getContext('2d')!;
    // Colour the mask while keeping its shading and its shape.
    c.drawImage(s.mask, 0, 0);
    c.globalCompositeOperation = 'multiply';
    c.fillStyle = team;
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(s.mask, 0, 0);
    c.globalCompositeOperation = 'destination-over';
    c.drawImage(s.image, 0, 0);
    s.tinted.set(team, canvas);
  }
  return canvas;
}

/** Draws a sprite with its anchor at (x, y). Returns where the frame's top-left corner ended up. */
export function drawSprite(
  ctx: CanvasRenderingContext2D, s: Sprite, team: string, x: number, y: number, now: number, flip = false,
): [number, number] {
  const frames = Math.max(1, s.def.frames ?? 1);
  const fw = s.image.width / frames;
  const fh = s.image.height;
  const scale = s.def.scale ?? 1;
  const [ax, ay] = s.def.anchor ?? [fw / 2, fh];
  const frame = frames > 1 ? Math.floor((now / 1000) * (s.def.fps ?? 8)) % frames : 0;
  const left = Math.round(x - ax * scale);
  const top = Math.round(y - ay * scale);
  const smooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = s.def.smooth === true;
  const img = tintedImage(s, team);
  if (flip) {
    ctx.save();
    ctx.translate(Math.round(x), 0);
    ctx.scale(-1, 1);
    ctx.drawImage(img, frame * fw, 0, fw, fh, -ax * scale, top, fw * scale, fh * scale);
    ctx.restore();
  } else {
    ctx.drawImage(img, frame * fw, 0, fw, fh, left, top, fw * scale, fh * scale);
  }
  ctx.imageSmoothingEnabled = smooth;
  return [left, top];
}
