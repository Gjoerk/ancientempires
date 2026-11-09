import type { Command } from './sim';

export interface PlayerInfo {
  slot: number;
  name: string;
}

/**
 * [id, owner, kind index into KINDS, x, y, hp, activity, extra, task, target]
 * activity: 0 idle, 1 moving, 2 working, 3 fighting.
 * extra: units carry `amount + 100 * resource index`; buildings report construction progress 0-100.
 * task/target: see `taskOf` for units; for castles task is 1 while a king is inside.
 */
export type EntitySnapshot = [number, number, number, number, number, number, number, number, number, number];

/** [slot, food, wood, gold, stone, population, housing, defeated (0/1)] */
export type PlayerSnapshot = [number, number, number, number, number, number, number, number];

/** [building id, progress of the first item 0-100, ...kind indices in the queue] */
export type QueueSnapshot = number[];

/** Sent by a player to the host. */
export type ClientMessage =
  | { t: 'join'; name: string }
  | { t: 'cmd'; cmd: Command };

/** Sent by the host to players. */
export type ServerMessage =
  | { t: 'welcome'; you: number; room: string; seed: number; players: PlayerInfo[]; tiles: [number, number][] }
  | { t: 'players'; players: PlayerInfo[] }
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
      winner: number;
    }
  | { t: 'error'; message: string };
