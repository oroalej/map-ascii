/**
 * The life layer's tuning (SPEC.md §4 "Life layer"): who moves where, how fast, how many, and
 * from which zoom. Everything is in real-world units, so motion reads the same at any zoom.
 */
import {
  LAMP_PLACEMENT,
  ROOF_BUILDING_CLASSES,
  curveAt,
  SHOP_POINT_RADIUS_M,
  PLACE_KINDS,
  VEHICLE_TYPES,
  placeShare,
  rhythmFor,
  type CityLifeConfig,
  type PlaceKind,
  type RuntimeSeasonConfig,
  type ZoomBand,
} from '@atlas/shared';
import { classId, groundClasses, MAX_CLASSES, renderClasses, type LifeClass } from '../classes';
import { LifeLine } from './geometry';
import { VEHICLES } from './vehicles';

export type AgentKind = 'vehicle' | 'person' | 'boat' | 'bird' | 'train' | 'dog' | 'cat';

/** Ground walkers share routing, crossing, and clearance rules. */
export const isWalker = (kind: AgentKind) => kind === 'person' || kind === 'dog' || kind === 'cat';

/** The zoom band in which each kind shows. */
export const LIFE_ZOOM: Readonly<Record<AgentKind, ZoomBand>> = {
  boat: { min: 13.5 },
  train: { min: 13.5 },
  bird: { min: 13.5 },
  vehicle: { min: 15 },
  person: { min: 17 },
  dog: { min: 17 },
  cat: { min: 17 },
};

/** Life agents come from tiles at least this deep; the shallowest band starts at 13.5. */
export const LIFE_TILE_MIN_ZOOM = 13;

/** At most this many agents are drawn, those nearest the view's center first. */
export const MAX_VISIBLE_AGENTS = 1200;
/** At most this many agents live in one tile. */
export const MAX_TILE_AGENTS = 600;
/** A longer frame (a background tab) is simulated as this long, so agents don't jump. */
export const MAX_STEP_S = 0.1;
/** Frozen out-of-view tiles, bounded by simulated time and count. */
export const RETIRE = { seconds: 8, max: 24 } as const;
/** Maximum rendered-pose discontinuity for a cross-zoom vehicle or boat. */
export const ADOPT = { snap: 4, bearing: 35 } as const;
/** A lane's width, m (the pipeline's, for roads tagged with lanes but no width). */
export const LANE_WIDTH_M = 3.2;
/** The width of a road line without one, m. */
export { DEFAULT_ROAD_WIDTH_M } from '@atlas/shared';
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
export const FOLLOW = {
  minGap: 1.5,
  headway: 1.2,
  squeeze: 0.3,
  lateralPad: 0.3,
  /** Where a lane moves sideways, following compares lanes this far ahead too, m. */
  laneAheadM: 10,
} as const;
/** Required distance from a vehicle centre to a stop edge, m. */
export const frontClearance = (length: number): number => length / 2 + FOLLOW.minGap;
/** Conservative broad phase for ordinary terminal approaches, m/s and m. */
export const TERMINAL = { cruise: 12, pad: 4, creep: 1 } as const;
/**
 * Terrain recovery for vehicles: sideways metres per metre travelled while shifting or returning
 * (no sideways move while stopped); clear road edge allowance for inferred widths, m.
 */
export const ROAD_AVOID = { slope: 0.25, shoulder: 0.5 } as const;
/**
 * Out of view, a vehicle leaves once fixed obstacles have stopped it this many seconds in a row,
 * or the movement guard has refused it for any reason this long.
 */
export const STALL = { terrainSeconds: 8, anySeconds: 20 } as const;
/**
 * Turn back after this many active seconds attempting a blocked walking route; from fixed
 * obstacles at once, once at least `terrainMinWalkM` has been walked since the last turn back.
 */
export const WALK_RECOVERY = { seconds: 3, terrainMinWalkM: 1 } as const;
/**
 * People wait at the curb while a vehicle moving faster than `movingMs` (m/s) couldn't stop
 * `marginM` short of the crossing.
 */
