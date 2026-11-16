import { Peer, DataConnection, PeerOptions } from 'peerjs';
import { ClientMessage, GameHost, MAP_SIZES, POP_LIMITS, ServerMessage, TICK_MS, TICK_RATE } from '@kingsfall/shared';

// There is no game server. One player's browser hosts the game and the others
// connect to it directly over WebRTC. Only the initial handshake goes through
// a PeerJS broker (the public one unless VITE_PEER_HOST is set).

const ID_PREFIX = 'kingsfall-room-';
const SILENCE_LIMIT_MS = 8000;

/** What only the host of a room can do. */
export interface HostControls {
  start(): void;
  backToLobby(): void;
  /** Adds a stand-in opponent that the host plays themselves. */
  addTestPlayer(): void;
  addComputer(): void;
  /** Removes a test or computer opponent from the lobby. */
  removeExtra(slot: number): void;
  setTeam(slot: number, team: number): void;
  /** How well a computer opponent plays. */
  setLevel(slot: number, level: string): void;
  setQuickStart(on: boolean): void;
  setMapSize(size: string): void;
  setPopLimit(limit: number): void;
  /** Switches which of the host's own players the host's commands go to. */
  control(slot: number): boolean;
}

export interface Session {
  send(msg: ClientMessage): void;
  close(): void;
  /** Present only for the host. */
  host?: HostControls;
}

export interface Handlers {
  onMessage(msg: ServerMessage): void;
  /** The session ended or could not start. */
  onClose(reason: string): void;
  /** Guests: the connection to the host dropped and is being restored (a reason), or is back (undefined). */
  onReconnect?(reason: string | undefined): void;
}

/** How often a guest tries to get back into a game after losing the connection (it keeps trying until it gives up itself). */
const RECONNECT_EVERY_MS = 4000;
/** A guest the host has heard nothing from for this long has lost their connection, even if it never closed. */
const GUEST_SILENCE_MS = 15000;

/**
 * This browser's key for a room: sent when joining, so that a lost connection, a reload or even a
 * closed tab gets the same place back. Kept for the tab first, and for the browser for a day.
 */
function roomToken(code: string): string {
  const key = `kingsfall.token.${code}`;
  try {
    let token = sessionStorage.getItem(key);
    if (!token) {
      const kept = JSON.parse(localStorage.getItem(key) ?? 'null') as { token: string; at: number } | null;
      if (kept && Date.now() - kept.at < 24 * 3600 * 1000) token = kept.token;
    }
    token ??= Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem(key, token);
    localStorage.setItem(key, JSON.stringify({ token, at: Date.now() }));
    return token;
  } catch {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
}

/**
 * Relay servers for strict networks (university Wi-Fi, some offices) where browsers cannot reach each
 * other directly: short-lived TURN logins from a small Cloudflare Worker (cloudflare/turn-worker.js),
 * whose address is VITE_TURN_URL. Without it, or if it does not answer, only direct connections are tried.
 */
let iceServers: RTCIceServer[] | undefined;
let iceFetched = 0;
/** Logins are valid for six hours; they are reused for five, also across reloads, to ask the Worker rarely. */
const ICE_REFRESH_MS = 5 * 60 * 60 * 1000;
const ICE_STORE = 'kingsfall.ice';

/**
 * How players connect. 'auto': directly where the network allows it, through Cloudflare's relay
 * otherwise. 'off': only directly, Cloudflare is never asked. 'always': everything through the relay.
 */
export type RelayMode = 'auto' | 'off' | 'always';
let relayMode: RelayMode = 'auto';
export function setRelayMode(mode: RelayMode): void {
  relayMode = mode;
}

/** Fetches relay logins (or reuses recent ones), waiting at most a few seconds. Called before hosting or joining. */
export async function prepareNetwork(): Promise<void> {
  const url = import.meta.env.VITE_TURN_URL as string | undefined;
  if (!url || relayMode === 'off' || (iceServers && Date.now() - iceFetched < ICE_REFRESH_MS)) return;
  try {
    const kept = JSON.parse(localStorage.getItem(ICE_STORE) ?? 'null') as { at: number; servers: RTCIceServer[] } | null;
    if (kept && Date.now() - kept.at < ICE_REFRESH_MS && Array.isArray(kept.servers)) {
      [iceServers, iceFetched] = [kept.servers, kept.at];
      return;
    }
  } catch {
    // Nothing kept, or storage is blocked: ask the Worker.
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) return void console.warn(`Kingsfall: relay servers unavailable (${res.status}); trying direct connections only.`);
    const data = (await res.json()) as { iceServers?: RTCIceServer[] };
    if (Array.isArray(data.iceServers) && data.iceServers.length) {
      // Google's public STUN first (finds direct routes), then Cloudflare's servers (STUN and the relay).
      iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, ...data.iceServers];
      iceFetched = Date.now();
      try {
        localStorage.setItem(ICE_STORE, JSON.stringify({ at: iceFetched, servers: iceServers }));
      } catch {
        // Not kept: asked again next time.
      }
      console.info('Kingsfall: relay servers ready.');
    }
  } catch {
    // No relay this time: direct connections still work on most networks.
    console.warn('Kingsfall: relay servers could not be reached; trying direct connections only.');
  }
}

