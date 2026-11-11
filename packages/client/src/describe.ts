import {
  AGE_NAMES, armorOf, attackOf, BUILDABLE, Cost, DEFS, FARM_FOOD, isTech, Kind, maxHpOf, rangeOf, RESEED_COST, TECH_IDS, TechId, TECHS,
  TRADE_BUY, TRADE_SELL,
} from '@kingsfall/shared';

// Texts for the details box in the bottom bar.

export interface Detail {
  title: string;
  icon: string;
  cost?: Cost;
  /** What the action brings in, shown as "+100" (market sales). */
  gain?: Cost;
  /** Small facts with an icon each: [icon id, text]. */
  stats: [string, string][];
  lines: string[];
  /** Why it cannot be used yet, shown in red. */
  warn?: string;
}

type Has = (tech: TechId) => boolean;

const ROLE: Record<Kind, string> = {
  villager: 'Gathers food, wood, gold and stone, and builds and repairs. Weak in a fight.',
  king: 'Your most important unit: if he dies, you are out. Keep him safe in a castle.',
  spearman: 'Cheap foot soldier with a long spear. The answer to riders and scouts.',
  swordsman: 'Tough, well-armoured foot soldier. Beats spearmen and hits buildings hard.',
  archer: 'Shoots from a distance. Good against spearmen; keep riders away from it.',
  rider: 'Fast, heavy cavalry. Runs down archers; beware of spearmen.',
  scout: 'Very fast and sees far. Use it to explore and to raid unguarded villagers.',
  ram: 'Slow siege engine that smashes buildings. Almost harmless to units, and hard to kill with arrows.',
  towncenter: 'Trains villagers, advances the age and takes every resource. Shelters up to 10 villagers and the king.',
  house: 'Gives room for 5 more people. Build more when the population counter turns red.',
  mill: 'Drop-off point for food. Build it next to berry bushes or among your farms.',
  lumbercamp: 'Drop-off point for wood. Build it at the edge of a forest so villagers walk less.',
  miningcamp: 'Drop-off point for gold and stone. Build it right next to a mine.',
  farm: `A field that keeps giving food. It yields ${FARM_FOOD} food, then is sown again automatically for ${RESEED_COST} wood.`,
  barracks: 'Trains foot soldiers.',
  range: 'Trains archers.',
  stable: 'Trains mounted units.',
  blacksmith: 'Researches better weapons and armour, for the whole army or for single kinds of soldier.',
  market: 'Trade food, wood and stone for gold, and back again.',
  workshop: 'Builds siege engines.',
  wall: 'Blocks the way for everyone, your own units too. Drag out a line to build many at once.',
  gate: 'A piece of wall that you and your allies can walk through, but enemies cannot.',
  tower: 'Shoots arrows at enemies in range. Keeps raiders away from your villagers.',
  castle: 'The strongest building. Shoots arrows, and your king and up to 15 villagers can shelter inside where they cannot be hurt.',
  monk: 'Heals friendly units nearby, and can win an enemy unit over to your side. Kings and buildings cannot be converted.',
  monastery: 'Trains monks.',
};

const plural = (kind: Kind): string => {
  const label = DEFS[kind].label.toLowerCase();
  return kind === 'swordsman' || kind === 'spearman' ? label.replace(/man$/, 'men') : `${label}s`;
};

const list = (items: string[]): string => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