export const WALK_GAP = { movingMs: 0.5, marginM: 2 } as const;
/** People turn round on the spot over this many seconds. */
export const TURN_AROUND = { seconds: 0.4 } as const;
/** Having stepped aside on a path, the share of the offset given back per metre walked on. */
export const WALK_ASIDE = { restore: 0.3 } as const;
/** Walking lines shorter than this, m, joined to no other at either end, get no residents. */
export const STRANDED_WALK_M = 20;
/**
 * A crossing's walking line runs this far past its walkable cut at each end (raster/geometry.ts),
 * giving a group room to clear the road before turning at an unattached end.
 */
export const CROSSING_WALK_PAST_M = 1.5;
/** Distances are metres; holdMax counts active simulation seconds. */
export const PEDESTRIAN = {
  corridorPad: 0.3,
  lookaheadPad: 4,
  maxRange: 30,
  curbReach: 2,
  holdMax: 20,
  holdMatch: 2,
} as const;

export const COS20 = Math.cos(Math.PI / 9),
  COS30 = Math.cos(Math.PI / 6);

/** m/s²: acceleration, comfortable braking, routine braking limit, lateral acceleration.
 * Safety caps may exceed maxBrake to prevent overlap or overshoot. */
export type Kinematics = { accel: number; brake: number; maxBrake: number; lateral: number };
export const KINEMATICS: Readonly<Record<string, Kinematics>> = {
  default: { accel: 1.5, brake: 2.5, maxBrake: 5, lateral: 2 },
  car: { accel: 2, brake: 3, maxBrake: 6, lateral: 2.5 },
  motorcycle: { accel: 2.5, brake: 3.5, maxBrake: 7, lateral: 3 },
  tricycle: { accel: 1.2, brake: 2.5, maxBrake: 5, lateral: 1.8 },
  jeepney: { accel: 1, brake: 2, maxBrake: 5, lateral: 1.5 },
  bus: { accel: 0.8, brake: 1.8, maxBrake: 4.5, lateral: 1.3 },
  truck: { accel: 0.8, brake: 1.8, maxBrake: 4.5, lateral: 1.3 },
  bicycle: { accel: 1, brake: 2, maxBrake: 4, lateral: 2 },
  rowboat: { accel: 0.3, brake: 0.4, maxBrake: 0.8, lateral: 1 },
  motorboat: { accel: 0.8, brake: 0.8, maxBrake: 1.5, lateral: 1.5 },
  banca: { accel: 0.5, brake: 0.6, maxBrake: 1.2, lateral: 1.2 },
  locomotive: { accel: 0.8, brake: 0.9, maxBrake: 1.5, lateral: 1 },
};
export const kinematicsOf = (craft?: string): Kinematics =>
  KINEMATICS[craft ?? ''] ?? KINEMATICS.default!;
export const FILLET = { maxM: 10, minAngle: 3, maxAngle: 150, padM: 0.5, lookaheadM: 60 } as const;
/** A terrain-cleared corner may run this far past its vertex, m. */
export const FILLET_RUN_ON_M = 2 * FILLET.maxM;
export const JUNCTION = {
  atLine: 3,
  linkedLookaheadM: 60,
  gap: 1.5,
  margin: 1,
  tie: 1,
  maxWait: 10,
  giveUp: 30,
  holdMax: 20,
  exitHalfWidth: 4,
  crossingReach: 30,
} as const;
export const TRAIN_FOLLOW = { minGap: 30, lookahead: 400, tolerance: 2.5 } as const;

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
  junctionGap: 5,
} as const;

const WALKING_LINES = [LifeLine.path, LifeLine.plaza] as const;
/** The line kinds each moving kind may use, at junctions too. */
export const usableLines: Readonly<Record<Exclude<AgentKind, 'bird'>, readonly LifeLine[]>> = {
  vehicle: [LifeLine.roadMajor, LifeLine.roadMid, LifeLine.roadMinor],
  person: WALKING_LINES,
  dog: WALKING_LINES,
  cat: WALKING_LINES,
  boat: [LifeLine.river, LifeLine.canal],
  train: [LifeLine.rail],
};

/** One train per this many meters of track, on average. */
export const TRAIN_SPACING_M = 3000;

/**
 * Trains: a locomotive and `coaches` cars (life/vehicles.ts), `coupling` m apart. At a junction a
 * train keeps to the straightest track. It stops `dwell` seconds at a station it comes within
 * `stationReach` m of (then not again within `stationGap` m of that stop), and at the end of the
 * track, where it pulls back out the way it came.
 */
