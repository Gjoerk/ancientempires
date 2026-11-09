import type { Command } from './sim';

export interface PlayerInfo {
  slot: number;
  name: string;
}

/** [id, owner, kind index into UNIT_KINDS, x, y, hp, moving (0/1)] */
export type EntitySnapshot = [number, number, number, number, number, number, number];

/** Sent by a player to the host. */
export type ClientMessage =
  | { t: 'join'; name: string }
  | { t: 'cmd'; cmd: Command };

/** Sent by the host to players. */
export type ServerMessage =
  | { t: 'welcome'; you: number; room: string; seed: number; players: PlayerInfo[] }
  | { t: 'players'; players: PlayerInfo[] }
  | { t: 'snap'; tick: number; ents: EntitySnapshot[] }
  | { t: 'error'; message: string };
