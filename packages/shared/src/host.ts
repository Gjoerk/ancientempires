import { DEFS, FALLOW_SECONDS, isTech, KINDS, POP_MAX, QUEUE_ITEMS, RESOURCES, TECH_IDS, TECHS } from './defs';
import { generateMap, MAP_SIZES, MAX_PLAYERS, MAX_TEAMS } from './map';
import { AI_LEVELS, AI_STYLES, AiLevel, runAi } from './ai';
import type { EntitySnapshot, GameSettings, PlayerInfo, QueueSnapshot, ServerMessage } from './protocol';
import { activityOf, FORMATIONS, countInside, hasKingInside, taskOf, addPlayer, applyCommand, Command, createGame, GameState, placeRelics, removePlayer, step, TICK_RATE } from './sim';

/**
 * The authoritative game for one room. It knows nothing about networking:
 * whoever hosts (currently one player's browser) feeds it joins and commands
 * and forwards the messages it returns.
 */
/** A byte array as [value, how many, value, how many, ...]: short for the mostly empty building marks. */
function runs(a: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; ) {
    let j = i;
    while (j < a.length && a[j] === a[i]) j++;
    out.push(a[i], j - i);
    i = j;
  }
  return out;
}
function unruns(r: number[], into: Uint8Array): void {
  let at = 0;
  for (let k = 0; k < r.length; k += 2) {
    into.fill(r[k], at, at + r[k + 1]);
    at += r[k + 1];
  }
}