export const TRAIN = {
  arrivals: [60, 120] as const,
  coaches: [2, 4] as const,
  coupling: 1,
  dwell: [20, 40] as const,
  stationReach: 25,
  stationGap: 150,
  /** Breadcrumbs along the track behind the head, every this many meters (cars sit on them). */
  crumb: 2,
  /** Passed to the next tile, a train must land within this many meters of its track there. */
  handover: 5,
  /**
   * A train standing by on each siding, spur, or yard track: `margin` m in from the siding's
   * start (clear of the switch), with up to this many coaches, as many as fit.
   */
  standby: { margin: 15, coaches: [1, 3] as const },
} as const;

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
  // Consume the legacy person stream on side streets, but spawnOn rejects those candidates.
  // This preserves unrelated traffic seeds while people use mapped walking lines only.
  [LifeLine.roadMinor]: [
    { kind: 'vehicle', spacing: 100, speed: [3, 6] },
    { kind: 'person', spacing: 50, speed: [0.9, 1.5] },
  ],
  [LifeLine.path]: [
    { kind: 'person', spacing: 20, speed: [0.9, 1.4] },
    { kind: 'dog', spacing: 180, speed: [0.8, 1.3] },
    { kind: 'cat', spacing: 300, speed: [0.5, 0.9] },
  ],
  [LifeLine.plaza]: [
    { kind: 'person', spacing: 10, speed: [0.6, 1.2] },
    { kind: 'cat', spacing: 300, speed: [0.5, 0.9] },
  ],
  [LifeLine.river]: [{ kind: 'boat', spacing: 200, speed: [1, 2.5] }],
  // Canals: a few small boats, slowly (the city's `traffic.canal` mix).
  [LifeLine.canal]: [{ kind: 'boat', spacing: 250, speed: [0.6, 1.4] }],
  // Sparse: a train every few kilometers of track, at a provincial line's easy pace.
  [LifeLine.rail]: [{ kind: 'train', spacing: TRAIN_SPACING_M, speed: [8, 14] }],
  // Trains stand by on sidings (simulate.ts `spawnStandby`); none run there.
  [LifeLine.siding]: [],
};

/** People stop for a while (chance per second, and how long in s), or turn back. */
export const PERSON_PAUSE = { chance: 0.04, seconds: [2, 8] as const };
export const PERSON_TURN_CHANCE = 0.01;

/**
 * Street dogs (askals): they stop to sniff often (chance per second, and how long in s), turn
 * back more than people do, now and then trot at `trot.speed` m/s for `trot.seconds`, and some
 * lie down a long while (`lie`). Each step of their gait goes `stride` m.
 */
export const DOG = {
  pause: { chance: 0.12, seconds: [1.5, 6] as const },
  turnChance: 0.03,
  trot: { chance: 0.02, speed: 2.6, seconds: [2, 5] as const },
  lie: { chance: 0.004, seconds: [30, 120] as const },
  stride: 0.35,
} as const;

/** Cats walk slowly, pause to rest or groom, and occupy at most six slots per tile. */
export const CAT = {
  initialPause: [15, 40],
  pause: { chance: 0.08, seconds: [10, 45] },
  groomChance: 0.4,
  blockedPause: 2,
  stride: 0.25,
  maxPerTile: 6,
} as const;

/**
 * Who walks together (life/people.ts): of the people spawned on a line, the shares that walk
 * alone, in twos, threes, and fours (cumulative); the chance each companion is a child (the
 * first is always an adult); and how far each step goes, m (the figure alternates its stride).
 */
export const PEOPLE = { groups: [0.62, 0.88, 0.97, 1] as const, child: 0.4, stride: 0.7 };

/**
 * Umbrellas (payong): the share of adults carrying one open, at least `base`, `rain` in a storm,
 * and against the sun from `sunFrom` degrees of solar altitude, up to `sun` by `sunFull`.
 */
export const UMBRELLA = { base: 0.02, rain: 0.75, sun: 0.3, sunFrom: 35, sunFull: 65 } as const;

