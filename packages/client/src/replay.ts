import type { ServerMessage } from '@kingsfall/shared';

// Replays: every browser records the updates it gets from the host during a game (the same ones
// spectators get, so the whole map), compressed and kept in this browser. Played back, they go
// through the normal game screen as if watching. A replay can be saved as a file and opened again.

export interface ReplayMeta {
  id: string;
  room: string;
  /** When the game started. */
  date: number;
  players: string[];
  /** Whose browser recorded it. */
  by: string;
  /** Length in game steps (10 a second). */
  ticks: number;
  /** The winning team's player names, when the game ended with one. */
  winners?: string[];
}

export interface Replay {
  meta: ReplayMeta;
  start: Extract<ServerMessage, { t: 'start' }>;
  /** The messages after the start, with the game step each one belongs to. */
  msgs: ServerMessage[];
  ticks: number[];
}

/** Records one game. */
export class Recorder {
  readonly meta: ReplayMeta;
  private readonly lines: string[] = [];
  private lastSaved = 0;
  readonly seed: number;
  done = false;

  constructor(start: Extract<ServerMessage, { t: 'start' }>, by: string) {
    this.seed = start.seed;
    this.meta = {
      id: `${start.room}-${start.seed.toString(36)}-${Date.now().toString(36)}`, room: start.room, date: Date.now(),
      players: start.players.map((p) => p.name), by, ticks: 0,
    };
    this.lines.push(JSON.stringify({ ...start, you: -1 }));
  }

  add(msg: ServerMessage): void {
    if (this.done) return;
    if (msg.t === 'snap') {
      this.meta.ticks = Math.max(this.meta.ticks, msg.tick);
      if (msg.winner >= 0) this.done = true;
    }
    this.lines.push(JSON.stringify(msg));
  }

  setWinners(names: string[]): void {
    this.meta.winners = names;
  }

  /** Keeps it in this browser (again, if it was kept before: the newer copy replaces it). */
  async save(): Promise<void> {
    // Too short to be worth keeping.
    if (this.meta.ticks < 300 || this.lines.length === this.lastSaved) return;
    this.lastSaved = this.lines.length;
    const blob = await pack([JSON.stringify(this.meta), ...this.lines].join('\n'));
    await store(this.meta, blob);
  }
}

async function pack(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

async function unpack(blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  // Plain text too, in case a file was unpacked by hand.
  if (head[0] !== 0x1f || head[1] !== 0x8b) return blob.text();
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

/** Turns the text of a replay into one ready to play. */
function parse(text: string): Replay {
  const lines = text.split('\n');
  const meta = JSON.parse(lines[0]) as ReplayMeta;
  const start = JSON.parse(lines[1]) as Replay['start'];
  if (!meta || !start || start.t !== 'start') throw new Error('not a replay');
  const msgs: ServerMessage[] = [];
  const ticks: number[] = [];
  let tick = 0;
  for (let i = 2; i < lines.length; i++) {
    if (!lines[i]) continue;
    const msg = JSON.parse(lines[i]) as ServerMessage;
    if (msg.t === 'snap') tick = msg.tick;
    msgs.push(msg);
    ticks.push(tick);
  }
  return { meta, start: { ...start, you: -1 }, msgs, ticks };
}

// --- kept in this browser (IndexedDB) ------------------------------------------

const DB = 'kingsfall';
const KEEP = 15;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('replayMeta', { keyPath: 'id' });
      req.result.createObjectStore('replayData');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

function get<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(meta: ReplayMeta, blob: Blob): Promise<void> {
  const db = await open();
  const tx = db.transaction(['replayMeta', 'replayData'], 'readwrite');
  tx.objectStore('replayMeta').put({ ...meta });
  tx.objectStore('replayData').put(blob, meta.id);
  await done(tx);
  // Only the latest few are kept.
  const all = await listReplays();
  if (all.length > KEEP) for (const old of all.slice(KEEP)) await deleteReplay(old.id);
}

/** The replays kept in this browser, newest first. */
export async function listReplays(): Promise<ReplayMeta[]> {
  try {
    const db = await open();
    const all = await get(db.transaction('replayMeta').objectStore('replayMeta').getAll() as IDBRequest<ReplayMeta[]>);
    return all.sort((a, b) => b.date - a.date);
  } catch {
    return [];
  }
}

async function blobOf(id: string): Promise<Blob | undefined> {
  const db = await open();
  return get(db.transaction('replayData').objectStore('replayData').get(id) as IDBRequest<Blob | undefined>);
}

export async function loadReplay(id: string): Promise<Replay | undefined> {
  const blob = await blobOf(id);
  return blob ? parse(await unpack(blob)) : undefined;
}

export async function deleteReplay(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(['replayMeta', 'replayData'], 'readwrite');
  tx.objectStore('replayMeta').delete(id);
  tx.objectStore('replayData').delete(id);
  await done(tx);
}

/** Saves a kept replay as a file. */
export async function downloadReplay(meta: ReplayMeta): Promise<void> {
  const blob = await blobOf(meta.id);
  if (!blob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const day = new Date(meta.date).toISOString().slice(0, 16).replace(/[T:]/g, '-');
  a.download = `kingsfall-${meta.room}-${day}.kfreplay`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Opens a replay file (and keeps it in this browser too). */
export async function readReplayFile(file: File): Promise<Replay> {
  const replay = parse(await unpack(file));
  try {
    await store(replay.meta, file);
  } catch {
    // Played anyway, just not kept.
  }
  return replay;
}
