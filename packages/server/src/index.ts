import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  applyCommand,
  ClientMessage,
  createGame,
  DEFAULT_PORT,
  EntitySnapshot,
  GameState,
  MAX_PLAYERS,
  PlayerInfo,
  removePlayer,
  ServerMessage,
  spawnPlayer,
  step,
  TICK_MS,
  UNIT_KINDS,
} from '@kingsfall/shared';

interface Room {
  code: string;
  state: GameState;
  clients: Map<WebSocket, PlayerInfo>;
  timer: NodeJS.Timeout;
}

const rooms = new Map<string, Room>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room: Room, msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of room.clients.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

function snapshot(state: GameState): EntitySnapshot[] {
  const round = (v: number) => Math.round(v * 100) / 100;
  return [...state.entities.values()].map((e) => [
    e.id, e.owner, UNIT_KINDS.indexOf(e.kind), round(e.x), round(e.y), e.hp, e.path.length > 0 ? 1 : 0,
  ]);
}

function getRoom(code: string): Room {
  let room = rooms.get(code);
  if (!room) {
    const state = createGame((Math.random() * 0xffffffff) >>> 0);
    const created: Room = {
      code,
      state,
      clients: new Map(),
      timer: setInterval(() => {
        step(state);
        broadcast(created, { t: 'snap', tick: state.tick, ents: snapshot(state) });
      }, TICK_MS),
    };
    rooms.set(code, created);
    room = created;
  }
  return room;
}

const http = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`kingsfall server, ${rooms.size} room(s)\n`);
});
const wss = new WebSocketServer({ server: http, maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  let room: Room | undefined;
  let me: PlayerInfo | undefined;

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === 'join' && !room) {
      const code = String(msg.room ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (!code) return send(ws, { t: 'error', message: 'Room code is missing.' });
      const target = getRoom(code);
      const taken = new Set([...target.clients.values()].map((p) => p.slot));
      let slot = 0;
      while (taken.has(slot)) slot++;
      if (slot >= MAX_PLAYERS) return send(ws, { t: 'error', message: 'That room is full.' });
      room = target;
      me = { slot, name: String(msg.name ?? '').trim().slice(0, 16) || `Player ${slot + 1}` };
      room.clients.set(ws, me);
      spawnPlayer(room.state, slot);
      const players = [...room.clients.values()];
      send(ws, { t: 'welcome', you: slot, room: code, seed: room.state.seed, players });
      broadcast(room, { t: 'players', players });
    } else if (msg.t === 'cmd' && room && me && msg.cmd) {
      applyCommand(room.state, me.slot, msg.cmd);
    }
  });

  ws.on('close', () => {
    if (!room || !me) return;
    room.clients.delete(ws);
    removePlayer(room.state, me.slot);
    if (room.clients.size === 0) {
      clearInterval(room.timer);
      rooms.delete(room.code);
    } else {
      broadcast(room, { t: 'players', players: [...room.clients.values()] });
    }
  });
});

const port = Number(process.env.PORT) || DEFAULT_PORT;
http.listen(port, () => console.log(`kingsfall server listening on :${port}`));