/** Close-up canopy timing (seconds) and widths; distant figures keep their instant look. */
export const UMBRELLA_MOTION = {
  zoom: 19,
  open: 0.7,
  close: 0.9,
  stagger: 1.5,
  lost: 0.5,
  folded: 0.3,
  stageCutoff: 0.5,
  stages: [0.45, 0.75],
} as const;

/** The share of adults under an umbrella for `rain` (0–1) and the sun's altitude (degrees). */
export function umbrellaShare(rain: number, sunAltitude: number): number {
  const sun = Math.min(
    1,
    Math.max(0, (sunAltitude - UMBRELLA.sunFrom) / (UMBRELLA.sunFull - UMBRELLA.sunFrom)),
  );
  return Math.max(UMBRELLA.base, rain * UMBRELLA.rain, sun * UMBRELLA.sun);
}

/** Whether this adult carries an umbrella for the current share. */
export function underUmbrella(
  walker: { figure: 'adult' | 'child'; umbrella: number },
  share: number,
): boolean {
  return walker.figure === 'adult' && walker.umbrella < share;
}

/**
 * People running (life/running.ts): now and then someone walking alone runs at `speed` m/s for
 * `seconds` (`chance` per second), at most `maxPerTile` at once. In the rain those with no
 * umbrella run at `dash` m/s, on their way or to a covered shelter within `shelter.reach` m,
 * which they head for with `shelter.chance` (life/interactions.ts). Unreachable cover waits
 * `shelter.retry` seconds before another route search.
 */
export const RUN = {
  chance: 0.004,
  seconds: [3, 8] as const,
  speed: [2.6, 3.4] as const,
  maxPerTile: 2,
  dash: [2.8, 3.6] as const,
  shelter: { reach: 60, chance: 0.9, retry: 5 },
} as const;

/**
 * Street vendors with their carts: one per this many meters of line (`spacing`), `marketBoost`
 * times as many on lines within `marketReach` m of a market, at most `maxPerTile`. A cart stands
 * `curb` m in from a road's edge, or `beside` m off a path or a park's edge, facing along it.
 */
export const VENDORS = {
  spacing: {
    [LifeLine.plaza]: 80,
    [LifeLine.path]: 250,
    [LifeLine.roadMinor]: 300,
  } as Readonly<Partial<Record<LifeLine, number>>>,
  marketReach: 120,
  marketBoost: 5,
  maxPerTile: 40,
  curb: 0.9,
  beside: 1.2,
} as const;
export const COMMERCE = { reach: 60, perShop: 0.5, max: 2 } as const;

/**
 * How people use a place (life/simulate.ts `Gatherer`): stand about and mill (`gather`), sit on a
 * bench (`sit`), run about a pitch (`play`), or walk the rows of a field with a carabao (`work`).
 */
export type PlaceBehavior = 'gather' | 'sit' | 'play' | 'work';

export type PlaceRule = {
  behavior: PlaceBehavior;
  /** People at the place: `base` plus `perMeter` per meter of its radius, at most `max`. */
  base: number;
  perMeter: number;
  max: number;
  /** How far from the place people wander, m past its radius (a building's: around it). */
  wander: number;
  /** Walking speed, m/s. */
  speed: readonly [number, number];
  /** How long people stand still between moves, s. */
  pause: readonly [number, number];
};

/**
 * People at places (SPEC.md §4 "Places"), by the place's kind. How many are out at a time
 * follows the place's own hours (rhythm.ts `placeShare`). At most `MAX_TILE_GATHERERS` per tile.
 */
export const PLACES: Readonly<Record<PlaceKind, PlaceRule>> = {
  worship: {
    behavior: 'gather',
    base: 4,
    perMeter: 0.6,
    max: 40,
    wander: 8,
    speed: [0.3, 0.8],
    pause: [5, 20],
  },
  school: {
    behavior: 'gather',
    base: 4,
    perMeter: 0.6,
    max: 40,
    wander: 8,
    speed: [0.4, 1.1],
    pause: [3, 12],
  },
  pitch: {
    behavior: 'play',
    base: 4,
    perMeter: 0.3,
    max: 14,
    wander: 0,
    speed: [1.5, 3.5],
    pause: [0.5, 3],
  },
  monument: {
    behavior: 'gather',
    base: 2,
    perMeter: 0.2,
    max: 8,
    wander: 5,
    speed: [0.3, 0.7],
    pause: [5, 20],
  },
  bench: { behavior: 'sit', base: 1, perMeter: 0, max: 2, wander: 0, speed: [0, 0], pause: [0, 0] },
  fountain: {
    behavior: 'gather',
    base: 3,
    perMeter: 0,
    max: 6,
    wander: 5,
    speed: [0.3, 0.7],
    pause: [5, 20],
  },
  farm: {
    behavior: 'work',
    base: 1,
    perMeter: 0.02,
    max: 4,
    wander: 0,
    speed: [0.3, 0.5],
    pause: [2, 6],
  },
};