export function describeKind(kind: Kind, has: Has, age: number): Detail {
  const def = DEFS[kind];
  const stats: [string, string][] = [['heart', `${maxHpOf(kind, has)} HP`]];
  if (def.attack) stats.push(['sword', `${attackOf(kind, has)} attack`]);
  if ((def.range ?? 0) > 2) stats.push(['bow', `range ${rangeOf(kind, has)}`]);
  if (!def.building || def.attack || (def.armor ?? 0) > 0) stats.push(['shield', `${armorOf(kind, has)} armour`]);
  if (def.speed) stats.push(['boot', `speed ${def.speed}`]);
  if (def.time) stats.push(['hourglass', `${def.time} s to ${def.building ? 'build' : 'train'}`]);
  if (def.housing) stats.push(['house', `houses ${def.housing}`]);

  const lines = [ROLE[kind]];
  const strong = Object.keys(def.bonus ?? {}).map((k) => plural(k as Kind));
  if (def.vsBuildings && def.vsBuildings >= 10) strong.push('buildings');
  if (strong.length) lines.push(`Strong against ${list(strong)}.`);
  // Say what it trains, unless the description already does.
  if (def.trains?.length && !/Trains/.test(ROLE[kind])) lines.push(`Trains ${list(def.trains.map(plural))}.`);
  const research = TECH_IDS.filter((id) => TECHS[id].at === kind && id !== 'age2' && id !== 'age3').map((id) => TECHS[id].label.replace(/^.*: /, ''));
  if (research.length && research.length <= 4) lines.push(`Research here: ${list(research)}.`);
  else if (research.length) lines.push(`${research.length} upgrades to research here.`);
  const needs = def.age ?? 1;
  return { title: def.label, icon: kind, cost: def.cost, stats, lines, warn: needs > age ? `Needs the ${AGE_NAMES[needs]}.` : undefined };
}

export function describeTech(id: TechId, has: Has, age: number): Detail {
  const tech = TECHS[id];
  const lines = [`${tech.effect}.`];
  if (id === 'age2' || id === 'age3') {
    const unlocks = [...BUILDABLE, 'spearman', 'swordsman', 'archer', 'rider', 'scout', 'monk', 'ram']
      .filter((k) => (DEFS[k as Kind].age ?? 1) === (id === 'age2' ? 2 : 3)).map((k) => DEFS[k as Kind].label);
    lines[0] = `Unlocks ${list(unlocks)}.`;
  }
  if (tech.boost?.hp) lines.push('Units you already have get the extra health at once.');
  lines.push(`Researched at the ${DEFS[tech.at].label.toLowerCase()}.`);
  let warn: string | undefined;
  if (tech.age > age) warn = `Needs the ${AGE_NAMES[tech.age]}.`;
  else if (tech.requires && !has(tech.requires)) warn = `Research ${TECHS[tech.requires].label} first.`;
  return { title: tech.label, icon: id, cost: tech.cost, stats: [['hourglass', `${tech.time} s to research`]], lines, warn };
}

/** Details for the buttons that are not a unit, a building or a technology. */
export function describeAction(id: string): Detail {
  const [action, res] = id.split('.');
  if (action === 'sell') {
    return { title: `Sell 100 ${res}`, icon: id, gain: { gold: TRADE_SELL }, cost: { [res]: 100 }, stats: [],
      lines: [`Trades 100 ${res} for ${TRADE_SELL} gold.`, 'Prices are fixed, so trade whatever you have too much of.'] };
  }
  if (action === 'buy') {
    return { title: `Buy 100 ${res}`, icon: id, cost: { gold: TRADE_BUY }, stats: [],
      lines: [`Buys 100 ${res} for ${TRADE_BUY} gold.`, 'Handy when a resource runs out near your town.'] };
  }
  if (id === 'stance.aggressive') {
    return { title: 'Aggressive', icon: id, stats: [], lines: ['Soldiers attack any enemy unit they see and chase it a little way.',
      'Buildings are only attacked when you right-click one.'] };
  }
  if (id === 'stance.defensive') {
    return { title: 'Defensive', icon: id, stats: [], lines: ['Soldiers hold their ground and only fight back when they are attacked.',
      'Good for guards that should not be lured away. An attack-move (Ctrl + right-click) still fights its way through.'] };
  }
  if (id === 'eject') {
    return { title: 'Send everyone out', icon: id, stats: [], lines: ['Everyone sheltering inside comes out. Outside they can be attacked, the king too.'] };
  }
  return { title: 'Cancel last', icon: 'cancel', stats: [], lines: ['Removes the last unit or research from the queue and gives back what it cost.'] };
}

export function describeAny(id: string, has: Has, age: number): Detail {
  if (isTech(id)) return describeTech(id, has, age);
  if (id in DEFS) return describeKind(id as Kind, has, age);
  return describeAction(id);
}
