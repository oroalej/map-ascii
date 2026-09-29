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
/** A lane's width, m (the pipeline's, for roads tagged with lanes but no width). */
export const LANE_WIDTH_M = 3.2;
/** The width of a road line without one, m. */
export const DEFAULT_ROAD_WIDTH_M = 6;
/** Vehicles keep at least this far inside the road's edge, m. */
export const ROAD_MARGIN_M = 0.2;

/**
 * How far right of a road's center line a vehicle drives, m, so two-way traffic passes: down
 * the middle of one of the lanes on its half of the road (`lane`, 0–1, picks which), or by the
 * edge with `curb` (bicycles), never closer to the edge than `ROAD_MARGIN_M`.
 */
export function laneOffset(
  roadWidth: number,
  vehicleWidth: number,
  lane: number,
  curb = false,
): number {
  const half = roadWidth / 2;
  if (curb) return Math.max(0, half - vehicleWidth / 2 - ROAD_MARGIN_M);
  const lanes = Math.max(1, Math.floor(half / LANE_WIDTH_M));
  const index = Math.min(lanes - 1, Math.floor(lane * lanes));
  const offset = ((index + 0.5) * half) / lanes;
  return Math.max(0, Math.min(offset, half - vehicleWidth / 2 - ROAD_MARGIN_M));
}

/**
 * Following: a vehicle or boat slows behind the one ahead in its lane, keeping this gap (m)
 * plus this many seconds of the gap beyond it, so queues form instead of overlaps. Two side by
 * side may overlap this much (m) and still pass.
 */
export const FOLLOW = { minGap: 1.5, headway: 1.2, squeeze: 0.3 } as const;

/**
 * Parked vehicles: shown from `zoom`; along both curbs of about `chance` of the roads at least
 * `minWidth` m wide, in a strip `strip` m wide, one every vehicle length plus `gap` m with
 * `taken` of the places filled; and on `lotTaken` of parking lots' stalls.
 */
export const PARKED = {
  zoom: { min: 17 } as ZoomBand,
  minWidth: 10,
  chance: 0.5,
  strip: 2.4,
  gap: 1.5,
  taken: 0.6,
  lotTaken: 0.65,
} as const;

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
 * Birds in trees: a flock picking where to go next lands in a tree (a perch, raster/geometry.ts)
 * with chance `chance`, settles within `spread` m of its trunk, and stays its `stay`. A gust in
 * the crown of at least `flush` (life/wind.ts strength × glyphs/select.ts treeGust) sends it up
 * at once, its birds scattering outward for `scatter` seconds before they regroup.
 */
export const PERCH = { chance: 0.5, spread: 2.5, flush: 0.7, scatter: 1.2 } as const;

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