/** At most this many people at places per tile. */
export const MAX_TILE_GATHERERS = 150;
/** The share of farm workers who lead a carabao. */
export const CARABAO_SHARE = 0.5;

/**
 * Birds: flocks per tile (at most one per roost or tree) and how long a flock stays over one
 * roost, s. Each flock's species sets the rest (life/birds.ts `BIRD_SPECIES`).
 */
export const BIRDS = {
  flocksPerTile: 5,
  stay: [15, 45] as const,
};

/** Ground feeding: bounded spot searches, visit seconds, nearby tree rests and landing blend. */
export const FORAGE = {
  attempts: 8,
  /** Search radius in metres for both reachable shoreline and a nearby resting tree. */
  reach: 40,
  visit: [60, 180],
  returnChance: 0.8,
  settleSeconds: 1,
} as const;

/**
 * Birds in trees: a flock picking where to go next lands in a tree (a perch, raster/geometry.ts)
 * with its species' chance (life/birds.ts `BirdSpec.perch`), settles within `spread` m of its
 * trunk, and stays its `stay`. A gust in the crown of at least `flush` (life/wind.ts strength ×
 * glyphs/select.ts treeGust) sends it up at once, its birds scattering outward for `scatter`
 * seconds before they regroup.
 */
export const PERCH = { spread: 2.5, flush: 0.7, scatter: 1.2 } as const;

/**
 * Birds and the weather: from `shelter` rain (0–1) flocks that perch head for the trees and sit
 * it out; a flock's circle drifts `drift` m downwind at full wind strength, and circling it
 * speeds up by up to `push` on the downwind side.
 */
export const BIRD_WEATHER = { shelter: 0.5, drift: 12, push: 0.5 } as const;

/**
 * A flying bird's shadow (life/draw.ts): it flies `altitude` m up, so its shadow falls that
 * height over the tangent of the sun's altitude away from the sun, but never more than `reach`
 * m off; it darkens the ground by `dark`.
 */
export const BIRD_SHADOW = { altitude: 8, reach: 40, dark: 0.3 } as const;

/**
 * A life texel with no agent (kind bits 0) whose last byte is this marks a flying bird's shadow:
 * the glyph shader darkens the map there by `BIRD_SHADOW.dark` (shaders/glyph.ts).
 */
export const LIFE_SHADOW = 1;

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
    case 'train':
      return 0.5 + 0.5 * daylight;
    case 'dog':
      return 0.5 + 0.5 * daylight;
    case 'cat':
      return 0.7 + 0.3 * daylight;
  }
}

/** How much of the night creatures (bats) are out: from dusk, all of them by full night. */
export const nightActivity = (daylight: number) =>
  Math.min(1, Math.max(0, (0.45 - daylight) / 0.3));

/**
 * How much of each kind is out (0–1), and of the people at each kind of place: each agent shows
 * while its rank is below its kind's (or its place's).
 */
export type Activity = Readonly<Record<AgentKind, number>> & {
  /** Night creatures (bats, life/birds.ts `nocturnal`): `nightActivity`. */
  night: number;
  places: Readonly<Record<PlaceKind, number>>;
  season?: { visitors: number; congregations: number };
};

/**
 * How much of each kind is out: by the city's daily rhythm at `clock.minutes` past local
 * midnight on `clock.weekday` (the pack's `life.rhythm` and `life.schedules`, else the
 * defaults, rhythm.ts), or without a clock, by the daylight alone (`activity`). Birds and bats
 * always follow the daylight; dogs keep to people's hours, but some are always out.
 */
