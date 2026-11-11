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
  osc.connect(gain).connect(ctx.destination);
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
  src.connect(filter).connect(gain).connect(ctx.destination);
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
 * Your own sound files, listed in public/sounds/manifest.json as { "<sound name>": "file.ogg" }.
 * A listed sound replaces the built-in one; anything not listed keeps its synthesised sound.
 */
const custom = new Map<string, AudioBuffer>();
let customLoading = false;

function loadCustomSounds(): void {
  if (customLoading || !ctx) return;
  customLoading = true;
  const audio = ctx;
  void fetch('sounds/manifest.json', { cache: 'no-cache' })
    .then((res) => (res.ok ? res.json() : {}))
    .then((list: Record<string, string>) => {
      for (const [name, file] of Object.entries(list)) {
        if (!(name in SOUNDS) || typeof file !== 'string') continue;
        void fetch('sounds/' + file)
          .then((res) => res.arrayBuffer())
          .then((data) => audio.decodeAudioData(data))
          .then((buffer) => custom.set(name, buffer))
          .catch(() => console.warn(`Sound "${name}" (${file}) could not be loaded; the built-in one is used.`));
      }
    })
    .catch(() => undefined);
}

/** Plays a sound, at most once per `gap` milliseconds so that big fights do not turn into noise. */
export function play(name: SoundName, gap = 90): void {
  if (muted || !ctx) return;
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -1e9) < gap) return;
  lastPlayed.set(name, now);
  const buffer = custom.get(name);
  if (buffer) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.6;
    src.connect(gain).connect(ctx.destination);
    src.start();
    return;
  }
  SOUNDS[name]();
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

let music: HTMLAudioElement | undefined;
let musicVolume = Math.max(0, Math.min(1, Number(read('kingsfall-music-volume', '0.5'))));
let musicMuted = read('kingsfall-music-muted', '0') === '1';

function track(): HTMLAudioElement {
  if (!music) {
    // Streamed rather than loaded up front, and looped for as long as the page is open.
    music = new Audio('sounds/music.mp3');
    music.loop = true;
    music.preload = 'none';
    music.volume = musicVolume;
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

export function toggleMusic(): boolean {
  musicMuted = !musicMuted;
  store('kingsfall-music-muted', musicMuted ? '1' : '0');
  if (musicMuted) music?.pause();
  else startMusic();
  return musicMuted;
}
