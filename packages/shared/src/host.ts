import { DEFS, FALLOW_SECONDS, isTech, KINDS, POP_MAX, QUEUE_ITEMS, RESOURCES, TECH_IDS, TECHS } from './defs';
import { MAP_SIZES, MAX_PLAYERS, MAX_TEAMS } from './map';
import { runAi } from './ai';
import type { EntitySnapshot, GameSettings, PlayerInfo, QueueSnapshot, ServerMessage } from './protocol';
import { activityOf, FORMATIONS, countInside, hasKingInside, taskOf, addPlayer, applyCommand, Command, createGame, GameState, placeRelics, removePlayer, step, TICK_RATE } from './sim';

/**
 * The authoritative game for one room. It knows nothing about networking:
 * whoever hosts (currently one player's browser) feeds it joins and commands
 * and forwards the messages it returns.
 */
export class GameHost {
  /** The running game, or undefined while the room waits in the lobby. */
  state: GameState | undefined;
  readonly players = new Map<number, PlayerInfo>();
  readonly settings: GameSettings = { quick: false, mapSize: 'medium', popLimit: POP_MAX };

  /**
   * A pause everyone has to agree to: 'asking' while the others decide, then 'paused' until
   * everyone has pressed continue. `agreed` holds who has answered yes in the current phase.
   */
  pause: { phase: 'asking' | 'paused'; by: number; agreed: Set<number> } | undefined;

  constructor(readonly room: string) {}

  /** The people who have to agree: everyone but computer and stand-in opponents. */
  private voters(): number[] {
    return [...this.players.values()].filter((p) => !p.ai && !p.test).map((p) => p.slot);
  }

  pauseMessage(declinedBy = -1): ServerMessage {
    const p = this.pause;
    if (!p) return { t: 'pause', phase: 'off', by: -1, waiting: [], declinedBy };
    return { t: 'pause', phase: p.phase, by: p.by, waiting: this.voters().filter((slot) => !p.agreed.has(slot)), declinedBy };
  }

  /**
   * A player asks for a pause, answers someone's request, or says they are ready to go on.
   * Returns the message telling everyone where things stand, or nothing if it changed nothing.
   */
  answerPause(slot: number, answer: unknown): ServerMessage | undefined {
    if (!this.state || this.state.winner >= 0 || !this.voters().includes(slot)) return undefined;
    const p = this.pause;
    if (answer === 'request' && !p) {
      this.pause = { phase: 'asking', by: slot, agreed: new Set([slot]) };
    } else if (answer === 'yes' && p) {
      p.agreed.add(slot);
    } else if (answer === 'no' && p?.phase === 'asking') {
      this.pause = undefined;
      return this.pauseMessage(slot);
    } else {
      return undefined;
    }
    return this.settlePause();
  }