export function activityLevels(
  daylight: number,
  clock?: {
    minutes: number;
    weekday: number;
    life?: Pick<CityLifeConfig, 'rhythm' | 'schedules'> | undefined;
  },
  season?: Pick<RuntimeSeasonConfig, 'visitors' | 'congregations'>,
): Activity {
  const byRhythm = (kind: 'vehicle' | 'person' | 'boat' | 'train') =>
    clock ? curveAt(rhythmFor(clock.life, kind), clock.minutes) : activity(kind, daylight);
  const places = {} as Record<PlaceKind, number>;
  for (const kind of PLACE_KINDS) {
    places[kind] = clock ? placeShare(kind, clock, clock.life) : activity('person', daylight);
  }
  return {
    vehicle: byRhythm('vehicle'),
    person: byRhythm('person'),
    boat: byRhythm('boat'),
    train: byRhythm('train'),
    bird: activity('bird', daylight),
    dog: Math.max(byRhythm('person'), activity('dog', 0)),
    cat: activity('cat', daylight),
    night: nightActivity(daylight),
    places,
    ...((season?.visitors || season?.congregations) && {
      season: {
        visitors: season.visitors && clock ? curveAt(season.visitors.hours, clock.minutes) : 0,
        congregations:
          season.congregations && clock ? curveAt(season.congregations.hours, clock.minutes) : 0,
      },
    }),
  };
}

/** Whether two activities differ by more than `epsilon` for any kind or place. */
export function activityChanged(a: Activity, b: Activity, epsilon = 0.001): boolean {
  const kinds: readonly AgentKind[] = ['vehicle', 'person', 'boat', 'bird', 'train', 'dog', 'cat'];
  return (
    kinds.some((k) => Math.abs(a[k] - b[k]) > epsilon) ||
    Math.abs(a.night - b.night) > epsilon ||
    PLACE_KINDS.some((k) => Math.abs(a.places[k] - b.places[k]) > epsilon) ||
    Math.abs((a.season?.visitors ?? 0) - (b.season?.visitors ?? 0)) > epsilon ||
    Math.abs((a.season?.congregations ?? 0) - (b.season?.congregations ?? 0)) > epsilon
  );
}

/** Illustrative long pauses beside memorials and outside churches, in seconds. */
export const SEASON_CROWD = {
  pause: [40, 180] as const,
  speed: [0.3, 0.7] as const,
  congregationWanderScale: 1.5,
};

/** The render class each kind is drawn with (its glyphs and color, theme.ts). */
export const lifeClassFor: Readonly<Record<AgentKind, LifeClass>> = {
  vehicle: 'life_vehicle',
  // Dogs are drawn as people are (their own figures, life/dogs.ts): the classes are all taken.
  // Listed before people, so a lookup from the class finds people.
  dog: 'life_person',
  cat: 'life_person',
  person: 'life_person',
  boat: 'life_boat',
  bird: 'life_bird',
  train: 'life_train',
};

/**
 * What the glyph pass may do on a cell, by the map class under it (`cellBits`): which agents
 * may be drawn there, and how the night lights it.
 */
export const CellBit = {
  /** Shop paint eligibility, independent of the class id's bit-mask range. */
  frontage: 256,
  vehicle: 1,
  person: 2,
  boat: 4,
  bird: 8,
  /** Some cells show a lit window at night. */
  window: 16,
  /** Major and secondary roads: a warm lit corridor from dusk, until streetlights show. */
  streetlight: 32,
  train: 64,
  /**
   * Grounds classes (classes.ts `groundClasses`): a church's or a school's grounds, where people
   * may stand on the cells without a height, never on the buildings.
   */
  grounds: 128,
} as const;

/**
 * Streetlights (life/lights.ts) along major and secondary roads, always at the roadside: shown
 * from `zoom`, one every `spacing` m alternating sides, `setback` m in from the carriageway's
 * edge (so the head lands on the road, not the buildings beside it) but never nearer the center
 * line than `minSide` of the half-width, each lighting a pool `radius` m across. None stand in a
 * divided road's median (another carriageway alongside, `minMedian`–`median` m off). `dead` of
 * them are out and `flicker` of them flicker.
 */
export const STREETLIGHT = {
  zoom: { min: 15 } as ZoomBand,
  ...LAMP_PLACEMENT,
  radius: 12,
  /** How far in over the road a lamp's arm reaches, m: its pool is centered there. */
  reach: 3,
  dead: 0.1,
  flicker: 0.1,
} as const;

