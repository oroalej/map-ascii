import type { AgentKind } from './config';
import type { BirdSpecies } from './birds';
import type { PersonFigure } from './people';
import type { VisibleAgent } from './simulate';
import type { CraftType } from './vehicles';
import type { FolkloreSprite } from './folklore';

const crafts: Record<CraftType, string> = {
  car: 'Car',
  motorcycle: 'Motorcycle',
  tricycle: 'Tricycle',
  jeepney: 'Jeepney',
  bus: 'Bus',
  truck: 'Truck',
  bicycle: 'Bicycle',
  rowboat: 'Rowboat',
  motorboat: 'Motorboat',
  banca: 'Banca',
  locomotive: 'Locomotive',
  coach: 'Train coach',
  pagoda: 'Pagoda',
  voyador: 'Voyador',
  baroto: 'Baroto',
  sailboat: 'Sailboat',
  cart: "Street vendor's cart",
  carabao: 'Carabao',
  ambulance: 'Ambulance',
  police: 'Police car',
  firetruck: 'Fire truck',
};
const figures: Record<PersonFigure, string> = {
  adult: 'Person',
  child: 'Child',
  umbrella: 'Person with an umbrella',
  rower: 'Paddler',
  seated: 'Person sitting',
};
const birds: Record<BirdSpecies, string> = {
  maya: 'Maya',
  swallow: 'Swallow',
  pigeon: 'Pigeon',
  egret: 'Egret',
  bat: 'Bat',
};
const kinds: Record<AgentKind, string> = {
  vehicle: 'Vehicle',
  person: 'Person',
  boat: 'Boat',
  train: 'Train',
  bird: 'Bird',
  dog: 'Dog',
  cat: 'Cat',
};

/** A decorative agent's public name; ropes and poles are not independent subjects. */
export function describeAgent(agent: VisibleAgent): string | null {
  if (agent.line || agent.prop) return null;
  let name = kinds[agent.kind];
  if (agent.vehicle && ['vehicle', 'boat', 'train'].includes(agent.kind)) {
    name = crafts[agent.vehicle];
    if (agent.parked && agent.kind === 'vehicle') name = `Parked ${name.toLowerCase()}`;
  } else if (agent.kind === 'person') {
    const group = (agent.people?.length ?? 0) > 1;
    if (agent.vehicle === 'cart') name = 'Street vendor';
    else if (agent.vehicle === 'carabao') name = 'Carabao';
    else if (agent.aboard) name = group ? 'Paddlers' : 'Paddler';
    else if (agent.candle) name = group ? 'People with candles' : 'Person with a candle';
    else if (group) name = 'People together';
    else name = figures[agent.people?.[0]?.figure ?? 'adult'];
  } else if (agent.kind === 'bird' && agent.bird) name = birds[agent.bird.species];
  return `${name} (simulated)`;
}

/** Owners are positions in this packed frame's array, never stable simulation identities. */
export function agentAt(
  owners: Uint32Array,
  cols: number,
  rows: number,
  agents: readonly VisibleAgent[],
  [col, row]: readonly [number, number],
): VisibleAgent | null {
  if (
    !Number.isInteger(col) ||
    !Number.isInteger(row) ||
    col < 0 ||
    row < 0 ||
    col >= cols ||
    row >= rows
  )
    return null;
  const owner = owners[row * cols + col] ?? 0;
  return owner > 0 ? (agents[owner - 1] ?? null) : null;
}
export function describeFolklore(sprite: Pick<FolkloreSprite, 'kind'>) {
  return sprite.kind === 'ghost'
    ? 'Ghost (folklore, simulated)'
    : 'Manananggal (folklore, simulated)';
}
