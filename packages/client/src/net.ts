import { Peer, DataConnection, PeerOptions } from 'peerjs';
import { ClientMessage, GameHost, MAP_SIZES, ServerMessage, TICK_MS, TICK_RATE } from '@kingsfall/shared';

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
  setQuickStart(on: boolean): void;
  setMapSize(size: string): void;
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
}

function peerOptions(): PeerOptions {
  const host = import.meta.env.VITE_PEER_HOST as string | undefined;
  if (!host) return {};
  return {
    host,
    port: Number(import.meta.env.VITE_PEER_PORT) || 443,
    path: (import.meta.env.VITE_PEER_PATH as string | undefined) ?? '/',
    secure: import.meta.env.VITE_PEER_SECURE !== 'false',
  };
}

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
  if (import.meta.env.DEV) Object.assign(window, { __host: game });
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
    handlers.onClose(reason);
  };

  peer.on('open', () => {
    mySlot = controlSlot = game.join(name)!.slot;
    sendLobby();
    stopTicker = startTicker(TICK_MS, () => {
      const snap = game.tick();
      if (snap) broadcast(snap);
      else if (++ticks % TICK_RATE === 0) toGuests(() => ({ t: 'ping' }));
    });
    // Closing the tab should disconnect guests right away.
    window.addEventListener('pagehide', () => peer.destroy());
  });

  peer.on('connection', (conn) => {
    conn.on('data', (data) => {
      const msg = data as ClientMessage;
      if (!msg || typeof msg !== 'object') return;
      const slot = guests.get(conn);
      if (msg.t === 'join' && slot === undefined) {
        const player = game.join(msg.name);
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
      }
    });
    const drop = () => {
      const slot = guests.get(conn);
      if (slot === undefined) return;
      guests.delete(conn);
      game.leave(slot);
      if (game.state) broadcast(game.playersMessage());
      else sendLobby();
    };
    conn.on('close', drop);
    conn.on('error', drop);
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') close('That room code is already in use. Pick another or join it.');
    else if (mySlot < 0) close('Could not reach the matchmaking service.');
    // Later errors (one guest failing to connect, a broker hiccup) do not end the game.
  });

  const isMine = (slot: number) => slot === mySlot || game.players.get(slot)?.test === true;

  return {
    send: (msg) => {
      if (msg.t === 'cmd' && controlSlot >= 0) game.command(controlSlot, msg.cmd);
      if (msg.t === 'chat' && mySlot >= 0) broadcast({ t: 'chat', from: mySlot, text: cleanChat(msg.text) });
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
  const peer = new Peer(peerOptions());
  let conn: DataConnection | undefined;
  let closed = false;
  let joined = false;
  let lastHeard = Date.now();
  // The host sends something at least every second, so silence means it is gone
  // (a closed tab does not always close the connection cleanly) or was never there.
  const watchdog = setInterval(() => {
    if (Date.now() - lastHeard < SILENCE_LIMIT_MS) return;
    close(joined ? 'The host left the game.' : 'No game with that code. Check the code or host a new game.');
  }, 1000);
  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    clearInterval(watchdog);
    peer.destroy();
    handlers.onClose(reason);
  };

  peer.on('open', () => {
    const c = peer.connect(ID_PREFIX + code, { reliable: true, serialization: 'json' });
    conn = c;
    c.on('open', () => c.send({ t: 'join', name } satisfies ClientMessage));
    c.on('data', (data) => {
      const msg = data as ServerMessage;
      lastHeard = Date.now();
      if (msg.t === 'error') return close(msg.message);
      joined = true;
      if (msg.t !== 'ping') handlers.onMessage(msg);
    });
    c.on('close', () => close('The host left the game.'));
    c.on('error', () => close('Connection to the host failed.'));
  });
  peer.on('error', (err) => {
    close(err.type === 'peer-unavailable' ? 'No game with that code. Check the code or host a new game.'
      : 'Could not reach the matchmaking service.');
  });

  return {
    send: (msg) => {
      if (conn?.open) conn.send(msg);
    },
    close: () => close(''),
  };
}