/** An update goes out every this many game steps (5 a second); the screens smooth the movement in between. */
export const SNAP_EVERY = 2;
export const SNAP_MS = 1000 / TICK_RATE * SNAP_EVERY;
/** A full update, everything included, every 10 s: a safety net. */
const KEYFRAME_TICKS = 10 * TICK_RATE;

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

  /** Each guest's key for the room (see ClientMessage join), so they can come back after losing their connection. */
  tokens = new Map<string, number>();

  /** The people who have to agree: everyone but computer and stand-in opponents, and those who are away. */
  private voters(): number[] {
    return [...this.players.values()].filter((p) => !p.ai && !p.test && !p.away).map((p) => p.slot);
  }

  /** Keys of players the host removed: they cannot come back with them. */
  banned = new Set<string>();
  ban(slot: number): void {
    for (const [token, s] of [...this.tokens]) {
      if (s !== slot) continue;
      this.banned.add(token);
      this.tokens.delete(token);
    }
  }
  isBanned(token: unknown): boolean {
    return typeof token === 'string' && this.banned.has(token);
  }

  /** Remembers whose key `token` is. */
  bindToken(token: unknown, slot: number): void {
    if (typeof token === 'string' && token.length >= 8 && token.length <= 64) this.tokens.set(token, slot);
  }

  /** Someone coming back into the running game with their key: their player. */
  rejoin(token: unknown): PlayerInfo | undefined {
    if (!this.state || typeof token !== 'string') return undefined;
    const slot = this.tokens.get(token);
    const player = slot === undefined ? undefined : this.players.get(slot);
    // Also when the host has not noticed yet that their old connection died: the key is proof enough.
    if (!player || player.ai || player.test) return undefined;
    player.away = false;
    return player;
  }

  /** A player lost their connection in the running game: their side stays, waiting for them. */
  setAway(slot: number): ServerMessage | undefined {
    const player = this.players.get(slot);
    if (!player || !this.state) return undefined;
    player.away = true;
    return this.pause ? this.settlePause() : undefined;
  }

  /** Every tile that differs from the start of the game, for someone coming back in. */
  catchUp(): ServerMessage | undefined {
    if (!this.state) return undefined;
    const start = generateMap(this.state.seed, this.state.map.size);
    const now = this.state.map;
    const tiles: [number, number, number][] = [];
    for (let i = 0; i < now.tiles.length; i++) {
      if (now.tiles[i] !== start.tiles[i] || now.amount[i] !== start.amount[i]) tiles.push([i, now.tiles[i], now.amount[i]]);
    }
    return { t: 'catchup', tiles };
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
  settlePause(): ServerMessage {
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
    if (kind === 'ai') {
      player.ai = true;
      player.level = 'normal';
    }
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

  private playerRows(s: GameState, workers: Map<number, Record<string, number>>, mask: (set: Set<string>) => number): number[][] {
    return [...s.players.values()].map((p) => [
      p.slot, p.res.food, p.res.wood, p.res.gold, p.res.stone, p.pop, p.cap, p.defeated ? 1 : 0,
      p.age, mask(p.techs), mask(p.researching), ...RESOURCES.map((r) => workers.get(p.slot)?.[r] ?? 0),
      // Whether the town bell has called the villagers in.
      [...s.entities.values()].some((e) => e.owner === p.slot && e.recall) ? 1 : 0,
    ]);
  }

  /** How well a computer opponent plays. */
  setLevel(slot: number, level: unknown): void {
    const player = this.players.get(slot);
    if (player?.ai && !this.state && AI_LEVELS.includes(level as AiLevel)) player.level = level as AiLevel;
  }

  /** Starts a fresh game with everyone who is in the lobby. */
  start(seed: number): void {
    this.state = createGame(seed, MAP_SIZES[this.settings.mapSize], this.settings.popLimit);
    for (const slot of [...this.players.keys()].sort()) {
      const info = this.players.get(slot)!;
      addPlayer(this.state, slot, info.team, this.settings.quick);
      // A hard computer gathers a little faster.
      if (info.ai) this.state.players.get(slot)!.gather = AI_STYLES[info.level ?? 'normal'].gather;
    }
    placeRelics(this.state);
    this.pause = undefined;
    this.sent.clear();
  }

  /** Ends the running game and sends everyone back to the lobby. */
  backToLobby(): void {
    this.state = undefined;
    this.pause = undefined;
    // Whoever is still away when the game ends is gone.
    for (const [slot, p] of [...this.players]) if (p.away) this.players.delete(slot);
  }

  command(slot: number, cmd: Command): void {
    if (this.state && this.pause?.phase !== 'paused' && this.players.has(slot) && cmd && typeof cmd === 'object') applyCommand(this.state, slot, cmd);
  }

  /**
   * The whole game as text, for the players who would take over if the host vanished (see fromBackup).
   * Map tiles are sent as their changes from the generated map; building marks are run-length coded.
   */
  backup(): string | undefined {
    const s = this.state;
    if (!s) return undefined;
    const start = generateMap(s.seed, s.map.size);
    const tiles: [number, number, number][] = [];
    for (let i = 0; i < s.map.tiles.length; i++) {
      if (s.map.tiles[i] !== start.tiles[i] || s.map.amount[i] !== start.amount[i]) tiles.push([i, s.map.tiles[i], s.map.amount[i]]);
    }
    const { map, tileEvents, amountEvents, shots, hits, deaths, blessings, occupied, changedTiles, ...rest } = s;
    void tileEvents; void amountEvents; void shots; void hits; void deaths; void blessings; void occupied;
    const data = {
      v: 1, room: this.room, settings: this.settings, players: [...this.players.values()], tokens: [...this.tokens], banned: [...this.banned],
      state: rest, changed: [...changedTiles],
      map: { size: map.size, version: map.version, tiles, blocked: runs(map.blocked), footprint: runs(map.footprint), gate: runs(map.gate) },
    };
    return JSON.stringify(data, (_, v) => (v instanceof Map ? { $map: [...v] } : v instanceof Set ? { $set: [...v] } : v));
  }

  /** A host for the game in a backup: to carry on where it was. */
  static fromBackup(text: string): GameHost {
    const data = JSON.parse(text, (_, v) => (v && typeof v === 'object' && '$map' in v ? new Map(v.$map) : v && typeof v === 'object' && '$set' in v ? new Set(v.$set) : v));
    const host = new GameHost(data.room);
    Object.assign(host.settings, data.settings);
    for (const p of data.players as PlayerInfo[]) host.players.set(p.slot, p);
    host.tokens = new Map(data.tokens);
    host.banned = new Set(data.banned ?? []);
    const map = generateMap(data.state.seed, data.map.size);
    for (const [i, tile, amount] of data.map.tiles as [number, number, number][]) {
      map.tiles[i] = tile;
      map.amount[i] = amount;
    }
    unruns(data.map.blocked, map.blocked);
    unruns(data.map.footprint, map.footprint);
    unruns(data.map.gate, map.gate);
    map.version = data.map.version + 1;
    host.state = {
      ...data.state, map, changedTiles: new Map(data.changed), tileEvents: [], amountEvents: new Map(), shots: [], hits: [], deaths: [], blessings: [], occupied: new Map(),
    } as GameState;
    return host;
  }

  /** The names of those watching (spectators take no part in the game itself). */
  watching: string[] = [];

  lobbyMessage(you: number, host: number): ServerMessage {
    return { t: 'lobby', you, host, room: this.room, players: [...this.players.values()], settings: { ...this.settings }, watching: [...this.watching] };
  }

  startMessage(you: number): ServerMessage {
    return { t: 'start', you, room: this.room, seed: this.state!.seed, size: this.state!.map.size, popLimit: this.state!.popLimit, players: [...this.players.values()],
      watching: [...this.watching] };
  }

  playersMessage(): ServerMessage {
    return { t: 'players', players: [...this.players.values()], watching: [...this.watching] };
  }

  /** Advances the game one tick and returns the snapshot to send to everyone (nothing while in the lobby). */
  /** What each entity looked like in the last update sent, to send only what changed. */
  private sent = new Map<number, string>();
  /** The events of the game steps since the last update. */
  private pending = { tiles: [] as [number, number][], amounts: new Map<number, number>(), shots: [] as [number, number][], hits: [] as [number, number][], blessings: [] as [number, number, number][] };

  /**
   * Advances the game one step (10 a second). Every SNAP_EVERY steps, and at the end, returns the
   * update to send to everyone: only what changed since the last one, with the events in between;
   * a full one every KEYFRAME_TICKS. Returns nothing in between, in the lobby, paused or after the end.
   */
  tick(): ServerMessage | undefined {
    const s = this.state;
    // Paused, or over: once there is a winner the game stands still.
    if (!s || this.pause?.phase === 'paused' || s.winner >= 0) return undefined;
    // Computer opponents think about once a second, each on its own tick.
    for (const player of this.players.values()) {
      if (!player.ai) continue;
      const level = player.level ?? 'normal';
      if ((s.tick + player.slot * 3) % AI_STYLES[level].every === 0) runAi(s, player.slot, level);
    }
    step(s);
    const p = this.pending;
    p.tiles.push(...s.tileEvents);
    for (const [i, a] of s.amountEvents) p.amounts.set(i, a);
    p.shots.push(...s.shots);
    p.hits.push(...s.hits);
    p.blessings.push(...s.blessings);
    if (s.tick % SNAP_EVERY !== 0 && s.winner < 0) return undefined;
    return this.snapshot(s.tick % KEYFRAME_TICKS === 0);
  }

  /** The update for everyone (see tick), or with `full` everything as it is, for someone just coming in. */
  snapshot(full: boolean, forNewcomer = false): ServerMessage | undefined {
    const s = this.state;
    if (!s) return undefined;
    const round = (v: number) => Math.round(v * 100) / 100;
    const ents: EntitySnapshot[] = [];
    const queues: QueueSnapshot[] = [];
    const rallies: [number, number, number][] = [];
    const mask = (set: Set<string>) => TECH_IDS.reduce((m, id, i) => (set.has(id) ? m | (1 << i) : m), 0);
    const workers = new Map<number, Record<string, number>>();
    // Fields someone is assigned to, coming and going included.
    const farmed = new Set<number>();
    const live = new Set<number>();
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
      const ent: EntitySnapshot = [
        e.id, e.owner, KINDS.indexOf(e.kind), round(e.x), round(e.y), Math.ceil(e.hp), activityOf(e),
        // Units: carried amount + 100 * resource + 1000 * building sites still queued.
        building ? Math.floor(e.progress * 100) : e.carry + 100 * RESOURCES.indexOf(e.carryRes) + 1000 * Math.min(9, e.tasks?.length ?? 0) + (e.stance === 'defensive' ? 10000 : 0) + 20000 * FORMATIONS.indexOf(e.formation ?? 'none')
          // Formation 0-4 (× 20000); trebuchets: 1 set up, 2 setting up or packing (× 100000).
          + 100000 * (e.setup ? 2 : e.deployed ? 1 : 0),
        task, target,
      ];
      // Only what changed goes out (everything in a full update).
      const key = ent.join(',');
      live.add(e.id);
      if (full || this.sent.get(e.id) !== key) ents.push(ent);
      if (!forNewcomer) this.sent.set(e.id, key);
      if (e.queue.length > 0) {
        const first = e.queue[0];
        const time = isTech(first) ? TECHS[first].time : DEFS[first as (typeof KINDS)[number]].time;
        queues.push([e.id, Math.floor((e.trainTicks / (time * TICK_RATE)) * 100), ...e.queue.map((k) => QUEUE_ITEMS.indexOf(k))]);
      }
      if (e.rally) rallies.push([e.id, e.rally[0], e.rally[1]]);
    }
    // Gone since the last update: dead, or sheltering inside a building.
    const gone: number[] = [];
    if (!forNewcomer) {
      for (const id of this.sent.keys()) {
        if (live.has(id)) continue;
        gone.push(id);
        this.sent.delete(id);
      }
    }
    // A newcomer gets the picture only: the events are for those who saw what came before.
    if (forNewcomer) {
      return {
        t: 'snap', tick: s.tick, full: true, ents, gone: [], queues, players: this.playerRows(s, workers, mask), blessings: [],
        relics: s.relics.map((r) => [round(r.x), round(r.y), r.carrier, r.monastery, r.foundBy]),
        tiles: [], amounts: [], shots: [], hits: [], deaths: [], rallies, winner: s.winner,
      };
    }
    // The deaths go out with this snapshot; whatever dies from now on goes in the next one.
    const deaths = s.deaths;
    s.deaths = [];
    const p = this.pending;
    this.pending = { tiles: [], amounts: new Map(), shots: [], hits: [], blessings: [] };
    return {
      t: 'snap', tick: s.tick, full: full || undefined, ents, gone, queues,
      players: this.playerRows(s, workers, mask),
      blessings: p.blessings,
      relics: s.relics.map((r) => [round(r.x), round(r.y), r.carrier, r.monastery, r.foundBy]),
      tiles: p.tiles, amounts: [...p.amounts], shots: p.shots, hits: p.hits, deaths, rallies, winner: s.winner, stats: s.winner >= 0 ? [...s.players.values()].map((p) => [p.slot, p.stats] as [number, typeof p.stats]) : undefined,
    };
  }
}