/**
 * Headlight beams (life/lights.ts `packBeams`): a moving vehicle's lights reach `length` m ahead,
 * the cone widening by `spread` m per m, `strength` at its brightest (0–1).
 */
export const BEAM = { length: 14, spread: 0.35, strength: 0.8 } as const;

/** A candle (life/lights.ts `packCandles`): a pool `radius` m across, `strength` at its brightest. */
export const CANDLE = { radius: 6, strength: 0.85 } as const;

/**
 * Floodlit landmarks (life/lights.ts): the light washes `spill` m past a landmark's footprint,
 * counted at most `maxRadius` m from its center (a big campus is lit around its heart, not
 * whole), `strength` at its brightest; a point landmark counts as `pointRadius` m across.
 */
export const FLOOD = { spill: 6, maxRadius: 30, pointRadius: 6, strength: 0.55 } as const;

/**
 * Lit shops and markets (life/lights.ts), while open (shared rhythm.ts `shopHours`): the light
 * spills `spill` m past the footprint, counted at most `maxRadius` m from its center, `strength`
 * at its brightest; a point shop counts as `pointRadius` m across.
 */
export const SHOP = {
  spill: 8,
  maxRadius: 30,
  pointRadius: SHOP_POINT_RADIUS_M * 2,
  strength: 0.9,
} as const;

/** A vendor's cart carries a bulb at night: a pool `radius` m across, `strength` at its brightest. */
export const BULB = { radius: 3, strength: 0.6 } as const;

/** The bit an agent needs on the cell under it. */
export const agentBit: Readonly<Record<AgentKind, number>> = {
  vehicle: CellBit.vehicle,
  person: CellBit.person,
  boat: CellBit.boat,
  bird: CellBit.bird,
  train: CellBit.train,
  // Dogs go where people go.
  dog: CellBit.person,
  cat: CellBit.person,
};

const roads = ['road_major', 'road_mid', 'road_minor'];
const water = ['water_river', 'water_stream', 'water_area', 'water_sea'];
const lit: readonly string[] = ROOF_BUILDING_CLASSES;
/** Where people can't stand: roofs, water, and walls. */
const noWalking = new Set([
  ...lit,
  'building_part',
  'building_woodwork',
  ...water,
  'barrier',
  'coastline',
]);

/**
 * Per class id, the `CellBit`s of its cells. Vehicles keep to roads, trains to track (and the
 * roads it crosses), and boats to water; people
 * stay off roofs and water; birds fly anywhere. Empty cells (id 0) count as open ground.
 */
export function cellBits(): Int32Array {
  const bits = new Int32Array(MAX_CLASSES);
  bits[0] = CellBit.person | CellBit.bird;
  for (const cls of renderClasses) {
    const id = classId(cls);
    let b = CellBit.bird;
    if (!noWalking.has(cls)) b |= CellBit.person;
    if (roads.includes(cls)) b |= CellBit.vehicle | CellBit.train;
    if (cls === 'rail') b |= CellBit.train;
    if (cls === 'road_major' || cls === 'road_mid') b |= CellBit.streetlight;
    if (water.includes(cls)) b |= CellBit.boat;
    if (lit.includes(cls)) b |= CellBit.window;
    if (groundClasses.includes(cls)) b |= CellBit.grounds;
    if (cls.startsWith('building') || cls === 'furniture') b |= CellBit.frontage;
    bits[id] = b;
  }
  return bits;
}
export const SIGNAL = {
  greenA: [20, 35],
  greenB: [15, 30],
  amber: 3,
  allRed: 2,
  midBlock: { green: 40, walk: 12 },
  gap: 1.5,
  lookahead: 40,
  brake: 3,
  walkMin: 5,
  /** Additional radius for associating crossing quads with signal controllers, m. */
  crossingMargin: 3.5,
} as const;

/** Protect full road-vehicle signal and linked-route lookahead before splitting a road. */
export const ROAD_SPLIT_CLEARANCE_M =
  Math.max(SIGNAL.lookahead, FILLET.lookaheadM, JUNCTION.linkedLookaheadM) +
  SIGNAL.gap +
  Math.max(...VEHICLE_TYPES.map((vehicle) => VEHICLES[vehicle].length / 2));
