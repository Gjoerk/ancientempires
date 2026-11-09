import { MAX_PLAYERS } from './map';
import type { EntitySnapshot, PlayerInfo, ServerMessage } from './protocol';
import { applyCommand, Command, createGame, GameState, removePlayer, spawnPlayer, step, UNIT_KINDS } from './sim';

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
    spawnPlayer(this.state, slot);
    return player;
  }

  leave(slot: number): void {
    if (this.players.delete(slot)) removePlayer(this.state, slot);
  }

  command(slot: number, cmd: Command): void {
    if (this.players.has(slot) && cmd && typeof cmd === 'object') applyCommand(this.state, slot, cmd);
  }

  welcome(slot: number): ServerMessage {
    return { t: 'welcome', you: slot, room: this.room, seed: this.state.seed, players: [...this.players.values()] };
  }

  playersMessage(): ServerMessage {
    return { t: 'players', players: [...this.players.values()] };
  }

  /** Advances the game one tick and returns the snapshot to send to everyone. */
  tick(): ServerMessage {
    step(this.state);
    const round = (v: number) => Math.round(v * 100) / 100;
    const ents: EntitySnapshot[] = [...this.state.entities.values()].map((e) => [
      e.id, e.owner, UNIT_KINDS.indexOf(e.kind), round(e.x), round(e.y), e.hp, e.path.length > 0 ? 1 : 0,
    ]);
    return { t: 'snap', tick: this.state.tick, ents };
  }
}