function peerOptions(): PeerOptions {
  const host = import.meta.env.VITE_PEER_HOST as string | undefined;
  const config = iceServers && relayMode !== 'off'
    ? { config: { iceServers, iceTransportPolicy: relayMode === 'always' ? 'relay' as const : 'all' as const } }
    : {};
  if (!host) return config;
  return {
    ...config,
    host,
    port: Number(import.meta.env.VITE_PEER_PORT) || 443,
    path: (import.meta.env.VITE_PEER_PATH as string | undefined) ?? '/',
    secure: import.meta.env.VITE_PEER_SECURE !== 'false',
  };
}

/** Shown when the room was found but no connection to the host could be made. */
const BLOCKED = 'Found the game, but could not connect to the host. This network may block direct connections between players: try another network (a phone hotspot works).';

/** Chat text as it is passed on: plain, single-line and short. */
function cleanChat(text: unknown): string {
  return (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

export function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

/** Runs `fn` at a steady rate even when the tab is in the background. */
function startTicker(ms: number, fn: () => void): () => void {
  const src = `setInterval(() => postMessage(0), ${ms});`;
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  worker.onmessage = fn;
  return () => worker.terminate();
}

export function hostGame(code: string, name: string, handlers: Handlers): Session {
  const peer = new Peer(ID_PREFIX + code, peerOptions());
  const game = new GameHost(code);
  const guests = new Map<DataConnection, number>();
  if (import.meta.env.DEV) Object.assign(window, { __host: game, __hostOffline: () => listener.disconnect() });
  let stopTicker: (() => void) | undefined;
  let mySlot = -1;
  /** The player the host's commands go to: the host, or one of their test opponents. */
  let controlSlot = -1;
  let ticks = 0;
  let closed = false;

  const toGuests = (make: (slot: number) => ServerMessage) => {
    for (const [conn, slot] of guests) if (conn.open) conn.send(make(slot));
  };
  const broadcast = (msg: ServerMessage) => {
    handlers.onMessage(msg);
    toGuests(() => msg);
  };
  const sendLobby = () => {
    handlers.onMessage(game.lobbyMessage(mySlot, mySlot));
    toGuests((slot) => game.lobbyMessage(slot, mySlot));
  };
  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    stopTicker?.();
    peer.destroy();
    if (listener !== peer) listener.destroy();
    handlers.onClose(reason);
  };

  /** When each guest was last heard from. */
  const heard = new Map<DataConnection, number>();
  peer.on('open', () => {
    // Also emitted again after the link to the matchmaking service came back: set up only once.
    if (mySlot >= 0) return;
    mySlot = controlSlot = game.join(name)!.slot;
    sendLobby();
    // A guest whose connection died without closing (a dead Wi-Fi) counts as away, so they can come back.
    setInterval(() => {
      if (closed) return;
      const now = Date.now();
      for (const [conn, t] of heard) {
        if (now - t < GUEST_SILENCE_MS || !guests.has(conn)) continue;
        heard.delete(conn);
        drops.get(conn)?.();
        conn.close();
      }
    }, 2000);
    stopTicker = startTicker(TICK_MS, () => {
      const snap = game.tick();
      if (snap) broadcast(snap);
      else if (++ticks % TICK_RATE === 0) toGuests(() => ({ t: 'ping' }));
    });
    // Closing the tab should disconnect guests right away.
    window.addEventListener('pagehide', () => peer.destroy());
  });

  const drops = new Map<DataConnection, () => void>();
  const accept = (conn: DataConnection) => {
    heard.set(conn, Date.now());
    conn.on('data', (data) => {
      const msg = data as ClientMessage;
      heard.set(conn, Date.now());
      if (!msg || typeof msg !== 'object' || msg.t === 'ping') return;
      const slot = guests.get(conn);
      if (msg.t === 'join' && slot === undefined) {
        // Someone who lost their connection coming back: their own place, and the game as it stands.
        const back = game.rejoin(msg.token);
        if (back) {
          // Their old connection, if the host still holds it, is dead: let it go quietly.
          for (const [other, s] of [...guests]) {
            if (s !== back.slot || other === conn) continue;
            guests.delete(other);
            heard.delete(other);
            other.close();
          }
          guests.set(conn, back.slot);
          conn.send(game.startMessage(back.slot));
          const tiles = game.catchUp();
          if (tiles) conn.send(tiles);
          conn.send(game.pauseMessage());
          broadcast(game.playersMessage());
          return;
        }
        const player = game.join(msg.name);
        if (player) game.bindToken(msg.token, player.slot);
        if (!player) {
          const message = game.state ? 'That game has already started.' : 'That game is full.';
          conn.send({ t: 'error', message } satisfies ServerMessage);
          return;
        }
        guests.set(conn, player.slot);
        sendLobby();
      } else if (msg.t === 'cmd' && slot !== undefined) {
        game.command(slot, msg.cmd);
      } else if (msg.t === 'chat' && slot !== undefined && cleanChat(msg.text)) {
        broadcast({ t: 'chat', from: slot, text: cleanChat(msg.text) });
      } else if (msg.t === 'team' && slot !== undefined) {
        game.setTeam(slot, msg.team);
        sendLobby();
      } else if (msg.t === 'pause' && slot !== undefined) {
        const news = game.answerPause(slot, msg.answer);
        if (news) broadcast(news);
      }
    });
    const drop = () => {
      const slot = guests.get(conn);
      if (slot === undefined) return;
      guests.delete(conn);
      if (game.state && game.state.winner < 0) {
        // During a game a lost connection is not leaving: the player's side stays, and they can come back.
        const news = game.setAway(slot);
        broadcast(game.playersMessage());
        if (news) broadcast(news);
        return;
      }
      game.leave(slot);
      if (game.state) {
        broadcast(game.playersMessage());
        broadcast(game.pauseMessage());
      }
      else sendLobby();
    };
    drops.set(conn, drop);
    conn.on('close', () => {
      drop();
      drops.delete(conn);
      heard.delete(conn);
    });
    conn.on('error', drop);
  };
  peer.on('connection', accept);

  // The link to the matchmaking service can drop while the game runs on (the connections to the guests
  // stay up). It is got back, so that anyone who lost their connection can find the game again: by
  // reconnecting, or, if the service has given the room's name away meanwhile, by signing in afresh
  // under it with a second listener (the old one keeps the guests already connected).
  let listener = peer;
  let tries = 0;
  const relisten = () => {
    if (closed) return;
    // A couple of plain reconnects first; if those fail, a fresh sign-in under the room's name.
    if (!listener.destroyed && listener.disconnected && tries++ < 2) {
      listener.reconnect();
      return;
    }
    if (!listener.destroyed && !listener.disconnected) {
      tries = 0;
      return;
    }
    if (listener !== peer) listener.destroy();
    tries = 0;
    if (!listener.destroyed && !listener.disconnected) return;
    const fresh = new Peer(ID_PREFIX + code, peerOptions());
    fresh.on('connection', accept);
    fresh.on('disconnected', () => setTimeout(relisten, 3000));
    fresh.on('error', () => setTimeout(relisten, 5000));
    listener = fresh;
  };
  peer.on('disconnected', () => setTimeout(relisten, 1500));
  peer.on('error', (err) => {
    // Once the game is set up, nothing here ends it: the room's name is taken back as soon as it can be.
    if (mySlot >= 0) return void setTimeout(relisten, 5000);
    if (err.type === 'unavailable-id') close('That room code is already in use. Pick another or join it.');
    else if (mySlot < 0) close('Could not reach the matchmaking service.');
    // Later errors (one guest failing to connect, a broker hiccup) do not end the game.
  });

  const isMine = (slot: number) => slot === mySlot || game.players.get(slot)?.test === true;

  return {
    send: (msg) => {
      if (msg.t === 'cmd' && controlSlot >= 0) game.command(controlSlot, msg.cmd);
      if (msg.t === 'chat' && mySlot >= 0) broadcast({ t: 'chat', from: mySlot, text: cleanChat(msg.text) });
      if (msg.t === 'pause' && mySlot >= 0) {
        const news = game.answerPause(mySlot, msg.answer);
        if (news) broadcast(news);
      }
    },
    close: () => close(''),
    host: {
      start() {
        if (game.state || mySlot < 0) return;
        game.start((Math.random() * 0xffffffff) >>> 0);
        controlSlot = mySlot;
        handlers.onMessage(game.startMessage(mySlot));
        toGuests((slot) => game.startMessage(slot));
      },
      backToLobby() {
        if (!game.state) return;
        game.backToLobby();
        controlSlot = mySlot;
        sendLobby();
      },
      addTestPlayer() {
        if (game.join('Test opponent', 'test')) sendLobby();
      },
      addComputer() {
        if (game.join('Computer', 'ai')) sendLobby();
      },
      removeExtra(slot) {
        const player = game.players.get(slot);
        if (game.state || !(player?.test || player?.ai)) return;
        game.leave(slot);
        sendLobby();
      },
      setTeam(slot, team) {
        game.setTeam(slot, team);
        sendLobby();
      },
      setLevel(slot, level) {
        game.setLevel(slot, level);
        sendLobby();
      },
      setPopLimit(limit) {
        if (game.state || !POP_LIMITS.includes(limit)) return;
        game.settings.popLimit = limit;
        sendLobby();
      },
      setMapSize(size) {
        if (game.state || !(size in MAP_SIZES)) return;
        game.settings.mapSize = size as keyof typeof MAP_SIZES;
        sendLobby();
      },
      setQuickStart(on) {
        if (game.state) return;
        game.settings.quick = on;
        sendLobby();
      },
      control(slot) {
        if (!isMine(slot)) return false;
        controlSlot = slot;
        return true;
      },
    },
  };
}

export function joinGame(code: string, name: string, handlers: Handlers): Session {
  const token = roomToken(code);
  let peer!: Peer;
  /** Tests only: a connection that has silently died. */
  let deaf: DataConnection | undefined;
  let conn: DataConnection | undefined;
  let closed = false;
  let joined = false;
  /** In a running game: a lost connection is then restored instead of ending things. */
  let playing = false;
  /** The room exists and the host answered the handshake, but the connection itself is not up yet. */
  let reached = false;
  /** Since when the connection has been lost, while trying to restore it. */
  let lostAt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastHeard = Date.now();
  // The host sends something at least every second, so silence means it is gone
  // (a closed tab does not always close the connection cleanly) or was never there.
  const watchdog = setInterval(() => {
    if (closed) return;
    // Tell the host this guest is still here (it lets go of guests who fall silent).
    if (conn?.open && conn !== deaf) conn.send({ t: 'ping' } satisfies ClientMessage);
    if (lostAt || Date.now() - lastHeard < SILENCE_LIMIT_MS) return;
    if (playing) return lost(`no word from the host for ${SILENCE_LIMIT_MS / 1000} s`);
    close(joined ? 'The host left the game.' : reached ? BLOCKED : 'No game with that code. Check the code or host a new game.');
  }, 1000);
  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    clearInterval(watchdog);
    clearTimeout(retry);
    peer.destroy();
    handlers.onClose(reason);
  };
  /**
   * The connection dropped during the game: keep trying to get back in, for as long as it takes
   * (the player can leave from the banner). The game goes on at the host meanwhile.
   */
  const lost = (why: string) => {
    if (closed) return;
    if (!playing) return close(reached && !joined ? BLOCKED : 'Connection to the host failed.');
    if (!lostAt) {
      lostAt = Date.now();
      console.warn(`Kingsfall: connection to the host lost (${why}); reconnecting.`);
      handlers.onReconnect?.(why);
    }
    clearTimeout(retry);
    retry = setTimeout(attempt, RECONNECT_EVERY_MS);
  };
  const attempt = () => {
    if (closed || !lostAt) return;
    conn?.close();
    conn = undefined;
    // Each try starts afresh with the matchmaking service, so a dead link to it never gets in the way.
    peer.destroy();
    peer = newPeer();
    // Try again a little later if this one gets nowhere (longer apart the longer it takes).
    retry = setTimeout(attempt, Math.min(20000, RECONNECT_EVERY_MS * 2 + (Date.now() - lostAt) / 10));
  };
  const connect = (p: Peer) => {
    const c = p.connect(ID_PREFIX + code, { reliable: true, serialization: 'json' });
    conn = c;
    // The host's browser answering at all means the code is right; a failure after that is the network.
    c.on('iceStateChanged', (state) => {
      if (c !== conn) return;
      if (state === 'checking' || state === 'connected') reached = true;
      if (state === 'failed' || (state === 'disconnected' && playing)) lost(`network ${state}`);
    });
    c.on('open', () => c.send({ t: 'join', name, token } satisfies ClientMessage));
    c.on('data', (data) => {
      if (c !== conn || c === deaf) return;
      const msg = data as ServerMessage;
      lastHeard = Date.now();
      // While coming back, a refusal means the host has not let go of the old connection yet: try again.
      if (msg.t === 'error') return lostAt ? lost('the host is still letting go of the old connection') : close(msg.message);
      joined = true;
      if (msg.t === 'start') playing = true;
      if (msg.t === 'lobby') playing = false;
      if (msg.t !== 'ping') handlers.onMessage(msg);
      // Told after the host's first message, which sets the game up again.
      if (lostAt) {
        lostAt = 0;
        clearTimeout(retry);
        console.info('Kingsfall: back in the game.');
        handlers.onReconnect?.(undefined);
      }
    });
    c.on('close', () => c === conn && (playing ? lost('connection closed') : close('The host left the game.')));
    c.on('error', () => c === conn && lost('connection error'));
  };
  const newPeer = (): Peer => {
    const p = new Peer(peerOptions());
    p.on('open', () => {
      if (p === peer && !conn) connect(p);
    });
    p.on('disconnected', () => {
      // Only the matchmaking link: the game connection itself may well still be up.
      if (!closed && p === peer && !p.destroyed) setTimeout(() => !closed && p === peer && p.disconnected && !p.destroyed && p.reconnect(), 1500);
    });
    p.on('error', (err) => {
      if (p !== peer) return;
      if (playing) return lost(`matchmaking: ${err.type}`);
      close(err.type === 'peer-unavailable' ? 'No game with that code. Check the code or host a new game.'
        : 'Could not reach the matchmaking service.');
    });
    return p;
  };
  peer = newPeer();
  // Tests only: drop the connection as a bad network would, or let it die silently (nothing gets through
  // either way, and nothing closes).
  if (import.meta.env.DEV) {
    Object.assign(window, {
      __dropConnection: () => conn?.peerConnection?.close(),
      __deafen: () => {
        deaf = conn;
      },
    });
  }

  return {
    send: (msg) => {
      if (conn?.open && conn !== deaf) conn.send(msg);
    },
    close: () => close(''),
  };
}
