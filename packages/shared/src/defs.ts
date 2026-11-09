export const RESOURCES = ['food', 'wood', 'gold', 'stone'] as const;
export type Res = (typeof RESOURCES)[number];
export type Cost = Partial<Record<Res, number>>;

/** Every unit and building type. The index in this list is what goes over the wire. */
export const KINDS = [
  'villager', 'king', 'swordsman', 'spearman', 'archer', 'rider',
  'towncenter', 'house', 'storehouse', 'farm', 'barracks', 'range', 'stable', 'tower',
] as const;
export type Kind = (typeof KINDS)[number];

export interface KindDef {
  label: string;
  building?: boolean;
  hp: number;
  cost: Cost;
  /** Seconds to train (units) or to build with one villager (buildings). */
  time: number;
  /** Tiles per second. */
  speed?: number;
  /** Footprint edge length in tiles (buildings). */
  size?: number;
  attack?: number;
  /** Attack range in tiles. */
  range?: number;
  /** Seconds between attacks. */
  cooldown?: number;
  armor?: number;
  /** Extra damage against specific kinds. */
  bonus?: Partial<Record<Kind, number>>;
  /** How far the unit looks for enemies on its own. */
  sight?: number;
  /** Population room this building provides. */
  housing?: number;
  trains?: Kind[];
  /** Villagers can deliver resources here. */
  dropoff?: boolean;
}

const MELEE = 1.5;

export const DEFS: Record<Kind, KindDef> = {
  villager: { label: 'Villager', hp: 25, cost: { food: 50 }, time: 12, speed: 2.2, attack: 3, range: MELEE, cooldown: 1.5, sight: 4 },
  king: { label: 'King', hp: 100, cost: {}, time: 0, speed: 2.6 },
  swordsman: {
    label: 'Swordsman', hp: 60, cost: { food: 60, gold: 20 }, time: 14, speed: 2.0,
    attack: 8, range: MELEE, cooldown: 1.5, armor: 1, sight: 6, bonus: { spearman: 3 },
  },
  spearman: {
    label: 'Spearman', hp: 45, cost: { food: 35, wood: 25 }, time: 12, speed: 2.2,
    attack: 4, range: MELEE, cooldown: 1.5, sight: 6, bonus: { rider: 20 },
  },
  archer: {
    label: 'Archer', hp: 30, cost: { wood: 25, gold: 45 }, time: 14, speed: 2.2,
    attack: 5, range: 5, cooldown: 1.6, sight: 7, bonus: { spearman: 3 },
  },
  rider: {
    label: 'Rider', hp: 90, cost: { food: 80, gold: 40 }, time: 18, speed: 3.4,
    attack: 9, range: MELEE, cooldown: 1.6, armor: 1, sight: 6, bonus: { archer: 4 },
  },
  towncenter: {
    label: 'Town Centre', building: true, hp: 800, cost: { wood: 275, stone: 100 }, time: 60, size: 3,
    armor: 3, housing: 5, trains: ['villager'], dropoff: true,
  },
  house: { label: 'House', building: true, hp: 200, cost: { wood: 30 }, time: 12, size: 2, armor: 3, housing: 5 },
  storehouse: { label: 'Storehouse', building: true, hp: 250, cost: { wood: 80 }, time: 15, size: 2, armor: 3, dropoff: true },
  farm: { label: 'Farm', building: true, hp: 100, cost: { wood: 50 }, time: 8, size: 2, armor: 1 },
  barracks: {
    label: 'Barracks', building: true, hp: 450, cost: { wood: 150 }, time: 25, size: 3, armor: 3,
    trains: ['swordsman', 'spearman'],
  },
  range: { label: 'Archery Range', building: true, hp: 400, cost: { wood: 150 }, time: 25, size: 3, armor: 3, trains: ['archer'] },
  stable: { label: 'Stable', building: true, hp: 400, cost: { wood: 150 }, time: 25, size: 3, armor: 3, trains: ['rider'] },
  tower: {
    label: 'Watchtower', building: true, hp: 400, cost: { stone: 100, wood: 25 }, time: 25, size: 1, armor: 3,
    attack: 6, range: 7, cooldown: 2,
  },
};

/** Buildings a villager can construct, in menu order. */
export const BUILDABLE: Kind[] = ['house', 'farm', 'storehouse', 'barracks', 'range', 'stable', 'tower', 'towncenter'];

export const POP_MAX = 60;
export const CARRY_CAPACITY = 10;
/** Resources gathered per second. */
export const GATHER_RATE = 1;
export const FARM_RATE = 0.7;
export const QUEUE_MAX = 5;
export const START_RESOURCES: Record<Res, number> = { food: 200, wood: 200, gold: 100, stone: 100 };
