// Small synthesised sound effects, so the game needs no audio files.

let ctx: AudioContext | undefined;
let muted = false;
try {
  muted = localStorage.getItem('kingsfall-muted') === '1';
} catch {
  // Storage can be unavailable (private windows); sound just starts on.
}
const lastPlayed = new Map<string, number>();

/** Browsers only allow sound after a click or key press; call this from one. */
export function unlockSound(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    loadCustomSounds();
  } catch {
    ctx = undefined;
  }
  startMusic();
}

export function isMuted(): boolean {
  return muted;
}

export function toggleMute(): boolean {
  muted = !muted;
  try {
    localStorage.setItem('kingsfall-muted', muted ? '1' : '0');
  } catch {
    // Not remembered, but still applied.
  }
  return muted;
}

/** Volume of the sound effects, 0 to 1; the music has its own. */
let effectsVolume = (() => {
  try {
    const v = Number(localStorage.getItem('kingsfall-effects-volume') ?? '0.7');
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.7;
  } catch {
    return 0.7;
  }
})();
let effects: GainNode | undefined;

/** Where every sound effect goes: one volume for all of them. */
function output(): AudioNode {
  if (!effects) {
    effects = ctx!.createGain();
    effects.gain.value = effectsVolume;
    effects.connect(ctx!.destination);
  }
  return effects;
}

export function effectsState(): { volume: number; muted: boolean } {
  return { volume: effectsVolume, muted };
}

export function setEffectsVolume(volume: number): void {
  effectsVolume = Math.max(0, Math.min(1, volume));
  if (effects) effects.gain.value = effectsVolume;
  try {
    localStorage.setItem('kingsfall-effects-volume', String(effectsVolume));
  } catch {
    // Not remembered, but still applied.
  }
}

function tone(freq: number, start: number, length: number, volume: number, type: OscillatorType = 'triangle', slideTo?: number): void {
  if (!ctx) return;
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + length);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(gain).connect(output());
  osc.start(t);
  osc.stop(t + length + 0.02);
}

function noise(start: number, length: number, volume: number, cutoff: number): void {
  if (!ctx) return;
  const t = ctx.currentTime + start;
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  src.connect(filter).connect(gain).connect(output());
  src.start(t);
}

const SOUNDS = {
  order: () => tone(520, 0, 0.07, 0.05, 'square'),
  hit: () => noise(0, 0.08, 0.12, 1800),
  arrow: () => tone(900, 0, 0.12, 0.04, 'sine', 300),
  death: () => tone(180, 0, 0.25, 0.08, 'sawtooth', 70),
  collapse: () => noise(0, 0.6, 0.25, 500),
  built: () => {
    tone(523, 0, 0.12, 0.08);
    tone(784, 0.1, 0.2, 0.08);
  },
  trained: () => tone(660, 0, 0.1, 0.06),
  chat: () => {
    tone(784, 0, 0.07, 0.04, 'sine');
    tone(1047, 0.07, 0.1, 0.04, 'sine');
  },
  research: () => {
    tone(440, 0, 0.1, 0.07);
    tone(554, 0.09, 0.1, 0.07);
    tone(659, 0.18, 0.22, 0.07);
  },
  age: () => {
    for (const [i, f] of [392, 523, 659, 784].entries()) tone(f, i * 0.14, 0.3, 0.09);
  },
  alarm: () => {
    tone(880, 0, 0.14, 0.1, 'square');
    tone(660, 0.16, 0.14, 0.1, 'square');
    tone(880, 0.32, 0.14, 0.1, 'square');
  },
  victory: () => {
    for (const [i, f] of [523, 659, 784, 1047].entries()) tone(f, i * 0.18, 0.5, 0.1);
  },
  defeat: () => {
    for (const [i, f] of [392, 330, 262, 196].entries()) tone(f, i * 0.22, 0.5, 0.1, 'sawtooth');
  },
};
export type SoundName = keyof typeof SOUNDS;

/**
 * Your own sound files, listed in public/sounds/manifest.json as { "<sound name>": "file.ogg" },
 * or with a list of files to pick one at random each time: { "built.mill": ["a.ogg", "b.ogg"] }.
 * A name can be general ("built") or more detailed ("built.farm", "order.gather.wood"); the most
 * detailed one there is gets played, so detailed files are optional. Anything without a file keeps
 * its built-in sound. Each file is measured when it loads and turned up or down so that all of them
 * sound about equally loud.
 */
const custom = new Map<string, { buffer: AudioBuffer; gain: number }[]>();
let customLoading = false;
/** Sounds that have no built-in version and stay silent unless a file is given. */
const FILE_ONLY = new Set(['select', 'heal', 'convert', 'error', 'click', 'start', 'bell', 'relic']);
type FileOnly = 'select' | 'heal' | 'convert' | 'error' | 'click' | 'start' | 'bell' | 'relic';
/**
 * Sounds that play quieter than the rest, as a share of the common loudness. Orders are heard
 * all the time, so they stay in the background; monks heal and convert for long stretches, so
 * theirs are only a murmur.
 */
const QUIETER: Record<string, number> = { order: 0.45, click: 0.45, heal: 0.2, convert: 0.2 };
/** Sounds that must not overlap: [name prefix, milliseconds between them]. */
const SPACED: [string, number][] = [['order.move.', 1300]];
/** How loud every file is made: the loudness of its sounding part, as an RMS level (about -18 dB). */
const TARGET_RMS = 0.126;

function levelOf(buffer: AudioBuffer): number {
  // Loudness of the part that sounds: silence before and after does not count.
  let sum = 0;
  let count = 0;
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
      if (v > 0.003) {
        sum += v * v;
        count++;
      }
    }
  }
  if (count === 0 || peak === 0) return 1;
  const rms = Math.sqrt(sum / count);
  // Never so loud that the file would clip.
  return Math.min(TARGET_RMS / rms, 0.95 / peak, 12);
}

