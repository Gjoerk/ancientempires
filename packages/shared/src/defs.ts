export const RESOURCES = ['food', 'wood', 'gold', 'stone'] as const;
export type Res = (typeof RESOURCES)[number];
export type Cost = Partial<Record<Res, number>>;

/** Every unit and building type. The index in this list is what goes over the wire. */
export const KINDS = [
  'villager', 'king', 'swordsman', 'spearman', 'archer', 'rider',
  'towncenter', 'house', 'storehouse', 'farm', 'barracks', 'range', 'stable', 'tower', 'castle',
  'blacksmith', 'market', 'workshop', 'wall', 'ram',
] as const;
export type Kind = (typeof KINDS)[number];

export interface KindDef {
  label: string;
  building?: boolean;
  hp: number;
  cost: Cost;
  /** Seconds to train (units) or to build with one villager (buildings). */
  time: number;
  /** Age the player must have reached (1-3). Default 1. */
  age?: number;
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
  /** Extra damage against every building. */
  vsBuildings?: number;
  /** How far it sees, and for soldiers how far they look for enemies on their own. */
  sight?: number;
  /** Population room this building provides. */
  housing?: number;
  trains?: Kind[];
  /** Villagers can deliver resources here. */
  dropoff?: boolean;
}

const MELEE = 1.5;

export const DEFS: Record<Kind, KindDef> = {
  villager: { label: 'Villager', hp: 25, cost: { food: 50 }, time: 12, speed: 2.2, attack: 3, range: MELEE, cooldown: 1.5, sight: 5 },
  king: { label: 'King', hp: 100, cost: {}, time: 0, speed: 2.6, sight: 6 },
  swordsman: {
    label: 'Swordsman', hp: 60, cost: { food: 60, gold: 20 }, time: 14, age: 2, speed: 2.0,
    attack: 8, range: MELEE, cooldown: 1.5, armor: 1, sight: 6, bonus: { spearman: 3 }, vsBuildings: 2,
  },
  spearman: {
    label: 'Spearman', hp: 45, cost: { food: 35, wood: 25 }, time: 12, speed: 2.2,
    attack: 4, range: MELEE, cooldown: 1.5, sight: 6, bonus: { rider: 20 },
  },
  archer: {
    label: 'Archer', hp: 30, cost: { wood: 25, gold: 45 }, time: 14, age: 2, speed: 2.2,
    attack: 5, range: 5, cooldown: 1.6, sight: 7, bonus: { spearman: 3 },
  },
  rider: {
    label: 'Rider', hp: 90, cost: { food: 80, gold: 40 }, time: 18, age: 2, speed: 3.4,
    attack: 9, range: MELEE, cooldown: 1.6, armor: 1, sight: 6, bonus: { archer: 4 },
  },
  ram: {
    label: 'Battering Ram', hp: 180, cost: { wood: 160, gold: 60 }, time: 25, age: 3, speed: 1.4,
    attack: 3, range: MELEE, cooldown: 2.5, armor: 4, sight: 4, vsBuildings: 45,
  },
  towncenter: {
    label: 'Town Centre', building: true, hp: 800, cost: { wood: 275, stone: 100 }, time: 60, age: 2, size: 3,
    armor: 3, sight: 8, housing: 5, trains: ['villager'], dropoff: true,
  },
  house: { label: 'House', building: true, hp: 200, cost: { wood: 30 }, time: 12, size: 2, armor: 3, housing: 5 },
  storehouse: { label: 'Storehouse', building: true, hp: 250, cost: { wood: 80 }, time: 15, size: 2, armor: 3, dropoff: true },
  farm: { label: 'Farm', building: true, hp: 100, cost: { wood: 50 }, time: 8, size: 2, armor: 1, sight: 3 },
  barracks: {
    label: 'Barracks', building: true, hp: 450, cost: { wood: 150 }, time: 25, size: 3, armor: 3,
    trains: ['spearman', 'swordsman'],
  },
  range: {
    label: 'Archery Range', building: true, hp: 400, cost: { wood: 150 }, time: 25, age: 2, size: 3, armor: 3, trains: ['archer'],
  },
  stable: { label: 'Stable', building: true, hp: 400, cost: { wood: 150 }, time: 25, age: 2, size: 3, armor: 3, trains: ['rider'] },
  blacksmith: { label: 'Blacksmith', building: true, hp: 350, cost: { wood: 120 }, time: 20, age: 2, size: 2, armor: 3 },
  market: { label: 'Market', building: true, hp: 350, cost: { wood: 150 }, time: 22, age: 2, size: 3, armor: 3 },
  workshop: {
    label: 'Siege Workshop', building: true, hp: 400, cost: { wood: 180 }, time: 25, age: 3, size: 3, armor: 3, trains: ['ram'],
  },
  wall: { label: 'Stone Wall', building: true, hp: 450, cost: { stone: 6 }, time: 5, size: 1, armor: 4, sight: 2 },
  tower: {
    label: 'Watchtower', building: true, hp: 400, cost: { stone: 100, wood: 25 }, time: 25, age: 2, size: 1, armor: 3,
    attack: 6, range: 7, cooldown: 2, sight: 9,
  },
  castle: {
    label: 'Castle', building: true, hp: 1500, cost: { stone: 450, wood: 200 }, time: 90, age: 3, size: 4, armor: 4,
    attack: 7, range: 7, cooldown: 2, sight: 9,
  },
};

