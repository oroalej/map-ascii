/**
 * The life layer's tuning (SPEC.md §4 "Life layer"): who moves where, how fast, how many, and
 * from which zoom. Everything is in real-world units, so motion reads the same at any zoom.
 */
import type { ZoomBand } from '@atlas/shared';
import { classId, MAX_CLASSES, renderClasses, type LifeClass } from '../classes';
import { LifeLine } from './geometry';

export type AgentKind = 'vehicle' | 'person' | 'boat' | 'bird';

/** The zoom band in which each kind shows. */
export const LIFE_ZOOM: Readonly<Record<AgentKind, ZoomBand>> = {
  boat: { min: 13.5 },
  bird: { min: 13.5 },
  vehicle: { min: 15 },
  person: { min: 17 },
};

/** At most this many agents are drawn, those nearest the view's center first. */
export const MAX_VISIBLE_AGENTS = 1200;
/** At most this many agents live in one tile. */
export const MAX_TILE_AGENTS = 600;
/** A longer frame (a background tab) is simulated as this long, so agents don't jump. */
export const MAX_STEP_S = 0.1;
/** Vehicles keep this far right of the road's center line, so two-way traffic passes. */
export const LANE_OFFSET_M = 2.5;

/** The line kinds each moving kind may use, at junctions too. */
export const usableLines: Readonly<Record<Exclude<AgentKind, 'bird'>, readonly LifeLine[]>> = {
  vehicle: [LifeLine.roadMajor, LifeLine.roadMid, LifeLine.roadMinor],
  person: [LifeLine.roadMinor, LifeLine.path, LifeLine.plaza],
  boat: [LifeLine.river],
};

export type SpawnRule = {
  kind: Exclude<AgentKind, 'bird'>;
  /** One agent per this many meters of line, on average. */
  spacing: number;
  /** Speed range, m/s. */
  speed: readonly [number, number];
};

/** Who is spawned on each line kind. */
export const spawnRules: Readonly<Record<LifeLine, readonly SpawnRule[]>> = {
  [LifeLine.roadMajor]: [{ kind: 'vehicle', spacing: 30, speed: [7, 12] }],
  [LifeLine.roadMid]: [{ kind: 'vehicle', spacing: 50, speed: [6, 10] }],
  // Side streets: tricycles and people on foot.
  [LifeLine.roadMinor]: [
    { kind: 'vehicle', spacing: 100, speed: [3, 6] },
    { kind: 'person', spacing: 50, speed: [0.9, 1.5] },
  ],
  [LifeLine.path]: [{ kind: 'person', spacing: 20, speed: [0.9, 1.4] }],
  [LifeLine.plaza]: [{ kind: 'person', spacing: 10, speed: [0.6, 1.2] }],
  [LifeLine.river]: [{ kind: 'boat', spacing: 200, speed: [1, 2.5] }],
};

/** People stop for a while (chance per second, and how long in s), or turn back. */
export const PERSON_PAUSE = { chance: 0.04, seconds: [2, 8] as const };
export const PERSON_TURN_CHANCE = 0.01;

/** Birds: flocks per tile (at most one per roost), birds per flock, and how they fly. */
export const BIRDS = {
  flocksPerTile: 5,
  flockSize: [3, 7] as const,
  /** m/s */
  speed: 9,
  /** Circles over a roost, m. */
  orbit: [15, 40] as const,
  /** How far birds spread around the flock's center, m. */
  spread: [2, 8] as const,
  /** How long a flock stays over one roost, s. */
  stay: [15, 45] as const,
  /** Wing beats per second (the glyph alternates). */
  flap: 3,
};

/**
 * How much of each kind is out at a time of day (`daylight`, 0 night – 1 day, life/sun.ts):
 * fewer people and cars at night, and birds roost after dusk. Each agent has a fixed rank in
 * 0–1 and shows while its rank is below this.
 */
export function activity(kind: AgentKind, daylight: number): number {
  switch (kind) {
    case 'vehicle':
      return 0.3 + 0.7 * daylight;
    case 'person':
      return 0.12 + 0.88 * daylight;
    case 'boat':
      return 0.2 + 0.8 * daylight;
    case 'bird':
      return Math.min(1, Math.max(0, (daylight - 0.2) / 0.5));
  }
}

/** The render class each kind is drawn with (its glyphs and color, theme.ts). */
export const lifeClassFor: Readonly<Record<AgentKind, LifeClass>> = {
  vehicle: 'life_vehicle',
  person: 'life_person',
  boat: 'life_boat',
  bird: 'life_bird',
};

/**
 * What the glyph pass may do on a cell, by the map class under it (`cellBits`): which agents
 * may be drawn there, and how the night lights it.
 */
export const CellBit = {
  vehicle: 1,
  person: 2,
  boat: 4,
  bird: 8,
  /** Some cells show a lit window at night. */
  window: 16,
  /** Warm streetlight at night. */
  streetlight: 32,
} as const;

/**
 * In the tilted view, windows light up by patch of a building's walls, fixed to the world so
 * they stay put as the camera turns: a bay this wide (mercator meters) by a storey this tall (m).
 */
export const WINDOW = { bay: 3, storey: 3 } as const;

/** The bit an agent needs on the cell under it. */
export const agentBit: Readonly<Record<AgentKind, number>> = {
  vehicle: CellBit.vehicle,
  person: CellBit.person,
  boat: CellBit.boat,
  bird: CellBit.bird,
};

const roads = ['road_major', 'road_mid', 'road_minor'];
const water = ['water_river', 'water_stream', 'water_area', 'water_sea'];
const lit = ['building', 'building_religious', 'building_school', 'building_market'];
/** Where people can't stand: roofs, water, and walls. */
const noWalking = new Set([...lit, 'building_part', ...water, 'barrier', 'coastline']);

/**
 * Per class id, the `CellBit`s of its cells. Vehicles keep to roads and boats to water; people
 * stay off roofs and water; birds fly anywhere. Empty cells (id 0) count as open ground. In the
 * tilted view, a building standing in front of an agent hides it.
 */
export function cellBits(): Int32Array {
  const bits = new Int32Array(MAX_CLASSES);
  bits[0] = CellBit.person | CellBit.bird;
  for (const cls of renderClasses) {
    const id = classId(cls);
    let b = CellBit.bird;
    if (!noWalking.has(cls)) b |= CellBit.person;
    if (roads.includes(cls)) b |= CellBit.vehicle;
    if (cls === 'road_major') b |= CellBit.streetlight;
    if (water.includes(cls)) b |= CellBit.boat;
    if (lit.includes(cls)) b |= CellBit.window;
    bits[id] = b;
  }
  return bits;
}
