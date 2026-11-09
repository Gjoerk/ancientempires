import { Peer, DataConnection, PeerOptions } from 'peerjs';
import { ClientMessage, GameHost, ServerMessage, TICK_MS } from '@kingsfall/shared';

// There is no game server. One player's browser hosts the game and the others
// connect to it directly over WebRTC. Only the initial handshake goes through
// a PeerJS broker (the public one unless VITE_PEER_HOST is set).

const ID_PREFIX = 'kingsfall-room-';
const SILENCE_LIMIT_MS = 8000;

export interface Session {
  send(msg: ClientMessage): void;
  close(): void;
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
  const game = new GameHost(code, (Math.random() * 0xffffffff) >>> 0);
  const guests = new Map<DataConnection, number>();
  let stopTicker: (() => void) | undefined;
  let mySlot = -1;
  let closed = false;

  const broadcast = (msg: ServerMessage) => {
    handlers.onMessage(msg);
    for (const conn of guests.keys()) if (conn.open) conn.send(msg);
  };
  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    stopTicker?.();
    peer.destroy();
    handlers.onClose(reason);
  };

  peer.on('open', () => {
    mySlot = game.join(name)!.slot;
    handlers.onMessage(game.welcome(mySlot));
    stopTicker = startTicker(TICK_MS, () => broadcast(game.tick()));
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
          conn.send({ t: 'error', message: 'That game is full.' } satisfies ServerMessage);
          return;
        }
        guests.set(conn, player.slot);
        conn.send(game.welcome(player.slot));
        broadcast(game.playersMessage());
      } else if (msg.t === 'cmd' && slot !== undefined) {
        game.command(slot, msg.cmd);
      }
    });
    const drop = () => {
      const slot = guests.get(conn);
      if (slot === undefined) return;
      guests.delete(conn);
      game.leave(slot);
      broadcast(game.playersMessage());
    };
    conn.on('close', drop);
    conn.on('error', drop);
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') close('That room code is already in use. Pick another or join it.');
    else if (mySlot < 0) close('Could not reach the matchmaking service.');
    // Later errors (one guest failing to connect, a broker hiccup) do not end the game.
  });

  return {
    send: (msg) => {
      if (msg.t === 'cmd' && mySlot >= 0) game.command(mySlot, msg.cmd);
    },
    close: () => close(''),
  };
}

export function joinGame(code: string, name: string, handlers: Handlers): Session {
  const peer = new Peer(peerOptions());
  let conn: DataConnection | undefined;
  let closed = false;
  let joined = false;
  let lastHeard = Date.now();
  // The host sends a snapshot every tick, so silence means it is gone (a closed
  // tab does not always close the connection cleanly) or was never there.
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
      joined = true;
      lastHeard = Date.now();
      handlers.onMessage(data as ServerMessage);
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