/** Sight for anything that does not set its own. */
export const DEFAULT_SIGHT = 6;

/** Buildings a villager can construct, in menu order. */
export const BUILDABLE: Kind[] = [
  'house', 'farm', 'storehouse', 'barracks', 'wall',
  'range', 'stable', 'blacksmith', 'market', 'tower', 'towncenter',
  'workshop', 'castle',
];

export const AGE_NAMES = ['', 'Village Age', 'Town Age', 'Kingdom Age'];

export const TECH_IDS = [
  'age2', 'age3', 'loom', 'tools', 'handcart', 'forging', 'steel', 'fletching', 'mail', 'plate',
] as const;
export type TechId = (typeof TECH_IDS)[number];

export interface TechDef {
  label: string;
  /** What it does, for the player. */
  effect: string;
  cost: Cost;
  time: number;
  /** Building where it is researched. */
  at: Kind;
  /** Age the player must have reached. */
  age: number;
  requires?: TechId;
}

export const TECHS: Record<TechId, TechDef> = {
  age2: { label: 'Advance to Town Age', effect: 'Unlocks soldiers, towers, blacksmith and market', cost: { food: 400 }, time: 40, at: 'towncenter', age: 1 },
  age3: {
    label: 'Advance to Kingdom Age', effect: 'Unlocks castles and siege', cost: { food: 700, gold: 300 }, time: 60,
    at: 'towncenter', age: 2, requires: 'age2',
  },
  loom: { label: 'Loom', effect: 'Villagers +15 HP, +1 armour', cost: { gold: 50 }, time: 15, at: 'towncenter', age: 1 },
  tools: { label: 'Better Tools', effect: 'Villagers gather 20% faster', cost: { food: 100, wood: 75 }, time: 20, at: 'storehouse', age: 1 },
  handcart: { label: 'Handcart', effect: 'Villagers carry 5 more', cost: { food: 150, wood: 100 }, time: 25, at: 'storehouse', age: 2 },
  forging: { label: 'Forging', effect: 'Melee attack +2', cost: { food: 120, gold: 60 }, time: 25, at: 'blacksmith', age: 2 },
  steel: {
    label: 'Steel Blades', effect: 'Melee attack +2 more', cost: { food: 220, gold: 150 }, time: 35, at: 'blacksmith', age: 3,
    requires: 'forging',
  },
  fletching: { label: 'Fletching', effect: 'Archers and towers +1 attack, +1 range', cost: { food: 100, gold: 50 }, time: 25, at: 'blacksmith', age: 2 },
  mail: { label: 'Mail Armour', effect: 'Soldiers +1 armour', cost: { food: 100, gold: 60 }, time: 25, at: 'blacksmith', age: 2 },
  plate: {
    label: 'Plate Armour', effect: 'Soldiers +1 armour more', cost: { food: 200, gold: 150 }, time: 35, at: 'blacksmith', age: 3,
    requires: 'mail',
  },
};

/** Everything that can sit in a production queue: units to train and technologies to research. */
export const QUEUE_ITEMS: string[] = [...KINDS, ...TECH_IDS];
export const isTech = (id: string): id is TechId => (TECH_IDS as readonly string[]).includes(id);

type Has = (tech: TechId) => boolean;
const isRanged = (kind: Kind) => (DEFS[kind].range ?? 0) > 2;
const isSoldier = (kind: Kind) => !DEFS[kind].building && kind !== 'villager' && kind !== 'king';

// Stats with a player's technologies applied. `has` says whether the owner researched a technology.
export function maxHpOf(kind: Kind, has: Has): number {
  return DEFS[kind].hp + (kind === 'villager' && has('loom') ? 15 : 0);
}
export function attackOf(kind: Kind, has: Has): number {
  const base = DEFS[kind].attack ?? 0;
  if (!base) return 0;
  if (isRanged(kind)) return base + (has('fletching') ? 1 : 0);
  if (DEFS[kind].building || kind === 'villager') return base;
  return base + (has('forging') ? 2 : 0) + (has('steel') ? 2 : 0);
}
export function rangeOf(kind: Kind, has: Has): number {
  return (DEFS[kind].range ?? 0) + (isRanged(kind) && has('fletching') ? 1 : 0);
}
export function armorOf(kind: Kind, has: Has): number {
  const base = DEFS[kind].armor ?? 0;
  if (kind === 'villager') return base + (has('loom') ? 1 : 0);
  return base + (isSoldier(kind) ? (has('mail') ? 1 : 0) + (has('plate') ? 1 : 0) : 0);
}

export const POP_MAX = 60;
export const CARRY_CAPACITY = 10;
/** Resources gathered per second. */
export const GATHER_RATE = 1;
export const FARM_RATE = 0.7;
export const QUEUE_MAX = 5;
export const START_RESOURCES: Record<Res, number> = { food: 200, wood: 200, gold: 100, stone: 100 };

/** Market: selling 100 of a resource gives this much gold, buying 100 costs that much. */
export const TRADE_SELL = 60;
export const TRADE_BUY = 130;
