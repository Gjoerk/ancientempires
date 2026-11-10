import { DEFS, isTech, KINDS, QUEUE_ITEMS, RESOURCES, TECH_IDS, TECHS } from './defs';
import { MAX_PLAYERS } from './map';
import { runAi } from './ai';
import type { EntitySnapshot, GameSettings, PlayerInfo, QueueSnapshot, ServerMessage } from './protocol';
import { activityOf, hasKingInside, taskOf, addPlayer, applyCommand, Command, createGame, GameState, removePlayer, step, TICK_RATE } from './sim';

/**
 * The authoritative game for one room. It knows nothing about networking:
 * whoever hosts (currently one player's browser) feeds it joins and commands
 * and forwards the messages it returns.
 */
export class GameHost {
  /** The running game, or undefined while the room waits in the lobby. */
  state: GameState | undefined;
  readonly players = new Map<number, PlayerInfo>();
  readonly settings: GameSettings = { quick: false };

  constructor(readonly room: string) {}

  /**
   * Adds a player to the lobby. Returns undefined when the room is full or the game is running.
   * `kind` makes a stand-in the host plays themselves ('test') or a computer opponent ('ai').
   */
  join(name: unknown, kind?: 'test' | 'ai'): PlayerInfo | undefined {
    if (this.state) return undefined;
    let slot = 0;
    while (this.players.has(slot)) slot++;
    if (slot >= MAX_PLAYERS) return undefined;
    const clean = (typeof name === 'string' ? name : '').trim().slice(0, 16);
    const player: PlayerInfo = { slot, name: clean || `Player ${slot + 1}`, team: slot };
    if (kind === 'test') player.test = true;
    if (kind === 'ai') player.ai = true;
    this.players.set(slot, player);
    return player;
  }

  leave(slot: number): void {
    if (this.players.delete(slot) && this.state) removePlayer(this.state, slot);
  }

  setTeam(slot: number, team: number): void {
    const player = this.players.get(slot);
    if (player && !this.state && Number.isInteger(team) && team >= 0 && team < MAX_PLAYERS) player.team = team;
  }

  /** Starts a fresh game with everyone who is in the lobby. */
  start(seed: number): void {
    this.state = createGame(seed);
    for (const slot of [...this.players.keys()].sort()) addPlayer(this.state, slot, this.players.get(slot)!.team, this.settings.quick);
  }

  /** Ends the running game and sends everyone back to the lobby. */
  backToLobby(): void {
    this.state = undefined;
  }

  command(slot: number, cmd: Command): void {
    if (this.state && this.players.has(slot) && cmd && typeof cmd === 'object') applyCommand(this.state, slot, cmd);
  }

  lobbyMessage(you: number, host: number): ServerMessage {
    return { t: 'lobby', you, host, room: this.room, players: [...this.players.values()], settings: { ...this.settings } };
  }

  startMessage(you: number): ServerMessage {
    return { t: 'start', you, room: this.room, seed: this.state!.seed, players: [...this.players.values()] };
  }

  playersMessage(): ServerMessage {
    return { t: 'players', players: [...this.players.values()] };
  }

  /** Advances the game one tick and returns the snapshot to send to everyone (nothing while in the lobby). */
  tick(): ServerMessage | undefined {
    const s = this.state;
    if (!s) return undefined;
    // Computer opponents think about once a second, each on its own tick.
    for (const player of this.players.values()) if (player.ai && (s.tick + player.slot * 3) % 10 === 0) runAi(s, player.slot);
    step(s);
    const round = (v: number) => Math.round(v * 100) / 100;
    const ents: EntitySnapshot[] = [];
    const queues: QueueSnapshot[] = [];
    const rallies: [number, number, number][] = [];
    const mask = (set: Set<string>) => TECH_IDS.reduce((m, id, i) => (set.has(id) ? m | (1 << i) : m), 0);
    for (const e of s.entities.values()) {
      if (e.inside >= 0) continue;
      const building = DEFS[e.kind].building;
      const [task, target] = building ? [e.kind === 'castle' && hasKingInside(s, e) ? 1 : 0, 0] : taskOf(e);
      ents.push([
        e.id, e.owner, KINDS.indexOf(e.kind), round(e.x), round(e.y), Math.ceil(e.hp), activityOf(e),
        building ? Math.floor(e.progress * 100) : e.carry + 100 * RESOURCES.indexOf(e.carryRes),
        task, target,
      ]);
      if (e.queue.length > 0) {
        const first = e.queue[0];
        const time = isTech(first) ? TECHS[first].time : DEFS[first as (typeof KINDS)[number]].time;
        queues.push([e.id, Math.floor((e.trainTicks / (time * TICK_RATE)) * 100), ...e.queue.map((k) => QUEUE_ITEMS.indexOf(k))]);
      }
      if (e.rally) rallies.push([e.id, e.rally[0], e.rally[1]]);
    }
    return {
      t: 'snap', tick: s.tick, ents, queues,
      players: [...s.players.values()].map((p) => [
        p.slot, p.res.food, p.res.wood, p.res.gold, p.pop, p.cap, p.defeated ? 1 : 0,
        p.age, mask(p.techs), mask(p.researching),
      ]),
      tiles: s.tileEvents, shots: s.shots, hits: s.hits, deaths: s.deaths, rallies, winner: s.winner,
    };
  }
}
