import type { Command } from './sim';

export interface PlayerInfo {
  slot: number;
  name: string;
}

/** [id, owner, kind index into UNIT_KINDS, x, y, hp, moving (0/1)] */
export type EntitySnapshot = [number, number, number, number, number, number, number];

export type ClientMessage =
  | { t: 'join'; room: string; name: string }
  | { t: 'cmd'; cmd: Command };

export type ServerMessage =
  | { t: 'welcome'; you: number; room: string; seed: number; players: PlayerInfo[] }
  | { t: 'players'; players: PlayerInfo[] }
  | { t: 'snap'; tick: number; ents: EntitySnapshot[] }
  | { t: 'error'; message: string };

export const DEFAULT_PORT = 8080;
