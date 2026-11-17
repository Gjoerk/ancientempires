import type { MapSizeName } from './map';
import type { Command, PlayerStats } from './sim';

export interface PlayerInfo {
  slot: number;
  name: string;
  /** Players with the same team number are allies. */
  team: number;
  /** A stand-in opponent that the host controls themselves, for testing. */
  test?: boolean;
  /** A computer opponent, played by the host's browser. */
  ai?: boolean;
  /** How well the computer opponent plays. */
  level?: 'easy' | 'normal' | 'hard';
  /** Lost their connection during the game; their side waits for them to come back. */
  away?: boolean;
}

export interface GameSettings {
  /** More starting resources and villagers, for shorter games. */
  quick: boolean;
  mapSize: MapSizeName;
  /** Highest population anyone may reach. */
  popLimit: number;
  /** How fast the game runs: 1, 1.5 or 2 (everything happens that much quicker). */
  speed?: number;
}

/**
 * [id, owner, kind index into KINDS, x, y, hp, activity, extra, task, target]
 * activity: 0 idle, 1 moving, 2 working, 3 fighting.
 * extra: units carry `amount + 100 * resource index + 1000 * queued sites + 10000 if defensive`; buildings report construction progress 0-100.
 * task/target: see `taskOf` for units; for castles task is 1 while a king is inside; for farms task has 1 while a farmer works it and 2 while it lies fallow, and target is the food left (fallow: seconds until it is gone).
 */
export type EntitySnapshot = [number, number, number, number, number, number, number, number, number, number];

/**
 * [slot, food, wood, gold, stone, population, housing, defeated (0/1), age,
 *  researched technologies as a bit mask over TECH_IDS, technologies being researched likewise,
 *  villagers gathering food, wood, gold, stone, town bell rung (0/1)]
 */
export type PlayerSnapshot = number[];

/** [building id, progress of the first item 0-100, ...indices into QUEUE_ITEMS] */
export type QueueSnapshot = number[];

/** Sent by a player to the host. */
export type ClientMessage =
  /** `token` is the guest's own random key for the room: with it, someone who lost their connection gets their place back. */
  | { t: 'join'; name: string; token?: string; watch?: boolean }
  | { t: 'cmd'; cmd: Command }
  /** `team`: only for the sender's allies. */
  | { t: 'chat'; text: string; team?: boolean }
  /** Marks a spot on the map for the sender's allies. */
  | { t: 'signal'; x: number; y: number }
  /** A player picks their own team (and with it their colour) in the lobby. */
  | { t: 'team'; team: number }
  /** Ask for a pause, answer someone's request, or say you are ready to continue ('yes'). */
  | { t: 'pause'; answer: 'request' | 'yes' | 'no' }
  /** Sent every couple of seconds, so the host can tell a guest whose connection silently died. */
  | { t: 'ping' };

/** Sent by the host to players. */
export type ServerMessage =
  /** The room is waiting in the lobby. Sent whenever who is in it changes. */
  /** `you` is -1 for a spectator; `watching` names the spectators. */
  | { t: 'lobby'; you: number; host: number; room: string; players: PlayerInfo[]; settings: GameSettings; watching?: string[] }
  /** The host started the game. */
  | { t: 'start'; you: number; room: string; seed: number; size: number; popLimit: number; players: PlayerInfo[]; watching?: string[]; speed?: number }
  | { t: 'players'; players: PlayerInfo[]; watching?: string[] }
  /** `from` is -1 for a spectator, who is then named. */
  | { t: 'chat'; from: number; text: string; team?: boolean; name?: string }
  /** An ally marked a spot on the map. */
  | { t: 'signal'; from: number; x: number; y: number }
  /**
   * Where a pause stands: 'asking' while players decide, 'paused' until everyone has pressed
   * continue, 'off' when the game runs. `waiting` lists who still has to answer.
   */
  | { t: 'pause'; phase: 'asking' | 'paused' | 'off'; by: number; waiting: number[]; declinedBy: number }
  /** Sent while nothing else is, so guests can tell the host is still there. */
  | { t: 'ping' }
  | {
      t: 'snap';
      tick: number;
      /** Everything is in it (otherwise only what changed since the last update). */
      full?: boolean;
      ents: EntitySnapshot[];
      /** Gone since the last update (dead, or gone inside a building). */
      gone: number[];
      players: PlayerSnapshot[];
      queues: QueueSnapshot[];
      /** Tiles that changed this tick: [tile index, new tile]. */
      tiles: [number, number][];
      /** Resource tiles that were gathered from this tick: [tile index, amount left]. */
      amounts: [number, number][];
      /** Ranged attacks this tick: [attacker id, target id]. */
      shots: [number, number][];
      /** Monks at work this tick: [monk id, target id, 1 heal / 2 convert]. */
      blessings: [number, number, number][];
      /** Every relic: [x, y, carrying monk or -1, keeping monastery or -1, bit mask of the players who have seen it]. */
      relics: [number, number, number, number, number][];
      /** Melee blows this tick: [attacker id, target id]. */
      hits: [number, number][];
      /** Deaths this tick: [kind index, x, y, owner]. */
      deaths: [number, number, number, number][];
      /** Rally points: [building id, x, y]. */
      rallies: [number, number, number][];
      /** The winning team, or -1. */
      winner: number;
      /** At the end: what happened over the game, for every player (by slot). */
      stats?: [number, PlayerStats][];
    }
  /** For someone coming back into a running game: tiles changed so far, [tile index, tile, amount left]. */
  | { t: 'catchup'; tiles: [number, number, number][] }
  /**
   * A piece of a backup of the whole game (see GameHost.backup), for the players who would take over
   * hosting if the host vanished: `heirs` in that order, the old host being `host`.
   */
  | { t: 'backup'; id: number; i: number; n: number; part: string; heirs: number[]; host: number }
  /** `final`: the end for this guest (removed by the host): no trying to get back in. */
  | { t: 'error'; message: string; final?: boolean };
