import { DEFS, KINDS } from './defs';
import { MAX_PLAYERS } from './map';
import type { EntitySnapshot, PlayerInfo, QueueSnapshot, ServerMessage } from './protocol';
import { activityOf, addPlayer, applyCommand, Command, createGame, GameState, removePlayer, step, TICK_RATE } from './sim';

/**
 * The authoritative game for one room. It knows nothing about networking:
 * whoever hosts (currently one player's browser) feeds it joins and commands
 * and forwards the messages it returns.
 */
export class GameHost {
  readonly state: GameState;
  readonly players = new Map<number, PlayerInfo>();

  constructor(readonly room: string, seed: number) {
    this.state = createGame(seed);
  }

  /** Adds a player and returns them, or undefined when the room is full. */
  join(name: unknown): PlayerInfo | undefined {
    let slot = 0;
    while (this.players.has(slot)) slot++;
    if (slot >= MAX_PLAYERS) return undefined;
    const clean = (typeof name === 'string' ? name : '').trim().slice(0, 16);
    const player = { slot, name: clean || `Player ${slot + 1}` };
    this.players.set(slot, player);
    addPlayer(this.state, slot);
    return player;
  }

  leave(slot: number): void {
    if (this.players.delete(slot)) removePlayer(this.state, slot);
  }

  command(slot: number, cmd: Command): void {
    if (this.players.has(slot) && cmd && typeof cmd === 'object') applyCommand(this.state, slot, cmd);
  }

  welcome(slot: number): ServerMessage {
    return {
      t: 'welcome', you: slot, room: this.room, seed: this.state.seed,
      players: [...this.players.values()], tiles: [...this.state.changedTiles],
    };
  }

  playersMessage(): ServerMessage {
    return { t: 'players', players: [...this.players.values()] };
  }

  /** Advances the game one tick and returns the snapshot to send to everyone. */
  tick(): ServerMessage {
    const s = this.state;
    step(s);
    const round = (v: number) => Math.round(v * 100) / 100;
    const ents: EntitySnapshot[] = [];
    const queues: QueueSnapshot[] = [];
    for (const e of s.entities.values()) {
      const building = DEFS[e.kind].building;
      ents.push([
        e.id, e.owner, KINDS.indexOf(e.kind), round(e.x), round(e.y), Math.ceil(e.hp), activityOf(e),
        building ? Math.floor(e.progress * 100) : e.carry,
      ]);
      if (e.queue.length > 0) {
        const pct = Math.floor((e.trainTicks / (DEFS[e.queue[0]].time * TICK_RATE)) * 100);
        queues.push([e.id, pct, ...e.queue.map((k) => KINDS.indexOf(k))]);
      }
    }
    return {
      t: 'snap', tick: s.tick, ents, queues,
      players: [...s.players.values()].map((p) => [
        p.slot, p.res.food, p.res.wood, p.res.gold, p.res.stone, p.pop, p.cap, p.defeated ? 1 : 0,
      ]),
      tiles: s.tileEvents, shots: s.shots, winner: s.winner,
    };
  }
}
