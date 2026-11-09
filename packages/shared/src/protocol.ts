import type { Command } from './sim';

export interface PlayerInfo {
  slot: number;
  name: string;
  /** A stand-in opponent that the host controls themselves, for testing. */
  test?: boolean;
}

/**
 * [id, owner, kind index into KINDS, x, y, hp, activity, extra, task, target]
 * activity: 0 idle, 1 moving, 2 working, 3 fighting.
 * extra: units carry `amount + 100 * resource index`; buildings report construction progress 0-100.
 * task/target: see `taskOf` for units; for castles task is 1 while a king is inside.
 */
export type EntitySnapshot = [number, number, number, number, number, number, number, number, number, number];

/**
 * [slot, food, wood, gold, stone, population, housing, defeated (0/1), age,
 *  researched technologies as a bit mask over TECH_IDS, technologies being researched likewise]
 */
export type PlayerSnapshot = number[];

/** [building id, progress of the first item 0-100, ...indices into QUEUE_ITEMS] */
export type QueueSnapshot = number[];

/** Sent by a player to the host. */
export type ClientMessage =
  | { t: 'join'; name: string }
  | { t: 'cmd'; cmd: Command };

/** Sent by the host to players. */
export type ServerMessage =
  /** The room is waiting in the lobby. Sent whenever who is in it changes. */
  | { t: 'lobby'; you: number; host: number; room: string; players: PlayerInfo[] }
  /** The host started the game. */
  | { t: 'start'; you: number; room: string; seed: number; players: PlayerInfo[] }
  | { t: 'players'; players: PlayerInfo[] }
  /** Sent while nothing else is, so guests can tell the host is still there. */
  | { t: 'ping' }
  | {
      t: 'snap';
      tick: number;
      ents: EntitySnapshot[];
      players: PlayerSnapshot[];
      queues: QueueSnapshot[];
      /** Tiles that changed this tick: [tile index, new tile]. */
      tiles: [number, number][];
      /** Ranged attacks this tick: [attacker id, target id]. */
      shots: [number, number][];
      /** Melee blows this tick: [attacker id, target id]. */
      hits: [number, number][];
      /** Deaths this tick: [kind index, x, y, owner]. */
      deaths: [number, number, number, number][];
      /** Rally points: [building id, x, y]. */
      rallies: [number, number, number][];
      winner: number;
    }
  | { t: 'error'; message: string };
