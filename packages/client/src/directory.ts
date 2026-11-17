import { DataConnection, Peer } from 'peerjs';
import { peerOptions } from './net';

// The list of open games, without a server of its own. One browser at a time holds the list under a
// well-known PeerJS id: whoever claims that id first, a visitor on the start page or a host. Hosts
// tell it about their room every few seconds; visitors ask it for the list. When the holder leaves,
// the next browser to notice claims the id and the hosts fill the list in again within seconds.

const DIRECTORY_ID = 'kingsfall-directory-v1';
/** How often a host repeats its room; a room not heard of for a while is dropped. */
const ANNOUNCE_MS = 8000;
const EXPIRE_MS = 25000;

export interface Listing {
  code: string;
  host: string;
  players: number;
  max: number;
  /** A running game: it can be watched, not joined. */
  started: boolean;
  mapSize: string;
  speed: number;
}

type DirMessage =
  | { t: 'announce'; room: Listing }
  | { t: 'gone'; code: string }
  | { t: 'watch' }
  | { t: 'rooms'; rooms: Listing[] };

const rooms = new Map<string, { room: Listing; at: number }>();
const watchers = new Set<(rooms: Listing[]) => void>();
/** This browser's rooms, each with the code it was last listed under. */
const announcers = new Map<() => Listing | undefined, string | undefined>();

let peer: Peer | undefined;
let link: DataConnection | undefined;
/** True while this browser holds the list itself. */
let holding = false;
const followers = new Set<DataConnection>();
let timer: ReturnType<typeof setInterval> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
/** When the holder last sent the list; a holder silent for long is taken to be gone. */
let lastHeard = 0;
const SILENT_MS = 20000;

const valid = (r: Partial<Listing> | undefined): r is Listing =>
  !!r && typeof r.code === 'string' && /^[A-Z0-9]{1,8}$/.test(r.code) && typeof r.host === 'string' &&
  Number.isFinite(r.players) && Number.isFinite(r.max) && typeof r.started === 'boolean';

function current(): Listing[] {
  const now = Date.now();
  for (const [code, { at }] of rooms) if (now - at > EXPIRE_MS) rooms.delete(code);
  return [...rooms.values()].map(({ room }) => room).sort((a, b) => Number(a.started) - Number(b.started) || a.code.localeCompare(b.code));
}

/** The holder tells everyone watching what is open now. */
function share(): void {
  const list = current();
  for (const w of watchers) w(list);
  const text = JSON.stringify({ t: 'rooms', rooms: list } satisfies DirMessage);
  // Everyone linked gets it, also hosts that only announce: it shows them the holder is still there.
  for (const c of followers) if (c.open) c.send(text);
}

function receive(conn: DataConnection, raw: unknown): void {
  let msg: DirMessage;
  try {
    msg = JSON.parse(String(raw)) as DirMessage;
  } catch {
    return;
  }
  if (holding) {
    if (msg.t === 'announce' && valid(msg.room)) {
      const room: Listing = { ...msg.room, host: msg.room.host.slice(0, 16), mapSize: String(msg.room.mapSize).slice(0, 12), speed: Number(msg.room.speed) || 1 };
      rooms.set(room.code, { room, at: Date.now() });
      (conn as DataConnection & { codes?: Set<string> }).codes ??= new Set();
      (conn as DataConnection & { codes?: Set<string> }).codes!.add(room.code);
      share();
    } else if (msg.t === 'gone' && typeof msg.code === 'string') {
      rooms.delete(msg.code);
      share();
    } else if (msg.t === 'watch') {
      conn.send(JSON.stringify({ t: 'rooms', rooms: current() } satisfies DirMessage));
    }
  } else if (msg.t === 'rooms' && Array.isArray(msg.rooms)) {
    lastHeard = Date.now();
    const list = msg.rooms.filter(valid);
    for (const w of watchers) w(list);
  }
}

function unlist(code: string): void {
  if (holding) {
    rooms.delete(code);
    share();
  } else if (link?.open) link.send(JSON.stringify({ t: 'gone', code } satisfies DirMessage));
}