function loadCustomSounds(): void {
  if (customLoading || !ctx) return;
  customLoading = true;
  const audio = ctx;
  void fetch('sounds/manifest.json', { cache: 'no-cache' })
    .then((res) => (res.ok ? res.json() : {}))
    .then((list: Record<string, string | string[]>) => {
      // The same file may be listed for several sounds: it is fetched and decoded once.
      const decoded = new Map<string, Promise<{ buffer: AudioBuffer; gain: number }>>();
      const load = (file: string) => {
        let job = decoded.get(file);
        if (!job) {
          job = fetch('sounds/' + file)
            .then((res) => res.arrayBuffer())
            .then((data) => audio.decodeAudioData(data))
            .then((buffer) => ({ buffer, gain: levelOf(buffer) }));
          decoded.set(file, job);
        }
        return job;
      };
      for (const [name, files] of Object.entries(list)) {
        const base = name.split('.')[0];
        if (!(base in SOUNDS) && !FILE_ONLY.has(base)) continue;
        for (const file of Array.isArray(files) ? files : [files]) {
          if (typeof file !== 'string') continue;
          void load(file)
            .then((sound) => custom.set(name, [...(custom.get(name) ?? []), sound]))
            .catch(() => console.warn(`Sound "${name}" (${file}) could not be loaded; the built-in one is used.`));
        }
      }
    })
    .catch(() => undefined);
}

/**
 * Plays a sound, at most once per `gap` milliseconds for its kind so that big fights do not turn
 * into noise. `name` may carry details after dots, like "built.farm": the most detailed sound
 * file there is gets played, else the general one, else the built-in sound.
 */
export function play(name: SoundName | FileOnly | `${SoundName | FileOnly}.${string}`, gap = 90): void {
  if (muted || !ctx) return;
  const base = name.split('.')[0];
  const now = performance.now();
  if (now - (lastPlayed.get(base) ?? -1e9) < gap) return;
  // The troops' longer replies get room to finish before the next one starts.
  const spaced = SPACED.find(([prefix]) => name.startsWith(prefix));
  if (spaced && now - (lastPlayed.get(spaced[0]) ?? -1e9) < spaced[1]) return;
  if (spaced) lastPlayed.set(spaced[0], now);
  lastPlayed.set(base, now);
  for (let key: string = name; ; key = key.slice(0, key.lastIndexOf('.'))) {
    if (playFile(key)) return;
    if (!key.includes('.')) break;
  }
  if (base in SOUNDS) SOUNDS[base as SoundName]();
}

/** Plays one of the files given for exactly this name, if there are any. */
function playFile(name: string): boolean {
  const takes = custom.get(name);
  if (!ctx || !takes?.length) return false;
  const sound = takes[Math.floor(Math.random() * takes.length)];
  const src = ctx.createBufferSource();
  src.buffer = sound.buffer;
  const gain = ctx.createGain();
  gain.gain.value = sound.gain * (QUIETER[name.split('.')[0]] ?? 1);
  src.connect(gain).connect(output());
  src.start();
  return true;
}

/**
 * Plays the first of these names that has a sound file, and nothing if none has: for sounds
 * that are only heard when they were made, like clicking a building.
 */
export function playFirstFile(names: string[], gap = 150): void {
  if (muted || !ctx) return;
  const now = performance.now();
  if (now - (lastPlayed.get('select') ?? -1e9) < gap) return;
  for (const name of names) {
    if (playFile(name)) {
      lastPlayed.set('select', now);
      return;
    }
  }
}

// --- background music ------------------------------------------------------------------------

const read = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered, but still applied.
  }
};

/** The background songs. They play one after the other; which one comes first is left to chance. */
const TRACKS = ['sounds/music.mp3', 'sounds/music2.mp3'];
let music: HTMLAudioElement | undefined;
let current = Math.floor(Math.random() * TRACKS.length);
let musicVolume = Math.max(0, Math.min(1, Number(read('kingsfall-music-volume', '0.5'))));
let musicMuted = read('kingsfall-music-muted', '0') === '1';

function track(): HTMLAudioElement {
  if (!music) {
    // Streamed rather than loaded up front; when a song ends the next one starts.
    music = new Audio(TRACKS[current]);
    music.preload = 'none';
    music.volume = musicVolume;
    music.addEventListener('ended', () => {
      current = (current + 1) % TRACKS.length;
      music!.src = TRACKS[current];
      if (!musicMuted) void music!.play().catch(() => undefined);
    });
  }
  return music;
}

/** Starts the music if it is on; browsers only allow this after a click or key press. */
export function startMusic(): void {
  if (musicMuted) return;
  const m = track();
  if (m.paused) void m.play().catch(() => undefined);
}

export function musicState(): { volume: number; muted: boolean } {
  return { volume: musicVolume, muted: musicMuted };
}

/** Volume from 0 to 1. */
export function setMusicVolume(volume: number): void {
  musicVolume = Math.max(0, Math.min(1, volume));
  track().volume = musicVolume;
  store('kingsfall-music-volume', String(musicVolume));
}

/** Skips to the other song; switches the music on if it was off. */
export function nextTrack(): void {
  const m = track();
  current = (current + 1) % TRACKS.length;
  m.src = TRACKS[current];
  if (musicMuted) toggleMusic();
  else void m.play().catch(() => undefined);
}

export function toggleMusic(): boolean {
  musicMuted = !musicMuted;
  store('kingsfall-music-muted', musicMuted ? '1' : '0');
  if (musicMuted) music?.pause();
  else startMusic();
  return musicMuted;
}