  /** Moves the pause on once everyone has agreed (also after someone leaves). */
  private settlePause(): ServerMessage {
    const p = this.pause;
    if (p && this.voters().every((slot) => p.agreed.has(slot))) {
      if (p.phase === 'asking') this.pause = { phase: 'paused', by: p.by, agreed: new Set() };
      else this.pause = undefined;
    }
    return this.pauseMessage();
  }

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
    if (this.pause) this.settlePause();
  }

  setTeam(slot: number, team: number): void {
    const player = this.players.get(slot);
    if (player && !this.state && Number.isInteger(team) && team >= 0 && team < MAX_TEAMS) player.team = team;
  }

  /** Starts a fresh game with everyone who is in the lobby. */
  start(seed: number): void {
    this.state = createGame(seed, MAP_SIZES[this.settings.mapSize], this.settings.popLimit);
    for (const slot of [...this.players.keys()].sort()) addPlayer(this.state, slot, this.players.get(slot)!.team, this.settings.quick);
    placeRelics(this.state);
    this.pause = undefined;
  }

  /** Ends the running game and sends everyone back to the lobby. */
  backToLobby(): void {
    this.state = undefined;
    this.pause = undefined;
  }

  command(slot: number, cmd: Command): void {
    if (this.state && this.pause?.phase !== 'paused' && this.players.has(slot) && cmd && typeof cmd === 'object') applyCommand(this.state, slot, cmd);
  }

  lobbyMessage(you: number, host: number): ServerMessage {
    return { t: 'lobby', you, host, room: this.room, players: [...this.players.values()], settings: { ...this.settings } };
  }

  startMessage(you: number): ServerMessage {
    return { t: 'start', you, room: this.room, seed: this.state!.seed, size: this.state!.map.size, popLimit: this.state!.popLimit, players: [...this.players.values()] };
  }

  playersMessage(): ServerMessage {
    return { t: 'players', players: [...this.players.values()] };
  }

  /** Advances the game one tick and returns the snapshot to send to everyone (nothing while in the lobby). */
  tick(): ServerMessage | undefined {
    const s = this.state;
    // Paused, or over: once there is a winner the game stands still.
    if (!s || this.pause?.phase === 'paused' || s.winner >= 0) return undefined;
    // Computer opponents think about once a second, each on its own tick.
    for (const player of this.players.values()) if (player.ai && (s.tick + player.slot * 3) % 10 === 0) runAi(s, player.slot);
    step(s);
    const round = (v: number) => Math.round(v * 100) / 100;
    const ents: EntitySnapshot[] = [];
    const queues: QueueSnapshot[] = [];
    const rallies: [number, number, number][] = [];
    const mask = (set: Set<string>) => TECH_IDS.reduce((m, id, i) => (set.has(id) ? m | (1 << i) : m), 0);
    const workers = new Map<number, Record<string, number>>();
    // Fields someone is assigned to, coming and going included.
    const farmed = new Set<number>();
    for (const e of s.entities.values()) if (e.order.t === 'gather' && e.order.farm >= 0) farmed.add(e.order.farm);
    for (const e of s.entities.values()) {
      if (e.order.t === 'gather') {
        const count = workers.get(e.owner) ?? {};
        count[e.order.res] = (count[e.order.res] ?? 0) + 1;
        workers.set(e.owner, count);
      }
      if (e.inside >= 0) continue;
      const building = DEFS[e.kind].building;
      // Buildings that shelter units report 1 when someone is inside and 2 more when it is the king, and how many.
      const inside = building && DEFS[e.kind].garrison ? countInside(s, e) : 0;
      const [task, target] = building
        ? e.kind === 'farm'
          ? [(farmed.has(e.id) ? 1 : 0) | (e.fallow !== undefined ? 2 : 0),
            e.fallow !== undefined ? Math.ceil(FALLOW_SECONDS - (s.tick - e.fallow) / TICK_RATE) : e.carry]
          : [(inside > 0 ? 1 : 0) | (hasKingInside(s, e) ? 2 : 0), inside]
        : taskOf(e);
      ents.push([
        e.id, e.owner, KINDS.indexOf(e.kind), round(e.x), round(e.y), Math.ceil(e.hp), activityOf(e),
        // Units: carried amount + 100 * resource + 1000 * building sites still queued.
        building ? Math.floor(e.progress * 100) : e.carry + 100 * RESOURCES.indexOf(e.carryRes) + 1000 * Math.min(9, e.tasks?.length ?? 0) + (e.stance === 'defensive' ? 10000 : 0) + 20000 * FORMATIONS.indexOf(e.formation ?? 'line'),
        task, target,
      ]);
      if (e.queue.length > 0) {
        const first = e.queue[0];
        const time = isTech(first) ? TECHS[first].time : DEFS[first as (typeof KINDS)[number]].time;
        queues.push([e.id, Math.floor((e.trainTicks / (time * TICK_RATE)) * 100), ...e.queue.map((k) => QUEUE_ITEMS.indexOf(k))]);
      }
      if (e.rally) rallies.push([e.id, e.rally[0], e.rally[1]]);
    }
    // The deaths go out with this snapshot; whatever dies from now on goes in the next one.
    const deaths = s.deaths;
    s.deaths = [];
    return {
      t: 'snap', tick: s.tick, ents, queues,
      players: [...s.players.values()].map((p) => [
        p.slot, p.res.food, p.res.wood, p.res.gold, p.res.stone, p.pop, p.cap, p.defeated ? 1 : 0,
        p.age, mask(p.techs), mask(p.researching), ...RESOURCES.map((r) => workers.get(p.slot)?.[r] ?? 0),
        // Whether the town bell has called the villagers in.
        [...s.entities.values()].some((e) => e.owner === p.slot && e.recall) ? 1 : 0,
      ]),
      blessings: s.blessings,
      relics: s.relics.map((r) => [round(r.x), round(r.y), r.carrier, r.monastery, r.foundBy]),
      tiles: s.tileEvents, amounts: [...s.amountEvents], shots: s.shots, hits: s.hits, deaths, rallies, winner: s.winner,
    };
  }
}