/** Repeats this browser's own rooms: straight into the list when holding it, to the holder otherwise. */
function announce(): void {
  for (const [get, was] of announcers) {
    const room = get();
    if (was && was !== room?.code) unlist(was);
    announcers.set(get, room?.code);
    if (!room) continue;
    if (holding) rooms.set(room.code, { room, at: Date.now() });
    else if (link?.open) link.send(JSON.stringify({ t: 'announce', room } satisfies DirMessage));
  }
  if (holding) share();
}

function stop(): void {
  if (timer) clearInterval(timer);
  if (retry) clearTimeout(retry);
  timer = retry = undefined;
  const old = peer;
  peer = link = undefined;
  holding = false;
  followers.clear();
  old?.destroy();
}

/** Tries again a little later, at a random moment so that not everyone claims the list at once. */
function later(): void {
  if (retry || (watchers.size === 0 && announcers.size === 0)) return;
  const old = peer;
  peer = link = undefined;
  holding = false;
  followers.clear();
  old?.destroy();
  retry = setTimeout(() => {
    retry = undefined;
    connect();
  }, 800 + Math.random() * 2200);
}

/** Becomes the holder of the list if nobody is, or follows the one who is. */
function connect(): void {
  if (peer || (watchers.size === 0 && announcers.size === 0)) return;
  lastHeard = Date.now();
  const claim = new Peer(DIRECTORY_ID, peerOptions());
  peer = claim;
  claim.on('open', () => {
    holding = true;
    announce();
    claim.on('connection', (conn) => {
      followers.add(conn);
      conn.on('data', (data) => receive(conn, data));
      conn.on('close', () => {
        followers.delete(conn);
        // A host that went away takes its rooms with it.
        const codes = (conn as DataConnection & { codes?: Set<string> }).codes;
        if (codes?.size) {
          for (const code of codes) rooms.delete(code);
          share();
        }
      });
    });
  });
  claim.on('error', (err) => {
    if (peer !== claim) return;
    if (err.type !== 'unavailable-id') return later();
    // Someone holds the list: follow them.
    if (peer !== claim) return;
    claim.destroy();
    const me = new Peer(peerOptions());
    peer = me;
    me.on('open', () => {
      const conn = me.connect(DIRECTORY_ID, { reliable: true });
      link = conn;
      conn.on('open', () => {
        lastHeard = Date.now();
        if (watchers.size > 0) conn.send(JSON.stringify({ t: 'watch' } satisfies DirMessage));
        announce();
      });
      conn.on('data', (data) => receive(conn, data));
      conn.on('close', () => link === conn && later());
      conn.on('error', () => link === conn && later());
    });
    me.on('error', () => peer === me && later());
  });
  claim.on('disconnected', () => {
    if (holding && peer === claim && !claim.destroyed) claim.reconnect();
  });
  timer ??= setInterval(() => {
    if (!holding && peer && Date.now() - lastHeard > SILENT_MS) return later();
    announce();
    if (holding) share();
  }, ANNOUNCE_MS);
}

/** Calls `onRooms` with the open games whenever the list changes. Returns a function that stops it. */
export function watchRooms(onRooms: (rooms: Listing[]) => void): () => void {
  watchers.add(onRooms);
  if (holding) onRooms(current());
  else if (link?.open) link.send(JSON.stringify({ t: 'watch' } satisfies DirMessage));
  connect();
  return () => {
    watchers.delete(onRooms);
    if (watchers.size === 0 && announcers.size === 0) stop();
  };
}

/** Lists a room while `get` returns it (undefined: not listed right now). Returns a function that removes it. */
export function listRoom(get: () => Listing | undefined): () => void {
  announcers.set(get, undefined);
  connect();
  announce();
  return () => {
    const code = announcers.get(get);
    announcers.delete(get);
    if (code) unlist(code);
    if (watchers.size === 0 && announcers.size === 0) setTimeout(() => watchers.size === 0 && announcers.size === 0 && stop(), 500);
  };
}

/** Tells the list about a change at once (a player joined, the game started). */
export function roomChanged(): void {
  announce();
}

if (import.meta.env.DEV) {
  Object.assign(window, {
    __dir: () => ({ holding, peer: peer?.id, open: peer?.open, destroyed: peer?.destroyed, link: link?.open, followers: followers.size, rooms: [...rooms.keys()], watchers: watchers.size, announcers: announcers.size, lastHeard: Date.now() - lastHeard, retry: !!retry, timer: !!timer }),
  });
}
