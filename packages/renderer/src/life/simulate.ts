import {
  EMERGENCY,
  emergencyBeacon,
  emergencyCraft,
  emergencyParked,
  isUrgent,
  type Beacon,
  type EmergencyState,
} from './emergency';
import {
  EmergencyDispatch,
  type EmergencyOwner,
  type EmergencyRequest,
} from './emergency-dispatch';
import { EmergencyRouter } from './emergency-network';
import { isEmergencyData, type EmergencyConfig, type EmergencyData } from '@atlas/shared';
import {
  CrossingReservations,
  CrossingWaits,
  type CrossingWaitState,
  type CrossingCursor,
} from './crossing-wait';
import type { SimulationSeason } from './seasonal-simulation';
import { FolkloreObserver, type FolkloreCalendar, type FolkloreBody } from './folklore';
import type { RuntimeFolklore } from './folklore-config';
import { FOLKLORE } from './folklore-config';
import { seasonalCrowds } from './seasonal-crowds';
import { gathererShare } from './gatherer-share';
import {
  birdFlightMargin,
  stepBirdFlight,
  type BirdFlight,
  type BirdFlightStep,
} from './bird-flight';
import { DEFAULT_CELLS } from '../density';
import { MOMENTS } from './moments';
import { EventTaps } from './event-taps';
import { ProcessionGlyph } from './procession-glyphs';
import { feedSpot, feedCrumbs, type FeedPoint, type TapPointer } from './feed';
import {
  TapSources,
  TapReactions,
  resolveTap,
  type LifeTap,
  type TapReceipt,
  type TapTarget,
} from './tap';
import type { EmojiSubject, EmojiMood } from '@atlas/shared';
import {
  EmojiObserver,
  EmojiMemory,
  type EmojiCue,
  type EmojiObservation,
  type EmojiObserverOptions,
} from './emoji';
/**
 * The life layer's simulation (SPEC.md §4 "Life layer"): vehicles, people, and boats moving
 * along the lines of the tiles on screen, and flocks of birds circling over parks, trees, and
 * water. Agents live in tile units, per tile; a tile's agents are spawned from a seed made of its
 * key when it comes into view, so the same tile always starts with the same agents. Pure TS: the
 * renderer projects the agents onto the cell grid (passes.ts `lifePass`).
 */
import { makeCellGuard } from './cell-guard';
import { GroundProcessionScene } from './procession-street';
import { eventActor, identifyEventActor, eventBodySize } from './event-actors';
import {
  eventBridgeAllows,
  eventGroundBounds,
  groundsForRoutes,
  trafficRings,
} from './ground-events';
import { eventTime, type EventTiming, type EventTime } from '@atlas/shared';
import type { SpeechCue } from './moments';
import { frameBetween, metricFrame, overlaps, masked, cede, ownedFootprints } from './frames';
import {
  projectMover,
  SegmentGrid,
  nearestReplacement,
  walkingBefore,
  walkingTransfer,
  type AdoptionOptions,
} from './continuity';
import type { ContinuityCounter, ContinuityRejection, LifeDiagnostics } from './diagnostics';
import { seamAhead, SEAMS } from './seams';
import { complete } from './cooperate';
import {
  admitBirths,
  birthFits,
  entryDistances,
  outsideView,
  BIRTHS,
  type LifeViewContext,
  type PendingSeed,
} from './births';
import type { FrameProfiler } from '../profile';
import {
  bandVisibility,
  VEHICLE_TYPES,
  carnivalRing,
  type PlaceKind,
  type ProcessionRoute,
  type TrafficMix,
  type CityLifeConfig,
  type ShopSchedule,
} from '@atlas/shared';
import {
  EXTENT,
  lngLatToTile,
  MERCATOR_METERS,
  metersPerUnit,
  tileToLngLat,
} from '../raster/geometry';
import type { TileId } from '../tiles';
import {
  activityLevels,
  type Activity,
  BIRD_WEATHER,
  BIRDS,
  FORAGE,
  CARABAO_SHARE,
  CAT,
  DOG,
  isWalker,
  PERCH,
  BIRD_POINTER,
  BIRD_TAKEOFF,
  BIRD_FLIGHT,
  DEFAULT_ROAD_WIDTH_M,
  FOLLOW,
  FILTER,
  DRIVE,
  frontClearance,
  laneLayout,
  LANE_WIDTH_M,
  TERMINAL,
  PEDESTRIAN,
  STALL,
  STRANDED_WALK_M,
  CROSSING_WALK_PAST_M,
  WALK_GAP,
  TURN_AROUND,
  WALK_ASIDE,
  FILLET,
  FILLET_RUN_ON_M,
  JUNCTION,
  kinematicsOf,
  laneOffset,
  LIFE_ZOOM,
  MAX_STEP_S,
  RETIRE,
  RUN,
  ADOPT,
  MAX_TILE_AGENTS,
  MAX_TILE_GATHERERS,
  MAX_VISIBLE_AGENTS,
  PARKED,
  PEOPLE,
  PERSON_PAUSE,
  PERSON_TURN_CHANCE,
  WALK_RECOVERY,
  PLACES,
  SEASON_CROWD,
  ROAD_MARGIN_M,
  ROAD_AVOID,
  LANE,
  RECOVERY,
  spawnRules,
  TRAIN,
  umbrellaShare,
  underUmbrella,
  UMBRELLA_MOTION,
  usableLines,
  VENDORS,
  COMMERCE,
  type AgentKind,
  type PlaceBehavior,
} from './config';
import {
  BIRD_SPECIES,
  BirdPose,
  Habitat,
  HABITAT_NAMES,
  pickSpecies,
  type BirdSpecies,
} from './birds';
import {
  inTile,
  LifeLine,
  PLACE_CODES,
  PLACE_STRIDE,
  vertexKey,
  sharedRoadVertexRecorder,
  physicalSeasonalRecords,
  type LifeGeometry,
} from './geometry';
import { DOG_PAINTS } from './dogs';
import {
  FORAGE_SPECIES,
  forageable,
  forageMovement,
  forageOffsets,
  forageSpot,
  isForager,
  prepareForageTerrainSteps,
  rebaseForagers,
  stepForager,
  type ForageTerrain,
  type ForageContext,
  type ForageMode,
  type GroundForager,
} from './forage';
import { CAT_PAINTS } from './cats';
import { LocalScenes, type YieldHooks } from './interactions';
import { faceGroup, restoreMover, snapshotMover } from './mover-pose';
import { runPace } from './running';
import { cruise } from './driving';
import { LifeInspection } from './inspection';
import { UmbrellaMotion } from './umbrellas';
import { MomentHost, type MomentOptions } from './moments-host';
import { assignEventCues, eventCheers } from './event-cues';
import { DialogueMemory } from './dialogue';
import { SignalControl, SignalPresses, signalState, type SignalOffsets } from './signals';
import { approach, nextSpeed, stopBefore, stoppingReach } from './motion';
import { fillet, filletLength, curvePose, type Pose, type Curve } from './curves';
import { bendAt, laneBend, LANE_BEND, type LaneTerrain } from './lane-clearance';
import {
  boxAhead,
  JunctionIndex,
  JunctionTable,
  type JunctionRequest,
  type Movement,
} from './junctions';
import { JunctionTraffic } from './junction-traffic';
import { JunctionCrossings } from './junction-crossings';
import { trainLimits, type TrainLimit } from './train-motion';
import { Paint } from './vehicles';
import { SHIRT_PAINTS, UMBRELLA_PAINTS, type PersonLook } from './people';
import {
  pickVehicle,
  resolveTraffic,
  trafficRoadFor,
  TRAIN_PAINTS,
  VEHICLES,
  type CraftType,
  type RailCraft,
  type ResolvedTraffic,
} from './vehicles';
import { PROCESSION, ProcessionScene, type LngLatBounds } from './procession';
import { hashString, random } from './random';
import { visibleLamps, type VehicleLamps } from './lamps';
import { VehicleEffectTracker, vehicleEffects } from './vehicle-effects';
import { PuffStore, PuffSelector, EMPTY_PUFFS } from './exhaust';
import { STAMP_MIN_CELLS } from './vehicles';
import {
  collectSeasonAnchors,
  seasonProximity,
  seasonMarkets,
  type SeasonAnchor,
} from './seasonal';
import { admitsInstallation } from './seasonal-installations';
import {
  hasTurnSignals,
  TURN_SIGNAL,
  turnSide,
  visibleTurnSignal,
  type TurnSignal,
  type VehicleRouting,
  type VehicleTurnPlan,
} from './turn-signals';
import {
  bodyInside,
  bodyCorners,
  bodiesOverlap,
  sweptBodyOverlap,
  segmentCrossing,
  Occupancy,
  BODY_KIND,
  PolygonIndex,
  segmentBody,
  memberSize,
  boundsOf,
  animalSize,
  reach,
  type Body,
  type Point,
  type Polygon,
} from './occupancy';
import {
  pedestrianView,
  EMPTY_PEDESTRIANS,
  pedestrianLimit,
  pedestrianRange,
  PedestrianCrossings,
  type PedestrianHold,
  type PedestrianView,
  type PedestrianSegment,
} from './pedestrians';
import {
  prepareRoadTerrainSteps,
  RoadAccess,
  WorldRoadCache,
  transformPolygon,
  type PreparedRoadTerrain,
} from './terrain';

export { hashString, random } from './random';

const NO_MOVERS: readonly Mover[] = [];
const compareJunctionRequests = (a: JunctionRequest, b: JunctionRequest) =>
  Number(b.inside) - Number(a.inside) ||
  (a.movement.boxAhead ?? a.movement.ahead) - (b.movement.boxAhead ?? b.movement.ahead);
const EMOJI_MOVER_KINDS: ReadonlySet<AgentKind> = new Set(['person', 'vehicle', 'dog', 'cat']);
const moverAttendance = (m: Mover, levels: Activity | undefined, crowd: number) =>
  !!m.train || !levels || m.rank < levels[m.kind] * crowd;
const vendorAttendance = (s: Stall, levels: Activity | undefined, crowd: number) =>
  s.open !== false && (!levels || s.rank < levels.person * crowd);
let terminalLookaheadM: number | undefined;
function terminalReach(velocity: number, length: number, brake: number) {
  return stoppingReach(velocity, brake, frontClearance(length), TERMINAL.pad);
}

export type GroundAgent = Mover | Gatherer | Stall;
export type GroundGuard = ((
  owner: GroundAgent,
  before?: GroundAgent,
  reserve?: boolean,
  reject?: (reason: ContinuityRejection) => void,
) => boolean) &
  YieldHooks & { eventDenied?: (owner: object) => boolean };
type SuppressedActors<T extends object> = {
  hidden: T[];
  order: WeakMap<T, number>;
  next: number;
};
function suppressedActors<T extends object>(): SuppressedActors<T> {
  return { hidden: [], order: new WeakMap(), next: 0 };
}
/** Keep actor identity and original array order when a temporary display occupies its site. */
function reconcileActors<T extends object>(
  active: T[],
  state: SuppressedActors<T>,
  blocked: (actor: T) => boolean,
  hide?: (actor: T) => void,
  restore?: (actor: T) => void,
) {
  for (const actor of active) if (!state.order.has(actor)) state.order.set(actor, state.next++);
  let restored = false;
  for (let i = state.hidden.length - 1; i >= 0; i--) {
    const actor = state.hidden[i]!;
    if (blocked(actor)) continue;
    state.hidden.splice(i, 1);
    active.push(actor);
    restore?.(actor);
    restored = true;
  }
  if (restored) active.sort((a, b) => state.order.get(a)! - state.order.get(b)!);
  for (let i = active.length - 1; i >= 0; i--) {
    const actor = active[i]!;
    if (!blocked(actor)) continue;
    active.splice(i, 1);
    state.hidden.push(actor);
    hide?.(actor);
  }
}
export type WorldGroundGuard = ((
  life: TileLife,
  owner: GroundAgent,
  before?: GroundAgent,
  ignore?: object,
  reserve?: boolean,
  identity?: GroundAgent,
  reject?: (reason: ContinuityRejection) => void,
  previousLife?: TileLife,
) => boolean) &
  Required<YieldHooks<[life: TileLife]>> & {
    eventDenied(owner: object): boolean;
    remove(owner: object): void;
    reserveSeam(life: TileLife, preview: Mover, identity: Mover): void;
    clearSeam(
      life: TileLife,
      preview: Mover,
      identity: Mover,
      reject?: (reason: ContinuityRejection) => void,
    ): boolean;
    roadQueue(life: TileLife, preview: Mover, identity: Mover): boolean;
    pedestrians(life: TileLife): PedestrianView;
  };
type SeamLimit = {
  room: number;
  crossing: boolean;
  boundary?: Pick<Mover, 'line' | 'dir'>;
};
export type StepPass = {
  /** The supplied world guard already composes transactional crossing checks. */
  crossingGuard?: boolean;
  pedestrians?: PedestrianView;
  junctions: JunctionTable;
  trains?: ReadonlyMap<Mover, TrainLimit>;
  owns?: (p: { x: number; y: number }) => boolean;
  seams?: ReadonlyMap<Mover, SeamLimit>;
  momentView?: { zoom: number; cellWidth: number; cellAspect: number };
  recoveredLines?: Set<number>;
  recoveryAttempts?: ReadonlySet<Mover>;
  recoveredNow?: ReadonlySet<Mover>;
  recovered?: (m: Mover) => void;
};

/** Agents this far outside the view's bounds are still placed, m: a vehicle half in view shows. */
const VIEW_MARGIN_M = 30;

/** Agents this far outside the view's bounds still move, m, so those panned into view are. */
const STEP_MARGIN_M = 100;

/**
 * Whether a point in `tile`'s units is inside `bounds` (none: everywhere), `margin` tile units
 * around them. The bounds' corners are enough: mercator keeps lines of longitude and latitude
 * straight.
 */
function viewIn(tile: TileId, bounds: LngLatBounds | undefined, margin: number) {
  if (!bounds) return () => true;
  const [west, south, east, north] = bounds;
  const nw = lngLatToTile(tile, west, north);
  const se = lngLatToTile(tile, east, south);
  const x0 = nw.x - margin;
  const x1 = se.x + margin;
  const y0 = nw.y - margin;
  const y1 = se.y + margin;
  return (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

const between = (rng: () => number, [lo, hi]: readonly [number, number]) => lo + (hi - lo) * rng();
const RUSH_KINDS: ReadonlySet<string> = new Set(DRIVE.rush.kinds);

/** Craft kinds in a stable order, for lane bend keys. */
const VEHICLE_KINDS = Object.keys(VEHICLES) as CraftType[];
/** The longest road vehicle, m: how far any lane bend can reach past its road. */
const LONGEST_ROAD_VEHICLE_M = Math.max(
  ...VEHICLE_TYPES.map((type) => VEHICLES[type as CraftType].length),
);

/**
 * The way someone faces partway through turning round (`Mover.turning`): from the facing they
 * turned from to their walking heading, the long way round by their right.
 */
function turningFacing(
  turning: NonNullable<Mover['turning']>,
  to: { hx: number; hy: number },
): { hx: number; hy: number } {
  const done = 1 - Math.max(0, turning.left) / TURN_AROUND.seconds;
  let angle = Math.atan2(
    turning.hx * to.hy - turning.hy * to.hx,
    turning.hx * to.hx + turning.hy * to.hy,
  );
  if (Math.abs(angle) > Math.PI - 1e-6) angle = Math.PI;
  const a = angle * done;
  const c = Math.cos(a),
    s = Math.sin(a);
  return { hx: turning.hx * c - turning.hy * s, hy: turning.hx * s + turning.hy * c };
}

/** A bend `distance` metres from where it is required, easing off at `LANE_BEND.slope`. */
const eased = (bend: number, distance: number) =>
  Math.sign(bend) * Math.max(0, Math.abs(bend) - LANE_BEND.slope * Math.max(0, distance));

/** The larger of two bends; a required bend always wins over a smaller one. */
const stronger = (a: number, b: number) => (Math.abs(b) > Math.abs(a) ? b : a);

/**
 * The lane `x` metres from a vertex (negative before it) where the lane moves from `a` to `b`
 * along a smoothstep centred on the vertex, no steeper than `LANE_BEND.slope`.
 */
function acrossVertex(a: number, b: number, x: number): number {
  const delta = b - a;
  if (Math.abs(delta) < 1e-3) return x < 0 ? a : b;
  // A smoothstep's steepest slope is 1.5× its mean.
  const half = handoffHalf(a, b);
  const u = Math.max(0, Math.min(1, (x + half) / (2 * half)));
  return a + delta * u * u * (3 - 2 * u);
}

const handoffHalf = (a: number, b: number) =>
  Math.abs(b - a) < 1e-3
    ? 0
    : Math.min(LANE_BEND.handoffMaxM / 2, Math.max(1, (0.75 * Math.abs(b - a)) / LANE_BEND.slope));

/** Replaced as a whole, so a shallow movement snapshot retains the accepted maneuver. */
export type RoadManeuver = Readonly<{
  kind: 'lane' | 'filter' | 'return';
  target: number;
  /** Filtering boundary as a fraction of the directional carriageway. */
  corridor?: number;
  queueSpeed?: number;
  blocked?: number;
  returning?: boolean;
}>;

/** Something that moves along lines: a vehicle, a person, a dog, or a boat. */
export type Mover = {
  emergency?: EmergencyState;
  crossingWait?: CrossingWaitState;
  /** Displayed social heading, separate from the navigation cursor and detour. */
  momentFacing?: { hx: number; hy: number };
  /** Cats' resting or grooming pose. */
  grooming?: boolean;
  kind: Exclude<AgentKind, 'bird'>;
  line: number;
  /** The vertex it last passed (an index into the tile's `coords` pairs). */
  from: number;
  /** Which way along the line it goes. */
  dir: 1 | -1;
  /** How far it is past `from`, in tile units. */
  d: number;
  /** Tile units per second. */
  speed: number;
  /** Accepted path velocity; undefined until the first controlled step. */
  v?: number;
  /** Vehicles and boats: which kind, and its paint (vehicles.ts `Paint`). */
  vehicle?: CraftType;
  paint: number;
  /** Vehicles: which of the lanes on its side of the road it keeps to, 0–1 (`laneOffset`). */
  lane: number;
  /** Normalized lane intent; lane remains the original spawn draw. */
  chosenLane?: number;
  /** Accepted maneuver displacement in metres, added to the ordinary routed offset. */
  lat?: number;
  /** Accepted maneuver heading slope, bounded to tan(15 degrees). */
  latYaw?: number;
  maneuver?: RoadManeuver;
  laneSignal?: 'left' | 'right';
  lanePatience?: number;
  laneCooldown?: number;
  filterRetry?: number;
  roadScan?: number;
  /** Checked within-road steering, in metres, relative to the seeded lane. */
  roadShift?: number;
  /** Retained direction of accepted steering during a forward-blocked episode. */
  roadSteering?: 1 | -1;
  /** A checked shorter turn curve, in metres, after a blocked default arc. */
  curveLengthM?: number;
  curveCorner?: { x: number; y: number };
  /** Original incoming segment for the outgoing half of an endpoint-to-interior turn. */
  entered?: { vertex: number; x: number; y: number; offset: number };
  /**
   * Sideways metres per metre travelled while `roadShift` (or a walker's `avoid`) changes,
   * smoothed: the nose, or the walker, faces the way it actually goes.
   */
  roadYaw?: number;
  /** Vehicles: seconds in a row fixed obstacles have stopped it (`STALL`). */
  terrainWait?: number;
  /** Consecutive guard refusals, independent of the recovery progress timer. */
  guardWait?: number;
  /** People turning round where they stand: the facing they turned from, and seconds left. */
  turning?: { hx: number; hy: number; left: number };
  /** People: `walked` when they last turned back from a blocked way (`WALK_RECOVERY`). */
  turnedAt?: number;
  /** Seconds left standing still (people and dogs). */
  pause: number;
  /** Dogs: seconds left trotting, and whether their pause is lying down (config.ts `DOG`). */
  trot?: number;
  lying?: boolean;
  /** People: seconds left of a run (config.ts `RUN`). */
  run?: number;
  /** Road vehicles: seconds left of a dry-weather burst (config.ts `DRIVE`). */
  rush?: number;
  /** Shows while this is below the kind's activity (config.ts `activity`). */
  rank: number;
  /** Position and heading (a unit vector), in tile units. */
  x: number;
  y: number;
  hx: number;
  hy: number;
  /** Trains: their cars and the track behind the head (`Train`). */
  train?: Train;
  /** People: who walks together (the first leads), and how far they have walked, m. */
  group?: Walker[];
  walked?: number;
  /** Local detour from the walking line, meters; relaxes back after an obstacle. */
  avoid?: number;
  waiting?: number;
  /** Motor vehicles: immutable exit intent and rear-clearance state for turn indicators. */
  routing?: VehicleRouting;
  /** Immutable endpoint choices through an explicitly linked signal zone. */
  junctionRoute?: { key: string; exits: readonly number[] };
  /** Immutable active crossing allowance, in geographic coordinates rather than tile geometry. */
  pedestrianHolds?: readonly PedestrianHold[];
  /** Non-motor craft intent; motors use routing.plan.exit exclusively. */
  next?: number;
  /** Incoming endpoint code, retained for the outgoing half of a curve. */
  came?: number;
};

/**
 * What the flocks react to (`LifeWorld.step`): who is out (config.ts `activityLevels`), how hard
 * it rains (0–1), and the wind, its direction a unit vector in world axes (x east, y south, like
 * tile units) and its strength 0–1 (life/wind.ts).
 */
export type LifeEnv = {
  /** The mouse, which birds keep clear of; absent for touch, replays and tests. */
  pointer?: { lngLat: readonly [number, number]; cellMeters: number };
  tapPointer?: TapPointer;
  diagnostics?: LifeDiagnostics;
  /** Actual render scale, independent of synthetic movement clearance in benchmarks. */
  effectCellMeters?: number;
  nextSourceId?: () => number;
  inspecting?: object;
  clock?: number;
  /** Viewer elapsed time for read-only moods; movement keeps its capped step clock. */
  emojiTime?: { clock: number; dt: number };
  minutes?: number;
  cityLife?: Pick<CityLifeConfig, 'schedules'>;
  season?: string | null;
  /** Installed, composed observer metadata; schedules remain in cityLife. */
  emojiSeasons?: readonly SimulationSeason[];
  /** Observer-only city calendar and same-frame lighting/weather choice. */
  date?: { epochDay: number; weekday: number; preview: boolean };
  folkloreDate?: FolkloreCalendar;
  folkloreDisturber?: { lng: number; lat: number };
  sunAltitude?: number;
  windPreset?: 'calm' | 'breeze' | 'gusty' | 'storm';
  emojiView?: { levels: Activity; crowd: number; bounds?: LngLatBounds };
  levels?: Activity;
  rain: number;
  wind?: { dir: readonly [number, number]; strength: number };
};

type FlockPointer = Point & { cellMeters: number; radius?: number };

/**
 * One of a group walking together (config.ts `PEOPLE`): an adult or a child, their shirt, their
 * umbrella (open while `umbrella` is below the share out under one, config.ts `umbrellaShare`),
 * their slot beside and behind the first, and which foot they lead with.
 */
export type Walker = {
  figure: 'adult' | 'child';
  shirt: number;
  umbrella: number;
  canopy: number;
  lateral: number;
  back: number;
  step: 0 | 1;
};

/** Slots in a group: the first, beside them on the right, then behind the two. */
const GROUP_SLOTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

/**
 * A street vendor (config.ts `VENDORS`): their cart's position and heading (tile units), its
 * paint, the vendor's shirt, which side of the cart they stand (1 right of the heading, -1
 * left), and their rank (config.ts `activity`).
 */
export type Stall = {
  covered?: boolean;
  open?: boolean;
  x: number;
  y: number;
  hx: number;
  hy: number;
  paint: number;
  shirt: number;
  side: 1 | -1;
  rank: number;
};

/**
 * Someone at a place (config.ts `PLACES`): the place's center and the ring they keep to (tile
 * units, `inner` to `outer` from it; `inner` is past a building's walls), where they are and
 * which way they face, where they are walking to, how fast (tile units per second), how long
 * they stand still, how far they have walked (m), how they look, and their rank (config.ts
 * `activityLevels`, by place). A farm worker walks the field's rows (`rx`, `ry`, turning at each
 * end: `sign`), leading a carabao in `carabao`'s paint.
 */
export type Gatherer = {
  crossingWait?: CrossingWaitState;
  seasonal?: 'visitors' | 'congregations';
  /** Original place ordinal; adjacent or coincident records retain separate ownership. */
  source?: number;
  momentFacing?: { hx: number; hy: number };
  place: PlaceKind;
  behavior: PlaceBehavior;
  cx: number;
  cy: number;
  inner: number;
  outer: number;
  x: number;
  y: number;
  hx: number;
  hy: number;
  tx: number;
  ty: number;
  speed: number;
  pause: number;
  walked: number;
  rank: number;
  walker: Walker;
  rx: number;
  ry: number;
  sign: 1 | -1;
  carabao?: number;
};

/**
 * A train (config.ts `TRAIN`): one mover, its head at the front of the locomotive. Its cars sit
 * on the breadcrumbs the head leaves along the track, so they follow it round curves and
 * through junctions.
 */
export type Train = {
  /** Front to back. */
  cars: RailCraft[];
  /** Breadcrumbs behind the head, most recent first: x, y pairs in tile units. */
  trail: number[];
  /** At the end of the track: when its wait is over, it heads back the way it came. */
  reverse: boolean;
  /**
   * At the end of its tile's copy of the track, past the tile's edge: it waits there, hidden,
   * for `LifeWorld.step` to hand it to the next tile.
   */
  edge: boolean;
  /** Where it last stopped at a station (tile units), or NaN. */
  stopX: number;
  stopY: number;
};

/** A locomotive pulling `coaches`. */
const consist = (coaches: number): RailCraft[] => [
  'locomotive',
  ...Array<RailCraft>(coaches).fill('coach'),
];

/** A train of `cars` that hasn't moved yet. */
const newTrain = (cars: RailCraft[]): Train => ({
  cars,
  trail: [],
  reverse: false,
  edge: false,
  stopX: NaN,
  stopY: NaN,
});

/** A train's length, m: its cars and the couplings between them. */
export const trainLength = (cars: readonly RailCraft[]): number =>
  cars.reduce((sum, car) => sum + VEHICLES[car].length, 0) + (cars.length - 1) * TRAIN.coupling;

/**
 * The point `distance` along a polyline (x, y pairs), and the heading there, pointing back
 * toward the polyline's start; null past its end.
 */
export function alongTrail(
  points: readonly number[],
  distance: number,
): { x: number; y: number; hx: number; hy: number } | null {
  let left = distance;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const [ax, ay, bx, by] = [points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!];
    const length = Math.hypot(bx - ax, by - ay);
    if (length === 0) continue;
    if (left <= length) {
      const t = left / length;
      const [hx, hy] = [(ax - bx) / length, (ay - by) / length];
      return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, hx, hy };
    }
    left -= length;
  }
  return null;
}

/** A polyline (x, y pairs) cut to its first `length`. */
export function cutTrail(points: readonly number[], length: number): number[] {
  const out = points.slice(0, 2);
  let left = length;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const [ax, ay, bx, by] = [points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!];
    const segment = Math.hypot(bx - ax, by - ay);
    if (segment >= left) {
      const t = segment === 0 ? 0 : left / segment;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
      return out;
    }
    out.push(bx, by);
    left -= segment;
  }
  return out;
}

/** A parked vehicle: its position and heading (a unit vector) in tile units, kind, and paint. */
export type Parked = {
  x: number;
  y: number;
  hx: number;
  hy: number;
  vehicle: CraftType;
  paint: number;
};

export type Bird = {
  ox: number;
  oy: number;
  phase: number;
  /** Rendered offset retained when departing, independent of a replacement landing layout. */
  departure?: Point;
  /** Mouse-flushed birds retain their own position until their reaction begins. */
  takeoff?: Point & { delay: number; seconds: number; face: number };
  /** Independent airborne cursor avoidance, retaining position, heading and speed. */
  flight?: BirdFlight;
} & Partial<GroundForager>;

export type Flock = {
  species: BirdSpecies;
  /** The flock's center, in tile units. */
  x: number;
  y: number;
  /** Which way it last flew (a unit vector, tile units). */
  hx: number;
  hy: number;
  /** The roost it circles (an index into `roosts` pairs). */
  roost: number;
  /** The tree it flies to or sits in (an index into `perches` pairs), or -1. */
  perch: number;
  /** Sitting in that tree. */
  perched: boolean;
  /** Approaching a prepared suitable ground patch, and settled there (birds.ts `ground`). */
  landing: boolean;
  tapLanding?: true;
  landed: boolean;
  /** Feeding rather than resting during a ground visit. */
  feeding: boolean;
  /** Seconds left in the current feeding or ground-rest bout. */
  bout: number;
  /** Fixed landing-patch anchor, in tile units, retained through a tree rest. */
  lx: number;
  ly: number;
  /** Saved roost index for a tree return; -1 outside a committed tree rest. */
  home: number;
  /** Ground preparation was tried for this destination; bounds failed rain retries. */
  landingAttempted: boolean;
  /** Approach offset blend from 0 to 1; completed before touchdown. */
  landingBlend: number;
  /** Departure offset blend from 1 to 0, independent of approach preparation. */
  departureBlend?: number;
  /** Individual mouse-flush transitions share an elapsed clock, not a displacement. */
  takeoff?: Point & { age: number; seconds: number; extent: number };
  /** Bounds of independently flying members; absent during ordinary flock flight. */
  flightBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  /** Seconds left of scattering, after a gust flushed it out of a tree. */
  scatter: number;
  /** Circling: angle (radians), radius (tile units), and seconds until it moves on. */
  angle: number;
  radius: number;
  stay: number;
  rank: number;
  birds: Bird[];
};

/** Smooth acceleration after this bird's own mouse-flush reaction delay. */
function takeoffProgress(flock: Flock, bird: Bird) {
  if (!flock.takeoff || !bird.takeoff) return 1;
  const t = Math.max(
    0,
    Math.min(1, (flock.takeoff.age - bird.takeoff.delay) / bird.takeoff.seconds),
  );
  return t * t * (3 - 2 * t);
}

/** Scale of the current resting or scattered flight formation. */
function birdSpread(flock: Flock) {
  return flock.perched
    ? PERCH.spread / BIRD_SPECIES[flock.species].spread[1]
    : flock.landed
      ? 1
      : 1 + (3 * flock.scatter) / PERCH.scatter;
}

function birdTurn(flock: Flock, bird: Bird, wobble: number) {
  return flock.perched || flock.landed ? bird.phase * 6 : wobble + bird.phase * 6;
}

/** One bird's rendered offset from its flock centre, written into caller-owned storage. */
function birdOffset(flock: Flock, bird: Bird, turn: number, spread: number, out: Point) {
  if (bird.flight) {
    out.x = bird.flight.x - flock.x;
    out.y = bird.flight.y - flock.y;
    return;
  }
  birdFormationOffset(flock, bird, turn, spread, out);
}

/** Navigation and regrouping retain the normal formation while members fly independently. */
function birdFormationOffset(flock: Flock, bird: Bird, turn: number, spread: number, out: Point) {
  const cos = Math.cos(turn) * spread;
  const sin = Math.sin(turn) * spread;
  const ground = isForager(bird) && flock.landed;
  const blend = ground ? 1 : flock.landing ? flock.landingBlend : 0;
  const ox = bird.ox * cos - bird.oy * sin;
  const oy = bird.ox * sin + bird.oy * cos;
  let x = ox + ((bird.gx ?? ox) - ox) * blend;
  let y = oy + ((bird.gy ?? oy) - oy) * blend;
  if (bird.departure && flock.departureBlend) {
    x += (bird.departure.x - x) * flock.departureBlend;
    y += (bird.departure.y - y) * flock.departureBlend;
  }
  if (bird.takeoff && flock.takeoff) {
    const progress = takeoffProgress(flock, bird);
    x = (bird.takeoff.x - flock.x) * (1 - progress) + x * progress;
    y = (bird.takeoff.y - flock.y) * (1 - progress) + y * progress;
  }
  out.x = x;
  out.y = y;
}

function flyingBirdNear(flock: Flock, near: (x: number, y: number) => boolean) {
  if (flock.flightBounds)
    for (const bird of flock.birds) {
      if (bird.flight && near(bird.flight.x, bird.flight.y)) return true;
    }
  return false;
}

/** The agents of one tile. */
export class TileLife {
  tapRequests?: TapReactions;
  private tapDash?: WeakMap<Mover, number>;
  private tapWake?: WeakMap<Mover, number>;
  tapFeed?: FeedPoint;
  wake(m: Mover, clock: number) {
    m.pause = 0;
    m.lying = m.grooming = false;
    this.scenes.wake(m);
    (this.tapWake ??= new WeakMap()).set(m, clock + 2);
  }
  requestEmoji(
    owner: object,
    subject: EmojiSubject,
    mood: EmojiMood,
    clock: number,
    duration = 2.5,
    delay = 0,
    lifetime = 5,
  ) {
    (this.tapRequests ??= new TapReactions()).add(
      {
        owner,
        subject,
        mood,
        eligible: true,
        speaking: false,
        duration,
        expires: clock + delay + lifetime,
      },
      clock + delay,
    );
  }
  hurry(m: Mover, clock: number) {
    if (m.kind !== 'person') return;
    (this.tapDash ??= new WeakMap()).set(m, clock + 2);
    m.pause = 0;
  }
  emergencyRouter?: EmergencyRouter;
  /** Projection is local to this owner; geographic state survives seams and zoom changes. */
  private emergencyStops = new WeakMap<
    Mover,
    { target: string; line: number; dir: number; along: number; curb: number }
  >();
  emergencyArrival(m: Mover) {
    const state = m.emergency,
      target = state?.target && this.emergencyRouter?.targets.get(state.target);
    if (!target || !m.vehicle || this.geo.lineIds?.[m.line] !== hashString(target.road)) return;
    let stop = this.emergencyStops.get(m);
    if (!stop || stop.target !== target.id || stop.line !== m.line || stop.dir !== m.dir) {
      const p = lngLatToTile(this.tile, ...target.at),
        c = this.geo.coords;
      let best = 3 * this.perMeter,
        found: typeof stop;
      for (let v = this.geo.starts[m.line]!; v < this.geo.starts[m.line + 1]! - 1; v++) {
        const ax = c[v * 2]!,
          ay = c[v * 2 + 1]!,
          dx = c[v * 2 + 2]! - ax,
          dy = c[v * 2 + 3]! - ay;
        const length = Math.hypot(dx, dy);
        if (!length) continue;
        const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / length ** 2));
        const error = Math.hypot(p.x - ax - t * dx, p.y - ay - t * dy);
        const alignment = (target.tangent[0] * dx) / length - (target.tangent[1] * dy) / length;
        if (error > best || Math.abs(alignment) < Math.cos(Math.PI / 6)) continue;
        best = error;
        const side = -target.side * Math.sign(alignment * m.dir),
          bounds = this.roadShiftBounds(m);
        found = {
          target: target.id,
          line: m.line,
          dir: m.dir,
          along: this.along[v]! + t * length,
          curb: side > 0 ? bounds[1] : bounds[0],
        };
      }
      if (!found) return;
      this.emergencyStops.set(m, (stop = found));
    }
    const remaining = ((stop.along - this.along[m.from]! - m.dir * m.d) * m.dir) / this.perMeter;
    return remaining >= -0.3 ? { remaining, curb: stop.curb } : undefined;
  }
  readonly puffs = new PuffStore();
  readonly effects = new VehicleEffectTracker(this, () => this.routingSeed);
  private eligible = new Uint8Array(0);

  private captureEffects(
    clock: number,
    dt: number,
    env?: LifeEnv,
    shows?: (kind: AgentKind) => boolean,
    near?: (x: number, y: number) => boolean,
    pass?: StepPass,
  ) {
    const enabled = this.effects.begin(
      clock,
      dt,
      env?.effectCellMeters ?? 0,
      env?.wind,
      env?.nextSourceId,
    );
    const visits = this.scenes.visits.size > 0;
    const services = this.scenes.services.size > 0;
    const returned = this.scenes.hasReturnSteps;
    const movers = this.movers;
    if (this.eligible.length < movers.length) this.eligible = new Uint8Array(movers.length);
    const eligible = this.eligible;
    const unfiltered = !this.inspected && !pass?.owns && !shows && !near && !env?.levels && !visits;
    if (unfiltered) eligible.fill(1, 0, movers.length);
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i]!;
      if (!unfiltered)
        eligible[i] = Number(
          this.inspected !== m &&
            (!pass?.owns || pass.owns(m)) &&
            (!shows || shows(m.kind)) &&
            (!near || m.train || near(m.x, m.y)) &&
            (!env?.levels || m.train || m.rank < env.levels[m.kind]) &&
            (!visits || !this.scenes.visits.has(m)),
        );
      if (returned && this.scenes.usedReturnStep(m)) eligible[i] = 0;
      if (enabled) {
        if (this.inspected === m) {
          const state = vehicleEffects(m);
          if (state && state.inactiveAt === undefined) state.inactiveAt = clock - dt;
          continue;
        }
        this.effects.capture(m, i, !!eligible[i], this.speeds[i]!, this.caps[i]!, services);
      }
    }
  }

  finishEffects(
    clock: number,
    dt: number,
    wind: LifeEnv['wind'],
    owners?: ReadonlyMap<Mover, TileLife>,
  ) {
    this.effects.finish(clock, dt, wind, owners);
  }

  private readonly sharedRoadVertices = new Set<number>();
  private inspected?: object;
  readonly momentHost: MomentHost;
  readonly emoji: EmojiObserver;
  /** Observer events and ownership never enter physical flock state. */
  readonly startled: Flock[] = [];
  readonly birdEmojiOwners = new Set<Flock>();
  private pointerInside?: WeakSet<Flock>;
  private readonly emojiInputs: EmojiObservation[] = [];
  private readonly emojiInputPool: Partial<EmojiObservation>[] = [];
  private readonly walkerRng: () => number;
  private seamLimits?: StepPass['seams'];
  private adoptionGrid?: SegmentGrid;
  private ownership?: (p: { x: number; y: number }) => boolean;
  private readonly commerceStallsRng: () => number;
  private readonly commercePeopleRng: () => number;
  private commerceAdmitted = false;
  junctionIndex!: JunctionIndex;
  private readonly localJunctions = new JunctionTable();
  private readonly localJunctionTraffic = new JunctionTraffic();
  private readonly clearingJunctions = new Set<string>();
  private readonly clearingCrossings = new Set<string>();
  readonly junctionCrossings = new JunctionCrossings(this);
  private readonly junctionRequests: JunctionRequest[] = [];
  private junctionMover!: Mover;
  private junctionTable!: JunctionTable;
  private junctionTraffic!: JunctionTraffic;
  private junctionPedestrians: PedestrianView = EMPTY_PEDESTRIANS;
  private junctionClock = 0;
  private junctionTileKey = '';
  private junctionIndexInTile = 0;
  private junctionRoom = Infinity;
  private readonly junctionNext = (line: number, dir: 1 | -1) =>
    this.seamExit(this.junctionMover, line, dir);
  private readonly carriedReady = (movement: Movement) =>
    this.junctionAllowed(movement, this.junctionRoom);
  private readonly trafficGroups = new Map<number, number[]>();
  private roadRearReachM = 0;
  private urgentCount = 0;
  private readonly emergencyYielders = new Map<
    Mover,
    { source: Mover; behind: number; feasible: boolean }
  >();
  private readonly emergencyOffsets = new Map<Mover, number>();
  /** Accepted body headings include steering, so a yawed long nose cannot count as clear. */
  private emergencyPassFits(a: Mover, b: Mover) {
    const p = this.pose(a),
      q = this.pose(b),
      sa = VEHICLES[a.vehicle!],
      sb = VEHICLES[b.vehicle!];
    const separation = Math.abs((q.x - p.x) * -a.hy + (q.y - p.y) * a.hx) / this.perMeter;
    const width = (pose: { hx: number; hy: number }, spec: typeof sa) =>
      Math.abs(pose.hx * a.hx + pose.hy * a.hy) * spec.width +
      Math.abs(-pose.hy * a.hx + pose.hx * a.hy) * spec.length;
    return separation >= (width(p, sa) + width(q, sb)) / 2 + FOLLOW.roadGap + FOLLOW.lateralPad;
  }
  private readonly trafficGroupBuffers = new Map<number, number[]>();
  /** Aggregate controller counters for deterministic regression/performance fixtures. */
  readonly motionStats = { steps: 0, hardCaps: 0, waiting: 0 };
  private readonly recoveryProgress = new WeakMap<Mover, number>();
  private readonly blockedRestoration = new WeakMap<
    Mover,
    { line: number; dir: 1 | -1; x: number; y: number; hx: number; hy: number }
  >();
  private readonly recoveryLeaders = new Map<number, Mover>();
  private readonly blockedProgress = new WeakMap<
    Mover,
    { x: number; y: number; hx: number; hy: number; ordinary?: boolean }
  >();
  private readonly walkerRecoveryProgress = new WeakMap<
    Mover,
    { travelled: number; blocked: number }
  >();
  private readonly recoverySearchRetry = new WeakMap<Mover, number>();
  private readonly recoveryApproaches = new WeakMap<
    Mover,
    { line: number; from: number; dir: 1 | -1; d: number; shift: number; blocked?: number }
  >();
  signals!: SignalControl;
  crossingWaits!: CrossingWaits;
  private crossingClock = 0;
  private crossingMinimum = 0;
  private readonly crossingCursor = { x: 0, y: 0, hx: 0, hy: 0 };
  private readonly crossingTarget = { x: 0, y: 0 };
  scenes!: LocalScenes;
  private readonly catRng: () => number;
  private readonly runRng: () => number;
  private readonly rushRng: () => number;
  readonly movers: Mover[] = [];
  /** Inert seeds: never stepped, drawn, colliding, visiting sites or donating. */
  readonly pending: PendingSeed[] = [];
  birthCredit = 0;
  readonly flocks: Flock[] = [];
  private readonly flockPointer: FlockPointer = { x: 0, y: 0, cellMeters: 0 };
  private readonly flockDetour: Point = { x: 0, y: 0 };
  private readonly birdOffset: Point = { x: 0, y: 0 };
  private readonly birdFlightStep: BirdFlightStep = { dt: 0, targetX: 0, targetY: 0, speed: 0 };
  private readonly birdFlightPointer = { x: 0, y: 0, reach: 0 };
  readonly parked: Parked[] = [];
  /** Trains standing by on sidings: one entry per car (`spawnStandby`). */
  readonly standby: Parked[] = [];
  /** Street vendors with their carts (`spawnStalls`). */
  readonly stalls: Stall[] = [];
  /** Temporary carts use their own population and never consume legacy random streams. */
  readonly seasonalStalls: Stall[] = [];
  private seasonalCandidates?: readonly Stall[];
  private suppressedGround?: {
    movers: SuppressedActors<Mover>;
    gatherers: SuppressedActors<Gatherer>;
    stalls: SuppressedActors<Stall>;
    parked: SuppressedActors<Parked>;
  };
  eventPopulation = 0;
  get population() {
    return (
      this.movers.length + (this.suppressedGround?.movers.hidden.length ?? 0) + this.eventPopulation
    );
  }
  get hasSuppressedActors() {
    return (
      !!this.suppressedGround &&
      Object.values(this.suppressedGround).some((state) => state.hidden.length > 0)
    );
  }
  *residentMovers() {
    yield* this.movers;
    yield* this.suppressedGround?.movers.hidden ?? [];
  }
  reconcileSeasonalActors(
    blocked: (owner: GroundAgent) => boolean,
    parkedBlocked: (owner: Parked) => boolean,
    active: boolean,
  ) {
    if (!active && !this.hasSuppressedActors) return;
    const state = (this.suppressedGround ??= {
      movers: suppressedActors<Mover>(),
      gatherers: suppressedActors<Gatherer>(),
      stalls: suppressedActors<Stall>(),
      parked: suppressedActors<Parked>(),
    });
    reconcileActors(
      this.stalls,
      state.stalls,
      blocked,
      (stall) => this.scenes.removeStall(stall),
      (stall) => this.scenes.addStall(stall),
    );
    reconcileActors(this.gatherers, state.gatherers, blocked);
    reconcileActors(
      this.movers,
      state.movers,
      (m) => (m.kind === 'vehicle' || isWalker(m.kind)) && blocked(m),
      (m) => this.scenes.release(m),
    );
    reconcileActors(this.parked, state.parked, parkedBlocked);
  }

  *allStalls() {
    yield* this.stalls;
    yield* this.seasonalStalls;
  }

  clearSeasonalStalls(limit = 0) {
    while (this.seasonalStalls.length > limit) this.scenes.removeStall(this.seasonalStalls.pop()!);
  }

  admitSeasonalStalls(
    config: NonNullable<SimulationSeason['stalls']>,
    anchors: readonly SeasonAnchor[],
    guard: GroundGuard,
  ) {
    const near = seasonProximity(
      this.tile,
      anchors,
      config.near,
      config.radius_m,
      seasonMarkets(config.near),
    );
    const limit = Math.min(config.per_tile, Math.max(0, MAX_TILE_AGENTS - this.population));
    for (const stall of (this.seasonalCandidates ??= this.prepareSeasonalCandidates())) {
      if (this.seasonalStalls.length >= limit) break;
      if (
        this.seasonalStalls.includes(stall) ||
        !near(stall.x, stall.y) ||
        !this.canIdle(stall) ||
        !guard(stall)
      )
        continue;
      this.seasonalStalls.push(stall);
      this.scenes.addStall(stall);
    }
  }

  private prepareSeasonalCandidates(): Stall[] {
    const rng = random(this.routingSeed ^ 0x3c6ef372);
    const result: Stall[] = [];
    const paints = VEHICLES.cart.paints;
    for (let line = 0; line < this.geo.kinds.length; line++) {
      const kind = this.geo.kinds[line]!;
      if (kind !== LifeLine.path && kind !== LifeLine.plaza) continue;
      const length = this.along[this.last(line)]!;
      if (!length) continue;
      const candidates = Math.min(96, Math.max(1, Math.ceil(length / this.perMeter / 12)));
      for (let n = 0; n < candidates; n++) {
        const p = this.pointAt(line, ((n + rng()) / candidates) * length);
        const side = rng() < 0.5 ? 1 : -1;
        const offset = VENDORS.beside * this.perMeter * side;
        const stall: Stall = {
          x: p.x - p.hy * offset,
          y: p.y + p.hx * offset,
          hx: p.hx,
          hy: p.hy,
          side,
          paint: paints[Math.floor(rng() * paints.length)]!,
          shirt: SHIRT_PAINTS[Math.floor(rng() * SHIRT_PAINTS.length)]!,
          rank: rng(),
        };
        if (inTile(stall)) result.push(stall);
      }
    }
    return result;
  }
  /** People at places: churches, schools, pitches, benches, fields (`spawnGatherers`). */
  readonly gatherers: Gatherer[] = [];
  private seasonalGatherersAdmitted = false;
  get ordinaryGatherers(): readonly Gatherer[] {
    return this.seasonalGatherersAdmitted
      ? this.gatherers.filter((g) => !g.seasonal)
      : this.gatherers;
  }

  /** A zoom transfer commits only after a detached preview passes every admission check. */
  projectFrom(m: Mover, source: TileLife, options: AdoptionOptions = {}): Mover | undefined {
    this.adoptionGrid ??= new SegmentGrid(this.geo, this.perMeter);
    return projectMover(this, source, m, this.adoptionGrid, options);
  }

  adoptFrom(
    m: Mover,
    source: TileLife,
    options: AdoptionOptions = {},
    admit?: (preview: Mover) => boolean,
  ): boolean {
    const replace = options.replace;
    if (source === this || !source.movers.includes(m)) {
      options.reject?.('ownership');
      return false;
    }
    if (
      !source.scenes.transferable(m) ||
      (replace && (!this.movers.includes(replace) || !this.scenes.transferable(replace)))
    ) {
      options.reject?.('localScene');
      return false;
    }
    if (this.population - (replace ? 1 : 0) >= MAX_TILE_AGENTS) {
      options.reject?.('capQuota');
      return false;
    }
    const preview = this.projectFrom(m, source, options);
    const clock = options.crossingClock ?? source.crossingClock;
    const minimum = options.crossingMinimum ?? source.crossingMinimum;
    if (
      !preview ||
      !this.crossingWaits.permits(preview, undefined, clock, minimum) ||
      (admit && !admit(preview))
    )
      return false;
    if (replace) this.release(replace);
    this.emoji.adopt(m, source.emoji);
    source.release(m, true);
    m.line = preview.line;
    m.from = preview.from;
    m.dir = preview.dir;
    m.d = preview.d;
    m.x = preview.x;
    m.y = preview.y;
    m.hx = preview.hx;
    m.hy = preview.hy;
    m.speed = preview.speed;
    m.v = preview.v;
    m.roadShift = preview.roadShift;
    m.roadSteering = preview.roadSteering;
    if (
      m.chosenLane !== undefined ||
      m.lat !== undefined ||
      m.latYaw !== undefined ||
      m.maneuver ||
      m.lanePatience !== undefined ||
      m.laneCooldown !== undefined ||
      m.filterRetry !== undefined ||
      m.roadScan !== undefined
    ) {
      m.chosenLane = preview.chosenLane;
      m.lat = preview.lat;
      m.latYaw = preview.latYaw;
      m.maneuver = preview.maneuver;
      m.laneSignal = preview.laneSignal;
      m.lanePatience = preview.lanePatience;
      m.laneCooldown = preview.laneCooldown;
      m.filterRetry = preview.filterRetry;
      m.roadScan = preview.roadScan;
    }
    m.curveLengthM = preview.curveLengthM;
    m.curveCorner = preview.curveCorner;
    m.next = preview.next;
    m.came = preview.came;
    m.entered = preview.entered;
    m.junctionRoute = preview.junctionRoute;
    m.waiting = preview.waiting;
    m.rush = preview.rush;
    if ((m.rush ?? 0) > 0)
      for (const resident of this.residentMovers())
        if ((resident.rush ?? 0) > 0) {
          m.rush = 0;
          break;
        }
    m.crossingWait = preview.crossingWait;
    m.routing = preview.routing;
    m.train = preview.train;
    this.movers.push(m);
    if (source.crossingWaits.registry !== this.crossingWaits.registry && m.crossingWait?.waiting)
      source.crossingWaits.registry.release(m.crossingWait.waiting.owner);
    this.crossingWaits.accept(m, undefined, clock, minimum);
    this.effects.adopt(m);
    return true;
  }

  release(m: Mover, transferring = false): void {
    if (!transferring) this.crossingWaits.release(m);
    this.emoji.release(m);
    const index = this.movers.indexOf(m);
    if (index >= 0) this.movers.splice(index, 1);
    if (m.emergency && this.suppressedGround) {
      const hidden = this.suppressedGround.movers.hidden;
      const at = hidden.indexOf(m);
      if (at >= 0) hidden.splice(at, 1);
    }
    this.scenes.release(m);
    this.localJunctions.release(m);
    this.recoveryApproaches.delete(m);
    this.blockedProgress.delete(m);
    this.blockedRestoration.delete(m);
    this.walkerRecoveryProgress.delete(m);
    this.recoveryProgress.delete(m);
    this.recoverySearchRetry.delete(m);
    if (this.recoveryLeaders.get(m.line) === m) this.recoveryLeaders.delete(m.line);
  }

  /** Suspend leadership without discarding a frozen actor's checked retreat target. */
  prepareRecovery(active?: (m: Mover) => boolean, inspecting: object | undefined = this.inspected) {
    if (!this.recoveryLeaders.size) return;
    for (const [line, leader] of this.recoveryLeaders) {
      const index = this.movers.indexOf(leader);
      if (
        index < 0 ||
        leader.line !== line ||
        leader === inspecting ||
        !(active ? active(leader) : this.eligible[index])
      )
        this.recoveryLeaders.delete(line);
    }
  }
  /** Tile units per meter. */
  readonly perMeter: number;
  roadTerrain!: PreparedRoadTerrain;
  private idleGuard?: (owner: GroundAgent) => boolean;
  private readonly idleBodies: Body[] = [];
  private readonly rng: () => number;
  private readonly routingSeed: number;
  private readonly routeRng: () => number;
  /** Scratch for `followSpeeds`, by mover: its speed, progress along its line, and offset. */
  private speeds = new Float64Array(0);
  private caps = new Float64Array(0);
  private progress = new Float64Array(0);
  private offsets = new Float64Array(0);
  private followLeaders = new Int32Array(0);
  private followTargets = new Float64Array(0);
  /** How people look and where vendors stand: its own stream, so no one else moves for it. */
  private readonly looks: () => number;
  /** People at places: their own stream, so no one else moves for them. */
  private readonly placeRng: () => number;
  private readonly visitorsRng: () => number;
  private readonly congregationsRng: () => number;
  private gathererRng(g: Gatherer) {
    return g.seasonal === 'visitors'
      ? this.visitorsRng
      : g.seasonal === 'congregations'
        ? this.congregationsRng
        : this.placeRng;
  }
  /** Birds' species, landings, and bats: their own stream, so no one else moves for them. */
  private readonly birdRng: () => number;
  /** Ground choices cannot change flight, traffic, or walking random streams. */
  private readonly forageRng: () => number;
  private forageTerrain?: ForageTerrain;
  private forageGuard?: (from: Point, to: Point) => boolean;
  private readonly forageContext: ForageContext & {
    species: BirdSpecies;
    habitat: Habitat;
    terrain?: ForageTerrain;
  } = {
    x: 0,
    y: 0,
    lx: 0,
    ly: 0,
    perMeter: 1,
    species: 'pigeon',
    habitat: Habitat.park,
    ok: (from, to) => {
      this.forageCheckCount++;
      const { species, habitat, terrain, perMeter } = this.forageContext;
      return (
        !!terrain &&
        forageMovement(species, habitat, from, to, terrain, perMeter) &&
        (!this.forageGuard || this.forageGuard(from, to))
      );
    },
  };
  private forageCheckCount = 0;
  /** Includes centre/layout candidates and complete ground movement validations. */
  get forageChecks() {
    return this.forageCheckCount;
  }

  /** Seasonal footprints change independently of immutable tile terrain. */
  setForageGuard(guard: ((from: Point, to: Point) => boolean) | undefined) {
    this.forageGuard = guard;
    if (!guard) return;
    for (const flock of this.flocks) {
      if (!flock.landed && !flock.landing) continue;
      let unsafe = false;
      for (const bird of flock.birds) {
        if (!isForager(bird)) continue;
        const p = {
          x: (flock.landing ? flock.lx : flock.x) + bird.gx,
          y: (flock.landing ? flock.ly : flock.y) + bird.gy,
        };
        const to = {
          x: (flock.landing ? flock.lx : flock.x) + bird.tx,
          y: (flock.landing ? flock.ly : flock.y) + bird.ty,
        };
        this.forageCheckCount++;
        if (!guard(p, to)) {
          const moving = bird.tx !== bird.gx || bird.ty !== bird.gy;
          if (moving) this.forageCheckCount++;
          if (!moving || !guard(p, p)) unsafe = true;
          else {
            bird.tx = bird.gx;
            bird.ty = bird.gy;
          }
        }
      }
      if (unsafe) {
        this.beginDeparture(flock);
        flock.landed = false;
        this.pickDestination(flock, { prepare: false });
        flock.perch = -1;
        flock.landing = false;
        flock.landingAttempted = false;
        flock.scatter = PERCH.scatter;
      }
    }
  }
  /** Dogs: their own stream, so no one else moves for them. */
  private readonly dogRng: () => number;
  /** Road lines with vehicles parked along their curbs; traffic drives on what is left. */
  private readonly parkingLines = new Set<number>();
  private readonly roadVertices = new Map<number, { code: number; vertex: number }[]>();
  /** Per vertex, the distance along its line from the line's first vertex, in tile units. */
  private readonly along: Float64Array;
  /** Line ends by packed position, holding line * 2 + (0 start, 1 end). */
  private readonly ends = new Map<number, number[]>();
  private readonly exitHeading = new Float64Array(4);
  private readonly seamExitOptions: number[] = [];
  private readonly curvable: Uint8Array;
  /** Fixed obstacles lanes bend around (`setLaneTerrain`); none without a world guard. */
  private laneTerrain?: LaneTerrain;
  /** Lane bends by line, direction, vehicle and lane; null when the ordinary lane is clear. */
  private readonly laneBends = new Map<number, Float32Array | null>();
  private readonly bendIntervals = new WeakMap<Float32Array, readonly [number, number]>();
  /** Per line: 0 not yet looked at, 1 no fixed obstacle anywhere near it, 2 some near it. */
  private laneNear: Uint8Array = new Uint8Array(0);
  /** The same per vertex, for corner curves (`clearCorner`). */
  private cornerNear: Uint8Array = new Uint8Array(0);
  /** Corner curves already checked against fixed obstacles (`clearCorner`). */
  private readonly clearCorners = new Map<string, Curve | null>();
  private transientCorners = new WeakMap<Mover, { key: string; curve: Curve | undefined }>();
  private laneQueryRegion?: readonly [number, number, number, number];
  /** Decisions made after line entry are shared by this mover's clearance retries. */
  private readonly enteredExits = new Map<number, number>();
  private time = 0;
  private junctions: { x: number; y: number; radius: number }[] = [];

  pedestrianCrossings!: PedestrianCrossings;
  private readonly pathScratch: { cursor: Mover; at: Pose; next: Pose }[] = [];
  private readonly pedestrianPose: Pose = { x: 0, y: 0, hx: 1, hy: 0 };
  private readonly followingPose: Pose = { x: 0, y: 0, hx: 1, hy: 0 };
  private readonly leaderPose: Pose = { x: 0, y: 0, hx: 1, hy: 0 };
  private readonly envelopePose: Pose = { x: 0, y: 0, hx: 1, hy: 0 };
  private readonly followingEnvelopes: { length: number; width: number }[] = [];
  private readonly followingEnvelopeEpochs: number[] = [];
  private followingEnvelopeEpoch = 0;
  private readonly followingManeuverOffsets: number[] = [];
  private readonly followingManeuverEpochs: number[] = [];
  /** Borrowed only by the synchronous physical query; generator/cache results remain detached. */
  private readonly straightSegments: PedestrianSegment[] = [
    { x: 0, y: 0, hx: 1, hy: 0, length: 0, ahead: 0, line: 0 },
  ];
  private stoppedPaths?: WeakMap<
    Mover,
    {
      at: Pick<
        Mover,
        | 'x'
        | 'y'
        | 'hx'
        | 'hy'
        | 'line'
        | 'from'
        | 'dir'
        | 'd'
        | 'lane'
        | 'chosenLane'
        | 'lat'
        | 'latYaw'
        | 'maneuver'
        | 'roadShift'
        | 'roadYaw'
        | 'came'
        | 'next'
        | 'curveLengthM'
        | 'curveCorner'
        | 'entered'
      >;
      exit: number | undefined;
      route: Mover['junctionRoute'];
      range: number;
      physicalRange: number;
      segments: PedestrianSegment[];
    }
  >;

  constructor(
    readonly tile: TileId,
    readonly geo: LifeGeometry,
    seed: number,
    private readonly traffic: ResolvedTraffic = resolveTraffic(),
    deferred = false,
    momentOptions?: MomentOptions,
    private readonly forageMode: ForageMode = 'standalone',
    emojiOptions?: EmojiObserverOptions,
  ) {
    this.perMeter = 1 / metersPerUnit(tile);
    this.rng = random(seed);
    this.walkerRng = random(seed ^ 0x3c6ef372);
    this.routingSeed = seed;
    this.routeRng = random(seed ^ 0x2545f491);
    this.looks = random(seed ^ 0xc2b2ae35);
    this.placeRng = random(seed ^ 0x27d4eb2f);
    this.visitorsRng = random(seed ^ 0x63a8f127);
    this.congregationsRng = random(seed ^ 0x4e19b6cd);
    this.birdRng = random(seed ^ 0x165667b1);
    this.forageRng = random(seed ^ 0x4f1bbcdc);
    this.dogRng = random(seed ^ 0xd3a2646c);
    this.catRng = random(seed ^ 0x68e31da4);
    this.runRng = random(seed ^ 0xcc9e2d51);
    this.rushRng = random(seed ^ 0x5a17d3e9);
    this.commerceStallsRng = random(seed ^ 0xa24baed5);
    this.commercePeopleRng = random(seed ^ 0x9fb21c65);
    const lines = geo.kinds.length;
    this.along = new Float64Array(geo.coords.length / 2);
    this.curvable = new Uint8Array(lines);
    this.momentHost = new MomentHost(this, seed, momentOptions);
    this.emoji = new EmojiObserver(seed, this.perMeter, emojiOptions);
    if (!deferred) complete(this.prepare());
  }

  /** The instance remains private to its preparation job until this iterator completes. */
  *prepare(): Generator<void, TileLife, void> {
    const { tile, geo, routingSeed: seed } = this;
    const lines = geo.kinds.length;
    const recordRoadVertex = sharedRoadVertexRecorder(
      geo.coords,
      geo.kinds,
      this.sharedRoadVertices,
    );
    this.roadTerrain = yield* prepareRoadTerrainSteps(geo, this.perMeter);
    if (geo.roosts.length)
      this.forageTerrain = yield* prepareForageTerrainSteps(geo, this.perMeter, this.forageMode);
    for (let line = 0; line < lines; line++) {
      this.addEnd(this.first(line), line * 2);
      this.addEnd(this.last(line), line * 2 + 1);
      recordRoadVertex(this.first(line), line);
      for (let v = this.first(line) + 1; v <= this.last(line); v++) {
        recordRoadVertex(v, line);
        this.along[v] = this.along[v - 1]! + this.segment(v - 1, v);
        if ((v & 127) === 0) yield;
      }
      if (geo.kinds[line]! <= LifeLine.roadMinor) {
        for (let v = this.first(line); v <= this.last(line); v++) {
          const key = this.endKey(v),
            list = this.roadVertices.get(key) ?? [];
          if (v < this.last(line)) list.push({ code: line * 2, vertex: v });
          if (v > this.first(line)) list.push({ code: line * 2 + 1, vertex: v });
          this.roadVertices.set(key, list);
        }
      }
      yield;
    }
    for (let line = 0; line < lines; line++)
      this.curvable[line] = Number(
        this.last(line) - this.first(line) > 1 ||
          (this.ends.get(this.endKey(this.first(line)))?.length ?? 0) > 1 ||
          (this.ends.get(this.endKey(this.last(line)))?.length ?? 0) > 1 ||
          (this.roadVertices.get(this.endKey(this.first(line)))?.length ?? 0) > 1 ||
          (this.roadVertices.get(this.endKey(this.last(line)))?.length ?? 0) > 1,
      );
    this.signals = new SignalControl(tile, geo, this.perMeter, this.along, true);
    yield* this.signals.prepare(tile, geo);
    this.crossingWaits = new CrossingWaits(
      geo,
      this.perMeter,
      (owner, minimum, natural, cursor) =>
        this.groundBodies(
          natural && 'crossingWait' in owner ? { ...owner, crossingWait: undefined } : owner,
          minimum,
          undefined,
          owner,
          cursor,
        ),
      this.roadTerrain.access,
      (owner, minimum) => this.crossingRadius(owner, minimum),
    );
    const crossings = new PedestrianCrossings(tile, this.perMeter);
    this.pedestrianCrossings = crossings;
    yield* crossings.prepare(geo, this.signals);
    this.junctionIndex = new JunctionIndex(tile, geo, this.perMeter, this.along, true);
    yield* this.junctionIndex.prepare(tile);
    this.junctionCrossings.prepare([this]);
    // Parking first, on its own random stream: it narrows the lanes, but doesn't change who
    // else is out.
    yield* this.findJunctions();
    yield* this.spawnParked(random(seed ^ 0x9e3779b9));
    yield* this.spawnStandby(random(seed ^ 0x85ebca6b));
    for (let line = 0; line < lines;) {
      const { end } = this.populationRange(line);
      yield* this.spawnOn(line, false, end);
      line = end;
    }
    // Dogs last, on their own stream: they don't change who else is out.
    for (let line = 0; line < lines;) {
      const kind = geo.kinds[line];
      const end =
        kind === LifeLine.path || kind === LifeLine.plaza
          ? this.populationRange(line).end
          : line + 1;
      yield* this.spawnOn(line, true, end);
      line = end;
    }
    yield* this.spawnStalls();
    yield* this.spawnGatherers();
    yield* this.spawnFlocks();
    this.scenes = new LocalScenes(
      geo,
      this.perMeter,
      seed,
      this.stalls,
      (m) => this.canIdle(m),
      (m) => this.momentHost.moments.busy(m),
      true,
    );
    yield* this.scenes.prepare(geo, this.stalls);
    yield* this.spawnCats();
    return this;
  }

  private first(line: number) {
    return this.geo.starts[line]!;
  }

  private last(line: number) {
    return this.geo.starts[line + 1]! - 1;
  }

  private endKey(vertex: number) {
    return vertexKey(this.geo.coords[vertex * 2]!, this.geo.coords[vertex * 2 + 1]!);
  }

  private addEnd(vertex: number, code: number) {
    const key = this.endKey(vertex);
    const list = this.ends.get(key);
    if (list) list.push(code);
    else this.ends.set(key, [code]);
  }

  /** Connected road ends are off-screen entrances, never in-view replacement spawn points. */
  continuesRoad(line: number, atStart: boolean): boolean {
    const vertex = atStart ? this.first(line) : this.last(line);
    const endpoint = line * 2 + (atStart ? 0 : 1);
    return (
      (this.sharedRoadVertices.has(this.endKey(vertex)) ||
        this.ends
          .get(this.endKey(vertex))
          ?.some(
            (code) => code !== endpoint && this.geo.kinds[code >> 1]! <= LifeLine.roadMinor,
          )) ??
      false
    );
  }

  private segment(a: number, b: number) {
    const { coords } = this.geo;
    return Math.hypot(coords[b * 2]! - coords[a * 2]!, coords[b * 2 + 1]! - coords[a * 2 + 1]!);
  }

  /** A line's length in tile units. */
  lineLength(line: number) {
    return this.along[this.last(line)]!;
  }

  populationRange(line: number): { first: number; end: number } {
    let first = line;
    let end = line + 1;
    const group = this.geo.spawnGroups?.[line];
    while (group !== undefined && first > 0 && this.geo.spawnGroups![first - 1] === group) first--;
    while (
      group !== undefined &&
      end < this.geo.kinds.length &&
      this.geo.spawnGroups![end] === group
    )
      end++;
    return { first, end };
  }

  /** Combined length of a population's contiguous routing pieces, in tile units. */
  populationLength(first: number, end: number): number {
    let length = 0;
    for (let piece = first; piece < end; piece++) length += this.lineLength(piece);
    return length;
  }

  /** Locate a distance measured from the chosen end of a population line. */
  populationPiece(first: number, end: number, distance: number, dir: 1 | -1) {
    let line = dir === 1 ? first : end - 1;
    for (let count = 1; count < end - first; count++) {
      const length = this.lineLength(line);
      if (distance < length) break;
      distance -= length;
      line += dir;
    }
    return { line, distance };
  }

  /**
   * A crossing, or another short walking line, joined to no other walking line at either end (no
   * mapped sidewalk): nobody lives there, or they would only pace back and forth across the road.
   */
  private strandedWalk(line: number): boolean {
    const kind = this.geo.kinds[line]!;
    if (kind !== LifeLine.path && kind !== LifeLine.plaza) return false;
    const range = this.populationRange(line);
    if (
      this.populationLength(range.first, range.end) / this.perMeter >= STRANDED_WALK_M &&
      !this.crossingLine(range.first)
    )
      return false;
    const joined = (atStart: boolean) => {
      const v = atStart ? this.first(range.first) : this.last(range.end - 1);
      const x = this.geo.coords[v * 2]!,
        y = this.geo.coords[v * 2 + 1]!;
      // Cut at the tile's edge, it goes on in the next tile.
      if (x <= 0 || y <= 0 || x >= EXTENT || y >= EXTENT) return true;
      return (
        this.ends
          .get(this.endKey(v))
          ?.some(
            (code) =>
              (code >> 1 < range.first || code >> 1 >= range.end) &&
              !this.geo.navigationOnly?.[code >> 1] &&
              (this.geo.kinds[code >> 1] === LifeLine.path ||
                this.geo.kinds[code >> 1] === LifeLine.plaza),
          ) ?? false
      );
    };
    return !joined(true) && !joined(false);
  }

  /**
   * Crossing stripes by centre, with how far they reach across the road: raster/geometry.ts
   * centres each crossing's walking line on its stripes, `CROSSING_WALK_PAST_M` beyond them.
   */
  private crossingReach?: Map<number, Point[]>;

  /** Whether a walking line is a crossing's own: two points, centred on its stripes. */
  private crossingLine(line: number): boolean {
    if (this.last(line) - this.first(line) !== 1) return false;
    if (!this.crossingReach) {
      this.crossingReach = new Map();
      for (const area of this.geo.areas ?? []) {
        const ring = area.rings[0];
        if (area.kind !== 'crossing' || !ring || ring.length < 4) continue;
        let x = 0,
          y = 0;
        for (let i = 0; i < 4; i++) {
          x += ring[i]!.x / 4;
          y += ring[i]!.y / 4;
        }
        this.crossingReach.set(vertexKey(Math.round(x), Math.round(y)), ring.slice(0, 4));
      }
    }
    const c = this.geo.coords,
      a = this.first(line);
    const x = (c[a * 2]! + c[a * 2 + 2]!) / 2,
      y = (c[a * 2 + 1]! + c[a * 2 + 3]!) / 2;
    const ring = this.crossingReach.get(vertexKey(Math.round(x), Math.round(y)));
    if (!ring) return false;
    const half = this.lineLength(line) / 2;
    const hx = (c[a * 2 + 2]! - c[a * 2]!) / (2 * half),
      hy = (c[a * 2 + 3]! - c[a * 2 + 1]!) / (2 * half);
    let reach = 0;
    for (const p of ring) reach = Math.max(reach, Math.abs((p.x - x) * hx + (p.y - y) * hy));
    return Math.abs(half - reach - CROSSING_WALK_PAST_M * this.perMeter) < 0.5 * this.perMeter;
  }

  /** Spawn the movers of `line`: its dogs with `dogs`, else everyone else. */
  private *spawnOn(line: number, dogs = false, endLine = line + 1): Generator<void, void, void> {
    if (this.geo.navigationOnly?.[line]) return;
    const kind = this.geo.kinds[line]! as LifeLine;
    const rules = spawnRules[kind];
    const road = trafficRoadFor[kind];
    const length = this.populationLength(line, endLine);
    const meters = length / this.perMeter;
    if (!rules || meters === 0) return;
    const rng = dogs ? this.dogRng : this.rng;
    for (const rule of rules) {
      // Cats spawn last on their own stream and with their own tile cap.
      if (rule.kind === 'cat') continue;
      if ((rule.kind === 'dog') !== dogs) continue;
      const count = Math.floor(meters / rule.spacing + rng());
      for (let i = 0; i < count && this.population < MAX_TILE_AGENTS; i++) {
        yield;
        let dir: 1 | -1 = rng() < 0.5 ? 1 : -1;
        const flow = this.geo.oneway?.[line];
        if (rule.kind === 'vehicle' && flow) dir = flow === 1 ? 1 : -1;
        let speed = between(rng, rule.speed);
        let vehicle: CraftType | undefined;
        let paint = 0;
        let lane = 0;
        let train: Train | undefined;
        if (rule.kind === 'train') {
          const cars = consist(Math.round(between(rng, TRAIN.coaches)));
          paint = TRAIN_PAINTS[Math.floor(rng() * TRAIN_PAINTS.length)]!;
          train = newTrain(cars);
        }
        if ((rule.kind === 'vehicle' || rule.kind === 'boat') && road) {
          vehicle = pickVehicle(this.traffic[road], rng());
          const spec = VEHICLES[vehicle];
          speed = Math.min(speed * spec.speed, spec.maxSpeed ?? Infinity);
          paint = spec.paints[Math.floor(rng() * spec.paints.length)]!;
          if (rule.kind === 'vehicle') lane = rng();
        }
        if (rule.kind === 'dog') paint = DOG_PAINTS[Math.floor(rng() * DOG_PAINTS.length)]!;
        const mover: Mover = {
          kind: rule.kind,
          line,
          from: dir === 1 ? this.first(line) : this.last(line),
          dir,
          d: 0,
          speed: speed * this.perMeter,
          vehicle,
          paint,
          lane,
          pause: 0,
          rank: rng(),
          x: 0,
          y: 0,
          hx: 1,
          hy: 0,
          train,
        };
        if (mover.kind === 'vehicle' && hasTurnSignals(vehicle))
          mover.routing = this.newRouting(this.movers.length);
        if (rule.kind === 'person') {
          mover.group = this.spawnGroup();
          // Somewhere in their stride, so a crowd doesn't step in time.
          mover.walked = this.looks() * 2 * PEOPLE.stride;
        }
        if (rule.kind === 'dog') mover.walked = rng() * 2 * DOG.stride;
        // Routing splits keep the original population and random draws in their original order.
        const position = this.populationPiece(line, endLine, rng() * length, dir);
        mover.line = position.line;
        mover.from = dir === 1 ? this.first(position.line) : this.last(position.line);
        this.advance(mover, position.distance, false);
        if (rule.kind === 'vehicle' && !this.junctionIndex.canSpawnVehicle(mover)) continue;
        // A train pulls in until the track behind it holds all its cars.
        if (train) {
          this.moveTrain(mover, trainLength(train.cars) * this.perMeter);
          mover.pause = 0;
        }
        if (
          rule.kind !== 'person' ||
          (usableLines.person.includes(kind) && !this.strandedWalk(position.line))
        )
          this.movers.push(mover);
      }
    }
  }

  /** A road line's width for driving: less the parking strips along its curbs, if any. */
  private roadWidth(line: number) {
    const width = this.geo.widths[line] || DEFAULT_ROAD_WIDTH_M;
    return this.parkingLines.has(line) ? width - 2 * PARKED.strip : width;
  }

  /** The same driving width used by poses, including retained parking strip decisions. */
  directionalLanes(line: number) {
    return laneLayout(this.roadWidth(line), this.geo.oneway?.[line] ?? 0);
  }

  private shiftedOffset(m: Mover, offset: number, line = m.line): number {
    if (m.roadShift === undefined) return offset;
    const [minimum, maximum] = this.roadShiftBounds(m, line);
    return Math.max(minimum, Math.min(maximum, offset + m.roadShift));
  }

  private roadShiftBounds(m: Mover, line = m.line): readonly [number, number] {
    return this.laneBounds(VEHICLES[m.vehicle!].width, line);
  }

  /**
   * Where a vehicle may drive to clear a fixed obstacle, m right of the centre line: the whole
   * road, as a driver passes a curb across the centre line when it must (the guard still keeps
   * it off oncoming traffic). Inferred widths get `ROAD_AVOID.shoulder` at the edge.
   */
  private laneBounds(width: number, line: number): readonly [number, number] {
    const edge = Math.max(0, this.roadWidth(line) / 2 - width / 2 + ROAD_AVOID.shoulder);
    return [-edge, edge];
  }

  /** Points in travel order for lane bends, metres apart from the line's own vertices. */
  private travelPoints(line: number, dir: 1 | -1): Float64Array {
    const first = this.first(line),
      last = this.last(line);
    const out = new Float64Array((last - first + 1) * 2);
    const c = this.geo.coords;
    for (let i = 0, v = dir === 1 ? first : last; i <= last - first; i++, v += dir) {
      out[i * 2] = c[v * 2]!;
      out[i * 2 + 1] = c[v * 2 + 1]!;
    }
    return out;
  }

  /** Lane bends follow the movement guard's fixed obstacles; set by the world with its terrain. */
  setLaneTerrain(terrain: LaneTerrain | undefined) {
    if (terrain === this.laneTerrain) return;
    this.laneTerrain = terrain;
    this.laneBends.clear();
    this.clearCorners.clear();
    this.transientCorners = new WeakMap();
    this.laneNear = new Uint8Array(this.geo.kinds.length);
    this.cornerNear = new Uint8Array(this.geo.coords.length / 2);
  }

  /** All lane and corner queries fit inside these tile-metre bounds. Geometry is immutable. */
  laneQueryBounds(): readonly [number, number, number, number] {
    if (this.laneQueryRegion) return this.laneQueryRegion;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let line = 0; line < this.geo.kinds.length; line++) {
      if (this.geo.kinds[line]! > LifeLine.roadMinor) continue;
      const reach =
        this.roadWidth(line) / 2 + ROAD_AVOID.shoulder + LONGEST_ROAD_VEHICLE_M + FILLET_RUN_ON_M;
      for (let v = this.first(line); v <= this.last(line); v++) {
        const x = this.geo.coords[v * 2]! / this.perMeter,
          y = this.geo.coords[v * 2 + 1]! / this.perMeter;
        x0 = Math.min(x0, x - reach);
        y0 = Math.min(y0, y - reach);
        x1 = Math.max(x1, x + reach);
        y1 = Math.max(y1, y + reach);
      }
    }
    return (this.laneQueryRegion = [x0, y0, x1, y1]);
  }

  /** How a vehicle's lane bends around fixed obstacles along `line` (lane-clearance.ts). */
  private laneBendOf(m: Mover, line: number, dir: 1 | -1): Float32Array | undefined {
    if (!this.laneTerrain || m.kind !== 'vehicle' || !m.vehicle) return;
    if (this.geo.kinds[line]! > LifeLine.roadMinor) return;
    if (this.laneNear[line] === 0) {
      // Any lane of any vehicle reaches at most this far from the centre line.
      const reach = this.roadWidth(line) / 2 + ROAD_AVOID.shoulder + LONGEST_ROAD_VEHICLE_M;
      const c = this.geo.coords;
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let v = this.first(line); v <= this.last(line); v++) {
        x0 = Math.min(x0, c[v * 2]!);
        y0 = Math.min(y0, c[v * 2 + 1]!);
        x1 = Math.max(x1, c[v * 2]!);
        y1 = Math.max(y1, c[v * 2 + 1]!);
      }
      const pm = this.perMeter;
      this.laneNear[line] = this.laneTerrain.near(
        x0 / pm - reach,
        y0 / pm - reach,
        x1 / pm + reach,
        y1 / pm + reach,
      )
        ? 2
        : 1;
    }
    if (this.laneNear[line] === 1) return;
    const spec = VEHICLES[m.vehicle];
    const road = this.roadWidth(line);
    const oneway = this.geo.oneway?.[line] ?? 0;
    const lanes = laneLayout(road, oneway).count;
    const preference = m.chosenLane ?? m.lane;
    const index = spec.curb ? lanes : Math.min(lanes - 1, Math.floor(preference * lanes));
    const key =
      (line * 2 + (dir === 1 ? 1 : 0)) * VEHICLE_KINDS.length +
      VEHICLE_KINDS.indexOf(m.vehicle) +
      index / (lanes + 1);
    let bend = this.laneBends.get(key);
    if (bend === undefined) {
      const base = laneOffset(road, spec.width, preference, spec.curb, oneway);
      const [lo, hi] = this.laneBounds(spec.width, line);
      bend =
        laneBend(
          {
            points: this.travelPoints(line, dir),
            perMeter: this.perMeter,
            base,
            lo: Math.min(lo, base),
            hi: Math.max(hi, base),
            length: spec.length,
            width: spec.width,
          },
          this.laneTerrain,
        ) ?? null;
      this.laneBends.set(key, bend);
    }
    return bend ?? undefined;
  }

  /**
   * Whether the road runs on roughly straight from one line into the next, so a bend around an
   * obstacle carries across their shared vertex. At a turn the corner's own curve decides.
   */
  private straightOn(inLine: number, inDir: 1 | -1, outLine: number, outDir: 1 | -1): boolean {
    const [ix, iy] = this.endHeading(inLine * 2 + (inDir === 1 ? 1 : 0));
    const [ox, oy] = this.endHeading(outLine * 2 + (outDir === 1 ? 0 : 1));
    return -ix * ox - iy * oy > Math.cos(Math.PI / 4);
  }

  /** How far a vehicle's lane bends `travelled` metres along `line`, m (lane-clearance.ts). */
  private bendOn(m: Mover, line: number, dir: 1 | -1, travelled: number): number {
    const bend = this.laneBendOf(m, line, dir);
    return bend ? bendAt(bend, travelled) : 0;
  }

  /**
   * A vehicle's lane `travelled` metres along `line`, m right of centre. Its bend keeps clear of
   * fixed obstacles, and a neighbouring line's bend at their shared vertex carries over, easing
   * off at `LANE_BEND.slope`, so a vehicle is already clear when it gets there. Where two lines'
   * ordinary lanes differ, it moves from one to the other across the vertex. `came` and `next`
   * are line end codes as on `Mover`.
   */
  private routeLane(
    m: Mover,
    line: number,
    dir: 1 | -1,
    travelled: number,
    came: number | undefined,
    next: number | undefined,
  ): number {
    const pm = this.perMeter;
    const lane = this.mergeLane(m, line);
    let bend = this.bendOn(m, line, dir, travelled),
      shift = 0;
    if (next !== undefined && next >= 0) {
      const outLine = next >> 1,
        outDir: 1 | -1 = next & 1 ? -1 : 1;
      const ahead = this.lineLength(line) / pm - travelled;
      if (this.straightOn(line, dir, outLine, outDir))
        bend = stronger(bend, eased(this.bendOn(m, outLine, outDir, 0), ahead));
      shift += acrossVertex(lane, this.mergeLane(m, outLine), -ahead) - lane;
    }
    if (came !== undefined) {
      const inLine = came >> 1,
        inDir: 1 | -1 = came & 1 ? 1 : -1;
      const end = this.lineLength(inLine) / pm;
      if (this.straightOn(inLine, inDir, line, dir))
        bend = stronger(bend, eased(this.bendOn(m, inLine, inDir, end), travelled));
      shift += acrossVertex(this.mergeLane(m, inLine), lane, travelled) - lane;
    }
    return lane + shift + bend;
  }

  /** Metres a mover has travelled along its line. */
  private travelled(m: Mover): number {
    const progress = this.along[m.from]! + m.dir * m.d;
    return (m.dir === 1 ? progress : this.lineLength(m.line) - progress) / this.perMeter;
  }

  /** A vehicle's lane where it is, and how fast it moves sideways per metre travelled. */
  private laneSlope(m: Mover): number {
    const t = this.travelled(m);
    const next = m.routing?.plan?.exit ?? m.next;
    const length = this.lineLength(m.line) / this.perMeter;
    const h = 0.5;
    const a = Math.max(0, t - h),
      b = Math.min(length, t + h);
    if (b - a < 1e-6) return 0;
    return (
      (this.routeLane(m, m.line, m.dir, b, m.came, next) -
        this.routeLane(m, m.line, m.dir, a, m.came, next)) /
      (b - a)
    );
  }

  /** Whether lane variation can affect this entire metre interval around a vehicle. */
  offsetVaries(m: Mover, ahead = 0, behind = 0): boolean {
    if (m.kind !== 'vehicle' || !m.vehicle || m.train) return false;
    if (m.roadShift !== undefined || m.lat !== undefined || m.latYaw !== undefined || m.maneuver)
      return true;
    const profile = this.laneTerrain ? this.laneBendOf(m, m.line, m.dir) : undefined;
    const next = m.routing?.plan?.exit ?? m.next;
    if (!profile && (next === undefined || next < 0) && m.came === undefined) return false;
    const length = this.lineLength(m.line) / this.perMeter,
      travelled = this.travelled(m),
      low = Math.max(0, travelled - behind),
      high = Math.min(length, travelled + ahead);
    if (profile) {
      let interval = this.bendIntervals.get(profile);
      if (!interval) {
        let first = Infinity,
          last = -Infinity;
        for (let i = 0; i < profile.length; i++)
          if (profile[i] !== 0) {
            first = Math.min(first, (i - 1) * LANE_BEND.sampleM);
            last = (i + 1) * LANE_BEND.sampleM;
          }
        this.bendIntervals.set(profile, (interval = [first, last]));
      }
      if (high >= interval[0] && low <= interval[1]) return true;
    }
    const lane = this.mergeLane(m, m.line);
    if (next !== undefined && next >= 0) {
      const outLine = next >> 1,
        outDir = next & 1 ? -1 : 1;
      let reach = handoffHalf(lane, this.mergeLane(m, outLine));
      if (this.straightOn(m.line, m.dir, outLine, outDir))
        reach = Math.max(reach, Math.abs(this.bendOn(m, outLine, outDir, 0)) / LANE_BEND.slope);
      if (reach > 0 && high >= length - reach) return true;
    }
    const came = m.came;
    if (came === undefined) return false;
    const inLine = came >> 1;
    const inDir = came & 1 ? 1 : -1;
    let reach = handoffHalf(this.mergeLane(m, inLine), lane);
    if (this.straightOn(inLine, inDir, m.line, m.dir))
      reach = Math.max(
        reach,
        Math.abs(this.bendOn(m, inLine, inDir, this.lineLength(inLine) / this.perMeter)) /
          LANE_BEND.slope,
      );
    return reach > 0 && low <= reach;
  }

  /** How far right of its line's center a mover keeps, m: a vehicle's lane, else 0. */
  offsetOf(m: Mover, identity = m): number {
    if (isWalker(m.kind)) return this.scenes.walkingOffset(m, identity);
    if (m.kind !== 'vehicle' || !m.vehicle) return 0;
    const spec = VEHICLES[m.vehicle];
    const road = this.roadWidth(m.line);
    const next = m.routing?.plan?.exit ?? m.next;
    const normal =
      !this.laneTerrain && m.came === undefined && (next === undefined || next < 0)
        ? laneOffset(
            road,
            spec.width,
            m.chosenLane ?? m.lane,
            spec.curb,
            this.geo.oneway?.[m.line] ?? 0,
          )
        : this.routeLane(m, m.line, m.dir, this.travelled(m), m.came, next);
    if (!this.scenes.hasCurbScenes) return this.shiftedOffset(m, normal) + (m.lat ?? 0);
    const curb = Math.max(0, road / 2 - spec.width / 2 - ROAD_MARGIN_M);
    const offset =
      identity === m
        ? this.scenes.offset(m, normal, curb)
        : this.scenes.offsetAt(identity, m, normal, curb);
    return this.shiftedOffset(m, offset) + (m.lat ?? 0);
  }

  private vehicleLane(m: Mover, line: number) {
    const spec = VEHICLES[m.vehicle!],
      road = this.roadWidth(line);
    const normal = laneOffset(
      road,
      spec.width,
      m.chosenLane ?? m.lane,
      spec.curb,
      this.geo.oneway?.[line] ?? 0,
    );
    return this.shiftedOffset(m, normal, line) + (m.lat ?? 0);
  }

  /** A straight neighbor leaves room for a long vehicle to begin turning before the midpoint. */
  private cornerSpan(
    line: number,
    adjacent: number,
    step: number,
    hx: number,
    hy: number,
    length: number,
  ): number {
    const next = adjacent + step;
    if (next < this.first(line) || next > this.last(line)) return length;
    const c = this.geo.coords;
    const dx = c[next * 2]! - c[adjacent * 2]!,
      dy = c[next * 2 + 1]! - c[adjacent * 2 + 1]!;
    const distance = Math.hypot(dx, dy);
    return distance > 0 &&
      (dx * hx + dy * hy) / distance > Math.cos((FILLET.minAngle * Math.PI) / 180)
      ? length * 2
      : length;
  }

  private corner(m: Mover, vertex: number, identity = m): Curve | undefined {
    // A recovery trial can advance onto another line before rechecking its old corner.
    if (vertex < this.first(m.line) || vertex > this.last(m.line)) return;
    let incoming = vertex - m.dir,
      outgoing = vertex + m.dir;
    let inLine = m.line,
      outLine = m.line;
    const start = m.dir === 1 ? this.first(m.line) : this.last(m.line);
    const end = m.dir === 1 ? this.last(m.line) : this.first(m.line);
    if (m.entered?.vertex === vertex) {
      incoming = -1;
    } else if (vertex === start) {
      if (m.came === undefined) return;
      inLine = m.came >> 1;
      incoming = m.came & 1 ? this.last(inLine) - 1 : this.first(inLine) + 1;
    }
    if (vertex === end) {
      const next = m.routing?.plan?.exit ?? m.next;
      if (next === undefined || next < 0) return;
      outLine = next >> 1;
      outgoing = this.directedVertex(next, vertex) + (next & 1 ? -1 : 1);
    }
    const c = this.geo.coords;
    const x = c[vertex * 2]!,
      y = c[vertex * 2 + 1]!;
    const ix = x - (incoming === -1 ? m.entered!.x : c[incoming * 2]!),
      iy = y - (incoming === -1 ? m.entered!.y : c[incoming * 2 + 1]!);
    const ox = c[outgoing * 2]! - x,
      oy = c[outgoing * 2 + 1]! - y;
    const li = Math.hypot(ix, iy),
      lo = Math.hypot(ox, oy);
    if (!li || !lo) return;
    const inDir = inLine === m.line ? m.dir : m.came! & 1 ? 1 : -1;
    const outDir = outLine === m.line ? m.dir : (m.routing?.plan?.exit ?? m.next)! & 1 ? -1 : 1;
    // Traffic keeps right: left turns use the available straight span, while a right
    // turn keeps its shorter approach rather than cutting across the inside curb early.
    const leftTurn = m.kind === 'vehicle' && ix * oy - iy * ox < 0;
    const spanIn = leftTurn
      ? this.cornerSpan(inLine, incoming, -inDir, -ix / li, -iy / li, li)
      : li;
    const spanOut = leftTurn
      ? this.cornerSpan(outLine, outgoing, outDir, ox / lo, oy / lo, lo)
      : lo;
    const pm = this.perMeter;
    /** A fillet running `before` and `after` its vertex, in tile units. */
    const build = (before: number, after: number) => {
      let offsetIn: number, offsetOut: number;
      if (m.kind !== 'vehicle' || !m.vehicle) {
        offsetIn = inLine === m.line ? this.offsetOf(m, identity) : 0;
        offsetOut = outLine === m.line ? this.offsetOf(m, identity) : 0;
      } else {
        // The lane where the fillet starts and ends, so the curve meets the straight poses.
        const reachIn = before / pm,
          reachOut = after / pm;
        const next = m.routing?.plan?.exit ?? m.next;
        const entry = m.line * 2 + (m.dir === 1 ? 0 : 1);
        const lane = (
          line: number,
          dir: 1 | -1,
          travelled: number,
          came?: number,
          exit?: number,
        ) => {
          const value = this.routeLane(m, line, dir, travelled, came, exit);
          if (line !== m.line) return this.shiftedOffset(m, value, line);
          const road = this.roadWidth(line);
          const curb = Math.max(0, road / 2 - VEHICLES[m.vehicle!].width / 2 - ROAD_MARGIN_M);
          const scene =
            identity === m
              ? this.scenes.offset(m, value, curb)
              : this.scenes.offsetAt(identity, m, value, curb);
          return this.shiftedOffset(m, scene);
        };
        if (inLine === m.line && outLine === m.line) {
          const at =
            (m.dir === 1 ? this.along[vertex]! : this.lineLength(m.line) - this.along[vertex]!) /
            pm;
          offsetIn = lane(m.line, m.dir, at - reachIn, m.came, next);
          offsetOut = lane(m.line, m.dir, at + reachOut, m.came, next);
        } else if (inLine === m.line) {
          offsetIn = lane(m.line, m.dir, this.lineLength(m.line) / pm - reachIn, m.came, next);
          const along = this.along[this.directedVertex(next!, vertex)]!;
          const entryDistance = (outDir === 1 ? along : this.lineLength(outLine) - along) / pm;
          offsetOut = lane(
            outLine,
            outDir,
            entryDistance + reachOut,
            m.line * 2 + (m.dir === 1 ? 1 : 0),
          );
        } else {
          offsetIn = lane(inLine, inDir, this.lineLength(inLine) / pm - reachIn, undefined, entry);
          offsetOut = lane(m.line, m.dir, reachOut, m.came, next);
        }
        if (incoming === -1) offsetIn = m.entered!.offset;
      }
      return fillet(
        x,
        y,
        ix / li,
        iy / li,
        ox / lo,
        oy / lo,
        before,
        after,
        offsetIn * pm,
        offsetOut * pm,
        pm,
      );
    };
    const reduced =
      !m.curveCorner || (m.curveCorner.x === x && m.curveCorner.y === y)
        ? m.curveLengthM
        : undefined;
    const full = Math.min(filletLength(spanIn, spanOut, pm), (reduced ?? FILLET.maxM) * pm);
    const curve = build(full, full);
    if (!curve || m.kind !== 'vehicle' || !m.vehicle || !this.laneTerrain) return curve;
    // A turn may run on past its vertex (a long vehicle's rear clears an island before it
    // swings), leaving the outgoing segment's far end to the next fillet.
    const longest = Math.max(full, Math.min(lo - FILLET.maxM * pm, FILLET_RUN_ON_M * pm));
    return this.clearCorner(m, vertex, inLine, outLine, curve, full, longest, build, identity);
  }

  /**
   * A corner curve whose body keeps off fixed obstacles: lane bends only plan the straights, so
   * where the full curve would touch an obstacle near its vertex, the turn starts later or runs
   * on further. Remembered per corner, vehicle and curve while no recovery or curb scene moves
   * the lane.
   */
  private clearCorner(
    m: Mover,
    vertex: number,
    inLine: number,
    outLine: number,
    curve: Curve,
    full: number,
    longest: number,
    build: (before: number, after: number) => Curve | undefined,
    identity: Mover,
  ): Curve | undefined {
    const pm = this.perMeter;
    const spec = VEHICLES[m.vehicle!];
    if (this.cornerNear[vertex] === 0) {
      // As far as any corner curve and vehicle reach from it.
      const reach = FILLET_RUN_ON_M + LONGEST_ROAD_VEHICLE_M;
      const x = this.geo.coords[vertex * 2]! / pm,
        y = this.geo.coords[vertex * 2 + 1]! / pm;
      this.cornerNear[vertex] = this.laneTerrain!.near(x - reach, y - reach, x + reach, y + reach)
        ? 2
        : 1;
    }
    if (this.cornerNear[vertex] === 1) return curve;
    const site = this.scenes.curbSite(identity);
    const steady =
      m.roadShift === undefined &&
      m.lat === undefined &&
      !m.maneuver &&
      m.curveLengthM === undefined &&
      site === undefined;
    const key =
      `${vertex}/${inLine}/${outLine}/${m.vehicle}/${m.line}/${m.dir}/${m.lane}/${m.chosenLane}/${m.lat}/${m.latYaw}/${m.maneuver?.target}/${m.maneuver?.corridor}/${m.came}/${m.routing?.plan?.exit ?? m.next}/${m.roadShift}/${curve.x0}/${curve.y0}/${curve.x1}/${curve.y1}/${curve.x2}/${curve.y2}/${curve.before}/${curve.after}/${longest}` +
      (site ? `/${site.x}/${site.y}/${m.x}/${m.y}` : '');
    if (steady && this.clearCorners.has(key)) return this.clearCorners.get(key) ?? undefined;
    if (!steady) {
      const cached = this.transientCorners.get(identity);
      if (cached?.key === key) return cached.curve;
    }
    // The guard's own body, with a hair of room so samples between checks stay clear too.
    const body: Body = {
      x: 0,
      y: 0,
      hx: 0,
      hy: 0,
      length: spec.length + 0.1,
      width: spec.width + 0.1,
    };
    const pose: Pose = { x: 0, y: 0, hx: 0, hy: 0 };
    const clear = (c: Curve) => {
      const span = c.before + c.after;
      const steps = Math.max(2, Math.ceil(span / pm / 0.25));
      for (let i = 0; i <= steps; i++) {
        curvePose(c, -c.before + (span * i) / steps, pose);
        body.x = pose.x / pm;
        body.y = pose.y / pm;
        body.hx = pose.hx;
        body.hy = pose.hy;
        if (this.laneTerrain!.hits(body)) return false;
      }
      return true;
    };
    let found: Curve | undefined = curve;
    if (!clear(curve)) {
      const tries: [number, number][] = [];
      for (const share of [0.75, 0.5, 0.35, 0.25]) tries.push([full * share, full * share]);
      for (const lead of [0.5, 0.25, 0.1])
        for (const run of [1, 1.5, 2]) tries.push([full * lead, Math.min(longest, full * run)]);
      for (const [before, after] of tries) {
        const other = build(before, after);
        if (other && clear(other)) {
          found = other;
          break;
        }
      }
    }
    if (steady) this.clearCorners.set(key, found ?? null);
    else this.transientCorners.set(identity, { key, curve: found });
    return found;
  }

  /** Pure render/clearance pose; the route cursor stays on the centreline. */
  pose(m: Mover, out: Pose = { x: 0, y: 0, hx: 0, hy: 0 }, identity = m): Pose {
    const offset = this.offsetOf(m, identity) * this.perMeter;
    out.x = m.x - m.hy * offset;
    out.y = m.y + m.hx * offset;
    out.hx = m.hx;
    out.hy = m.hy;
    if (m.kind === 'vehicle' && m.vehicle && !m.train) {
      // Where the lane moves sideways, the nose points along the way the body actually goes.
      const slope =
        (m.roadYaw ?? 0) +
        (m.latYaw ?? 0) +
        (this.offsetVaries(m, 0.5, 0.5) ? this.laneSlope(m) : 0);
      if (Math.abs(slope) > 1e-4) {
        const hx = m.hx - m.hy * slope,
          hy = m.hy + m.hx * slope;
        const norm = Math.hypot(hx, hy);
        out.hx = hx / norm;
        out.hy = hy / norm;
      }
    }
    if (m.momentFacing) Object.assign(out, m.momentFacing);
    else if (m.turning) Object.assign(out, turningFacing(m.turning, m));
    else if (m.roadYaw && isWalker(m.kind)) {
      const hx = out.hx - out.hy * m.roadYaw,
        hy = out.hy + out.hx * m.roadYaw;
      const norm = Math.hypot(hx, hy);
      out.hx = hx / norm;
      out.hy = hy / norm;
    }
    const wait = m.crossingWait?.waiting;
    if (wait) {
      const facing = wait.poses[0];
      if (facing) {
        out.hx = facing.hx;
        out.hy = facing.hy;
      }
      if (m.kind === 'dog' || m.kind === 'cat') {
        if (facing) {
          out.x = m.x + facing.x * this.perMeter;
          out.y = m.y + facing.y * this.perMeter;
        }
      }
    }
    if (!m.vehicle || m.train || !this.curvable[m.line]) return out;
    // A curve can run on past its vertex for up to twice the usual fillet (`clearCorner`).
    const reach = FILLET_RUN_ON_M * this.perMeter;
    const behind = m.d <= reach ? this.corner(m, m.from, identity) : undefined;
    if (behind && m.d <= behind.after) return curvePose(behind, m.d, out);
    const remaining = this.segment(m.from, m.from + m.dir) - m.d;
    const ahead = remaining <= reach ? this.corner(m, m.from + m.dir, identity) : undefined;
    if (ahead && remaining <= ahead.before) return curvePose(ahead, -remaining, out);
    return out;
  }

  /** Pure lookup within the maximum reach; callers retain their actual-arc predicates. */
  private cornerWithin(m: Mover, vertex: number, distance: number, identity = m) {
    return distance <= FILLET_RUN_ON_M * this.perMeter
      ? this.corner(m, vertex, identity)
      : undefined;
  }

  private matchesCurve(m: Mover, vertex: number) {
    return (
      !!m.curveCorner &&
      this.geo.coords[vertex * 2] === m.curveCorner.x &&
      this.geo.coords[vertex * 2 + 1] === m.curveCorner.y
    );
  }

  private clearPastCurve(m: Mover) {
    const corner = m.curveCorner;
    if (!corner) return;
    // Keep the shortened shape until even the default outgoing arc is behind us;
    // clearing at the smaller arc's end would re-enter the wider default curve.
    const reach = FILLET.maxM * this.perMeter;
    if (this.matchesCurve(m, m.from) && m.d <= reach) return;
    if (this.matchesCurve(m, m.from + m.dir) && this.segment(m.from, m.from + m.dir) - m.d <= reach)
      return;
    m.curveLengthM = undefined;
    m.curveCorner = undefined;
  }

  private cruise(m: Mover): number {
    return cruise(m, this.scenes.raining);
  }

  private curveTarget(m: Mover): number {
    const speed = this.cruise(m);
    if (!this.curvable[m.line]) return speed;
    if (
      this.last(m.line) - this.first(m.line) === 1 &&
      m.came === undefined &&
      m.routing?.plan === undefined &&
      m.next === undefined
    )
      return speed;
    const k = kinematicsOf(m.vehicle),
      pm = this.perMeter,
      lateral =
        k.lateral *
        (this.scenes.raining && m.kind === 'vehicle' && m.vehicle ? DRIVE.rain.lateral : 1);
    let target = speed;
    const behind = this.corner(m, m.from);
    if (behind && m.d <= behind.after)
      target = Math.min(target, Math.sqrt(lateral * pm * behind.radius));
    let distance = -m.d;
    let v = m.from;
    const end = m.dir === 1 ? this.last(m.line) : this.first(m.line);
    for (let count = 0; count < 3 && v !== end; count++) {
      distance += this.segment(v, v + m.dir);
      v += m.dir;
      if (distance > FILLET.lookaheadM * pm) break;
      const curve = this.corner(m, v);
      if (curve)
        target = Math.min(
          target,
          approach(distance - curve.before, Math.sqrt(lateral * pm * curve.radius), k.brake * pm),
        );
    }
    return target;
  }

  private straightPedestrianSegment(m: Mover, range: number, out?: PedestrianSegment) {
    const pm = this.perMeter;
    const remaining = this.segment(m.from, m.from + m.dir) - m.d;
    const reach = FILLET_RUN_ON_M * pm;
    if (
      this.scenes.curbSite(m) === undefined &&
      !this.offsetVaries(m, range) &&
      remaining >= range * pm &&
      (!this.curvable[m.line] || (m.d > reach && remaining - range * pm > reach))
    ) {
      // No bend or changing curb offset can affect this entire lookahead chord.
      const at = this.pose(m, this.pedestrianPose);
      if (!out)
        return {
          x: at.x / pm,
          y: at.y / pm,
          hx: at.hx,
          hy: at.hy,
          length: range,
          ahead: 0,
          line: m.line,
        };
      out.x = at.x / pm;
      out.y = at.y / pm;
      out.hx = at.hx;
      out.hy = at.hy;
      out.length = range;
      out.ahead = 0;
      out.line = m.line;
      return out;
    }
    return undefined;
  }

  /** Pure lookahead over known exits, using the same fillet poses as clearance. */
  private *pedestrianPath(
    m: Mover,
    range: number,
    physicalRange = range,
  ): Generator<PedestrianSegment> {
    const straight = this.straightPedestrianSegment(m, range);
    if (straight) {
      yield straight;
      return;
    }
    const pm = this.perMeter,
      c = this.geo.coords;
    const exits = m.junctionRoute?.exits;
    const firstExit = m.routing?.plan?.exit ?? m.next;
    const curbScenes = this.scenes.curbSite(m) !== undefined;
    let exitIndex = 0;
    const scratch: { cursor: Mover; at: Pose; next: Pose } = this.pathScratch.pop() ?? {
      cursor: {
        kind: 'vehicle',
        line: 0,
        from: 0,
        dir: 1,
        d: 0,
        speed: 0,
        paint: 0,
        lane: 0,
        pause: 0,
        rank: 0,
        x: 0,
        y: 0,
        hx: 1,
        hy: 0,
      },
      at: { x: 0, y: 0, hx: 0, hy: 0 },
      next: { x: 0, y: 0, hx: 0, hy: 0 },
    };
    const cursor = scratch.cursor;
    cursor.kind = m.kind;
    cursor.vehicle = m.vehicle;
    cursor.line = m.line;
    cursor.from = m.from;
    cursor.dir = m.dir;
    cursor.d = m.d;
    cursor.x = m.x;
    cursor.y = m.y;
    cursor.hx = m.hx;
    cursor.hy = m.hy;
    cursor.lane = m.lane;
    cursor.chosenLane = m.chosenLane;
    cursor.lat = m.lat;
    cursor.latYaw = m.latYaw;
    cursor.maneuver = m.maneuver;
    cursor.roadYaw = m.roadYaw;
    cursor.roadShift = m.roadShift;
    cursor.came = m.came;
    cursor.curveLengthM = m.curveLengthM;
    cursor.curveCorner = m.curveCorner;
    cursor.entered = m.entered;
    cursor.next = exits ? exits[0] : firstExit;
    cursor.momentFacing = m.momentFacing;
    try {
      let at = this.pose(cursor, scratch.at, m),
        next = scratch.next,
        ahead = 0;
      let curveLine = -1,
        curveFrom = -1,
        curveDir = 0,
        curveNext: number | undefined,
        curveCame: number | undefined,
        offset = 0,
        behind: Curve | undefined,
        front: Curve | undefined;
      while (ahead < range - 1e-7) {
        const end = cursor.dir === 1 ? this.last(cursor.line) : this.first(cursor.line);
        let vertex = cursor.from + cursor.dir;
        let remaining =
          vertex >= this.first(cursor.line) && vertex <= this.last(cursor.line)
            ? this.segment(cursor.from, vertex) - cursor.d
            : 0;
        if (remaining <= 1e-9) {
          if (
            vertex !== end &&
            vertex >= this.first(cursor.line) &&
            vertex <= this.last(cursor.line)
          ) {
            cursor.from = vertex;
            cursor.d = 0;
          } else {
            const code = exits ? exits[exitIndex++] : exitIndex++ === 0 ? firstExit : undefined;
            if (code === undefined || code < 0) break;
            const target = this.directedExit(code, vertex);
            const previous = cursor.from;
            const entered = {
              vertex: target.vertex,
              x: c[previous * 2]!,
              y: c[previous * 2 + 1]!,
              offset: this.offsetOf(cursor, m),
            };
            cursor.came = cursor.line * 2 + (cursor.dir === 1 ? 1 : 0);
            cursor.line = target.line;
            cursor.dir = target.dir;
            cursor.from = target.vertex;
            cursor.entered =
              target.vertex !== this.first(target.line) && target.vertex !== this.last(target.line)
                ? entered
                : undefined;
            cursor.d = 0;
            cursor.next = exits?.[exitIndex];
          }
          vertex = cursor.from + cursor.dir;
          remaining = this.segment(cursor.from, vertex);
          if (remaining <= 1e-9) continue;
        }
        const dx = c[vertex * 2]! - c[cursor.from * 2]!,
          dy = c[vertex * 2 + 1]! - c[cursor.from * 2 + 1]!;
        const full = Math.hypot(dx, dy);
        cursor.hx = dx / full;
        cursor.hy = dy / full;
        // A curb scene or a lane that moves sideways changes the offset within a segment; a
        // moving lane is followed a metre at a time so the chords keep to its bends.
        const bends = this.offsetVaries(cursor, Math.min(remaining / pm, range - ahead));
        const vary = curbScenes || bends;
        if (
          vary ||
          curveLine !== cursor.line ||
          curveFrom !== cursor.from ||
          curveDir !== cursor.dir ||
          curveNext !== cursor.next ||
          curveCame !== cursor.came
        ) {
          curveLine = cursor.line;
          curveFrom = cursor.from;
          curveDir = cursor.dir;
          curveNext = cursor.next;
          curveCame = cursor.came;
          offset = this.offsetOf(cursor, m) * pm;
          behind = this.curvable[cursor.line] ? this.corner(cursor, cursor.from, m) : undefined;
          front = this.curvable[cursor.line] ? this.corner(cursor, vertex, m) : undefined;
        }
        let delta = Math.min(remaining, (range - ahead) * pm);
        // Reusing a longer courtesy path must retain the physical query's exact final chord.
        if (physicalRange < range && ahead < physicalRange - 1e-7)
          delta = Math.min(delta, (physicalRange - ahead) * pm);
        if (this.curvable[cursor.line]) {
          if (behind && cursor.d < behind.after - 1e-9)
            delta = Math.min(delta, pm, behind.after - cursor.d);
          else if (front && remaining <= front.before + 1e-9) delta = Math.min(delta, pm);
          else if (front) delta = Math.min(delta, remaining - front.before);
        }
        if (bends) delta = Math.min(delta, pm);
        if (delta <= 1e-9) delta = Math.min(remaining, pm);
        cursor.d += delta;
        cursor.x = c[cursor.from * 2]! + cursor.hx * cursor.d;
        cursor.y = c[cursor.from * 2 + 1]! + cursor.hy * cursor.d;
        // Otherwise lane offsets and fillets are constant over this route segment.
        if (vary) this.pose(cursor, next, m);
        else {
          next.x = cursor.x - cursor.hy * offset;
          next.y = cursor.y + cursor.hx * offset;
          next.hx = cursor.hx;
          next.hy = cursor.hy;
        }
        if (!vary) {
          if (behind && cursor.d <= behind.after) curvePose(behind, cursor.d, next);
          else if (front && full - cursor.d <= front.before)
            curvePose(front, -(full - cursor.d), next);
        }
        const vx = (next.x - at.x) / pm,
          vy = (next.y - at.y) / pm,
          length = Math.hypot(vx, vy);
        if (length > 1e-9) {
          yield {
            x: at.x / pm,
            y: at.y / pm,
            hx: vx / length,
            hy: vy / length,
            length: Math.min(length, range - ahead),
            ahead,
            line: cursor.line,
          };
          ahead += length;
        }
        const previous = at;
        at = next;
        next = previous;
      }
    } finally {
      cursor.momentFacing = undefined;
      this.pathScratch.push(scratch);
    }
  }

  /** Only route geometry is cached; pedestrian positions and crossing timers stay live. */
  private pedestrianSegments(m: Mover, range: number, physicalRange: number) {
    if (m.v !== 0 || this.scenes.curbSite(m) !== undefined || m.momentFacing)
      return [...this.pedestrianPath(m, range, physicalRange)];
    const previous = this.stoppedPaths?.get(m);
    const at = previous?.at;
    const exit = m.routing?.plan?.exit;
    if (
      previous &&
      at &&
      at.x === m.x &&
      at.y === m.y &&
      at.hx === m.hx &&
      at.hy === m.hy &&
      at.line === m.line &&
      at.from === m.from &&
      at.dir === m.dir &&
      at.d === m.d &&
      at.lane === m.lane &&
      at.chosenLane === m.chosenLane &&
      at.lat === m.lat &&
      at.latYaw === m.latYaw &&
      at.roadYaw === m.roadYaw &&
      at.maneuver === m.maneuver &&
      at.roadShift === m.roadShift &&
      at.came === m.came &&
      at.next === m.next &&
      at.curveLengthM === m.curveLengthM &&
      at.curveCorner?.x === m.curveCorner?.x &&
      at.curveCorner?.y === m.curveCorner?.y &&
      at.entered?.vertex === m.entered?.vertex &&
      at.entered?.x === m.entered?.x &&
      at.entered?.y === m.entered?.y &&
      at.entered?.offset === m.entered?.offset &&
      previous.exit === exit &&
      previous.route === m.junctionRoute &&
      previous.range === range &&
      previous.physicalRange === physicalRange
    )
      return previous.segments;
    const segments = [...this.pedestrianPath(m, range, physicalRange)];
    (this.stoppedPaths ??= new WeakMap()).set(m, {
      at: {
        x: m.x,
        y: m.y,
        hx: m.hx,
        hy: m.hy,
        line: m.line,
        from: m.from,
        dir: m.dir,
        d: m.d,
        lane: m.lane,
        chosenLane: m.chosenLane,
        lat: m.lat,
        latYaw: m.latYaw,
        maneuver: m.maneuver,
        roadShift: m.roadShift,
        roadYaw: m.roadYaw,
        came: m.came,
        next: m.next,
        curveLengthM: m.curveLengthM,
        curveCorner: m.curveCorner && { ...m.curveCorner },
        entered: m.entered && { ...m.entered },
      },
      exit,
      route: m.junctionRoute,
      range,
      physicalRange,
      segments,
    });
    return segments;
  }

  private hasPedestrianCrossing(m: Mover): boolean {
    const crossings = this.pedestrianCrossings;
    if (m.pedestrianHolds?.length || crossings.hasLine(m.line)) return true;
    const planned = m.routing?.plan?.exit;
    if (planned !== undefined && planned >= 0 && crossings.hasLine(planned >> 1)) return true;
    if (m.next !== undefined && m.next >= 0 && crossings.hasLine(m.next >> 1)) return true;
    const exits = m.junctionRoute?.exits;
    if (exits) for (const code of exits) if (code >= 0 && crossings.hasLine(code >> 1)) return true;
    return false;
  }

  /** Target-only limits from the live post-walker index, leaving safety caps to the guard. */
  private pedestrianTarget(m: Mover, target: number, pedestrians: PedestrianView, dt: number) {
    return this.pedestrianControl(m, target, pedestrians, dt).target;
  }

  courtesyHeld(m: Mover, pedestrians: PedestrianView, dt: number): boolean {
    return (
      m.kind === 'vehicle' &&
      !!m.vehicle &&
      this.pedestrianControl(m, m.speed, pedestrians, dt, false).held
    );
  }

  private pedestrianControl(
    m: Mover,
    target: number,
    pedestrians: PedestrianView,
    dt: number,
    commit = true,
  ) {
    const crossings = this.pedestrianCrossings;
    if (crossings.empty && target <= 0) {
      if (commit) m.pedestrianHolds = undefined;
      return { target, held: false };
    }
    const spec = VEHICLES[m.vehicle!],
      k = kinematicsOf(m.vehicle);
    const length = Math.max(spec.length, pedestrians.minimum);
    const range = pedestrianRange((m.v ?? m.speed) / this.perMeter, length, k);
    const halfWidth = spec.width / 2 + PEDESTRIAN.corridorPad;
    let fullRange = range;
    if (m.pedestrianHolds?.length) {
      const straight =
        !m.momentFacing &&
        this.straightPedestrianSegment(m, PEDESTRIAN.maxRange, this.straightSegments[0]);
      fullRange = straight
        ? crossings.heldRange(m.pedestrianHolds, straight, range)
        : PEDESTRIAN.maxRange;
    }
    const segments = this.hasPedestrianCrossing(m)
      ? this.pedestrianSegments(m, fullRange, range)
      : undefined;
    const clearing = this.clearingCrossings;
    clearing.clear();
    // The entry gate already admitted this occupant. It must clear the box,
    // retaining physical pedestrian braking and courtesy at unrelated crossings.
    for (const r of this.junctionTable?.holds(m) ?? []) {
      if (!r.inside) continue;
      for (let i = 0; i < 2; i++) {
        const arm = i === 0 ? r.movement.entry : r.movement.exit;
        for (const c of this.junctionCrossings.forArm(r.movement.junction, arm))
          clearing.add(c.identity.key);
      }
    }
    const crossing =
      segments &&
      crossings.limit(
        pedestrians,
        segments,
        halfWidth,
        length,
        range,
        target,
        k,
        dt,
        m.pedestrianHolds,
        (m.v ?? m.speed) / this.perMeter,
        clearing,
      );
    if (commit) m.pedestrianHolds = crossing?.holds;
    const physicalTarget = crossing?.target ?? target;
    const held = crossing?.held ?? false;
    if (!commit) return { target: physicalTarget, held };
    if (physicalTarget <= 0 || pedestrians.empty) return { target: physicalTarget, held };
    const straight =
      !segments && this.straightPedestrianSegment(m, range, this.straightSegments[0]);
    return {
      held,
      target: pedestrianLimit(
        pedestrians,
        segments ?? (straight ? this.straightSegments : this.pedestrianPath(m, fullRange, range)),
        halfWidth,
        length,
        physicalTarget,
        k,
        this.perMeter,
        dt,
        range,
      ),
    };
  }

  /** The same meters and group slots used by the life drawing pass. */
  groundBodies(
    a: GroundAgent,
    minimum = 0,
    out: Body[] = [],
    identity: GroundAgent = a,
    cursor: CrossingCursor = a,
  ): Body[] {
    if (!('kind' in a) && !('walker' in a)) {
      const cart = VEHICLES.cart;
      const put = (i: number, x: number, y: number, length: number, width: number) => {
        const b = out[i] ?? (out[i] = { x: 0, y: 0, hx: 0, hy: 0, length: 0, width: 0 });
        Object.assign(b, {
          x,
          y,
          hx: a.hx,
          hy: a.hy,
          length: Math.max(length, minimum),
          width: Math.max(width, minimum),
          kind: i === 0 ? BODY_KIND.fixed : BODY_KIND.human,
        });
      };
      put(0, a.x / this.perMeter, a.y / this.perMeter, cart.length, cart.width);
      put(
        1,
        a.x / this.perMeter - a.hy * a.side * 1.3,
        a.y / this.perMeter + a.hx * a.side * 1.3,
        memberSize('adult').length,
        memberSize('adult').width,
      );
      out.length = 2;
      return out;
    }
    const mover = 'kind' in a;
    if (mover && a.train) {
      const train = this.birthBodies(a);
      out.length = train.length;
      train.forEach((b, i) => {
        out[i] = { ...b, length: Math.max(b.length, minimum), kind: BODY_KIND.vehicle };
      });
      return out;
    }
    const sceneOwner = 'kind' in identity ? identity : undefined;
    const lane = mover ? this.offsetOf(a, sceneOwner) : 0;
    const x = cursor.x / this.perMeter - cursor.hy * lane;
    const y = cursor.y / this.perMeter + cursor.hx * lane;

    if (mover && (a.kind === 'dog' || a.kind === 'cat')) {
      const size = animalSize(a.kind);
      const b = out[0] ?? (out[0] = { x: 0, y: 0, hx: 0, hy: 0, length: 0, width: 0 });
      Object.assign(b, {
        x,
        y,
        hx: cursor.hx,
        hy: cursor.hy,
        length: Math.max(size.length, minimum),
        width: Math.max(size.width, minimum),
        kind: BODY_KIND.animal,
      });
      const waiting = a.crossingWait?.waiting?.poses[0];
      if (waiting)
        Object.assign(b, waiting, {
          x: cursor.x / this.perMeter + waiting.x,
          y: cursor.y / this.perMeter + waiting.y,
        });
      out.length = 1;
      return out;
    }
    if (mover && a.vehicle) {
      const s = VEHICLES[a.vehicle];
      const b = out[0] ?? (out[0] = { x: 0, y: 0, hx: 0, hy: 0, length: 0, width: 0 });
      this.pose(a, b, sceneOwner);
      b.x /= this.perMeter;
      b.y /= this.perMeter;
      b.length = Math.max(s.length, minimum);
      b.width = Math.max(s.width, minimum);
      b.kind = BODY_KIND.vehicle;
      out.length = 1;
      return out;
    }
    const walkers = mover ? (a.group ?? []) : [a.walker];
    const { hx, hy } = a.momentFacing ?? cursor;

    for (let i = 0; i < walkers.length; i++) {
      const w = walkers[i]!;
      const b = out[i] ?? (out[i] = { x: 0, y: 0, hx: 0, hy: 0, length: 0, width: 0 });
      b.x = x - hy * w.lateral - hx * w.back;
      b.y = y + hx * w.lateral - hy * w.back;
      b.hx = hx;
      b.hy = hy;
      b.length = Math.max(memberSize(w.figure).length, minimum);
      b.width = Math.max(memberSize(w.figure).width, minimum);
      b.kind = BODY_KIND.human;
      const waiting = a.crossingWait?.waiting?.poses[i];
      if (waiting)
        Object.assign(b, waiting, {
          x: cursor.x / this.perMeter + waiting.x,
          y: cursor.y / this.perMeter + waiting.y,
        });
    }
    out.length = walkers.length;
    return out;
  }

  /** Conservative complete formation radius, without constructing individual bodies. */
  private crossingRadius(a: GroundAgent, minimum: number): number {
    const mover = 'kind' in a;
    const lane = mover ? Math.abs(this.offsetOf(a)) : 0;
    if (mover && (a.kind === 'dog' || a.kind === 'cat')) {
      const size = animalSize(a.kind);
      return lane + Math.hypot(Math.max(size.length, minimum), Math.max(size.width, minimum)) / 2;
    }
    if (!mover && !('walker' in a)) return 0;
    const facing = a.momentFacing ?? a;
    const scale = Math.hypot(facing.hx, facing.hy);
    let radius = 0;
    const count = mover ? (a.group?.length ?? 0) : 1;
    for (let i = 0; i < count; i++) {
      const w = mover ? a.group![i]! : a.walker;
      const size = memberSize(w.figure);
      const footprint =
        Math.hypot(Math.max(size.length, minimum), Math.max(size.width, minimum)) / 2;
      const extent = lane + Math.hypot(w.lateral, w.back) * scale + footprint;
      radius = Math.max(radius, extent);
    }
    return radius;
  }

  /** World terrain supplies neighboring carriageways; standalone tiles use their own roads. */
  setIdleGuard(guard: (owner: GroundAgent) => boolean) {
    this.idleGuard = guard;
  }

  /** Idle opportunities require every physical body to be entirely off the carriageway. */
  canIdle(owner: GroundAgent): boolean {
    return this.idleGuard
      ? this.idleGuard(owner)
      : this.roadTerrain.access.allows(this.groundBodies(owner, 0, this.idleBodies), false);
  }

  /** Resolve invalid initial positions instead of leaving an overlapping agent stuck. */
  settleGround(guard: GroundGuard) {
    complete(this.settleGroundSteps(guard));
  }
  *settleGroundSteps(guard: GroundGuard): Generator<void, void, void> {
    for (let i = this.stalls.length - 1; i >= 0; i--)
      if (!guard(this.stalls[i]!)) {
        this.scenes.removeStall(this.stalls[i]!);
        this.stalls.splice(i, 1);
      }
    for (let i = this.movers.length - 1; i >= 0; i--) {
      yield;
      const m = this.movers[i]!;
      if (m.kind !== 'vehicle' && m.kind !== 'person') continue;
      let fits = (m.kind !== 'vehicle' || this.junctionIndex.canSpawnVehicle(m)) && guard(m);

      for (let attempt = 0; !fits && attempt < 24; attempt++) {
        yield;
        this.advance(m, (3 + attempt) * this.perMeter, false);
        fits =
          inTile(m) && (m.kind !== 'vehicle' || this.junctionIndex.canSpawnVehicle(m)) && guard(m);
      }
      if (!fits) this.movers.splice(i, 1);
    }
    for (let i = this.gatherers.length - 1; i >= 0; i--) {
      yield;
      const g = this.gatherers[i]!;
      let fits = this.canIdle(g) && guard(g);
      for (let attempt = 0; !fits && g.behavior !== 'sit' && attempt < 24; attempt++) {
        yield;
        this.nextTarget(g);
        g.x = g.tx;
        g.y = g.ty;
        fits = this.canIdle(g) && guard(g);
      }
      if (!fits) this.gatherers.splice(i, 1);
    }
  }

  /** Animals reserve only the space left after all legacy ground actors settle. */
  settleAnimals(guard: GroundGuard) {
    complete(this.settleAnimalsSteps(guard));
  }
  *settleAnimalsSteps(guard: GroundGuard): Generator<void, void, void> {
    for (let i = this.movers.length - 1; i >= 0; i--) {
      yield;
      const m = this.movers[i]!;
      if (m.kind !== 'cat' && m.kind !== 'dog') continue;
      let fits = inTile(m) && guard(m);
      for (let attempt = 0; !fits && attempt < 24; attempt++) {
        yield;
        this.advance(m, (3 + attempt) * this.perMeter, false);
        fits = inTile(m) && guard(m);
      }
      if (!fits) this.movers.splice(i, 1);
    }
  }

  /** Legacy actors settle first. New streams only append candidates that fit the reserved scene. */
  admitCommerce(guard: GroundGuard) {
    complete(this.admitCommerceSteps(guard));
  }
  *admitCommerceSteps(guard: GroundGuard): Generator<void, void, void> {
    if (this.commerceAdmitted) return;
    const commerce = this.geo.commerce ?? [];
    if (!commerce.length) {
      this.commerceAdmitted = true;
      return;
    }
    for (const shoppers of [false, true]) {
      const rng = shoppers ? this.commercePeopleRng : this.commerceStallsRng;
      for (let line = 0, end = 0; line < this.geo.kinds.length; line = end) {
        end = this.populationRange(line).end;
        if (this.geo.navigationOnly?.[line]) continue;
        yield;
        const kind = this.geo.kinds[line];
        if (kind !== LifeLine.path && kind !== LifeLine.plaza) continue;
        const length = this.populationLength(line, end),
          meters = length / this.perMeter;
        if (!length) continue;
        let shops = 0;
        for (let i = 0; i < commerce.length; i += 2) {
          const p = { x: commerce[i]!, y: commerce[i + 1]! };
          let matched = false;
          for (let piece = line; piece < end; piece++) {
            for (let v = this.first(piece); v < this.last(piece); v++) {
              if ((v & 63) === 0) yield;
              const x = this.geo.coords[v * 2]!,
                y = this.geo.coords[v * 2 + 1]!,
                dx = this.geo.coords[(v + 1) * 2]! - x,
                dy = this.geo.coords[(v + 1) * 2 + 1]! - y;
              const t = Math.max(
                0,
                Math.min(1, ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy || 1)),
              );
              if (
                Math.hypot(p.x - x - dx * t, p.y - y - dy * t) <=
                COMMERCE.reach * this.perMeter
              ) {
                shops++;
                matched = true;
                break;
              }
            }
            if (matched) break;
          }
        }
        const count = Math.min(
          shoppers ? 40 : 20,
          Math.floor((meters / 100) * Math.min(COMMERCE.max, shops * COMMERCE.perShop) + rng()),
        );
        for (let i = 0; i < count; i++) {
          yield;
          if (
            shoppers ? this.population >= MAX_TILE_AGENTS : this.stalls.length >= VENDORS.maxPerTile
          )
            break;
          const dir = rng() < 0.5 ? 1 : -1;
          const m: Mover = {
            kind: 'person',
            line,
            from: dir === 1 ? this.first(line) : this.last(line),
            dir,
            d: 0,
            speed: (1 + rng() * 0.5) * this.perMeter,
            paint: 0,
            lane: 0,
            pause: 0,
            rank: rng(),
            x: 0,
            y: 0,
            hx: 1,
            hy: 0,
            walked: rng() * 2 * PEOPLE.stride,
          };
          const position = this.populationPiece(line, end, rng() * length, dir);
          m.line = position.line;
          m.from = dir === 1 ? this.first(position.line) : this.last(position.line);
          this.advance(m, position.distance, false);
          if (!inTile(m)) continue;
          let close = false;
          for (let j = 0; j < commerce.length; j += 2)
            if (
              Math.hypot(m.x - commerce[j]!, m.y - commerce[j + 1]!) <
              COMMERCE.reach * this.perMeter
            )
              close = true;
          if (!close) continue;
          if (shoppers) {
            m.group = [
              {
                figure: 'adult',
                shirt: SHIRT_PAINTS[Math.floor(rng() * SHIRT_PAINTS.length)]!,
                umbrella: rng(),
                canopy: UMBRELLA_PAINTS[Math.floor(rng() * UMBRELLA_PAINTS.length)]!,
                lateral: 0,
                back: 0,
                step: rng() < 0.5 ? 0 : 1,
              },
            ];
            if (!this.strandedWalk(m.line) && guard(m)) this.movers.push(m);
          } else {
            let market = false;
            for (let j = 0; j < this.geo.markets.length; j += 2)
              if (
                Math.hypot(m.x - this.geo.markets[j]!, m.y - this.geo.markets[j + 1]!) <
                VENDORS.marketReach * this.perMeter
              )
                market = true;
            if (market) continue;
            const side = dir;
            const stall: Stall = {
              x: m.x - m.hy * VENDORS.beside * this.perMeter,
              y: m.y + m.hx * VENDORS.beside * this.perMeter,
              hx: m.hx,
              hy: m.hy,
              paint: Paint.cream,
              shirt: SHIRT_PAINTS[Math.floor(rng() * SHIRT_PAINTS.length)]!,
              side,
              rank: rng(),
            };
            if (guard(stall)) {
              this.stalls.push(stall);
              this.scenes.addStall(stall);
            }
          }
        }
      }
    }
    this.commerceAdmitted = true;
  }

  private *spawnCats(): Generator<void, void, void> {
    const rng = this.catRng;
    let count = 0;
    for (
      let line = 0, end = 0;
      line < this.geo.kinds.length && count < CAT.maxPerTile;
      line = end
    ) {
      const kind = this.geo.kinds[line];
      end =
        kind === LifeLine.path || kind === LifeLine.plaza
          ? this.populationRange(line).end
          : line + 1;
      yield;
      if (this.geo.navigationOnly?.[line]) continue;
      if (!usableLines.cat.includes(this.geo.kinds[line]! as LifeLine)) continue;
      const rule = spawnRules[this.geo.kinds[line]! as LifeLine].find((r) => r.kind === 'cat');
      if (!rule) continue;
      const length = this.populationLength(line, end);
      const cats = Math.floor(length / this.perMeter / rule.spacing + rng());
      for (
        let i = 0;
        i < cats && count < CAT.maxPerTile && this.population < MAX_TILE_AGENTS;
        i++
      ) {
        yield;
        const dir = rng() < 0.5 ? 1 : -1;
        const m: Mover = {
          kind: 'cat',
          line,
          from: dir === 1 ? this.first(line) : this.last(line),
          dir,
          d: 0,
          speed: between(rng, rule.speed) * this.perMeter,
          paint: CAT_PAINTS[Math.floor(rng() * CAT_PAINTS.length)]!,
          lane: 0,
          pause: between(rng, CAT.initialPause),
          rank: rng(),
          x: 0,
          y: 0,
          hx: 1,
          hy: 0,
          walked: 0,
        };
        const position = this.populationPiece(line, end, rng() * length, dir);
        m.line = position.line;
        m.from = dir === 1 ? this.first(position.line) : this.last(position.line);
        this.advance(m, position.distance, false);
        if (
          !inTile(m) ||
          !this.scenes.walkable(m, m) ||
          !this.roadTerrain.access.allows(this.groundBodies(m))
        )
          continue;
        this.movers.push(m);
        count++;
      }
    }
  }

  /** The point `distance` tile units along `line`, and the line's heading there. */
  private pointAt(line: number, distance: number) {
    const { coords } = this.geo;
    let v = this.first(line);
    while (v < this.last(line) - 1 && this.along[v + 1]! <= distance) v++;
    const length = this.segment(v, v + 1) || 1;
    const hx = (coords[(v + 1) * 2]! - coords[v * 2]!) / length;
    const hy = (coords[(v + 1) * 2 + 1]! - coords[v * 2 + 1]!) / length;
    const t = distance - this.along[v]!;
    return { x: coords[v * 2]! + hx * t, y: coords[v * 2 + 1]! + hy * t, hx, hy };
  }
  /** Pure candidate placement on the seed's original route; complete trains need a real trail. */
  placeSeed(m: Mover, distance: number): Mover | undefined {
    const line = m.line,
      first = this.first(line),
      last = this.last(line);
    const d = Math.max(0, Math.min(this.lineLength(line), distance));
    let v = first;
    while (v < last - 1 && this.along[v + 1]! <= d) v++;
    const length = this.segment(v, v + 1);
    if (!length) return;
    const point = this.pointAt(line, d);
    const candidate: Mover = {
      ...m,
      ...point,
      hx: point.hx * m.dir,
      hy: point.hy * m.dir,
      from: m.dir === 1 ? v : v + 1,
      d: m.dir === 1 ? d - this.along[v]! : this.along[v + 1]! - d,
      v: 0,
      next: undefined,
      came: undefined,
      junctionRoute: undefined,
    };
    if (m.routing) candidate.routing = { seed: m.routing.seed, turns: m.routing.turns };
    if (m.train) {
      const length = trainLength(m.train.cars) * this.perMeter;
      if (m.dir === 1 ? d < length : this.lineLength(line) - d < length) return;
      const trail: number[] = [];
      for (
        let back = TRAIN.crumb * this.perMeter;
        back < length + TRAIN.crumb * this.perMeter;
        back += TRAIN.crumb * this.perMeter
      ) {
        const p = this.pointAt(line, d - m.dir * Math.min(length, back));
        trail.push(p.x, p.y);
      }
      candidate.train = { ...m.train, trail, stopX: NaN, stopY: NaN, edge: false, reverse: false };
    }
    return candidate;
  }

  birthBodies(m: Mover): Body[] {
    if (!m.train) return this.groundBodies(m);
    const trail = [m.x, m.y, ...m.train.trail],
      bodies: Body[] = [];
    let back = 0;
    for (const car of m.train.cars) {
      const spec = VEHICLES[car],
        at = alongTrail(trail, (back + spec.length / 2) * this.perMeter);
      if (!at) return [];
      bodies.push({
        x: at.x / this.perMeter,
        y: at.y / this.perMeter,
        hx: at.hx,
        hy: at.hy,
        length: spec.length,
        width: spec.width,
      });
      back += spec.length + TRAIN.coupling;
    }
    return bodies;
  }

  /** Who walks together (config.ts `PEOPLE`): one to four, led by an adult. */
  private spawnGroup(): Walker[] {
    const { looks } = this;
    const pick = (paints: readonly number[]) => paints[Math.floor(looks() * paints.length)]!;
    const r = looks();
    const size = PEOPLE.groups.findIndex((upTo) => r < upTo) + 1;
    return GROUP_SLOTS.slice(0, size).map(([lateral, back], i) => ({
      figure: i > 0 && looks() < PEOPLE.child ? 'child' : 'adult',
      shirt: pick(SHIRT_PAINTS),
      umbrella: looks(),
      canopy: pick(UMBRELLA_PAINTS),
      lateral,
      back,
      step: looks() < 0.5 ? 0 : 1,
    }));
  }

  /**
   * Street vendors beside walking paths and parks. Legacy road candidates consume their
   * appearance stream but are omitted, keeping the other vendors deterministic.
   */
  private *spawnStalls(): Generator<void, void, void> {
    const { geo, looks, perMeter } = this;
    const reach = VENDORS.marketReach * perMeter;
    const nearMarket = (x: number, y: number) => {
      for (let i = 0; i < geo.markets.length; i += 2) {
        if (Math.hypot(geo.markets[i]! - x, geo.markets[i + 1]! - y) <= reach) return true;
      }
      return false;
    };
    const paints = VEHICLES.cart.paints;
    for (let line = 0, end = 0; line < geo.kinds.length; line = end) {
      end = this.populationRange(line).end;
      if (geo.navigationOnly?.[line]) continue;
      const kind = geo.kinds[line]! as LifeLine;
      const spacing = VENDORS.spacing[kind];
      const length = this.populationLength(line, end);
      if (!spacing || length === 0) continue;
      const point = (distance: number) => {
        const position = this.populationPiece(line, end, distance, 1);
        return this.pointAt(position.line, position.distance);
      };
      const middle = point(length / 2);
      const boost = nearMarket(middle.x, middle.y) ? VENDORS.marketBoost : 1;
      const count = Math.floor(((length / perMeter) * boost) / spacing + looks());
      for (let i = 0; i < count && this.stalls.length < VENDORS.maxPerTile; i++) {
        yield;
        const p = point(looks() * length);
        const side = looks() < 0.5 ? 1 : -1;
        // Right of the line's direction for `side` 1; the vendor stands on the far side.
        const o = VENDORS.beside * perMeter * side;
        const stall: Stall = {
          x: p.x - p.hy * o,
          y: p.y + p.hx * o,
          hx: p.hx,
          hy: p.hy,
          paint: paints[Math.floor(looks() * paints.length)]!,
          shirt: SHIRT_PAINTS[Math.floor(looks() * SHIRT_PAINTS.length)]!,
          side,
          rank: looks(),
        };
        if (
          kind !== LifeLine.roadMinor &&
          this.roadTerrain.access.allows(this.groundBodies(stall), false)
        )
          this.stalls.push(stall);
      }
    }
  }

  /**
   * People at places (config.ts `PLACES`): around churches and schools (on their grounds, or
   * around their buildings), running about pitches, at monuments and fountains, on benches, and
   * working the fields, at most `MAX_TILE_GATHERERS`. At a school, most are children.
   */
  private *spawnGatherers(): Generator<void, void, void> {
    const { geo, perMeter } = this;
    const rng = this.placeRng;
    for (let i = 0; i < geo.places.length; i += PLACE_STRIDE) {
      yield;
      const place = PLACE_CODES[geo.places[i + 2]!];
      if (!place) continue;
      const rule = PLACES[place];
      const cx = geo.places[i]!;
      const cy = geo.places[i + 1]!;
      const radius = geo.places[i + 3]!;
      // Around a building, a monument, or a fountain, never on it; else anywhere on the area.
      const around = geo.places[i + 4] === 1 || place === 'monument' || place === 'fountain';
      const inner = around ? radius + 1.5 * perMeter : 0;
      const outer = around ? radius + (1.5 + rule.wander) * perMeter : radius * 0.85;
      const count = Math.min(
        rule.max,
        Math.floor(rule.base + (rule.perMeter * radius) / perMeter + rng()),
      );
      const row = rng() * Math.PI;
      for (
        let n = 0;
        n < count &&
        this.gatherers.length + (this.suppressedGround?.gatherers.hidden.length ?? 0) <
          MAX_TILE_GATHERERS;
        n++
      ) {
        yield;
        const figure = place === 'school' && rng() < 0.6 ? 'child' : 'adult';
        const g: Gatherer = {
          source: i / PLACE_STRIDE,
          place,
          behavior: rule.behavior,
          cx,
          cy,
          inner,
          outer,
          x: cx,
          y: cy,
          hx: 1,
          hy: 0,
          tx: cx,
          ty: cy,
          speed: between(rng, rule.speed) * perMeter,
          pause: between(rng, rule.pause),
          walked: 0,
          rank: rng(),
          walker: {
            figure,
            shirt: SHIRT_PAINTS[Math.floor(rng() * SHIRT_PAINTS.length)]!,
            umbrella: rng(),
            canopy: UMBRELLA_PAINTS[Math.floor(rng() * UMBRELLA_PAINTS.length)]!,
            lateral: 0,
            back: 0,
            step: rng() < 0.5 ? 0 : 1,
          },
          rx: Math.cos(row),
          ry: Math.sin(row),
          sign: rng() < 0.5 ? 1 : -1,
        };
        if (g.behavior === 'sit') {
          // Side by side on the bench.
          const bearing = geo.seatBearings?.[i / PLACE_STRIDE];
          const offset = (n - (count - 1) / 2) * 0.5 * perMeter;
          if (bearing !== undefined && Number.isFinite(bearing)) {
            const angle = (bearing * Math.PI) / 180;
            g.hx = Math.sin(angle);
            g.hy = -Math.cos(angle);
            g.x = cx - g.hy * offset;
            g.y = cy + g.hx * offset;
          } else g.x = cx + offset;
        } else {
          const a = rng() * Math.PI * 2;
          const d = Math.sqrt(inner * inner + rng() * (outer * outer - inner * inner));
          g.x = cx + Math.cos(a) * d;
          g.y = cy + Math.sin(a) * d;
          g.hx = -Math.sin(a);
          g.hy = Math.cos(a);
          if (g.behavior === 'work') {
            g.hx = g.rx;
            g.hy = g.ry;
            if (rng() < CARABAO_SHARE) {
              const paints = VEHICLES.carabao.paints;
              g.carabao = paints[Math.floor(rng() * paints.length)]!;
            }
          }
          this.nextTarget(g);
        }
        if (this.canIdle(g)) this.gatherers.push(g);
      }
    }
  }

  /**
   * Where someone at a place walks next: across the pitch (players); to the end of their row,
   * then along the next row over, back the other way (farm workers); or a few meters round the
   * building, monument, or fountain they stand by, or across the grounds they stand on.
   */
  admitSeasonalGatherers(
    config: SimulationSeason,
    guard: GroundGuard,
    remove: (owner: Gatherer) => void = () => {},
  ) {
    this.seasonalGatherersAdmitted = true;
    this.gatherers.push(
      ...seasonalCrowds(config, {
        tile: this.tile,
        geo: this.geo,
        perMeter: this.perMeter,
        count: this.gatherers.length + (this.suppressedGround?.gatherers.hidden.length ?? 0),
        visitorsRng: this.visitorsRng,
        congregationsRng: this.congregationsRng,
        target: (g) => this.nextTarget(g),
        guard: (g) => this.canIdle(g) && guard(g),
        remove,
      }),
    );
  }

  clearSeasonalGatherers(remove: (owner: Gatherer) => void = () => {}) {
    this.seasonalGatherersAdmitted = false;
    const clear = (owners: Gatherer[]) => {
      for (let i = owners.length - 1; i >= 0; i--) {
        const g = owners[i]!;
        if (!g.seasonal) continue;
        remove(g);
        if (this.inspected === g) this.inspected = undefined;
        delete g.momentFacing;
        owners.splice(i, 1);
      }
    };
    clear(this.gatherers);
    if (this.suppressedGround) clear(this.suppressedGround.gatherers.hidden);
  }

  private nextTarget(g: Gatherer) {
    const previous = { tx: g.tx, ty: g.ty, sign: g.sign };
    this.chooseTarget(g);
    if (!this.canIdle(this.targetBody(g))) {
      Object.assign(g, previous);
      if (!this.canIdle(this.targetBody(g))) {
        g.tx = g.x;
        g.ty = g.y;
      }
    }
  }

  private targetBody(g: Gatherer): Gatherer {
    const dx = g.tx - g.x,
      dy = g.ty - g.y;
    const length = Math.hypot(dx, dy);
    return {
      ...g,
      x: g.tx,
      y: g.ty,
      hx: length > 0 ? dx / length : g.hx,
      hy: length > 0 ? dy / length : g.hy,
    };
  }

  private chooseTarget(g: Gatherer) {
    const rng = this.gathererRng(g);
    const { perMeter } = this;
    const reach = 8 * perMeter;
    switch (g.behavior) {
      case 'sit':
        return;
      case 'play': {
        const a = rng() * Math.PI * 2;
        const d = Math.sqrt(rng()) * g.outer;
        g.tx = g.cx + Math.cos(a) * d;
        g.ty = g.cy + Math.sin(a) * d;
        return;
      }
      case 'work': {
        // The next row over, then to its end in the new direction (at most 40 m on).
        g.sign = g.sign === 1 ? -1 : 1;
        let x = g.x - g.ry * 2 * perMeter;
        let y = g.y + g.rx * 2 * perMeter;
        if (Math.hypot(x - g.cx, y - g.cy) > g.outer) {
          // Out of the field: start again from the middle row.
          x = g.cx;
          y = g.cy;
        }
        const qx = x - g.cx;
        const qy = y - g.cy;
        const b = qx * g.rx + qy * g.ry;
        const disc = b * b - (qx * qx + qy * qy - g.outer * g.outer);
        const end = disc > 0 ? -b + g.sign * Math.sqrt(disc) : 0;
        const t = Math.max(-40 * perMeter, Math.min(40 * perMeter, end));
        g.tx = x + g.rx * t;
        g.ty = y + g.ry * t;
        return;
      }
      case 'gather': {
        if (g.inner > 0) {
          // A few meters round the ring, at a new distance from the walls.
          const at = Math.atan2(g.y - g.cy, g.x - g.cx);
          const a = at + ((rng() * 2 - 1) * reach) / Math.max(g.inner, perMeter);
          const d = g.inner + rng() * (g.outer - g.inner);
          g.tx = g.cx + Math.cos(a) * d;
          g.ty = g.cy + Math.sin(a) * d;
        } else {
          // Towards a spot on the grounds, at most `reach` away.
          const a = rng() * Math.PI * 2;
          const d = Math.sqrt(rng()) * g.outer;
          const dx = g.cx + Math.cos(a) * d - g.x;
          const dy = g.cy + Math.sin(a) * d - g.y;
          const k = Math.min(1, reach / (Math.hypot(dx, dy) || 1));
          g.tx = g.x + dx * k;
          g.ty = g.y + dy * k;
        }
        return;
      }
    }
  }

  /** People at places walk to their next spot, and stand there a while (`PLACES` `pause`). */
  private stepGatherers(dt: number, near?: (x: number, y: number) => boolean, guard?: GroundGuard) {
    for (const g of this.gatherers) {
      const rng = this.gathererRng(g);
      if (this.inspected === g) continue;
      if (this.ownership && !this.ownership(g)) continue;
      if (g.behavior === 'sit' || (near && !near(g.x, g.y))) continue;
      if (this.momentHost.moments.busy(g)) {
        g.pause = Math.max(0, g.pause - dt);
        continue;
      }
      if (!this.canIdle(g)) g.pause = 0;
      if (g.pause > 0) {
        if (!g.seasonal) this.momentHost.attend(g, guard);
        g.pause -= dt;
        continue;
      }
      const dx = g.tx - g.x;
      const dy = g.ty - g.y;
      const dist = Math.hypot(dx, dy);
      this.crossingTarget.x = g.tx;
      this.crossingTarget.y = g.ty;
      const move = this.crossingWaits.limit(
        g,
        this.crossingTarget,
        g.speed * dt,
        this.crossingClock,
        this.crossingMinimum,
      );
      const before = guard && { ...g };
      delete g.momentFacing;
      if (dist <= move) {
        g.x = g.tx;
        g.y = g.ty;
        g.pause = this.canIdle(g)
          ? between(rng, g.seasonal ? SEASON_CROWD.pause : PLACES[g.place].pause)
          : 0;
        this.nextTarget(g);
      } else {
        g.hx = dx / dist;
        g.hy = dy / dist;
        g.x += g.hx * move;
        g.y += g.hy * move;
        g.walked += move / this.perMeter;
      }
      if (before && guard && !guard(g, before)) {
        Object.assign(g, before);
        this.nextTarget(g);
      }
    }
  }

  /**
   * Parked vehicles (config.ts `PARKED`): on parking lots' stalls, and along both curbs of
   * some wide roads, facing the traffic on their side.
   */
  private *spawnParked(rng: () => number): Generator<void, void, void> {
    const { geo, perMeter } = this;
    const shares = this.traffic.parked;
    const excluded = new PolygonIndex();
    for (const a of geo.areas ?? [])
      if (a.kind === 'blocked' || a.kind === 'vehicle-blocked' || a.kind === 'parking-exclusion')
        yield* excluded.addSteps(transformPolygon(a.rings, 0, 0, 1 / perMeter));
    const sample: Body[] = [];
    const curbSources = new Map<Parked, number>();
    const bodyOf = (x: number, y: number, hx: number, hy: number, vehicle: CraftType) => ({
      x,
      y,
      hx,
      hy,
      length: VEHICLES[vehicle].length * perMeter,
      width: VEHICLES[vehicle].width * perMeter,
    });
    const park = (
      x: number,
      y: number,
      hx: number,
      hy: number,
      vehicle: CraftType,
      line?: number,
    ) => {
      if (
        this.parked.length + (this.suppressedGround?.parked.hidden.length ?? 0) >=
          MAX_TILE_AGENTS ||
        !inTile({ x, y })
      )
        return;
      const body = bodyOf(x, y, hx, hy, vehicle);
      sample[0] = {
        ...body,
        x: x / perMeter,
        y: y / perMeter,
        length: body.length / perMeter,
        width: body.width / perMeter,
      };
      if (excluded.hits(sample)) return;
      const gap = 0.2 * perMeter;
      if (
        this.parked.some((p) => bodiesOverlap(body, bodyOf(p.x, p.y, p.hx, p.hy, p.vehicle), gap))
      )
        return;
      const paints = VEHICLES[vehicle].paints;
      const paint = paints[Math.floor(rng() * paints.length)]!;
      // Consume the original paint draw before this added rejection, preserving
      // all later placements on the independent parking stream.
      if (
        this.junctionIndex.junctions.some((j) => {
          const dx = j.x - x,
            dy = j.y - y;
          const along = Math.max(0, Math.abs(dx * hx + dy * hy) - body.length / 2);
          const across = Math.max(0, Math.abs(-dx * hy + dy * hx) - body.width / 2);
          return Math.hypot(along, across) < j.radius + PARKED.junctionGap * perMeter;
        })
      )
        return;
      const record = { x, y, hx, hy, vehicle, paint };
      this.parked.push(record);
      if (line !== undefined) curbSources.set(record, line);
    };
    const lots = geo.areas?.filter((a) => a.kind === 'parking');
    for (let i = 0; i < geo.spots.length; i += 4) {
      yield;
      const vehicle = pickVehicle(shares, rng());
      if (rng() < PARKED.lotTaken) {
        const [x, y, hx, hy] = [
          geo.spots[i]!,
          geo.spots[i + 1]!,
          geo.spots[i + 2]!,
          geo.spots[i + 3]!,
        ];
        const body = bodyOf(x, y, hx, hy, vehicle);
        if (lots?.length && !lots.some((a) => bodyInside(body, a.rings))) continue;
        park(x, y, hx, hy, vehicle);
      }
    }
    const curbParking = new Map<number, boolean>();
    for (let line = 0; line < geo.kinds.length; line++) {
      const road = trafficRoadFor[geo.kinds[line]! as LifeLine];
      const width = geo.widths[line] ?? 0;
      const onWater = road === 'river' || road === 'canal';
      if (!road || onWater || width < PARKED.minWidth) continue;
      const id = geo.lineIds?.[line] ?? 0;
      let chosen = id ? curbParking.get(id) : undefined;
      if (chosen === undefined) {
        chosen = rng() < PARKED.chance;
        if (id) curbParking.set(id, chosen);
      }
      if (!chosen) continue;
      this.parkingLines.add(line);
      const length = this.along[this.last(line)]!;
      for (const side of [1, -1]) {
        for (let at = 0; ;) {
          yield;
          const vehicle = pickVehicle(shares, rng());
          const spec = VEHICLES[vehicle];
          const center = at + (spec.length / 2) * perMeter;
          at += (spec.length + PARKED.gap) * perMeter;
          if (at > length) break;
          if (rng() >= PARKED.taken) continue;
          if (spec.width > PARKED.strip - ROAD_MARGIN_M) continue;
          const p = this.pointAt(line, center);
          if (
            this.junctions.some(
              (j) =>
                Math.hypot(p.x - j.x, p.y - j.y) <
                j.radius + (PARKED.junctionGap + spec.length / 2) * perMeter,
            )
          )
            continue;
          const offset = (width / 2 - spec.width / 2 - ROAD_MARGIN_M) * perMeter * side;
          // At a bend, both ends of a long vehicle must fit the actual carriageway.
          const fits = [-spec.length / 2, spec.length / 2].every((d) => {
            const q = this.pointAt(line, center + d * perMeter);
            const x = p.x - p.hy * offset + p.hx * d * perMeter;
            const y = p.y + p.hx * offset + p.hy * d * perMeter;
            return (
              Math.hypot(x - q.x, y - q.y) + (spec.width / 2) * perMeter <=
              (width / 2) * perMeter + 0.01
            );
          });
          if (!fits) continue;
          // Right of the line's own direction for `side` 1, facing along it; left, facing back.
          park(p.x - p.hy * offset, p.y + p.hx * offset, p.hx * side, p.hy * side, vehicle, line);
        }
      }
    }
    // Finish every legacy placement and conditional RNG draw before changing live parking.
    const eligible = (line: number) => PARKED.classes.some((kind) => kind === geo.kinds[line]);
    let kept = 0;
    for (const record of this.parked) {
      const line = curbSources.get(record);
      if (line === undefined || eligible(line)) this.parked[kept++] = record;
    }
    this.parked.length = kept;
    for (const line of this.parkingLines) if (!eligible(line)) this.parkingLines.delete(line);
  }

  /** Shared vertices, T-junctions and crossings; two continuation arms are just a bend. */
  private *findJunctions(): Generator<void, void, void> {
    const { geo } = this;
    const segments: {
      line: number;
      a: { x: number; y: number };
      b: { x: number; y: number };
      width: number;
    }[] = [];
    for (let line = 0; line < geo.kinds.length; line++) {
      if (geo.kinds[line]! > LifeLine.roadMinor) continue;
      for (let v = this.first(line); v < this.last(line); v++) {
        if ((v & 127) === 0) yield;
        segments.push({
          line,
          a: { x: geo.coords[v * 2]!, y: geo.coords[v * 2 + 1]! },
          b: { x: geo.coords[v * 2 + 2]!, y: geo.coords[v * 2 + 3]! },
          width: (geo.widths[line]! / 2) * this.perMeter,
        });
      }
    }
    const found = new Map<string, { x: number; y: number; radius: number; arms: Set<number> }>();
    let pairs = 0;
    for (let i = 0; i < segments.length; i++)
      for (let j = i + 1; j < segments.length; j++) {
        if ((++pairs & 127) === 0) yield;
        const a = segments[i]!,
          b = segments[j]!;
        if (a.line === b.line) continue;
        if (
          Math.max(a.a.x, a.b.x) < Math.min(b.a.x, b.b.x) ||
          Math.max(b.a.x, b.b.x) < Math.min(a.a.x, a.b.x) ||
          Math.max(a.a.y, a.b.y) < Math.min(b.a.y, b.b.y) ||
          Math.max(b.a.y, b.b.y) < Math.min(a.a.y, a.b.y)
        )
          continue;
        const p = segmentCrossing(a.a, a.b, b.a, b.b);
        if (!p) continue;
        const key = `${Math.round(p.x)}/${Math.round(p.y)}`;
        let hit = found.get(key);
        if (!hit) found.set(key, (hit = { ...p, radius: 0, arms: new Set() }));
        hit.radius = Math.max(hit.radius, a.width, b.width);
        for (const q of [a.a, a.b, b.a, b.b]) {
          if (Math.hypot(q.x - p.x, q.y - p.y) < 1) continue;
          hit.arms.add(
            Math.round((Math.atan2(q.y - p.y, q.x - p.x) + Math.PI) / (Math.PI / 16)) % 32,
          );
        }
      }
    this.junctions = [...found.values()].filter((j) => j.arms.size >= 3);
  }

  /**
   * A train standing by on each siding, spur, or yard track (config.ts `TRAIN.standby`): a
   * locomotive and as many coaches as fit, from `margin` m in from the siding's start. A siding
   * belongs to the tile holding its first vertex, so each gets one train, however many tiles'
   * buffers it reaches into.
   */
  private *spawnStandby(rng: () => number): Generator<void, void, void> {
    const { geo, perMeter } = this;
    const { margin, coaches } = TRAIN.standby;
    for (let line = 0; line < geo.kinds.length; line++) {
      yield;
      if (geo.kinds[line] !== LifeLine.siding) continue;
      const x = geo.coords[this.first(line) * 2]!;
      const y = geo.coords[this.first(line) * 2 + 1]!;
      if (!inTile({ x, y })) continue;
      const cars = consist(Math.round(between(rng, coaches)));
      const paint = TRAIN_PAINTS[Math.floor(rng() * TRAIN_PAINTS.length)]!;
      const room = this.along[this.last(line)]! / perMeter - margin;
      let at = margin;
      for (const car of cars) {
        const { length } = VEHICLES[car];
        if (at + length > room) break;
        const p = this.pointAt(line, (at + length / 2) * perMeter);
        // Facing back toward the siding's start, the way it would pull out.
        this.standby.push({ x: p.x, y: p.y, hx: -p.hx, hy: -p.hy, vehicle: car, paint });
        at += length + TRAIN.coupling;
      }
    }
  }

  /** Admit a complete train on a running line, with enough trail for every coach. */
  arrive(line: number, rng: () => number, owns?: (m: Mover) => boolean): boolean {
    if (this.geo.kinds[line] !== LifeLine.rail || this.population >= MAX_TILE_AGENTS) return false;
    const cars = consist(Math.round(between(rng, TRAIN.coaches)));
    const length = trainLength(cars) * this.perMeter;
    if (this.lineLength(line) < length + 10 * this.perMeter) return false;
    const dir = rng() < 0.5 ? 1 : -1;
    const speed = between(rng, [8, 14]) * this.perMeter;
    const paint = TRAIN_PAINTS[Math.floor(rng() * TRAIN_PAINTS.length)]!;
    // Stay inside the owning tile even when the source line includes a tile buffer. Each attempt
    // starts afresh: a failed one may have turned the train onto another line or reversed it.
    for (const progress of [5, 15, 30]) {
      const m: Mover = {
        kind: 'train',
        line,
        from: dir === 1 ? this.first(line) : this.last(line),
        dir,
        d: 0,
        speed,
        paint,
        lane: 0,
        pause: 0,
        rank: 0,
        x: 0,
        y: 0,
        hx: 1,
        hy: 0,
        train: newTrain(cars),
      };
      this.advance(m, progress * this.perMeter, false);
      this.moveTrain(m, length);
      if (
        inTile(m) &&
        (!owns || owns(m)) &&
        !m.train!.edge &&
        trainCars(this, m).length === cars.length
      ) {
        this.movers.push(m);
        return true;
      }
    }
    return false;
  }

  private *spawnFlocks(): Generator<void, void, void> {
    const { rng, geo } = this;
    const roosts = geo.roosts.length / 2;
    const perches = geo.perches.length / 2;
    const flocks = Math.min(BIRDS.flocksPerTile, roosts + perches);
    for (let f = 0; f < flocks; f++) {
      yield;
      // A tile with only trees starts its flocks in them.
      const inTree = roosts === 0;
      const roost = inTree ? 0 : Math.floor(rng() * roosts);
      const perch = inTree ? Math.floor(rng() * perches) : -1;
      const home = inTree ? geo.perches : geo.roosts;
      const at = inTree ? perch : roost;
      // The species that gather over its home.
      const habitat = inTree ? Habitat.trees : ((geo.roostHabitats[roost] ?? 0) as Habitat);
      const species = pickSpecies(habitat, this.birdRng);
      const spec = BIRD_SPECIES[species];
      const size = Math.round(between(rng, spec.flockSize));
      const birds: Bird[] = [];
      for (let b = 0; b < size; b++) {
        const angle = rng() * 2 * Math.PI;
        const spread = between(rng, spec.spread) * this.perMeter;
        birds.push({ ox: Math.cos(angle) * spread, oy: Math.sin(angle) * spread, phase: rng() });
      }
      this.flocks.push({
        species,
        x: home[at * 2]!,
        y: home[at * 2 + 1]!,
        hx: 0,
        hy: -1,
        roost,
        perch,
        perched: inTree,
        landing: false,
        landed: false,
        feeding: false,
        bout: 0,
        lx: NaN,
        ly: NaN,
        home: -1,
        landingAttempted: false,
        landingBlend: 0,
        scatter: 0,
        angle: rng() * 2 * Math.PI,
        radius: between(rng, spec.orbit) * this.perMeter,
        stay: between(rng, BIRDS.stay),
        rank: rng(),
        birds,
      });
    }
    // By night, bats: a few flocks over the tile's roosts (the trees and water they favor), on
    // their own stream.
    if (roosts === 0) return;
    const brng = this.birdRng;
    const bats = Math.floor(brng() * 3);
    const spec = BIRD_SPECIES.bat;
    for (let f = 0; f < bats; f++) {
      const roost = this.pickRoost('bat', brng);
      const birds: Bird[] = [];
      const size = Math.round(between(brng, spec.flockSize));
      for (let b = 0; b < size; b++) {
        const angle = brng() * 2 * Math.PI;
        const spread = between(brng, spec.spread) * this.perMeter;
        birds.push({ ox: Math.cos(angle) * spread, oy: Math.sin(angle) * spread, phase: brng() });
      }
      this.flocks.push({
        species: 'bat',
        x: geo.roosts[roost * 2]!,
        y: geo.roosts[roost * 2 + 1]!,
        hx: 0,
        hy: -1,
        roost,
        perch: -1,
        perched: false,
        landing: false,
        landed: false,
        feeding: false,
        bout: 0,
        lx: NaN,
        ly: NaN,
        home: -1,
        landingAttempted: false,
        landingBlend: 0,
        scatter: 0,
        angle: brng() * 2 * Math.PI,
        radius: between(brng, spec.orbit) * this.perMeter,
        stay: between(brng, BIRDS.stay),
        rank: brng(),
        birds,
      });
    }
  }

  /** Room before a one-way endpoint with no legal continuation, including the front bumper. */
  private oneWayEndRoom(m: Mover, junctions = true): number | undefined {
    if (m.kind !== 'vehicle' || !this.geo.oneway?.[m.line]) return;
    return this.endpointRoom(m, undefined, junctions);
  }

  private endpointRoom(m: Mover, remaining?: number, junctions = true): number | undefined {
    if (this.crossesSeamLine(m)) return;
    const end = m.dir === 1 ? this.last(m.line) : this.first(m.line);
    if (junctions ? this.hasExit(m, end) : this.populationContinuation(m, end) !== undefined)
      return;
    const length = m.vehicle ? VEHICLES[m.vehicle].length : 0;
    const distance = remaining ?? m.dir * (this.along[end]! - this.along[m.from]!) - m.d;
    return Math.max(0, distance - frontClearance(length) * this.perMeter);
  }

  /** A legal continuation on the original population line, without changing a cursor or RNG. */
  private populationContinuation(m: Mover, end: number): number | undefined {
    const group = this.geo.spawnGroups?.[m.line];
    const line = m.line + m.dir;
    if (group === undefined || this.geo.spawnGroups?.[line] !== group) return;
    const vertex = m.dir === 1 ? this.first(line) : this.last(line);
    if (this.endKey(end) !== this.endKey(vertex)) return;
    const code = line * 2 + (m.dir === 1 ? 0 : 1);
    if (this.exitOptions(m, end).includes(code)) return code;
  }

  /** Initial settlement follows the original line without choosing a random junction exit. */
  private continuePopulation(m: Mover): boolean {
    const code = this.populationContinuation(m, m.from);
    if (code === undefined) return false;
    const line = code >> 1;
    const vertex = code & 1 ? this.last(line) : this.first(line);
    m.line = line;
    m.from = vertex;
    m.next = undefined;
    if (m.routing) m.routing = { ...m.routing, plan: undefined };
    return true;
  }

  /** Read the committed next exit, or the only legal exit, without advancing a random stream. */
  seamExit(m: Mover, line: number, dir: 1 | -1, consumed?: number): number | undefined {
    const end = dir === 1 ? this.last(line) : this.first(line);
    const current = line === m.line && dir === m.dir && (consumed === undefined || consumed === 0);

    const route = m.junctionRoute?.exits;
    const enteredAt = route?.indexOf(line * 2 + (dir === 1 ? 0 : 1)) ?? -1;
    const routeIndex = consumed ?? (current ? 0 : enteredAt >= 0 ? enteredAt + 1 : -1);
    const reserved = routeIndex >= 0 ? route?.[routeIndex] : undefined;
    const plan = m.routing?.plan;
    const planned =
      current && plan?.line === line && plan.dir === dir && plan.vertex === end
        ? plan.exit
        : undefined;
    const remembered = current ? m.next : undefined;
    const options = this.seamExitOptions;
    this.writeExitOptions(m.kind, line, dir, end, options);
    return (
      this.committedExit(options, reserved, planned, remembered) ??
      (options.length === 1 ? options[0] : undefined)
    );
  }

  /** An accepted boundary belongs to its actual routing piece, rather than earlier junctions. */
  private crossesSeamLine(m: Mover): boolean {
    const seam = this.seamLimits?.get(m);
    return (
      !!seam?.crossing &&
      (!seam.boundary || (seam.boundary.line === m.line && seam.boundary.dir === m.dir))
    );
  }

  /** Move along legal lines; one-way dead ends hold instead of reversing. */
  private advance(
    m: Mover,
    distance: number,
    junctions = true,
    enteredExits?: Map<number, number>,
  ) {
    const { coords } = this.geo;
    let left = distance;
    let moved = 0;
    // Bounded, so zero-length segments can't loop forever.
    for (let guard = 0; guard < 256 && left > 0; guard++) {
      // Also protects initial placement, oversized steps, and collision retries. Re-evaluate
      // after each junction in case this step enters a one-way line ending at a dead end.
      const room =
        m.kind === 'vehicle' && this.geo.oneway?.[m.line]
          ? this.oneWayEndRoom(m, junctions)
          : undefined;
      if (room !== undefined) left = Math.min(left, room);
      if (left <= 0) break;
      const to = m.from + m.dir;
      const length = this.segment(m.from, to);
      if (junctions && this.crossingWaits.records.length && isWalker(m.kind) && length > 0) {
        const hx = (coords[to * 2]! - coords[m.from * 2]!) / length;
        const hy = (coords[to * 2 + 1]! - coords[m.from * 2 + 1]!) / length;
        const cursor = this.crossingCursor;
        cursor.x = coords[m.from * 2]! + hx * m.d;
        cursor.y = coords[m.from * 2 + 1]! + hy * m.d;
        cursor.hx = hx;
        cursor.hy = hy;
        this.crossingTarget.x = coords[to * 2]!;
        this.crossingTarget.y = coords[to * 2 + 1]!;
        const cap = this.crossingWaits.limit(
          m,
          this.crossingTarget,
          Math.min(left, length - m.d),
          this.crossingClock,
          this.crossingMinimum,
          cursor,
        );
        if (cap < Math.min(left, length - m.d)) left = cap;
      }
      const traveled = Math.min(left, Math.max(0, length - m.d));
      moved += traveled;
      if (m.routing?.signal && traveled > 0) {
        const remaining = m.routing.signal.remaining - traveled / this.perMeter;
        m.routing = {
          ...m.routing,
          signal: remaining > 0 ? { ...m.routing.signal, remaining } : undefined,
        };
      }
      if (m.d + left < length) {
        m.d += left;
        break;
      }
      left -= length - m.d;
      m.d = 0;
      m.from = to;
      const atEnd = m.dir === 1 ? to === this.last(m.line) : to === this.first(m.line);
      if (atEnd) {
        // The clipped line end is a geographic seam, not a route choice.
        if (this.crossesSeamLine(m)) {
          m.from -= m.dir;
          m.d = length;
          break;
        }
        if (junctions) {
          this.turn(m);
          if (enteredExits && m.kind === 'vehicle') this.prepareTurn(m, undefined, enteredExits);
        } else if (!this.continuePopulation(m)) {
          if (m.kind === 'vehicle' && this.geo.oneway?.[m.line]) {
            m.from -= m.dir;
            m.d = length;
            break;
          }
          m.dir = m.dir === 1 ? -1 : 1;
        }
        // A train at the end of the track stops there (`step` turns it round).
        if (m.train?.reverse || m.train?.edge) break;
      }
    }
    const to = m.from + m.dir;
    const length = this.segment(m.from, to);
    const ax = coords[m.from * 2]!;
    const ay = coords[m.from * 2 + 1]!;
    if (length > 0) {
      m.hx = (coords[to * 2]! - ax) / length;
      m.hy = (coords[to * 2 + 1]! - ay) / length;
    }
    m.x = ax + m.hx * m.d;
    m.y = ay + m.hy * m.d;
    return moved;
  }

  private exitOptions(m: Pick<Mover, 'kind' | 'line' | 'dir'>, vertex: number): number[] {
    const options: number[] = [];
    this.writeExitOptions(m.kind, m.line, m.dir, vertex, options);
    return options;
  }
  /** Owned routing arrays and scratch-only previews use the same future-cursor policy. */
  private writeExitOptions(
    kind: Mover['kind'],
    line: number,
    dir: 1 | -1,
    vertex: number,
    out: number[],
  ): void {
    out.length = 0;
    const arrived = line * 2 + (dir === 1 ? 1 : 0);
    if (kind === 'vehicle') {
      for (const arm of this.roadVertices.get(this.endKey(vertex)) ?? [])
        if (this.legalExit(kind, arm.code, arrived)) out.push(arm.code);
    } else
      for (const code of this.ends.get(this.endKey(vertex)) ?? [])
        if (this.legalExit(kind, code, arrived)) out.push(code);
    if (kind !== 'vehicle' || out.length < 2) return;
    // A vehicle doesn't double back sharper than a corner can curve (`FILLET.maxAngle`), which
    // would spin it on the spot, unless that is the only way on.
    const headings = this.exitHeading;
    this.writeEndHeading(arrived, headings, 0, vertex);
    const limit = Math.cos((FILLET.maxAngle * Math.PI) / 180);
    let turnable = 0;
    for (const code of out) {
      this.writeEndHeading(code, headings, 2, vertex);
      if (-headings[0]! * headings[2]! - headings[1]! * headings[3]! >= limit)
        out[turnable++] = code;
    }
    if (turnable) out.length = turnable;
  }
  private legalExit(kind: Mover['kind'], code: number, arrived: number): boolean {
    return (
      code !== arrived &&
      usableLines[kind].includes(this.geo.kinds[code >> 1]! as LifeLine) &&
      !(
        kind === 'vehicle' &&
        this.geo.oneway?.[code >> 1] &&
        this.geo.oneway[code >> 1] !== (code & 1 ? -1 : 1)
      )
    );
  }
  private vehicleExitDraw(m: Mover, vertex: number): number {
    const arrived = m.line * 2 + (m.dir === 1 ? 1 : 0);
    const legacy = this.ends.get(this.endKey(vertex)) ?? [];
    if (legacy.some((code) => this.legalExit(m.kind, code, arrived))) return this.routeRng();
    return hashString(`${this.routingSeed}/${m.rank}/${m.line}/${m.dir}`) / 0x1_0000_0000;
  }

  private hasExit(m: Mover, vertex: number): boolean {
    const arrived = m.line * 2 + (m.dir === 1 ? 1 : 0);
    if (m.kind === 'vehicle') {
      for (const arm of this.roadVertices.get(this.endKey(vertex)) ?? [])
        if (this.legalExit(m.kind, arm.code, arrived)) return true;
    } else
      for (const code of this.ends.get(this.endKey(vertex)) ?? [])
        if (this.legalExit(m.kind, code, arrived)) return true;

    return false;
  }

  /** Vertex-only callers share the directed reference without allocating a plan. */
  private directedVertex(code: number, shared?: number): number {
    if (shared !== undefined) {
      const arms = this.roadVertices.get(this.endKey(shared));
      if (arms) for (const arm of arms) if (arm.code === code) return arm.vertex;
    }
    return code & 1 ? this.last(code >> 1) : this.first(code >> 1);
  }

  /** Resolve the same directed reference for planning, curves, following and entry. */
  directedExit(code: number, shared?: number) {
    const line = code >> 1,
      dir: 1 | -1 = code & 1 ? -1 : 1,
      entry = this.directedVertex(code, shared);
    return { line, dir, vertex: entry, along: this.along[entry]! };
  }

  private newRouting(index: number): VehicleRouting {
    return { seed: hashString(`${this.routingSeed}/turns/${index}`), turns: 0 };
  }

  /** Heading from a line end into that line, skipping repeated endpoint coordinates. */
  endHeading(code: number, shared?: number): readonly [number, number] {
    const result: [number, number] = [0, 0];
    this.writeEndHeading(code, result, 0, shared);
    return result;
  }
  private writeEndHeading(
    code: number,
    result: number[] | Float64Array,
    offset = 0,
    shared?: number,
  ): void {
    const line = code >> 1;
    const dir = (code & 1) === 0 ? 1 : -1;
    const end = this.directedVertex(code, shared);
    const opposite = dir === 1 ? this.last(line) : this.first(line);
    for (let v = end + dir; dir === 1 ? v <= opposite : v >= opposite; v += dir) {
      const dx = this.geo.coords[v * 2]! - this.geo.coords[end * 2]!;
      const dy = this.geo.coords[v * 2 + 1]! - this.geo.coords[end * 2 + 1]!;
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        result[offset] = dx / length;
        result[offset + 1] = dy / length;
        return;
      }
    }
    result[offset] = result[offset + 1] = 0;
  }

  private plannedExit(
    m: Mover,
    vertex: number,
    options: readonly number[],
  ): VehicleTurnPlan | undefined {
    if (!options.length || !m.routing) return;
    const pick = hashString(`${m.routing.seed}/${m.routing.turns}/${this.endKey(vertex)}`);
    const routed =
      m.emergency?.target &&
      this.emergencyRouter?.scoreExits(
        tileToLngLat(this.tile, {
          x: this.geo.coords[vertex * 2]!,
          y: this.geo.coords[vertex * 2 + 1]!,
        }),
        options,
        (code) => this.endHeading(code, vertex),
        m.emergency.target,
      );
    const exit = routed
      ? routed.option
      : options[Math.floor((pick / 0x1_0000_0000) * options.length)]!;
    const arrived = m.line * 2 + (m.dir === 1 ? 1 : 0);
    const back = this.endHeading(arrived, vertex);
    const outward = [arrived, ...options].map((code) => this.endHeading(code, vertex));
    const arms = new Set(
      outward
        .filter(([x, y]) => x !== 0 || y !== 0)
        .map(([x, y]) => Math.round((Math.atan2(y, x) + Math.PI) / (Math.PI / 16)) % 32),
    );
    const radius = Math.max(
      ...[arrived, ...options].map(
        (code) => (this.geo.widths[code >> 1] || DEFAULT_ROAD_WIDTH_M) / 2,
      ),
    );
    return {
      line: m.line,
      dir: m.dir,
      vertex,
      exit,
      target: this.directedExit(exit, vertex),
      radius,
      side:
        arms.size >= 3 ? turnSide([-back[0], -back[1]], this.endHeading(exit, vertex)) : undefined,
    };
  }

  /** Plan before speed restrictions, so waiting traffic keeps its original intention. */
  private prepareTurn(m: Mover, index?: number, enteredExits?: Map<number, number>) {
    if (!m.vehicle) return;
    if (!this.curvable[m.line]) {
      if (hasTurnSignals(m.vehicle) && index !== undefined) m.routing ??= this.newRouting(index);
      return;
    }
    const vertex = m.dir === 1 ? this.last(m.line) : this.first(m.line);
    const progress = this.along[m.from]! + m.dir * m.d;
    const remaining = m.dir * (this.along[vertex]! - progress);
    const brake = kinematicsOf(m.vehicle).brake * this.perMeter;
    const reach = Math.max(
      FILLET.lookaheadM * this.perMeter,
      (m.v ?? m.speed) ** 2 / (2 * brake) + FILLET.maxM * this.perMeter,
    );
    if (!hasTurnSignals(m.vehicle)) {
      if (remaining <= reach && m.next === undefined) {
        const options = this.exitOptions(m, vertex);
        const key = m.line * 2 + (m.dir === 1 ? 1 : 0);
        m.next =
          enteredExits?.get(key) ??
          (options.length
            ? options[Math.floor(this.vehicleExitDraw(m, vertex) * options.length)]!
            : -1);
        enteredExits?.set(key, m.next);
      }
      return;
    }
    if (!m.routing) {
      if (index === undefined) return;
      m.routing = this.newRouting(index);
    }
    const plan = m.routing.plan;
    if (plan && (plan.line !== m.line || plan.dir !== m.dir))
      m.routing = { ...m.routing, plan: undefined, signal: undefined, indicating: false };
    const lead = Math.max(
      TURN_SIGNAL.leadMeters * this.perMeter,
      TURN_SIGNAL.leadSeconds * m.speed,
    );
    if (remaining <= Math.max(reach, lead) && !m.routing.plan)
      m.routing = { ...m.routing, plan: this.plannedExit(m, vertex, this.exitOptions(m, vertex)) };
    if (remaining <= lead && !m.routing.indicating) m.routing = { ...m.routing, indicating: true };
  }

  private prepareSignalRoute(m: Mover) {
    if (!this.junctionIndex.hasLinked || m.kind !== 'vehicle' || m.junctionRoute) return;
    const movement = this.junctionIndex.movement(m, JUNCTION.linkedLookaheadM * this.perMeter);
    if (!movement?.junction.linked || movement.ahead < 0) return;
    const end = m.dir === 1 ? this.last(m.line) : this.first(m.line);
    const options = this.exitOptions(m, end);
    if (hasTurnSignals(m.vehicle) && m.routing && !m.routing.plan)
      m.routing = { ...m.routing, plan: this.plannedExit(m, end, options) };
    let code = m.routing?.plan?.exit ?? m.next;
    if (code === undefined && options.length) {
      code =
        options[
          Math.floor(
            (hashString(`${this.routingSeed}/${m.rank}/${m.line}/${m.dir}`) / 0x1_0000_0000) *
              options.length,
          )
        ];
      m.next = code;
    }
    if (code === undefined || code < 0) return;
    const exits: number[] = [];
    const future = { ...m };
    for (let step = 0; step < 16; step++) {
      if (exits.includes(code)) return; // Do not reserve a route trapped inside the zone.
      exits.push(code);
      const line: number = code >> 1,
        dir: 1 | -1 = code & 1 ? -1 : 1;
      if (
        movement.junction.arms.some((a) => a.line === line && a.out === dir && a.outbound !== false)
      ) {
        m.junctionRoute = { key: movement.key, exits };
        return;
      }
      future.line = line;
      future.dir = dir;
      const vertex: number = dir === 1 ? this.last(line) : this.first(line);
      future.from = vertex;
      if (future.routing) future.routing = { ...future.routing, turns: future.routing.turns + 1 };
      const next = this.exitOptions(future, vertex);
      if (!next.length) return;
      code =
        this.plannedExit(future, vertex, next)?.exit ??
        next[
          Math.floor(
            (hashString(`${this.routingSeed}/${future.rank}/${line}/${dir}`) / 0x1_0000_0000) *
              next.length,
          )
        ]!;
    }
  }

  /** At a line's end: consume a remembered exit, else keep the existing non-motor routing. */
  private turn(m: Mover) {
    const vertex = m.from,
      previous = m.from - m.dir;
    const offset = m.kind === 'vehicle' ? this.offsetOf(m) : 0;
    if (m.vehicle) m.came = m.line * 2 + (m.dir === 1 ? 1 : 0);
    const options = this.exitOptions(m, m.from);
    if (!options.length && m.kind === 'vehicle' && this.geo.oneway?.[m.line]) {
      // Defensive terminal clamp: keep a valid incoming cursor, never point against flow.
      // Normal movement brakes before this endpoint through oneWayEndRoom.
      m.from -= m.dir;
      m.d = this.segment(m.from, m.from + m.dir);
      m.next = undefined;
      return;
    }
    const motor = m.kind === 'vehicle' && hasTurnSignals(m.vehicle);
    const planned = m.routing?.plan;
    const plan = motor
      ? planned &&
        planned.line === m.line &&
        planned.dir === m.dir &&
        planned.vertex === m.from &&
        options.includes(planned.exit)
        ? planned
        : this.plannedExit(m, m.from, options)
      : undefined;
    if (motor && m.routing)
      m.routing = {
        ...m.routing,
        turns: m.routing.turns + 1,
        plan: undefined,
        indicating: false,
        signal: plan?.side
          ? {
              side: plan.side,
              remaining: plan.radius + VEHICLES[m.vehicle!].length / 2 + TURN_SIGNAL.gap,
            }
          : undefined,
      };
    if (options.length === 0) {
      m.next = undefined;
      this.beginTurn(m);
      m.dir = m.dir === 1 ? -1 : 1;
      if (m.train) {
        // A real end of the track: it waits, then heads back. Past the tile's edge, the track
        // only ends where the tile's copy of it was cut: it runs on in the next tile.
        const { coords } = this.geo;
        const x = coords[m.from * 2]!;
        const y = coords[m.from * 2 + 1]!;
        if (x >= 0 && x < EXTENT && y >= 0 && y < EXTENT) {
          m.train.reverse = true;
          m.pause = between(this.rng, TRAIN.dwell);
        } else {
          m.train.edge = true;
        }
      }
      return;
    }
    const code =
      this.committedExit(
        options,
        m.junctionRoute?.exits[0],
        plan?.exit,
        m.vehicle ? m.next : undefined,
      ) ??
      (m.train
        ? this.straightest(m, options)
        : options[
            Math.floor(
              (m.vehicle
                ? this.vehicleExitDraw(m, vertex)
                : m.kind === 'cat'
                  ? this.catRng()
                  : m.kind === 'dog'
                    ? this.dogRng()
                    : m.kind === 'person'
                      ? this.walkerRng()
                      : this.rng()) * options.length,
            )
          ]!);
    m.next = undefined;
    if (m.junctionRoute)
      m.junctionRoute =
        m.junctionRoute.exits.length > 1
          ? { ...m.junctionRoute, exits: m.junctionRoute.exits.slice(1) }
          : undefined;
    const target = this.directedExit(code, vertex);
    m.line = target.line;
    m.from = target.vertex;
    m.dir = target.dir;
    if (
      m.kind === 'vehicle' &&
      target.vertex !== this.first(target.line) &&
      target.vertex !== this.last(target.line)
    )
      m.entered = {
        vertex: target.vertex,
        x: this.geo.coords[previous * 2]!,
        y: this.geo.coords[previous * 2 + 1]!,
        offset,
      };
    else m.entered = undefined;
  }

  /** Reservations, valid plans and remembered exits share the same legal priority. */
  private committedExit(
    options: readonly number[],
    reserved: number | undefined,
    planned: number | undefined,
    remembered: number | undefined,
  ): number | undefined {
    if (reserved !== undefined && options.includes(reserved)) return reserved;
    if (planned !== undefined && options.includes(planned)) return planned;
    if (remembered !== undefined && options.includes(remembered)) return remembered;
  }

  /** Of the line ends meeting at a mover's vertex, the one carrying on straightest. */
  private straightest(m: Mover, options: readonly number[]): number {
    const { coords } = this.geo;
    const back = m.from - m.dir;
    const inX = coords[m.from * 2]! - coords[back * 2]!;
    const inY = coords[m.from * 2 + 1]! - coords[back * 2 + 1]!;
    let best = options[0]!;
    let bestScore = -Infinity;
    for (const code of options) {
      const line = code >> 1;
      const fromStart = (code & 1) === 0;
      const a = fromStart ? this.first(line) : this.last(line);
      const b = fromStart ? a + 1 : a - 1;
      const outX = coords[b * 2]! - coords[a * 2]!;
      const outY = coords[b * 2 + 1]! - coords[a * 2 + 1]!;
      const norm = Math.hypot(inX, inY) * Math.hypot(outX, outY) || 1;
      const score = (inX * outX + inY * outY) / norm;
      if (score > bestScore) {
        bestScore = score;
        best = code;
      }
    }
    return best;
  }

  /** Move a train on `distance` tile units, leaving breadcrumbs for its cars. */
  private moveTrain(m: Mover, distance: number) {
    const train = m.train!;
    const crumb = TRAIN.crumb * this.perMeter;
    let moved = 0;
    for (let left = distance; left > 0 && !train.reverse && !train.edge; left -= crumb) {
      const [px, py] = [m.x, m.y];
      moved += this.advance(m, Math.min(left, crumb));
      const [tx, ty] = train.trail.length ? [train.trail[0]!, train.trail[1]!] : [px, py];
      if (train.trail.length === 0 || Math.hypot(m.x - tx, m.y - ty) >= crumb) {
        train.trail.unshift(px, py);
      }
    }
    // Keep only as much track as the cars need.
    const keep = (trainLength(train.cars) + 2 * TRAIN.crumb) * this.perMeter;
    const { trail } = train;
    let length = trail.length ? Math.hypot(m.x - trail[0]!, m.y - trail[1]!) : 0;
    for (let i = 0; i + 3 < trail.length; i += 2) {
      if (length > keep) {
        trail.length = i + 2;
        break;
      }
      length += Math.hypot(trail[i + 2]! - trail[i]!, trail[i + 3]! - trail[i + 1]!);
    }
    return moved;
  }

  /** Pure rail projection using the same nearest-track tolerance as adoption. */
  projectRail(m: Mover): Mover | undefined {
    const c = this.geo.coords;
    let best = TRAIN.handover * this.perMeter;
    let result: Mover | undefined;
    for (let line = 0; line < this.geo.kinds.length; line++) {
      if (this.geo.kinds[line] !== LifeLine.rail) continue;
      for (let v = this.first(line); v < this.last(line); v++) {
        const x = c[v * 2]!,
          y = c[v * 2 + 1]!,
          dx = c[(v + 1) * 2]! - x,
          dy = c[(v + 1) * 2 + 1]! - y;
        const length = Math.hypot(dx, dy);
        if (!length) continue;
        const t = Math.max(0, Math.min(1, ((m.x - x) * dx + (m.y - y) * dy) / (length * length)));
        const distance = Math.hypot(m.x - x - t * dx, m.y - y - t * dy);
        if (distance > best || (result && distance === best)) continue;
        best = distance;
        const dir = m.hx * dx + m.hy * dy >= 0 ? 1 : -1;
        result = {
          ...m,
          line,
          from: dir === 1 ? v : v + 1,
          dir,
          d: (dir === 1 ? t : 1 - t) * length,
          x: x + t * dx,
          y: y + t * dy,
          hx: (dir * dx) / length,
          hy: (dir * dy) / length,
        };
      }
    }
    return result;
  }

  /** Walk a copied rail cursor without RNG, breadcrumbs, stops, or simulation mutation. */
  trackAhead(
    m: Mover,
    reach: number,
    visit: (p: Pose & { distance: number }) => void,
    owns?: (p: { x: number; y: number }) => boolean,
  ) {
    const cursor = { ...m },
      c = this.geo.coords;
    let distance = 0,
      end = false,
      edge = false;
    const place = () => {
      const to = cursor.from + cursor.dir,
        length = this.segment(cursor.from, to);
      cursor.hx = length ? (c[to * 2]! - c[cursor.from * 2]!) / length : cursor.hx;
      cursor.hy = length ? (c[to * 2 + 1]! - c[cursor.from * 2 + 1]!) / length : cursor.hy;
      cursor.x = c[cursor.from * 2]! + cursor.hx * cursor.d;
      cursor.y = c[cursor.from * 2 + 1]! + cursor.hy * cursor.d;
    };
    place();
    visit({ x: cursor.x, y: cursor.y, hx: cursor.hx, hy: cursor.hy, distance });
    for (let guard = 0; guard < 2048 && distance < reach; guard++) {
      const to = cursor.from + cursor.dir,
        length = this.segment(cursor.from, to);
      const step = Math.min(
        TRAIN.crumb * this.perMeter,
        reach - distance,
        Math.max(0, length - cursor.d),
      );
      cursor.d += step;
      distance += step;
      place();
      visit({ x: cursor.x, y: cursor.y, hx: cursor.hx, hy: cursor.hy, distance });
      if (!inTile(cursor) || (owns && !owns(cursor))) {
        edge = true;
        break;
      }
      if (cursor.d >= length - 1e-9) {
        cursor.from = to;
        cursor.d = 0;
        if (to === (cursor.dir === 1 ? this.last(cursor.line) : this.first(cursor.line))) {
          const options = this.exitOptions(cursor, to);
          if (!options.length) {
            end = true;
            break;
          }
          const code = this.straightest(cursor, options);
          cursor.line = code >> 1;
          cursor.dir = code & 1 ? -1 : 1;
          cursor.from = cursor.dir === 1 ? this.first(cursor.line) : this.last(cursor.line);
        }
      }
    }
    return { cursor, distance, end, edge };
  }

  /**
   * A train at the end of the track heads back the way it came: its head moves to where its
   * tail was, and the track it stood on is now behind it.
   */
  private reverseTrain(m: Mover) {
    const train = m.train!;
    const length = trainLength(train.cars) * this.perMeter;
    const body = cutTrail([m.x, m.y, ...train.trail], length);
    train.reverse = false;
    // `turn` already pointed it back along the line.
    this.advance(m, length);
    const back: number[] = [];
    for (let i = body.length - 2; i >= 0; i -= 2) back.push(body[i]!, body[i + 1]!);
    train.trail = back.slice(2);
  }

  /** Take out the trains whose head has left the tile, for `LifeWorld.step` to hand over. */
  takeLeavers(reowned?: (m: Mover) => boolean): readonly Mover[] {
    let out: Mover[] | undefined;
    for (let i = this.movers.length - 1; i >= 0; i--) {
      const m = this.movers[i]!;
      if (!m.train || (inTile(m) && !reowned?.(m))) continue;
      (out ??= []).push(m);
      this.movers.splice(i, 1);
    }
    return out ?? NO_MOVERS;
  }

  /**
   * Take over a train from the neighboring tile (`dx`, `dy` tiles over), on this tile's copy of
   * the track, going the same way. Returns false (and the train is lost) if this tile has no
   * track near where it arrives.
   */
  adopt(m: Mover, dx: number, dy: number): boolean {
    const train = m.train!;
    const [ox, oy] = [dx * EXTENT, dy * EXTENT];
    const hx0 = train.trail.length ? m.x - train.trail[0]! : m.hx;
    const hy0 = train.trail.length ? m.y - train.trail[1]! : m.hy;
    const x = m.x - ox;
    const y = m.y - oy;
    const { coords, kinds } = this.geo;
    let best: { v: number; line: number; t: number; distance: number } | undefined;
    for (let line = 0; line < kinds.length; line++) {
      if (kinds[line] !== LifeLine.rail) continue;
      for (let v = this.first(line); v < this.last(line); v++) {
        const [ax, ay] = [coords[v * 2]!, coords[v * 2 + 1]!];
        const [sx, sy] = [coords[(v + 1) * 2]! - ax, coords[(v + 1) * 2 + 1]! - ay];
        const length2 = sx * sx + sy * sy;
        if (length2 === 0) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * sx + (y - ay) * sy) / length2));
        const distance = Math.hypot(ax + sx * t - x, ay + sy * t - y);
        if (!best || distance < best.distance) best = { v, line, t, distance };
      }
    }
    if (!best || best.distance > TRAIN.handover * this.perMeter) return false;
    const { v, line, t } = best;
    const length = this.segment(v, v + 1);
    const forward =
      hx0 * (coords[(v + 1) * 2]! - coords[v * 2]!) +
        hy0 * (coords[(v + 1) * 2 + 1]! - coords[v * 2 + 1]!) >=
      0;
    m.line = line;
    m.dir = forward ? 1 : -1;
    m.from = forward ? v : v + 1;
    m.d = (forward ? t : 1 - t) * length;
    train.trail = train.trail.map((value, i) => value - (i % 2 === 0 ? ox : oy));
    train.stopX -= ox;
    train.stopY -= oy;
    train.edge = false;
    train.reverse = false;
    m.pause = 0;
    // Places it on the segment and sets its heading.
    this.advance(m, 0);
    this.movers.push(m);
    return true;
  }

  /** Whether a train has come to a station it hasn't just stopped at (and if so, stops there). */
  private atStation(m: Mover, remaining: number): boolean {
    const train = m.train!;
    const { stations } = this.geo;
    const reach = TRAIN.stationReach * this.perMeter;
    // Pulling out of its last stop; once well clear of it, it may stop there again on its way
    // back.
    if (Math.hypot(m.x - train.stopX, m.y - train.stopY) < TRAIN.stationGap * this.perMeter) {
      return false;
    }
    train.stopX = train.stopY = NaN;
    if (remaining > this.perMeter) return false;
    for (let i = 0; i < stations.length; i += 2) {
      if (Math.hypot(stations[i]! - m.x, stations[i + 1]! - m.y) <= reach) {
        train.stopX = m.x;
        train.stopY = m.y;
        return true;
      }
    }
    return false;
  }

  /** Route plans and lane progress are prepared for every tile before world arbitration. */
  prepareTraffic(active: (m: Mover) => boolean) {
    const { movers, perMeter: pm } = this;
    if (this.speeds.length < movers.length) {
      const size = Math.max(movers.length, 2 * this.speeds.length);
      this.speeds = new Float64Array(size);
      this.caps = new Float64Array(size);
      this.progress = new Float64Array(size);
      this.offsets = new Float64Array(size);
      this.followLeaders = new Int32Array(size);
      this.followTargets = new Float64Array(size);
    }
    for (const group of this.trafficGroups.values()) group.length = 0;
    this.roadRearReachM = 0;
    this.urgentCount = 0;
    this.emergencyYielders.clear();
    this.emergencyOffsets.clear();
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i]!;
      if (!m.vehicle || !active(m)) continue;
      if (m.kind === 'vehicle') {
        // Include a possible burst/call start and residual accepted speed before later movers step.
        const velocity = Math.max(m.speed * DRIVE.rush.pace[1], m.v ?? m.speed) / pm;
        const spec = VEHICLES[m.vehicle];
        this.roadRearReachM = Math.max(
          this.roadRearReachM,
          FOLLOW.minGap +
            velocity ** 2 / (2 * kinematicsOf(m.vehicle).brake) +
            (spec.length + spec.width) / 2,
        );
      }
      if (isUrgent(m)) this.urgentCount++;
      this.prepareTurn(m, i);
      if (this.junctionIndex.hasLinked) this.prepareSignalRoute(m);
      this.progress[i] = (m.dir * this.along[m.from]! + m.d) / pm;
      this.offsets[i] = this.offsetOf(m);
      const key = m.line * 2 + (m.dir === 1 ? 1 : 0);
      let group = this.trafficGroups.get(key);
      if (!group) {
        group = this.trafficGroupBuffers.get(key);
        if (!group) this.trafficGroupBuffers.set(key, (group = []));
        group.length = 0;
        this.trafficGroups.set(key, group);
      }
      group.push(i);
    }
    for (const [key, group] of this.trafficGroups) {
      if (group.length) group.sort((a, b) => this.progress[a]! - this.progress[b]! || a - b);
      else this.trafficGroups.delete(key);
    }
    if (this.urgentCount) {
      const mark = (source: Mover, index: number, behind: number) => {
        const m = movers[index]!;
        if (m === source || isUrgent(m) || behind <= 0 || behind > EMERGENCY.yieldAheadM) return;
        const old = this.emergencyYielders.get(m);
        if (old && old.behind <= behind) return;
        const bounds = this.roadShiftBounds(m),
          passing = this.roadShiftBounds(source),
          gap =
            (VEHICLES[m.vehicle!].width + VEHICLES[source.vehicle!].width) / 2 +
            FOLLOW.roadGap +
            FOLLOW.lateralPad +
            0.2;
        const offset = Math.max(passing[0], Math.min(passing[1], bounds[1] - gap));
        const feasible = bounds[1] - offset >= gap - 1e-8;
        this.emergencyYielders.set(m, { source, behind, feasible });
        this.emergencyOffsets.set(m, bounds[1]);
        if (feasible) this.emergencyOffsets.set(source, offset);
      };
      for (const group of this.trafficGroups.values())
        for (let k = 0; k < group.length; k++) {
          const i = group[k]!,
            source = movers[i]!;
          if (!isUrgent(source)) continue;
          for (let n = k + 1; n < group.length; n++)
            mark(source, group[n]!, this.progress[group[n]!]! - this.progress[i]!);
          const code = source.routing?.plan?.exit;
          if (code === undefined || code < 0) continue;
          const line = code >> 1,
            dir = code & 1 ? -1 : 1,
            end = source.dir === 1 ? this.last(source.line) : this.first(source.line),
            remaining = (source.dir * this.along[end]!) / pm - this.progress[i]!,
            entry = (dir * this.directedExit(code, end).along) / pm;
          for (const j of this.trafficGroups.get(line * 2 + (dir === 1 ? 1 : 0)) ?? [])
            if (this.progress[j]! >= entry) mark(source, j, remaining + this.progress[j]! - entry);
        }
    }
  }

  requestJunctions(
    table: JunctionTable,
    active: (m: Mover) => boolean,
    clock: number,
    tileKey = '',
    traffic?: JunctionTraffic,
    pedestrians: PedestrianView = EMPTY_PEDESTRIANS,
  ) {
    if (!this.junctionIndex.junctions.length && table.empty) return;
    traffic ??= this.localJunctionTraffic;
    if (traffic === this.localJunctionTraffic) {
      traffic.begin(this);
      for (const m of this.movers) if (active(m)) traffic.add(this, m);
    }
    this.junctionTable = table;
    this.junctionTraffic = traffic;
    this.junctionPedestrians = pedestrians;
    this.junctionClock = clock;
    this.junctionTileKey = tileKey;
    for (let index = 0; index < this.movers.length; index++) {
      const m = this.movers[index]!;
      if (m.kind !== 'vehicle' || !m.vehicle || !active(m)) continue;
      this.junctionMover = m;
      this.junctionIndexInTile = index;
      const pm = this.perMeter,
        length = VEHICLES[m.vehicle].length * pm;
      const movements = this.junctionIndex.movements(
        m,
        Math.max(
          60 * pm,
          (m.v ?? m.speed) ** 2 / (2 * kinematicsOf(m.vehicle).brake * pm) + 20 * pm,
        ),
        this.junctionNext,
      );
      const requests = this.junctionRequests;
      requests.length = 0;
      for (const r of table.holds(m)) {
        const previous = r.movement,
          j = previous.junction;
        const past =
          (m.x - (previous.exit.x ?? j.x)) * previous.outHx +
          (m.y - (previous.exit.y ?? j.y)) * previous.outHy;
        const candidate = movements.find((p) => p.key === previous.key);
        const sameApproach =
          m.line === previous.line &&
          m.dir === previous.dir &&
          m.dir * (previous.stop - this.along[m.from]! - m.dir * m.d) > 0;
        if ((r.inside || !candidate) && !sameApproach && past > j.radius + length / 2) {
          table.release(m, previous.key);
          continue;
        }
        if (r.carried && !r.inside && candidate) {
          r.carried = false;
          this.submitJunction(
            candidate,
            candidate.ahead < -JUNCTION.insideToleranceM * pm && candidate.line === m.line,
          );
        } else if (r.carried) {
          const availableRoom = traffic.room(m, previous, this);
          this.junctionRoom = availableRoom;
          const refreshed = table.refreshCarried(
            m,
            this.carriedReady,
            availableRoom,
            previous.key,
            traffic,
            this.junctionIndexInTile,
          );
          if (refreshed) requests.push(refreshed);
        } else if (r.inside) {
          previous.ahead = boxAhead(m, previous, pm);
          previous.boxAhead = previous.ahead;
          this.submitJunction(previous, true);
        } else if (candidate)
          this.submitJunction(
            candidate,
            candidate.ahead < -JUNCTION.insideToleranceM * pm && candidate.line === m.line,
          );
        else table.release(m, previous.key); // A committed route was abandoned, not rear-cleared.
        if (candidate) movements.splice(movements.indexOf(candidate), 1);
      }
      for (const movement of movements)
        this.submitJunction(
          movement,
          movement.ahead < -JUNCTION.insideToleranceM * pm && movement.line === m.line,
        );
      if (requests.length > 1) requests.sort(compareJunctionRequests);
      for (let i = 0; i < requests.length; i++)
        requests[i]!.precedingKey = requests[i - 1]?.movement.key;
    }
  }

  private junctionAllowed(movement: Movement, availableRoom?: number): boolean {
    const m = this.junctionMover;
    this.junctionCrossings.holdAhead(movement, this.junctionControlled(movement));
    this.junctionRoom = availableRoom ?? this.junctionTraffic.room(m, movement, this);
    return (
      this.junctionRoom >= VEHICLES[m.vehicle!].length + JUNCTION.gap &&
      (this.signals.allows(
        m,
        movement.entry?.x ?? movement.junction.x,
        movement.entry?.y ?? movement.junction.y,
        this.junctionClock,
        Math.max(0, movement.ahead),
        movement,
      ) ||
        (isUrgent(m) &&
          (((movement.ahead <= 0.5 * this.perMeter || this.signals.atStoppingLine(m, movement)) &&
            (m.v ?? m.speed) <= EMERGENCY.creepMps * this.perMeter) ||
            [...this.junctionTable.holds(m)].some(
              (r) =>
                r.movement.key === movement.key && r.authorizedOutside && r.since !== undefined,
            )))) &&
      this.junctionClear(movement, this.junctionPedestrians)
    );
  }
  private submitJunction(movement: Movement, inside: boolean): void {
    const m = this.junctionMover;
    const ready = this.junctionAllowed(movement);
    const request: JunctionRequest = {
      m,
      life: this,
      tileKey: this.junctionTileKey,
      index: this.junctionIndexInTile,
      movement,
      ready,
      inside,
      atLine: this.junctionTraffic.atLine(m, movement, this, this.junctionTable),
      room: this.junctionRoom,
      traffic: this.junctionTraffic,
    };
    this.junctionRequests.push(request);
    this.junctionTable.request(request);
  }

  private junctionControlled(movement: Movement): boolean {
    return this.junctionCrossings.controlled(movement);
  }
  junctionClear(movement: Movement, pedestrians: PedestrianView): boolean {
    return this.junctionCrossings.clear(movement, pedestrians, this.junctionControlled(movement));
  }

  private terminalTarget(m: Mover, target: number, remaining: number): number {
    if (m.kind !== 'vehicle' || !m.vehicle || this.geo.oneway?.[m.line]) return target;
    const pm = this.perMeter;
    const k = kinematicsOf(m.vehicle);
    if (remaining >= terminalReach((m.v ?? m.speed) / pm, VEHICLES[m.vehicle].length, k.brake) * pm)
      return target;
    const room = this.endpointRoom(m, remaining);
    return room === undefined
      ? target
      : Math.min(target, stopBefore(room, TERMINAL.creep * pm, k.brake * pm));
  }

  /** A vehicle's lane `FOLLOW.laneAheadM` further along its line, m right of centre. */
  private laneAhead(m: Mover): number {
    const length = this.lineLength(m.line) / this.perMeter;
    const at = Math.min(length, this.travelled(m) + FOLLOW.laneAheadM);
    const next = m.routing?.plan?.exit ?? m.next;
    return this.shiftedOffset(m, this.routeLane(m, m.line, m.dir, at, m.came, next)) + (m.lat ?? 0);
  }

  /** A vehicle's ordinary lane on `line`, m right of centre. */
  private mergeLane(m: Mover, line = m.line): number {
    const spec = VEHICLES[m.vehicle!];
    return laneOffset(
      this.roadWidth(line),
      spec.width,
      m.chosenLane ?? m.lane,
      spec.curb,
      this.geo.oneway?.[line] ?? 0,
    );
  }

  /** Prospective routed pose, without changing the accepted actor or its seeded lane. */
  private maneuverOffset(m: Mover): number {
    const state = m.maneuver;
    if (!state) return this.offsetOf(m);
    const cursor = { ...m, chosenLane: state.target, lat: undefined, maneuver: undefined };
    const normal = this.offsetOf(cursor, m);
    if (state.kind !== 'filter' || state.corridor === undefined) return normal;
    const layout = this.directionalLanes(m.line);
    return normal + layout.start + layout.span * state.corridor - this.mergeLane(cursor);
  }

  /** Complete-rider corridor fit shared by entry and detached continuity previews. */
  filterCorridor(m: Mover, candidate: RoadManeuver) {
    if (!m.vehicle || candidate.corridor === undefined) return;
    const layout = this.directionalLanes(m.line);
    const target = this.maneuverOffset({ ...m, maneuver: candidate });
    const half = VEHICLES[m.vehicle].width / 2;
    const offset = layout.count === 1 ? layout.start + layout.span - half - ROAD_MARGIN_M : target;
    if (
      offset - half < layout.start + ROAD_MARGIN_M ||
      offset + half > layout.start + layout.span - ROAD_MARGIN_M
    )
      return;
    return {
      offset,
      maneuver:
        layout.count === 1
          ? { ...candidate, corridor: candidate.corridor + (offset - target) / layout.span }
          : candidate,
    };
  }

  private tickRoadTimers(m: Mover, dt: number) {
    if (m.laneCooldown !== undefined) m.laneCooldown = Math.max(0, m.laneCooldown - dt);
    if (m.filterRetry !== undefined) m.filterRetry = Math.max(0, m.filterRetry - dt);
    if (m.roadScan !== undefined) m.roadScan = Math.max(0, m.roadScan - dt);
  }

  /** Propose once per trial; retries start from the same immutable accepted state. */
  private proposeLateral(m: Mover, before: Mover, distance: number, dt: number, share = 1) {
    if (!before.maneuver) return 0;
    const difference = this.maneuverOffset(before) - this.offsetOf(before, m);
    if (before.maneuver.returning && before.maneuver.kind !== 'return') return 0;
    const limit = Math.min(
      LANE.lateral * dt * share,
      (distance / this.perMeter) * Math.sin(Math.PI / 12),
    );
    const change = Math.max(-limit, Math.min(limit, difference));
    m.lat = (before.lat ?? 0) + change;
    return Math.abs(change) * this.perMeter;
  }

  private finishLateral(m: Mover, _before: Mover) {
    const state = m.maneuver;
    if (!state) return;
    if (state.kind === 'filter') return;
    // Completion and retained displacement share the continuity numerical-noise tolerance.
    if (Math.abs(this.maneuverOffset(m) - this.offsetOf(m)) > 1e-8 || m.latYaw !== undefined)
      return;
    const accepted = this.offsetOf(m);
    m.chosenLane = state.target;
    m.lat = undefined;
    const residual = accepted - this.offsetOf(m);
    m.lat = Math.abs(residual) > 1e-8 ? residual : undefined;
    m.maneuver = undefined;
    m.laneSignal = undefined;
    m.laneCooldown = LANE.cooldown;
  }

  /** Next protected approach in metres; following room is deliberately excluded. */
  private roadProtectedRoom(m: Mover, table: JunctionTable): number {
    let room = this.lineLength(m.line) / this.perMeter - this.travelled(m);
    room = Math.min(room, this.signals.protectedRoom(m) / this.perMeter);
    for (const r of table.holds(m)) {
      if (r.inside) return 0;
      if (r.movement.ahead >= -JUNCTION.insideToleranceM * this.perMeter)
        room = Math.min(room, Math.max(0, r.movement.ahead / this.perMeter));
    }
    const site = this.scenes.services.get(m)?.site;
    if (site?.road === m.line && site.direction === m.dir) {
      const ahead = ((site.x - m.x) * m.hx + (site.y - m.y) * m.hy) / this.perMeter;
      if (ahead >= 0) room = Math.min(room, ahead);
    }
    return room;
  }

  /** Project the accepted physical body onto its current travel axes. */
  private roadEnvelope(m: Mover, out = { length: 0, width: 0 }, future?: number) {
    const spec = VEHICLES[m.vehicle!],
      pose = this.pose(m, this.envelopePose);
    const length = spec.length;
    const width = spec.width;
    const along = Math.abs(pose.hx * m.hx + pose.hy * m.hy);
    const across = Math.abs(-pose.hy * m.hx + pose.hx * m.hy);
    const lateral =
      !!m.maneuver &&
      (Math.abs((future ?? this.maneuverOffset(m)) - this.offsetOf(m)) > 1e-6 || !!m.latYaw);
    out.length = Math.max(
      (along * length + across * width) / 2,
      lateral ? (Math.cos(Math.PI / 12) * length + Math.sin(Math.PI / 12) * width) / 2 : 0,
    );
    out.width = Math.max(
      (along * width + across * length) / 2,
      lateral ? (Math.cos(Math.PI / 12) * width + Math.sin(Math.PI / 12) * length) / 2 : 0,
    );
    return out;
  }

  /** Full lateral sweep plus both longitudinal gaps, in metres and m/s. */
  private roadGapSafe(m: Mover, target: number, continuing = false): boolean {
    const at = this.offsetOf(m),
      body = this.roadEnvelope(m);
    const progress = (m.dir * this.along[m.from]! + m.d) / this.perMeter;
    const velocity = Math.max(0, (m.v ?? m.speed) / this.perMeter);
    for (const index of this.trafficGroups.get(m.line * 2 + (m.dir === 1 ? 1 : 0)) ?? []) {
      const other = this.movers[index]!;
      if (other === m || other.line !== m.line || other.dir !== m.dir) continue;
      const separation = (other.dir * this.along[other.from]! + other.d) / this.perMeter - progress;
      if (!this.roadGapClear(m, other, separation, at, target, body, velocity, continuing))
        return false;
    }
    // All passed junctions matter, including interior vertices and routes the mover did not take.
    // The road population's stopping/body bound excludes distant approaches before pose queries.
    const exit = m.line * 2 + (m.dir === 1 ? 0 : 1);
    const start = m.dir === 1 ? this.first(m.line) : this.last(m.line);
    for (let vertex = m.from; m.dir === 1 ? vertex >= start : vertex <= start; vertex -= m.dir) {
      const travelled = (m.dir * (this.along[m.from]! - this.along[vertex]!) + m.d) / this.perMeter;
      if (travelled > body.length + this.roadRearReachM + 1e-6) break;
      for (const arm of this.roadVertices.get(this.endKey(vertex)) ?? []) {
        if (arm.code >> 1 === m.line) continue;
        for (const index of this.trafficGroups.get(arm.code) ?? []) {
          const other = this.movers[index]!;
          if ((other.routing?.plan?.exit ?? other.next) !== exit) continue;
          const remaining =
            (other.dir * (this.along[arm.vertex]! - this.along[other.from]!) - other.d) /
            this.perMeter;
          if (remaining < -JUNCTION.insideToleranceM) continue;
          if (
            !this.roadGapClear(
              m,
              other,
              -remaining - travelled,
              at,
              target,
              body,
              velocity,
              continuing,
              true,
            )
          )
            return false;
        }
      }
    }
    return true;
  }

  private roadGapClear(
    m: Mover,
    other: Mover,
    separation: number,
    at: number,
    target: number,
    body: { length: number; width: number },
    velocity: number,
    continuing: boolean,
    incoming = false,
  ): boolean {
    const peerVelocity =
      this.inspected === other ? 0 : Math.max(0, (other.v ?? other.speed) / this.perMeter);
    const required =
      FOLLOW.minGap +
      (separation >= 0
        ? continuing
          ? Math.max(0, (velocity ** 2 - peerVelocity ** 2) / (2 * kinematicsOf(m.vehicle).brake))
          : FOLLOW.headway * velocity
        : Math.max(
            0,
            (peerVelocity ** 2 - velocity ** 2) / (2 * kinematicsOf(other.vehicle).brake),
          ));
    const spec = VEHICLES[other.vehicle!];
    // A projected half-length cannot exceed half the sum of the physical sides at any yaw.
    // This bounds the exact gap inequalities before constructing a distant actor's pose.
    if (Math.abs(separation) > required + body.length + (spec.length + spec.width) / 2 + 1e-6)
      return true;
    const peerPose = incoming ? this.pose(other, this.leaderPose) : undefined;
    const offset = peerPose
        ? ((peerPose.x - m.x) * -m.hy + (peerPose.y - m.y) * m.hx) / this.perMeter
        : this.offsetOf(other),
      peer = this.roadEnvelope(other);
    let future = other.maneuver ? this.maneuverOffset(other) : offset;
    if (incoming) {
      const state = other.maneuver;
      future = state
        ? this.vehicleLane({ ...other, chosenLane: state.target }, m.line)
        : this.vehicleLane(other, m.line) + (other.lat ?? 0);
      if (state?.kind === 'filter' && state.corridor !== undefined) {
        const layout = this.directionalLanes(m.line);
        future =
          layout.count === 1
            ? layout.start + layout.span - spec.width / 2 - ROAD_MARGIN_M
            : layout.start + layout.span * state.corridor;
      }
      future += other.roadShift ?? 0;
      const along = Math.abs(other.hx * m.hx + other.hy * m.hy),
        across = Math.abs(other.hy * m.hx - other.hx * m.hy);
      const length = peer.length,
        width = peer.width;
      peer.length = Math.max(length, along * length + across * width);
      peer.width = Math.max(width, along * width + across * length);
    }
    const lateral = Math.max(
      Math.min(at, target) - Math.max(offset, future),
      Math.min(offset, future) - Math.max(at, target),
    );
    if (lateral >= body.width + peer.width + FOLLOW.roadGap) return true;
    const gap = Math.abs(separation) - body.length - peer.length;
    if (gap < FOLLOW.minGap) return false;
    if (separation >= 0) {
      if (!continuing && gap + 1e-8 < FOLLOW.minGap + FOLLOW.headway * velocity) return false;
      const lead =
        this.inspected === other ? 0 : Math.max(0, (other.v ?? other.speed) / this.perMeter);
      if (
        continuing &&
        approach(gap - FOLLOW.minGap, lead, kinematicsOf(m.vehicle).brake) + 1e-8 < velocity
      )
        return false;
    } else {
      const rearSpeed =
        this.inspected === other ? 0 : Math.max(0, (other.v ?? other.speed) / this.perMeter);
      if (
        approach(gap - FOLLOW.minGap, velocity, kinematicsOf(other.vehicle).brake) + 1e-8 <
        rearSpeed
      )
        return false;
    }
    return true;
  }

  private laneTargetOffset(m: Mover, preference: number): number {
    return this.offsetOf({ ...m, chosenLane: preference, lat: undefined, maneuver: undefined }, m);
  }

  private filterCap(m: Mover): number {
    return (
      Math.min(m.speed / this.perMeter, (m.maneuver?.queueSpeed ?? 0) + FILTER.gain, FILTER.max) *
      this.perMeter
    );
  }

  /** An inherited too-small source gap already fails every full-sweep entry check. */
  private roadSourceBlocked(index: number): boolean {
    if (this.caps[index] !== 0) return false;
    const m = this.movers[index]!,
      j = this.followLeaders[index]!;
    if (j < 0) return false;
    const leader = this.movers[j]!;
    if (leader.line !== m.line || leader.dir !== m.dir) return false;
    // This cheap branch is only for straight accepted poses. Curves and existing maneuvers
    // retain the full projection/sweep query, including every source and rear follower.
    if (
      m.maneuver ||
      leader.maneuver ||
      m.roadYaw ||
      leader.roadYaw ||
      m.latYaw ||
      leader.latYaw ||
      m.came !== undefined ||
      leader.came !== undefined ||
      m.routing?.plan ||
      leader.routing?.plan ||
      m.next !== undefined ||
      leader.next !== undefined ||
      this.last(m.line) - this.first(m.line) !== 1
    )
      return false;
    const gap =
      (leader.dir * this.along[leader.from]! + leader.d - m.dir * this.along[m.from]! - m.d) /
        this.perMeter -
      (VEHICLES[m.vehicle!].length + VEHICLES[leader.vehicle!].length) / 2;
    return gap < FOLLOW.minGap - 1e-6;
  }

  /** Queue identity can change as the rider passes; its velocity remains meaningful meanwhile. */
  private updateFilter(index: number, table: JunctionTable) {
    const m = this.movers[index]!;
    if (m.kind !== 'vehicle' || (m.vehicle !== 'motorcycle' && m.vehicle !== 'bicycle')) return;
    let state = m.maneuver;
    if (state && state.corridor === undefined && state.kind !== 'filter') return;
    if (!state && this.roadSourceBlocked(index)) return;
    if (
      !state &&
      (this.followLeaders[index]! < 0 ||
        (m.filterRetry ?? 0) > 0 ||
        (m.roadScan ?? 0) > 0 ||
        (m.v ?? m.speed) / this.perMeter > FILTER.max ||
        m.roadShift !== undefined ||
        m.curveLengthM !== undefined ||
        this.scenes.merging(m) ||
        this.roadProtectedRoom(m, table) <= FILTER.clear)
    )
      return;
    const refresh = !state || (m.roadScan ?? 0) <= 0;
    if (refresh) m.roadScan = 0.5;
    const group = this.trafficGroups.get(m.line * 2 + (m.dir === 1 ? 1 : 0)) ?? [];
    const at = this.offsetOf(m),
      layout = this.directionalLanes(m.line);
    const original = this.laneTargetOffset(m, m.chosenLane ?? m.lane);
    const progress = (m.dir * this.along[m.from]! + m.d) / this.perMeter;
    let queue: Mover | undefined,
      nearest = Infinity;
    const reference = state ? original : at;
    if (refresh)
      for (const j of group) {
        const peer = this.movers[j]!;
        if (
          peer === m ||
          peer.line !== m.line ||
          peer.dir !== m.dir ||
          peer.vehicle === 'bicycle' ||
          peer.vehicle === 'motorcycle'
        )
          continue;
        const separation = Math.abs(
          (peer.dir * this.along[peer.from]! + peer.d) / this.perMeter - progress,
        );
        if (
          separation > 60 ||
          separation >= nearest ||
          Math.abs(reference - this.offsetOf(peer)) >=
            (VEHICLES[m.vehicle].width + VEHICLES[peer.vehicle!].width) / 2 + FOLLOW.roadGap
        )
          continue;
        nearest = separation;
        queue = peer;
      }
    const velocity = queue
      ? this.inspected === queue
        ? 0
        : Math.max(0, (queue.v ?? queue.speed) / this.perMeter)
      : state?.queueSpeed;
    if (state) {
      if (velocity !== undefined && velocity !== state.queueSpeed) {
        state = { ...state, queueSpeed: velocity };
        m.maneuver = state;
      }
      const transit = this.scenes.services.get(m)?.site;
      const request =
        state.returning ||
        (velocity ?? 0) > FILTER.leave ||
        (transit?.road === m.line && this.roadProtectedRoom(m, table) < FILTER.clear);
      if (request && state.kind === 'filter') {
        if (this.roadGapSafe(m, original)) {
          m.maneuver = {
            ...state,
            kind: 'return',
            target: m.chosenLane ?? m.lane,
            returning: true,
          };
          if (Math.abs(original - at) > 1e-6) m.laneSignal = original < at ? 'left' : 'right';
        } else if (!state.returning) m.maneuver = { ...state, returning: true };
      } else if (state.kind === 'return' && !this.roadGapSafe(m, original, true)) {
        m.maneuver = { ...state, kind: 'filter', returning: true };
      }
      return;
    }
    const leaderIndex = this.followLeaders[index]!;
    if (
      leaderIndex < 0 ||
      !queue ||
      velocity === undefined ||
      velocity >= FILTER.enter ||
      (m.v ?? m.speed) / this.perMeter > FILTER.max ||
      (m.filterRetry ?? 0) > 0 ||
      m.roadShift !== undefined ||
      m.curveLengthM !== undefined ||
      this.scenes.merging(m) ||
      this.roadProtectedRoom(m, table) <= FILTER.clear
    )
      return;
    const actual = Math.max(
      0,
      Math.min(layout.count - 1, Math.floor((at - layout.start) / layout.width)),
    );
    const boundaries =
      layout.count > 1
        ? Array.from({ length: layout.count - 1 }, (_, n) => n + 1)
            .sort((a, b) => Math.abs(a - actual) - Math.abs(b - actual) || a - b)
            .map((n) => n / layout.count)
        : [1];
    for (const corridor of boundaries) {
      const candidate: RoadManeuver = {
        kind: 'filter',
        target: m.chosenLane ?? m.lane,
        corridor,
        queueSpeed: velocity,
      };
      const fit = this.filterCorridor(m, candidate);
      if (!fit) continue;
      const half = VEHICLES[m.vehicle].width / 2;
      const { offset, maneuver: chosen } = fit;
      let clear = true;
      for (const j of group) {
        const peer = this.movers[j]!;
        if (
          peer === m ||
          Math.abs((peer.dir * this.along[peer.from]! + peer.d) / this.perMeter - progress) > 60
        )
          continue;
        if (
          Math.abs(offset - this.offsetOf(peer)) <
          half + this.roadEnvelope(peer).width + FOLLOW.roadGap
        ) {
          clear = false;
          break;
        }
      }
      if (!clear || !this.roadGapSafe(m, offset)) continue;
      m.maneuver = chosen;
      m.laneSignal = offset < at ? 'left' : 'right';
      m.lanePatience = undefined;
      return;
    }
  }

  /** Count final simulation outcomes once, including a step whose every guard trial failed. */
  private recordFilterStep(m: Mover, before: Mover) {
    const state = m.maneuver;
    if (state?.kind !== 'filter') return;
    const displaced =
      Math.abs((m.lat ?? 0) - (before.lat ?? 0)) > 1e-8 ||
      Math.hypot(m.x - before.x, m.y - before.y) > 1e-8 * this.perMeter;
    const blocked = displaced ? 0 : (state.blocked ?? 0) + 1;
    if (blocked !== (state.blocked ?? 0) || (blocked >= 2 && !state.returning))
      m.maneuver = { ...state, blocked, returning: state.returning || blocked >= 2 };
    if (blocked >= 2) m.filterRetry = FILTER.retry;
  }

  private updateLane(index: number, dt: number, table: JunctionTable, otherLimited: boolean) {
    const m = this.movers[index]!;
    if (!m.vehicle || m.kind !== 'vehicle') return;
    const state = m.maneuver;
    if (state) {
      if (state.kind === 'filter' || state.corridor !== undefined) return;
      const target = this.maneuverOffset(m),
        delta = Math.abs(target - this.offsetOf(m));
      const bound = Math.max(m.speed, m.v ?? m.speed) / this.perMeter;
      const room = this.roadProtectedRoom(m, table);
      if (
        !state.returning &&
        room >= LANE.clear + (bound * delta) / LANE.lateral &&
        this.roadGapSafe(m, target, true)
      )
        return;
      const preference = m.chosenLane ?? m.lane;
      if (this.roadGapSafe(m, this.laneTargetOffset(m, preference), true)) {
        m.maneuver = { ...state, kind: 'return', target: preference, returning: true };
        const goal = this.laneTargetOffset(m, preference),
          at = this.offsetOf(m);
        if (Math.abs(goal - at) > 1e-6) m.laneSignal = goal < at ? 'left' : 'right';
      } else if (state.kind === 'return' || !state.returning)
        m.maneuver = { ...state, kind: 'lane', returning: true };
      return;
    }
    if (this.roadSourceBlocked(index)) {
      m.lanePatience = undefined;
      return;
    }
    if (
      !hasTurnSignals(m.vehicle) ||
      m.vehicle === 'tricycle' ||
      m.roadShift !== undefined ||
      m.curveLengthM !== undefined ||
      (m.guardWait ?? 0) > 0 ||
      this.scenes.merging(m) ||
      otherLimited ||
      (m.laneCooldown ?? 0) > 0 ||
      this.roadWidth(m.line) < (this.geo.oneway?.[m.line] ? 2 : 4) * LANE_WIDTH_M
    ) {
      m.lanePatience = undefined;
      return;
    }
    const leaderIndex = this.followLeaders[index]!,
      leader = leaderIndex >= 0 ? this.movers[leaderIndex] : undefined;
    if (
      !leader ||
      leader.line !== m.line ||
      leader.dir !== m.dir ||
      (m.speed - this.followTargets[index]!) / this.perMeter + 1e-8 < LANE.gain
    ) {
      m.lanePatience = undefined;
      return;
    }
    m.lanePatience = (m.lanePatience ?? 0) + dt;
    if (m.lanePatience + 1e-8 < LANE.patience || (m.roadScan ?? 0) > 0) return;
    m.roadScan = 0.5;
    const layout = this.directionalLanes(m.line);
    const lane = Math.max(
      0,
      Math.min(layout.count - 1, Math.floor((m.chosenLane ?? m.lane) * layout.count)),
    );
    const bound = Math.max(m.speed, m.v ?? m.speed) / this.perMeter;
    for (const candidate of [lane - 1, lane + 1]) {
      if (candidate < 0 || candidate >= layout.count) continue;
      const preference = (candidate + 0.5) / layout.count;
      const target = this.laneTargetOffset(m, preference);
      const duration = Math.abs(target - this.offsetOf(m)) / LANE.lateral;
      if (
        this.roadProtectedRoom(m, table) + 1e-8 < LANE.clear + bound * duration ||
        !this.roadGapSafe(m, target)
      )
        continue;
      m.maneuver = { kind: 'lane', target: preference };
      m.laneSignal = candidate < lane ? 'left' : 'right';
      m.lanePatience = undefined;
      return;
    }
  }

  private mergingOverlap(
    i: number,
    j: number,
    lane: number,
    envelope: (index: number) => { length: number; width: number },
    futureOffset: (index: number) => number,
  ): boolean {
    const { movers, offsets } = this;
    const a = movers[i]!,
      b = movers[j]!;
    // Terrain recovery can use the clear part of the road and then return to the lane.
    // Keep a following gap throughout that maneuver, including both lateral directions.
    if (a.roadShift !== undefined || b.roadShift !== undefined) return true;
    if (a.maneuver || b.maneuver) {
      const futureA = a.maneuver ? futureOffset(i) : lane;
      const futureB = b.maneuver ? futureOffset(j) : offsets[j]!;
      const gap = Math.max(
        Math.min(lane, futureA) - Math.max(offsets[j]!, futureB),
        Math.min(offsets[j]!, futureB) - Math.max(lane, futureA),
      );
      if (gap < envelope(i).width + envelope(j).width + FOLLOW.roadGap) return true;
    }
    const mergingA = this.scenes.merging(a),
      mergingB = this.scenes.merging(b);
    // A lane that bends or meets a narrower road moves sideways: compare where it goes next.
    const bendsA = !mergingA && this.offsetVaries(a, FOLLOW.laneAheadM),
      bendsB = !mergingB && this.offsetVaries(b, FOLLOW.laneAheadM);
    const width = (VEHICLES[a.vehicle!].width + VEHICLES[b.vehicle!].width) / 2;
    if (!mergingA && !mergingB && !bendsA && !bendsB) return false;
    const futureA =
        mergingA && lane === offsets[i]
          ? this.mergeLane(a)
          : bendsA && lane === offsets[i]
            ? this.laneAhead(a)
            : lane,
      futureB = mergingB ? this.mergeLane(b) : bendsB ? this.laneAhead(b) : offsets[j]!;
    const separation = Math.max(
      Math.min(lane, futureA) - Math.max(offsets[j]!, futureB),
      Math.min(offsets[j]!, futureB) - Math.max(lane, futureA),
    );
    return separation < width + FOLLOW.lateralPad;
  }

  private capJunction(index: number, movement: Movement, dt: number): void {
    const pm = this.perMeter;
    const ahead =
      movement.ahead >= -JUNCTION.insideToleranceM * pm
        ? movement.ahead
        : (movement.boxAhead ?? movement.ahead);
    if (ahead < -JUNCTION.insideToleranceM * pm) return;
    const m = this.movers[index]!;
    this.speeds[index] = Math.min(
      this.speeds[index]!,
      approach(ahead, 0, kinematicsOf(m.vehicle).brake * pm),
    );
    this.caps[index] = Math.min(this.caps[index]!, Math.max(0, ahead) / dt);
  }

  /** Nearest overlapping leader, including the chosen exit when this line is clear. */
  private followLimits(
    dt: number,
    table: JunctionTable,
    diagnostics?: LifeDiagnostics,
  ): Float64Array {
    const { movers, perMeter: pm, speeds, caps, progress, offsets } = this;
    const epoch = ++this.followingEnvelopeEpoch;
    const futureOffset = (index: number) => {
      if (this.followingManeuverEpochs[index] !== epoch) {
        this.followingManeuverOffsets[index] = this.maneuverOffset(movers[index]!);
        this.followingManeuverEpochs[index] = epoch;
      }
      return this.followingManeuverOffsets[index]!;
    };
    const envelope = (index: number) => {
      const out = (this.followingEnvelopes[index] ??= { length: 0, width: 0 });
      if (this.followingEnvelopeEpochs[index] !== epoch) {
        const m = movers[index]!;
        this.roadEnvelope(m, out, m.maneuver ? futureOffset(index) : undefined);
        this.followingEnvelopeEpochs[index] = epoch;
      }
      return out;
    };
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i]!;
      speeds[i] = this.cruise(m);
      this.followLeaders[i] = -1;
      this.followTargets[i] = speeds[i]!;
      caps[i] = Infinity;
      const yielding = this.urgentCount && this.emergencyYielders.get(m);
      if (yielding && yielding.feasible) {
        speeds[i] = Math.min(speeds[i]!, EMERGENCY.yieldMps * pm);
        if (
          yielding.behind <= EMERGENCY.stopBehindM &&
          this.emergencyPassFits(yielding.source, m)
        ) {
          speeds[i] = 0;
          caps[i] = 0;
        }
      }
      const room =
        m.kind === 'vehicle' && this.geo.oneway?.[m.line] ? this.oneWayEndRoom(m) : undefined;
      if (room !== undefined) {
        speeds[i] = Math.min(speeds[i]!, approach(room, 0, kinematicsOf(m.vehicle).brake * pm));
        caps[i] = room / dt;
      }
    }
    const limit = (i: number, j: number, separation: number) => {
      const previous = speeds[i]!;
      const m = movers[i]!,
        leader = movers[j]!;
      const spec = VEHICLES[m.vehicle!],
        leaderSpec = VEHICLES[leader.vehicle!];
      let gap = separation - (spec.length + leaderSpec.length) / 2;
      if (
        m.chosenLane !== undefined ||
        leader.chosenLane !== undefined ||
        m.maneuver ||
        leader.maneuver ||
        m.lat !== undefined ||
        leader.lat !== undefined
      )
        gap = Math.min(gap, separation - envelope(i).length - envelope(j).length);
      if (
        m.roadShift !== undefined ||
        leader.roadShift !== undefined ||
        m.latYaw ||
        leader.latYaw
      ) {
        // Offset turns compress centreline progress. Leave room behind the actual rear
        // footprint so a following vehicle cannot pin a terrain recovery against its curb.
        const at = this.pose(m, this.followingPose),
          ahead = this.pose(leader, this.leaderPose);
        const front =
          (Math.abs(at.hx * m.hx + at.hy * m.hy) * spec.length +
            Math.abs(-at.hy * m.hx + at.hx * m.hy) * spec.width) /
          2;
        const rear =
          (Math.abs(ahead.hx * m.hx + ahead.hy * m.hy) * leaderSpec.length +
            Math.abs(-ahead.hy * m.hx + ahead.hx * m.hy) * leaderSpec.width) /
          2;
        gap = Math.min(
          gap,
          ((ahead.x - at.x) * m.hx + (ahead.y - at.y) * m.hy) / pm - front - rear,
        );
      }
      const room = Math.max(0, gap - FOLLOW.minGap) * pm;
      if (room < 0.5 * pm) diagnostics?.following(m, leader);
      const wetRoad = this.scenes.raining && m.kind === 'vehicle' && !!m.vehicle;
      let targetGap = wetRoad ? DRIVE.rain.gap : FOLLOW.minGap;
      // Admission reserves the physical gap; clear that box before seeking extra wet room.
      if (wetRoad)
        for (const r of table.holds(m))
          if (r.inside && r.since !== undefined) {
            targetGap = FOLLOW.minGap;
            break;
          }
      const targetRoom = Math.max(0, gap - targetGap) * pm;
      const target = Math.min(
        speeds[i]!,
        targetRoom / (wetRoad ? DRIVE.rain.headway : FOLLOW.headway),
      );
      const lead = this.inspected === leader ? 0 : (leader.v ?? leader.speed);
      // Comfortable braking cannot lower a target already below the lead speed.
      speeds[i] =
        target <= Math.abs(lead)
          ? target
          : Math.min(target, approach(targetRoom, lead, kinematicsOf(m.vehicle).brake * pm));
      caps[i] = Math.min(caps[i]!, room / dt);
      this.followLeaders[i] = j;
      if (speeds[i] + 1e-9 < previous) this.followTargets[i] = speeds[i]!;
    };
    const curbScenes =
      this.scenes.hasCurbScenes || movers.some((m) => this.offsetVaries(m, FOLLOW.laneAheadM));
    const overlaps = (i: number, j: number, lane = offsets[i]!) => {
      const a = movers[i]!,
        b = movers[j]!;
      const width =
        a.kind === 'vehicle' &&
        b.kind === 'vehicle' &&
        (a.chosenLane !== undefined ||
          b.chosenLane !== undefined ||
          a.maneuver ||
          b.maneuver ||
          a.lat !== undefined ||
          b.lat !== undefined)
          ? envelope(i).width + envelope(j).width
          : (VEHICLES[a.vehicle!].width + VEHICLES[b.vehicle!].width) / 2;
      return (
        Math.abs(lane - offsets[j]!) <
          width +
            (a.kind === 'vehicle' && b.kind === 'vehicle' ? FOLLOW.roadGap : -FOLLOW.squeeze) ||
        (curbScenes &&
          !(
            this.urgentCount &&
            ((isUrgent(a) && this.emergencyYielders.get(b)?.source === a) ||
              (isUrgent(b) && this.emergencyYielders.get(a)?.source === b))
          ) &&
          this.mergingOverlap(i, j, lane, envelope, futureOffset))
      );
    };
    for (const group of this.trafficGroups.values())
      for (let k = 0; k < group.length; k++) {
        const i = group[k]!,
          m = movers[i]!;
        speeds[i] = Math.min(speeds[i]!, this.curveTarget(m));
        let found = false;
        for (let n = k + 1; n < group.length; n++) {
          const j = group[n]!;
          if (!overlaps(i, j)) continue;
          limit(i, j, progress[j]! - progress[i]!);
          found = true;
          break;
        }
        if (!found) {
          const code = m.routing?.plan?.exit ?? m.next;
          if (code !== undefined && code >= 0) {
            const line = code >> 1,
              dir = code & 1 ? -1 : 1;
            const end = m.dir === 1 ? this.last(m.line) : this.first(m.line);
            const remaining = (m.dir * this.along[end]!) / pm - progress[i]!;
            const entry = (dir * this.directedExit(code, end).along) / pm;
            const lane = m.kind === 'vehicle' ? this.vehicleLane(m, line) : 0;
            for (const j of this.trafficGroups.get(line * 2 + (dir === 1 ? 1 : 0)) ?? []) {
              // An interior entry joins ahead of traffic on the through line's
              // preceding segment. That traffic competes for its junction grant;
              // it is not an outgoing leader with negative following room.
              if (j === i || progress[j]! < entry || !overlaps(i, j, lane)) continue;
              limit(i, j, remaining + progress[j]! - entry);
              break;
            }
          }
        }
        for (const { movement } of table.holds(m)) {
          if (!table.canEnter(m, movement.key)) this.capJunction(i, movement, dt);
        }
      }
    return speeds;
  }

  private terminalLimits(speeds: Float64Array) {
    const pm = this.perMeter;
    const lookahead = (terminalLookaheadM ??= Math.max(
      ...VEHICLE_TYPES.map((type) =>
        terminalReach(TERMINAL.cruise, VEHICLES[type].length, kinematicsOf(type).brake),
      ),
    ));
    for (const group of this.trafficGroups.values())
      for (const i of group) {
        const m = this.movers[i]!;
        if (m.kind !== 'vehicle' || !m.vehicle) continue;
        const remaining =
          (m.dir === 1 ? this.along[this.last(m.line)]! / pm : 0) - this.progress[i]!;
        if (remaining <= lookahead || (m.v ?? m.speed) > TERMINAL.cruise * pm)
          speeds[i] = this.terminalTarget(m, speeds[i]!, remaining * pm);
      }
  }

  private prepareLocalTraffic(
    table: JunctionTable,
    clock: number,
    shows?: (kind: AgentKind) => boolean,
    near?: (x: number, y: number) => boolean,
    env?: LifeEnv,
  ) {
    const active = (m: Mover) =>
      (!shows || shows(m.kind)) &&
      (!near || near(m.x, m.y)) &&
      (!env?.levels || m.rank < env.levels[m.kind]) &&
      !this.scenes.hidden(m);
    this.prepareTraffic(active);
    table.begin(new Set([this]));
    this.requestJunctions(
      table,
      active,
      clock,
      '',
      undefined,
      this.standalonePedestrians(shows, near, env),
    );
    table.resolve(clock);
  }

  /** Already ordered actors need neither wrapper objects nor another stable sort. */
  private movementOrder(): number[] | undefined {
    const { movers } = this;
    let previousWalker = 1,
      previousWait = Infinity;
    for (const m of movers) {
      const walker = Number(isWalker(m.kind)),
        waiting = m.waiting ?? 0;
      if (walker > previousWalker || (walker === previousWalker && waiting > previousWait)) {
        return Array.from(movers.keys()).sort(
          (a, b) =>
            Number(isWalker(movers[b]!.kind)) - Number(isWalker(movers[a]!.kind)) ||
            (movers[b]!.waiting ?? 0) - (movers[a]!.waiting ?? 0) ||
            a - b,
        );
      }
      previousWalker = walker;
      previousWait = waiting;
    }
  }

  /**
   * Move everything on by `dt` seconds. `gustAt` is how hard the wind blows in a tree's crown at
   * a point (tile units), which can flush birds out of it. With `shows`, only the kinds it shows
   * move, and with `near` (tile units), only those near the view, trains aside (they run on
   * from tile to tile); the others wait where they are, unseen.
   */
  step(
    dt: number,
    gustAt?: (x: number, y: number) => number,
    shows?: (kind: AgentKind) => boolean,
    near?: (x: number, y: number) => boolean,
    env?: LifeEnv,
    guard?: GroundGuard,
    pass?: StepPass,
  ) {
    if (dt <= 0) return;
    const pedestrians = this.pedestrianLimiter(dt, pass?.pedestrians, shows, near, env);
    this.stepFrame(dt, gustAt, shows, near, env, guard, pass, pedestrians);
  }

  private clearEmojiInput(input: Partial<EmojiObservation>) {
    input.owner = undefined;
    input.mover = undefined;
    input.gatherer = undefined;
    input.visit = undefined;
    input.passenger = undefined;
  }
  private releaseEmojiInputs() {
    for (const input of this.emojiInputs) this.clearEmojiInput(input);
    this.emojiInputs.length = 0;
  }
  private emojiInput(
    owner: EmojiObservation['owner'],
    subject: EmojiObservation['subject'],
    eligible: boolean,
  ): EmojiObservation {
    const index = this.emojiInputs.length;
    const input = this.emojiInputPool[index] ?? (this.emojiInputPool[index] = {});
    input.owner = owner;
    input.subject = subject;
    input.eligible = eligible;
    input.speaking = subject === 'bird' ? false : this.momentHost.speaking(owner);
    // Required fields are populated before lending this pooled record to the observer.
    const observation = input as EmojiObservation;
    this.emojiInputs.push(observation);
    return observation;
  }
  private emojiArrival(mover: Mover): boolean {
    for (const event of this.scenes.speechEvents)
      if (event.kind === 'arrival' && event.mover === mover) return true;
    return false;
  }
  private emojiObservations(
    env: LifeEnv,
    near?: (x: number, y: number) => boolean,
    owns?: (p: { x: number; y: number }) => boolean,
  ): EmojiObservation[] {
    this.releaseEmojiInputs();
    const levels = env.emojiView?.levels ?? env.levels;
    const crowd = env.emojiView?.crowd ?? 1;
    const visible = viewIn(this.tile, env.emojiView?.bounds, 0);
    const eligible = (p: { x: number; y: number }) =>
      inTile(p) && (!owns || owns(p)) && visible(p.x, p.y) && (!near || near(p.x, p.y));
    const observations = this.emojiInputs;
    const visits = this.scenes.visits.size > 0;
    const services = this.scenes.services.size > 0;
    const arrivals = this.scenes.speechEvents.length > 0;
    for (const m of this.movers) {
      if (m.train || !EMOJI_MOVER_KINDS.has(m.kind)) continue;
      const subject = m.kind === 'vehicle' ? 'driver' : (m.kind as 'person' | 'dog' | 'cat');
      if (subject === 'person' && !m.group) continue;
      const admitted = eligible(m) && this.visibleMover(m, levels, crowd);
      if (!admitted && this.emoji.memory.get(m)?.clock === undefined) continue;
      const input = this.emojiInput(m, subject, admitted);
      input.mover = m;
      input.figure = m.group?.[0]?.figure;
      input.vendor = undefined;
      input.visit = visits ? this.scenes.visits.get(m) : undefined;
      input.held = services ? this.scenes.held(m) : false;
      input.passenger = services ? this.scenes.services.get(m)?.passenger : undefined;
      input.arrival = arrivals ? this.emojiArrival(m) : false;
      input.still = m.pause > 0 || (!!input.visit && this.scenes.still(m));
    }
    for (const g of this.gatherers) {
      if (g.carabao !== undefined) continue;
      const admitted = eligible(g) && (!levels || g.rank < gathererShare(g, levels) * crowd);
      if (!admitted && this.emoji.memory.get(g)?.clock === undefined) continue;
      const input = this.emojiInput(g, 'person', admitted);
      input.gatherer = g;
      input.figure = g.walker.figure;
      input.held = input.arrival = input.still = input.vendor = undefined;
    }
    for (const s of this.seasonalStalls.length ? this.allStalls() : this.stalls) {
      const admitted = eligible(s) && vendorAttendance(s, levels, crowd);
      if (!admitted && this.emoji.memory.get(s)?.clock === undefined) continue;
      const input = this.emojiInput(s, 'person', admitted);
      input.figure = 'adult';
      input.vendor = true;
      input.held = input.arrival = input.still = undefined;
    }
    for (const flock of this.birdEmojiOwners) {
      const spec = BIRD_SPECIES[flock.species];
      const share = levels ? (spec.nocturnal ? levels.night : levels.bird) : 1;
      const admitted = eligible(flock) && flock.rank < share * crowd;
      this.emojiInput(flock, 'bird', admitted);
    }
    return observations;
  }
  /** Freeze pending/active cues, but never replay an undelivered physical event. */
  freezeEmoji() {
    this.tapRequests?.clear();
    this.startled.length = 0;
    this.pointerInside = undefined;
    this.emoji.freeze();
  }
  private clearBirdEmojiOwners() {
    for (const flock of this.birdEmojiOwners) this.emoji.memory.get(flock)?.edges.clear();
    this.birdEmojiOwners.clear();
  }
  disposeEmoji() {
    this.startled.length = 0;
    this.pointerInside = undefined;
    this.clearBirdEmojiOwners();
    this.emoji.dispose();
  }
  visibleMover(m: Mover, levels: Activity | undefined, crowd: number) {
    return moverAttendance(m, levels, crowd) && !this.scenes.hidden(m);
  }
  private motionFits(
    m: Mover,
    before: Mover,
    distance: number,
    dt: number,
    guarded: boolean,
    fitsGround: GroundGuard,
    rejected: (reason: ContinuityRejection) => void,
    trial: { origin?: Pose; varies?: boolean },
  ) {
    if (
      guarded &&
      m.kind === 'vehicle' &&
      m.vehicle &&
      (m.roadShift !== undefined ||
        m.curveLengthM !== undefined ||
        (trial.varies ??= this.offsetVaries(before, distance / this.perMeter))) &&
      m.line === before.line &&
      m.from === before.from &&
      m.dir === before.dir
    ) {
      const origin = (trial.origin ??= this.pose(before, undefined, m)),
        pose = this.pose(m);
      if (
        Math.hypot(pose.x - origin.x, pose.y - origin.y) >
        Math.max(distance, m.speed * dt) + 1e-8 * this.perMeter
      )
        return false;
    }
    return fitsGround(m, before, undefined, rejected);
  }
  private readonly standaloneGround: GroundGuard = (owner, before) =>
    !('kind' in owner) ||
    (owner.kind !== 'cat' && owner.kind !== 'dog') ||
    (this.scenes.walkable(before ?? owner, owner) &&
      this.roadTerrain.access.allows(this.groundBodies(owner)));

  private stepFrame(
    dt: number,
    gustAt?: (x: number, y: number) => number,
    shows?: (kind: AgentKind) => boolean,
    near?: (x: number, y: number) => boolean,
    env?: LifeEnv,
    guard?: GroundGuard,
    pass?: StepPass,
    pedestrianTarget?: (m: Mover, target: number) => { target: number; held: boolean },
  ) {
    if (dt <= 0) return;
    if (!env?.pointer) this.pointerInside = undefined;
    this.inspected = env?.inspecting;
    this.ownership = pass?.owns;
    this.seamLimits = pass?.seams;
    this.time += dt;
    const { rng } = this;
    const clock = env?.clock ?? this.time;
    this.crossingClock = clock;
    const minimum = pass?.momentView?.cellWidth ?? 0;
    this.crossingMinimum = minimum;
    this.crossingWaits.beginStep();
    if (this.crossingWaits.records.length) {
      if (!guard || !pass?.crossingGuard) {
        const physical = guard ?? this.standaloneGround;
        guard = Object.assign(
          (
            owner: GroundAgent,
            before?: GroundAgent,
            reserve?: boolean,
            reject?: (reason: ContinuityRejection) => void,
          ) => {
            const trial = this.crossingWaits.prepare(owner, before, minimum);
            if (!this.crossingWaits.permits(owner, before, clock, minimum, trial)) return false;
            if (!physical(owner, before, reserve, reject)) return false;
            if (reserve !== false)
              this.crossingWaits.accept(
                owner,
                before,
                clock,
                minimum,
                () => this.movers.indexOf(owner as Mover),
                trial,
              );
            return true;
          },
          physical,
        );
      }
      for (const owner of this.movers) {
        if (
          owner === this.inspected ||
          (near && !near(owner.x, owner.y)) ||
          (pass?.owns && !pass.owns(owner))
        )
          continue;
        this.crossingWaits.tick(owner, dt, clock, minimum, guard);
      }
      for (const owner of this.gatherers) {
        if (
          owner === this.inspected ||
          (near && !near(owner.x, owner.y)) ||
          (pass?.owns && !pass.owns(owner))
        )
          continue;
        this.crossingWaits.tick(owner, dt, clock, minimum, guard);
      }
    }
    const walkDistance = (m: Mover, target: { x: number; y: number }, distance: number) =>
      this.crossingWaits.limit(m, target, distance, clock, minimum);

    this.scenes.step(
      dt,
      this.movers,
      env ?? {},
      near,
      shows,
      guard,
      (m) => this.offsetOf(m),
      walkDistance,

      pass?.owns,
      this.inspected,
      env?.diagnostics,
    );
    const momentView = pass?.momentView;
    this.momentHost.step(
      dt,
      momentView?.zoom ?? (!shows || shows('person') ? MOMENTS.zoom : 0),
      env,
      pass?.owns ? (x, y) => (!near || near(x, y)) && pass.owns!({ x, y }) : near,
      guard,
      momentView?.cellWidth ?? 0,
      momentView?.cellAspect ?? DEFAULT_CELLS.aspect,
      this.inspected,
    );
    const emojiEnv = env ?? { rain: 0, clock };
    const emojiZoom = momentView?.zoom ?? (!shows || shows('person') ? MOMENTS.zoom : 0);
    const observing = this.emoji.observes(emojiZoom);
    if (observing) {
      for (const flock of this.startled) this.birdEmojiOwners.add(flock);
      this.emoji.step(
        dt,
        emojiZoom,
        emojiEnv,
        this.emojiObservations(emojiEnv, near, pass?.owns),
        this.scenes.purchaseCompletions,
        this.momentHost.voiceCompletions,
        this.startled,
        this.tapRequests?.drain(
          emojiEnv.emojiTime?.clock ?? clock,
          (owner) =>
            this.emojiInputs.some((o) => o.owner === owner && o.eligible) ||
            this.movers.some(
              (m) =>
                m === owner &&
                !!m.train &&
                (!near || near(m.x, m.y)) &&
                (!pass?.owns || pass.owns(m)),
            ),
          (owner) => this.momentHost.speaking(owner),
        ),
      );
      for (const flock of this.birdEmojiOwners) {
        const track = this.emoji.memory.get(flock);
        if (!track?.edges.has('scared') && !track?.group) this.birdEmojiOwners.delete(flock);
      }
    } else {
      this.emoji.step(dt, emojiZoom, emojiEnv, []);
      this.tapRequests?.clear();
      this.clearBirdEmojiOwners();
    }
    this.startled.length = 0;
    // Inputs are borrowed only for this observer call; do not retain actor references.
    this.releaseEmojiInputs();
    const table = pass?.junctions ?? this.localJunctions;
    let rushing = this.reconcileRush();
    if (!pass) this.prepareLocalTraffic(table, clock, shows, near, env);
    const speeds = this.followLimits(dt, table, env?.diagnostics);
    if (guard) this.terminalLimits(speeds);
    // Scenes can begin/end visits in this step. Share the main loop's eligibility after that.
    this.captureEffects(clock, dt, env, shows, near, pass);
    this.prepareRecovery();
    const trains = pass?.trains ?? trainLimits([this], dt);
    const limit = { target: 0, cap: Infinity };
    let recoveredLines = pass?.recoveredLines;
    // Walkers get a chance to clear a crossing; waiting traffic wins ties among cars.
    const order = this.movementOrder();
    const motionTrial: { origin?: Pose; varies?: boolean } = {};
    let terrainRejected = false;
    const rejected = (reason: ContinuityRejection) => {
      terrainRejected ||= reason === 'terrain';
    };
    const fitsGround: GroundGuard = guard ?? this.standaloneGround;
    let livePedestrians = pass?.pedestrians;

    // Scene visitors drop runs; other frozen runners keep their timer. Resumed runs share
    // the cap in stable mover order.
    let running = 0;
    for (let i = 0; i < this.movers.length; i++) {
      const m = this.movers[i]!;
      if ((m.run ?? 0) <= 0) continue;
      else if (this.scenes.visits.has(m)) this.stopRun(m);
      else if (this.eligible[i]) {
        if (running < RUN.maxPerTile) running++;
        else this.stopRun(m);
      }
    }
    for (let slot = 0; slot < this.movers.length; slot++) {
      const i = order?.[slot] ?? slot,
        m = this.movers[i]!;
      if (this.inspected === m) {
        env?.diagnostics?.eligible(m, m.kind);
        env?.diagnostics?.hold(m, 'inspection');
        continue;
      }
      if (!this.eligible[i]) continue;
      env?.diagnostics?.eligible(m, m.kind);
      if (isWalker(m.kind) && this.scenes.yieldStep(m, dt, guard, walkDistance, pass?.owns))
        continue;
      const maneuver = m.vehicle && this.recoveryLeaders.get(m.line);
      if (
        maneuver &&
        maneuver !== m &&
        maneuver.dir !== m.dir &&
        Math.hypot(m.x - maneuver.x, m.y - maneuver.y) <
          ((VEHICLES[m.vehicle!].length + VEHICLES[maneuver.vehicle!].length) / 2 + 2) *
            this.perMeter
      ) {
        // The opposed actor retains its route while the selected recovery makes
        // room to rotate; advancing into the vacated retreat space would cancel it.
        m.v = 0;
        continue;
      }
      let intentionalHold = false;
      let otherRoadLimit = false;
      if (m.kind === 'vehicle') {
        if (!this.scenes.held(m)) this.updateFilter(i, table);
        if (m.vehicle) {
          limit.target =
            m.maneuver?.corridor !== undefined
              ? Math.min(speeds[i]!, this.filterCap(m))
              : speeds[i]!;
          limit.cap = this.caps[i]!;
          this.scenes.limit(m, dt, kinematicsOf(m.vehicle).brake * this.perMeter, limit);
          if (m.emergency?.target) {
            const stop = this.emergencyArrival(m);
            if (stop) {
              const room = Math.max(0, stop.remaining) * this.perMeter;
              limit.target = Math.min(
                limit.target,
                stopBefore(room, 0, kinematicsOf(m.vehicle).brake * this.perMeter),
              );
              limit.cap = Math.min(limit.cap, room / dt);
              if (
                stop.remaining < EMERGENCY.approachM &&
                Math.abs(stop.curb - this.offsetOf(m)) > EMERGENCY.curbToleranceM
              )
                limit.target = Math.min(limit.target, 1.2 * this.perMeter);
            }
          }
          const clearing = this.clearingJunctions;
          clearing.clear();
          for (const r of table.holds(m))
            if (r.inside && r.since !== undefined && r.authorizedOutside)
              clearing.add(r.movement.key);
          if (isUrgent(m))
            for (const r of table.holds(m)) {
              if (
                !r.authorizedOutside ||
                r.since === undefined ||
                !table.canEnter(m, r.movement.key)
              )
                continue;
              clearing.add(r.movement.key);
              const path = r.movement;
              for (const key of this.signals.controllerKeys(path)) clearing.add(key);
              if (
                !this.signals.allows(
                  m,
                  path.entry?.x ?? path.junction.x,
                  path.entry?.y ?? path.junction.y,
                  clock,
                  Math.max(0, path.ahead),
                  path,
                )
              ) {
                const at = tileToLngLat(this.tile, path.junction),
                  old = m.emergency!.creep ?? [];
                if (
                  !old.some(
                    (p) => Math.abs(p.at[0] - at[0]) < 1e-9 && Math.abs(p.at[1] - at[1]) < 1e-9,
                  )
                )
                  m.emergency = {
                    ...m.emergency!,
                    creep: [
                      ...old,
                      {
                        at,
                        out: [path.outHx, path.outHy],
                        radiusM: Math.max(
                          path.junction.radius / this.perMeter,
                          this.signals.controllerRadius(path),
                        ),
                      },
                    ],
                  };
                limit.target = Math.min(limit.target, EMERGENCY.creepMps * this.perMeter);
                limit.cap = Math.min(limit.cap, EMERGENCY.creepMps * this.perMeter);
              }
            }
          if (m.emergency?.creep) {
            const retained = isUrgent(m)
              ? m.emergency.creep.filter((p) => {
                  const center = lngLatToTile(this.tile, ...p.at);
                  return this.groundBodies(m).some((body) =>
                    bodyCorners(body).some(
                      (c) =>
                        ((c.x * this.perMeter - center.x) * p.out[0] +
                          (c.y * this.perMeter - center.y) * p.out[1]) /
                          this.perMeter <=
                        p.radiusM,
                    ),
                  );
                })
              : [];
            if (retained.length) {
              limit.target = Math.min(limit.target, EMERGENCY.creepMps * this.perMeter);
              limit.cap = Math.min(limit.cap, EMERGENCY.creepMps * this.perMeter);
            } else {
              const { creep: _creep, ...state } = m.emergency;
              m.emergency = state;
            }
          }
          intentionalHold = this.signals.vehicleLimit(
            m,
            dt,
            clock,
            limit,
            clearing,
            env?.diagnostics,
          );

          speeds[i] = limit.target;
          this.caps[i] = limit.cap;
        } else
          speeds[i] = Math.min(
            speeds[i]!,
            this.scenes.speed(m, dt),
            this.signals.vehicleSpeed(m, dt, clock),
          );
        if (this.scenes.held(m) || emergencyParked(m)) {
          m.waiting = 0;
          env?.diagnostics?.hold(m, 'service');
          if (m.vehicle) m.v = 0;
          continue;
        }
      }
      if (m.train) {
        if (m.train.edge) continue;
        if (m.pause > 0) {
          m.v = 0;
          m.pause -= dt;
          continue;
        }
        if (m.train.reverse) {
          this.reverseTrain(m);
          m.v = 0;
          continue;
        }
        const trainLimit = trains.get(m) ?? { target: m.speed, cap: Infinity, station: Infinity };
        if (this.atStation(m, trainLimit.station)) {
          m.pause = between(rng, TRAIN.dwell);
          m.v = 0;
          continue;
        }
        const v = nextSpeed(
          m.v ?? m.speed,
          trainLimit.target,
          trainLimit.cap,
          kinematicsOf('locomotive'),
          this.perMeter,
          dt,
        );
        const moved = this.moveTrain(m, v * dt);
        m.v = m.pause > 0 || m.train.reverse || m.train.edge ? 0 : moved / dt;
        continue;
      }
      if (m.kind === 'dog') {
        const speed = this.dogSpeed(
          m,
          dt,
          this.canIdle(m) && !((this.tapWake?.get(m) ?? 0) > clock),
        );
        if (speed === undefined) {
          m.waiting = 0;
          continue;
        }
        speeds[i] = speed;
      }
      if (m.kind === 'cat') {
        const idle = this.canIdle(m) && !((this.tapWake?.get(m) ?? 0) > clock);
        if (!idle) {
          m.pause = 0;
          m.grooming = false;
        }
        if (m.pause > 0) {
          m.pause -= dt;
          continue;
        }
        m.grooming = false;
        if (idle && this.catRng() < CAT.pause.chance * dt) {
          m.pause = between(this.catRng, CAT.pause.seconds);
          m.grooming = this.catRng() < CAT.groomChance;
          continue;
        }
      }
      if (m.kind === 'person') {
        if (m.turning) {
          // Turning round on the spot (`beginTurn`).
          m.turning.left -= dt;
          if (m.turning.left > 0) continue;
          m.turning = undefined;
        }
        if (this.momentHost.moments.busy(m)) {
          m.waiting = 0;
          env?.diagnostics?.hold(m, 'moment');
          m.pause = Math.max(0, m.pause - dt);
          running -= Number(this.stopRun(m));
          continue;
        }
        const idle = this.canIdle(m);
        const dash =
          this.scenes.dashPace(m) ??
          ((this.tapDash?.get(m) ?? 0) > clock ? runPace(m, RUN.speed, this.perMeter) : undefined);
        const dashing = dash !== undefined;
        if (!idle || dashing) m.pause = 0;
        if (m.pause > 0) {
          m.waiting = 0;
          m.pause -= dt;
          env?.diagnostics?.hold(m, 'pause');
          continue;
        }
        if (idle && this.walkerRng() < PERSON_PAUSE.chance * dt) {
          const pause = between(this.walkerRng, PERSON_PAUSE.seconds);
          if (!dashing) {
            m.waiting = 0;
            env?.diagnostics?.hold(m, 'pause');
            m.pause = pause;
            running -= Number(this.stopRun(m));
            continue;
          }
        } else if (
          idle &&
          this.walkerRng() < PERSON_TURN_CHANCE * dt &&
          !dashing &&
          !m.crossingWait?.waiting
        ) {
          running -= Number(this.stopRun(m));
          const previous = snapshotMover(m);
          const heading = m.momentFacing ?? { hx: m.hx, hy: m.hy };
          this.beginTurn(m);
          this.turnBack(m);
          m.avoid = -(m.avoid ?? 0);
          // The group turns round where it stands: the one on the right is now on the left.
          this.advance(m, 0, false);
          faceGroup(m, m.hx, m.hy, heading);
          if (guard && !guard(m, previous)) restoreMover(m, previous);
        }
        const was = (m.run ?? 0) > 0;
        const randomPace = this.runSpeed(m, dt, running < RUN.maxPerTile);
        const pace = dash ?? randomPace;
        running += Number((m.run ?? 0) > 0) - Number(was);
        if (pace !== undefined) speeds[i] = pace;
      }
      const walking = isWalker(m.kind);
      if (walking) {
        if (m.kind === 'person' && speeds[i]! > 0 && this.trafficTooClose(m, speeds[i]! * dt))
          speeds[i] = 0;
      }
      if (m.vehicle) {
        this.motionStats.steps++;
        const seam = pass?.seams?.get(m);
        if (seam && !seam.crossing)
          speeds[i] = Math.min(
            speeds[i]!,
            approach(seam.room, 0, kinematicsOf(m.vehicle).brake * this.perMeter),
          );
        if (m.kind === 'vehicle') {
          livePedestrians ??= this.standalonePedestrians(shows, near, env);
          let revoked = false;
          for (const r of table.holds(m)) {
            const p = r.movement;
            if (r.inside || r.since === undefined || this.junctionClear(p, livePedestrians))
              continue;
            table.revokeGrant(m, p.key);
            this.capJunction(i, p, dt);
            revoked = true;
          }
          if (revoked)
            for (const r of table.holds(m))
              if (!r.inside && !table.canEnter(m, r.movement.key))
                this.capJunction(i, r.movement, dt);
        }
        if (pedestrianTarget && m.kind === 'vehicle') {
          const decision = pedestrianTarget(m, speeds[i]!);
          speeds[i] = decision.target;
          intentionalHold ||= decision.held;
          if (decision.held) env?.diagnostics?.hold(m, 'signal');
        }

        otherRoadLimit = intentionalHold || speeds[i]! + 1e-9 < this.followTargets[i]!;
        if (m.v === undefined && (guard || pedestrianTarget || this.scenes.hasCurbScenes))
          m.v = Math.min(m.speed, speeds[i]!, this.caps[i]!);
        if (m.kind === 'vehicle') {
          const was = (m.rush ?? 0) > 0;
          const openRoad =
            !was &&
            rushing < DRIVE.rush.maxPerTile &&
            Math.min(speeds[i]!, this.caps[i]!) + 1e-8 * this.perMeter >= this.cruise(m);
          this.rushTick(m, dt, openRoad);
          rushing += Number((m.rush ?? 0) > 0) - Number(was);
          // New starts keep this step's traffic limits; expiry eases back immediately.
          if (was && (m.rush ?? 0) <= 0) speeds[i] = Math.min(speeds[i]!, this.cruise(m));
        }
        const next = nextSpeed(
          m.v ?? m.speed,
          speeds[i]!,
          Infinity,
          kinematicsOf(m.vehicle),
          this.perMeter,
          dt,
        );
        if (this.caps[i]! + 1e-9 < next) this.motionStats.hardCaps++;
        speeds[i] = Math.min(next, this.caps[i]!);
        if (seam) speeds[i] = Math.min(speeds[i], Math.max(0, seam.room) / dt);
      }
      let distance = speeds[i]! * dt;
      if (pass?.recoveredNow?.has(m)) {
        m.v = 0;
        continue;
      }
      if (this.recoveryApproaches.has(m)) {
        // Retain the selected retreat instead of returning to the blocked nose
        // between attempts. Signal/service holds freeze it. A following cap
        // limits forward travel, while this already selected retreat stays swept.
        if (guard && m.speed > 0 && !intentionalHold && !pass?.recoveryAttempts?.has(m)) {
          recoveredLines ??= new Set();
          if (this.recoverVehicle(m, guard, table, recoveredLines, pass?.owns, dt)) {
            pass?.recovered?.(m);
            env?.diagnostics?.recovery(m, 'vehicle');
          }
        }
        m.v = 0;
        continue;
      }
      this.enteredExits.clear();
      if (m.kind === 'vehicle') {
        this.tickRoadTimers(m, dt);
        this.updateLane(i, dt, table, otherRoadLimit);
        if (m.maneuver && m.maneuver.kind !== 'filter' && m.maneuver.corridor === undefined)
          distance = Math.min(
            distance,
            Math.max(0, this.roadProtectedRoom(m, table) - LANE.clear) * this.perMeter,
          );
      }
      // Unguarded craft have no rejected trials; avoid allocating rollback snapshots for them.
      if (m.vehicle && (!guard || m.kind !== 'vehicle') && !m.maneuver && !m.latYaw) {
        m.v =
          distance === 0 && m.v === 0 ? 0 : this.advance(m, distance, true, this.enteredExits) / dt;
        m.waiting = 0;
        continue;
      }
      const before = walking && m.momentFacing ? snapshotMover(m) : { ...m };
      motionTrial.origin = undefined;
      motionTrial.varies = undefined;
      const restoreBlock = m.kind === 'vehicle' ? this.blockedRestoration.get(m) : undefined;
      if (
        restoreBlock &&
        (m.roadShift === undefined ||
          m.line !== restoreBlock.line ||
          m.dir !== restoreBlock.dir ||
          (m.x - restoreBlock.x) * restoreBlock.hx + (m.y - restoreBlock.y) * restoreBlock.hy >=
            ((m.vehicle ? VEHICLES[m.vehicle].length : 0) + FOLLOW.minGap) * this.perMeter)
      )
        this.blockedRestoration.delete(m);
      const parking = m.emergency?.target && this.emergencyArrival(m);
      const curbTarget =
        parking && parking.remaining < EMERGENCY.approachM
          ? parking.curb - (this.offsetOf(m) - (m.roadShift ?? 0))
          : this.urgentCount && this.emergencyOffsets.has(m)
            ? this.emergencyOffsets.get(m)! - (this.offsetOf(m) - (m.roadShift ?? 0))
            : undefined;
      if (
        curbTarget !== undefined &&
        !this.cornerWithin(m, m.from, m.d) &&
        !this.cornerWithin(m, m.from + m.dir, this.segment(m.from, m.from + m.dir) - m.d)
      ) {
        const old = m.roadShift ?? 0,
          delta = curbTarget - old;
        const change = Math.min(
          Math.abs(delta),
          ROAD_AVOID.restore * dt,
          (ROAD_AVOID.slope * distance) / this.perMeter,
        );
        if (change) m.roadShift = old + Math.sign(delta) * change;
      } else if (
        m.kind === 'vehicle' &&
        !m.maneuver &&
        m.speed > 0 &&
        m.roadShift !== undefined &&
        m.roadSteering === undefined &&
        !this.blockedRestoration.has(m) &&
        !this.cornerWithin(m, m.from, m.d) &&
        !this.cornerWithin(m, m.from + m.dir, this.segment(m.from, m.from + m.dir) - m.d)
      ) {
        const change = Math.min(
          Math.abs(m.roadShift),
          ROAD_AVOID.restore * dt,
          (ROAD_AVOID.slope * distance) / this.perMeter,
        );
        m.roadShift -= Math.sign(m.roadShift) * change;
        if (Math.abs(m.roadShift) < 1e-8) m.roadShift = undefined;
      }
      // A safe return can straighten at a stop without advancing past its forward cap.
      // Unsafe returning lanes retain their accepted pose until the full sweep opens.
      const lateralBudget =
        before.maneuver?.corridor !== undefined
          ? Math.max(distance, this.filterCap(before) * dt)
          : before.maneuver?.kind === 'return' ||
              (before.maneuver?.kind === 'lane' &&
                !before.maneuver.returning &&
                Math.abs(this.maneuverOffset(before) - this.offsetOf(before)) <= 1e-8)
            ? Math.max(distance, before.speed * dt)
            : distance;
      const lateral = this.proposeLateral(m, before, lateralBudget, dt);
      if (walking) {
        if (m.momentFacing) faceGroup(m, m.hx, m.hy);
        m.avoid = (m.avoid ?? 0) * Math.max(0, 1 - (WALK_ASIDE.restore * distance) / this.perMeter);
      }
      const restored =
        m.kind === 'vehicle' && before.roadShift !== m.roadShift
          ? Math.abs(this.offsetOf(m) - this.offsetOf(before, m)) * this.perMeter
          : 0;
      const forwardDistance = Math.sqrt(
        Math.max(0, distance * distance - (restored + lateral) ** 2),
      );
      let moved =
        distance === 0 && m.vehicle && m.v === 0
          ? 0
          : this.advance(m, forwardDistance, true, this.enteredExits);
      if (
        guard &&
        m.kind === 'vehicle' &&
        (m.roadShift !== undefined ||
          m.curveLengthM !== undefined ||
          (motionTrial.varies ??= this.offsetVaries(before, distance / this.perMeter))) &&
        m.line === before.line &&
        m.from === before.from &&
        m.dir === before.dir
      ) {
        const origin = (motionTrial.origin ??= this.pose(before, undefined, m));
        for (let retry = 0; retry < 3; retry++) {
          const pose = this.pose(m);
          const travel = Math.hypot(pose.x - origin.x, pose.y - origin.y);
          if (travel <= lateralBudget + 1e-8 * this.perMeter || travel === 0) break;
          m.d = before.d + ((m.d - before.d) * lateralBudget) / travel;
          this.advance(m, 0, false);
          moved = Math.max(0, m.d - before.d);
        }
      }
      let curveForward = 0;
      terrainRejected = false;

      if (m.kind === 'vehicle' || walking) {
        this.trialYaw(m, before, moved, lateralBudget, dt);
        let fits = this.motionFits(
          m,
          before,
          distance,
          dt,
          !!guard,
          fitsGround,
          rejected,
          motionTrial,
        );
        const forwardTerrainRejected = terrainRejected;
        if (!fits && m.kind === 'vehicle' && guard?.eventDenied?.(m)) {
          // A live street closure is deliberate. Stop at its checked edge
          // instead of creeping sideways or entering blocked-road recovery.
          restoreMover(m, before);
          m.v = 0;
          env?.diagnostics?.tag(m, 'eventClosure');
          continue;
        }
        if (!fits && distance > 0 && guard?.contact) {
          const trial = snapshotMover(m);
          restoreMover(m, before);
          guard.contact(m, trial);
          restoreMover(m, trial);
        }
        const correctingCurve =
          m.curveLengthM !== undefined &&
          m.curveCorner !== undefined &&
          m.vehicle &&
          (m.v ?? m.speed) < m.speed / 2 &&
          ((this.matchesCurve(m, before.from) &&
            this.cornerWithin(before, before.from, before.d, m)) ||
            (this.matchesCurve(m, before.from + before.dir) &&
              this.cornerWithin(
                before,
                before.from + before.dir,
                this.segment(before.from, before.from + before.dir) - before.d,
                m,
              )));
        if (!fits || correctingCurve) {
          if (!fits && m.kind === 'vehicle') {
            // Keep the checked bypass until its complete footprint has departed
            // this rejection. Recentering then uses the ordinary swept guard.
            this.blockedRestoration.set(m, {
              line: before.line,
              dir: before.dir,
              x: before.x,
              y: before.y,
              hx: before.hx,
              hy: before.hy,
            });
          }
          const ordinary = fits ? { ...m } : undefined,
            ordinaryMoved = moved;
          fits = false;
          // Vehicles creep; walkers also step aside, preferring the same side on successive
          // steps so detours don't oscillate. Each try is [side, share of the step].
          let tries = [
            [0, 0.5],
            [0, 0.25],
          ];
          if (m.kind === 'vehicle' && before.roadShift !== undefined) tries.unshift([0, 1]);
          let limit = 0;
          let steeringOrigin = before.roadShift ?? 0;
          const steeringSpeed = Math.min(ROAD_AVOID.steer, m.speed / this.perMeter / Math.SQRT2);
          if (
            m.kind === 'vehicle' &&
            !before.maneuver &&
            m.vehicle &&
            this.curvable[m.line] &&
            distance > 1e-8 * this.perMeter &&
            !intentionalHold &&
            this.scenes.transferable(m)
          ) {
            const vertex = this.cornerWithin(before, before.from, before.d, m)
                ? before.from
                : before.from + before.dir,
              corner = {
                x: this.geo.coords[vertex * 2]!,
                y: this.geo.coords[vertex * 2 + 1]!,
              },
              length =
                !before.curveCorner ||
                (before.curveCorner.x === corner.x && before.curveCorner.y === corner.y)
                  ? (before.curveLengthM ?? FILLET.maxM)
                  : FILLET.maxM,
              shape = this.corner(before, vertex, m),
              // Short mapped segments can cap the arc below its retained maximum.
              // Start at that cap so accepted retries actually change the physical pose.
              effective =
                shape &&
                (vertex === before.from
                  ? before.d <= shape.after
                  : this.segment(before.from, before.from + before.dir) - before.d <=
                    shape.before) &&
                Math.min(length, Math.min(shape.before, shape.after) / this.perMeter);
            if (effective && effective > 2) {
              const oldPose = (motionTrial.origin ??= this.pose(before, undefined, m));
              for (const share of [1, 0.25, 0]) {
                restoreMover(m, before);
                m.curveLengthM = Math.max(2, effective - dt * steeringSpeed);
                m.curveCorner = corner;
                moved = this.advance(m, distance * share, true, this.enteredExits);
                this.trialYaw(m, before, moved);
                const pose = this.pose(m),
                  spec = VEHICLES[m.vehicle];
                const cornerTravel =
                  Math.hypot(pose.x - oldPose.x, pose.y - oldPose.y) +
                  (Math.hypot(pose.hx - oldPose.hx, pose.hy - oldPose.hy) *
                    Math.hypot(spec.length, spec.width) *
                    this.perMeter) /
                    2;
                if (
                  this.corner(m, vertex) &&
                  cornerTravel > 1e-8 * this.perMeter &&
                  cornerTravel <= distance * share + dt * steeringSpeed * this.perMeter + 1e-8 &&
                  this.bodyCentresOwned(m, pass?.owns) &&
                  this.motionFits(
                    m,
                    before,
                    distance,
                    dt,
                    !!guard,
                    fitsGround,
                    rejected,
                    motionTrial,
                  )
                ) {
                  fits = true;
                  curveForward = Math.max(
                    0,
                    (pose.x - oldPose.x) * pose.hx + (pose.y - oldPose.y) * pose.hy,
                  );
                  break;
                }
              }
            }
          }
          if (!fits && ordinary) {
            restoreMover(m, ordinary);
            moved = ordinaryMoved;
            fits = true;
          }
          if (walking) {
            // Mapped sidewalk/path widths bound detours; unmeasured paths retain 1.5 m.
            const width = m.kind === 'dog' || m.kind === 'cat' ? animalSize(m.kind).width : 1;
            limit = Math.max(0, (this.geo.widths[m.line] || 4) / 2 - width / 2);
            const side = Math.sign(before.avoid ?? 0) || 1;
            tries = [
              [side, 0.5],
              [0, 0.5],
              [0, 0.25],
              [side, 0],
              [-side, 0.5],
              [-side, 0],
            ];
          } else if (
            m.kind === 'vehicle' &&
            !before.maneuver &&
            m.vehicle &&
            distance > 1e-8 * this.perMeter &&
            !intentionalHold &&
            this.scenes.transferable(m)
          ) {
            const side = before.roadSteering ?? (Math.sign(before.roadShift ?? 0) || -1);
            const spec = VEHICLES[m.vehicle];
            const effectiveShift =
              this.vehicleLane(before, before.line) -
              laneOffset(
                this.roadWidth(before.line),
                spec.width,
                before.chosenLane ?? before.lane,
                spec.curb,
                this.geo.oneway?.[before.line] ?? 0,
              ) -
              (before.lat ?? 0);
            if (Math.abs(effectiveShift - steeringOrigin) > 1e-8) {
              const behind = this.cornerWithin(before, before.from, before.d, m);
              const remaining = this.segment(before.from, before.from + before.dir) - before.d;
              const ahead = this.cornerWithin(before, before.from + before.dir, remaining, m);
              // A narrower road can clamp a retained shift well before its stored
              // value. Start retries at the same effective lane, so their first
              // increment moves. Active arcs keep both existing tangent offsets.
              if (!(behind && before.d <= behind.after) && !(ahead && remaining <= ahead.before))
                steeringOrigin = effectiveShift;
            }
            tries = [
              [side, 0.5],
              [side, 0],
              [side, -1],
              [-side, 0.5],
              [-side, 0],
              [-side, -1],
              ...tries,
            ];
          }
          for (const [side, share] of tries) {
            if (fits) break;
            restoreMover(m, before);
            if (walking) {
              m.avoid = Math.max(-limit, Math.min(limit, (before.avoid ?? 0) + side! * dt * 1.5));
              if (share === 0 && m.avoid === (before.avoid ?? 0)) continue;
              m.walked = (m.walked ?? 0) + (distance * share!) / this.perMeter;
            } else if (side) {
              const shiftLimit = this.geo.oneway?.[m.line] ? this.roadWidth(m.line) : 1;
              m.roadShift = Math.max(
                -shiftLimit,
                Math.min(shiftLimit, steeringOrigin + side * dt * steeringSpeed),
              );
              const lateral = Math.abs(this.offsetOf(m) - this.offsetOf(before, m));
              if (lateral < 1e-8 || lateral > dt * steeringSpeed + 1e-8) continue;
              // A retained shorter fillet must still fit both tangent offsets.
              // Losing it here would turn the next line transition into a jump.
              if (m.curveLengthM !== undefined && m.curveCorner) {
                const vertex = this.matchesCurve(m, m.from) ? m.from : m.from + m.dir;
                if (this.matchesCurve(m, vertex) && !this.corner(m, vertex)) continue;
              }
            }
            const retryLateral = before.maneuver
              ? this.proposeLateral(m, before, lateralBudget * share!, dt, share)
              : 0;
            if (!walking && share! < 0) {
              const retreat = Math.min(m.d, dt * this.perMeter * steeringSpeed);
              if (retreat <= 1e-8 * this.perMeter) continue;
              m.d -= retreat;
              this.advance(m, 0, false);
              moved = -retreat;
            } else
              moved = this.advance(
                m,
                Math.sqrt(Math.max(0, (distance * share!) ** 2 - retryLateral ** 2)),
                true,
                this.enteredExits,
              );
            this.trialYaw(
              m,
              before,
              moved,
              lateralBudget * Math.max(0, share!),
              dt * Math.max(0, share!),
            );
            if (side && !walking && !this.bodyCentresOwned(m, pass?.owns)) continue;
            if (
              (fits = this.motionFits(
                m,
                before,
                distance,
                dt,
                !!guard,
                fitsGround,
                rejected,
                motionTrial,
              ))
            ) {
              if (!walking && side) m.roadSteering = side as 1 | -1;
              break;
            }
          }
          if (
            !fits &&
            guard &&
            m.kind === 'vehicle' &&
            m.vehicle &&
            before.roadYaw &&
            distance > 1e-8 * this.perMeter &&
            !intentionalHold &&
            this.scenes.transferable(m)
          ) {
            // A retained steering angle can pin the nose before there is room
            // for the forward travel that normally straightens it. Rotate only
            // through the same swept guard and the remaining physical budget.
            restoreMover(m, before);
            const origin = this.pose(before, undefined, m);
            const radius = Math.hypot(VEHICLES[m.vehicle].length, VEHICLES[m.vehicle].width) / 2;
            const change = Math.min(Math.abs(before.roadYaw), (dt * steeringSpeed) / radius);
            m.roadYaw = before.roadYaw - Math.sign(before.roadYaw) * change;
            const pose = this.pose(m);
            const travel =
              Math.hypot(pose.x - origin.x, pose.y - origin.y) / this.perMeter +
              radius * Math.hypot(pose.hx - origin.hx, pose.hy - origin.hy);
            if (
              travel > 1e-8 &&
              travel <= (m.speed * dt) / this.perMeter + 1e-8 &&
              this.bodyCentresOwned(m, pass?.owns) &&
              fitsGround(m, before)
            ) {
              moved = 0;
              fits = true;
            }
          }
        }
        if (!fits) {
          restoreMover(m, before);
          moved = 0;
        } else if (m.kind === 'vehicle') this.clearPastCurve(m);
        if (m.kind === 'vehicle') this.finishLateral(m, before);
        if (walking && fits) m.walked = (before.walked ?? 0) + Math.max(0, moved) / this.perMeter;
        if (m.kind === 'vehicle' && !intentionalHold) {
          const refused = distance > 1e-8 * this.perMeter && (!fits || moved <= distance * 1e-6);
          m.terrainWait = refused && terrainRejected ? (before.terrainWait ?? 0) + dt : undefined;
          m.guardWait = refused ? (before.guardWait ?? 0) + dt : undefined;
        }
        const commanded = distance;
        let ordinaryForward = false;
        if (!guard) {
          m.waiting =
            !intentionalHold &&
            commanded > 1e-8 * this.perMeter &&
            Math.max(moved, curveForward) < commanded * 0.25
              ? (before.waiting ?? 0) + dt
              : 0;
        } else if (!intentionalHold && commanded > 1e-8 * this.perMeter) {
          let progress = this.blockedProgress.get(m);
          const afterPose =
            fits && progress && (walking || m.kind === 'vehicle') ? this.pose(m) : undefined;
          const previousPose = afterPose && (motionTrial.origin ?? this.pose(before, undefined, m));
          const forward =
            afterPose && previousPose
              ? (afterPose.x - previousPose.x) * m.hx + (afterPose.y - previousPose.y) * m.hy
              : 0;
          if (
            progress &&
            m.kind === 'vehicle' &&
            moved > commanded * 0.25 &&
            forward >= commanded * 0.25 &&
            m.hx * progress.hx + m.hy * progress.hy < 0.95
          ) {
            // Accepted forward travel after a mapped turn changes route intent.
            // Keep its blockage age until half a metre in that new direction;
            // refused, sideways-only and backward trials cannot rearm recovery.
            progress.x = previousPose!.x;
            progress.y = previousPose!.y;
            progress.hx = m.hx;
            progress.hy = m.hy;
          }
          if (
            progress &&
            walking &&
            !progress.ordinary &&
            !this.walkerRecoveryProgress.has(m) &&
            m.hx * progress.hx + m.hy * progress.hy < 0 &&
            forward >= commanded * 0.25
          ) {
            // An accepted ordinary reversal changes route intent. Keep the
            // blockage age until half a metre of checked new forward travel.
            progress.x = previousPose!.x;
            progress.y = previousPose!.y;
            progress.hx = m.hx;
            progress.hy = m.hy;
            progress.ordinary = true;
          }
          ordinaryForward =
            !!progress?.ordinary &&
            m.hx * progress.hx + m.hy * progress.hy > 0.95 &&
            forward >= commanded * 0.25;
          if (
            !progress &&
            (m.roadSteering !== undefined || Math.max(moved, curveForward) < commanded * 0.25)
          ) {
            const pose = this.pose(before, undefined, m);
            progress = { x: pose.x, y: pose.y, hx: before.hx, hy: before.hy };
            this.blockedProgress.set(m, progress);
          }
          const pose = progress && (afterPose ?? this.pose(m));
          if (
            progress &&
            pose &&
            (pose.x - progress.x) * progress.hx + (pose.y - progress.y) * progress.hy <
              0.5 * this.perMeter
          ) {
            m.waiting = (before.waiting ?? 0) + dt;
          } else {
            m.waiting = 0;
            if (progress) this.blockedProgress.delete(m);
            if (m.roadSteering !== undefined) m.roadSteering = undefined;
          }
        } else m.waiting = before.waiting ?? 0;

        const walledIn =
          forwardTerrainRejected &&
          (m.turnedAt === undefined ||
            (m.walked ?? 0) - m.turnedAt >= WALK_RECOVERY.terrainMinWalkM);
        if (
          (m.kind === 'person' || m.kind === 'dog') &&
          !m.crossingWait?.waiting &&
          (m.waiting >= WALK_RECOVERY.blockedTurnSeconds ||
            (m.kind === 'person' && walledIn && !m.momentFacing)) &&
          !this.walkerRecoveryProgress.has(m) &&
          !ordinaryForward &&
          this.recoverySearchReady(m, dt)
        ) {
          const accepted = snapshotMover(m);
          // Replace an unpublished sideways-only trial rather than adding a
          // retreat to a frame whose translation budget it already consumed.
          const snapshot = moved <= 1e-8 * this.perMeter ? snapshotMover(before) : accepted;
          snapshot.waiting = accepted.waiting;
          restoreMover(m, snapshot);
          const guardBefore = snapshot;
          const at = this.pose(snapshot, undefined, m),
            start = this.pose(before, undefined, m);
          const remaining = Math.max(
            0,
            speeds[i]! * dt - Math.hypot(at.x - start.x, at.y - start.y),
          );
          let recovered = false;
          let lastRetreat = -1;
          for (const metres of RECOVERY.walkerRetreats) {
            const retreat = Math.min(metres * this.perMeter, remaining);
            if (retreat === lastRetreat) continue;
            lastRetreat = retreat;
            restoreMover(m, snapshot);
            if (retreat > m.d) continue;
            m.d -= retreat;
            this.advance(m, 0, false);
            if (retreat && !fitsGround(m, guardBefore, false)) continue;
            const retreated = snapshotMover(m);
            const heading = m.momentFacing ?? { hx: m.hx, hy: m.hy };
            this.beginTurn(m);
            this.turnBack(m);
            m.avoid = -(m.avoid ?? 0);
            this.advance(m, 0, false);
            faceGroup(m, m.hx, m.hy, heading);
            if (fitsGround(m, retreated)) {
              m.walked = (snapshot.walked ?? 0) + retreat / this.perMeter;
              recovered = true;
              break;
            }
          }
          if (!recovered && m.kind === 'person') {
            // A curbside walker can back away while retaining its physical facing,
            // then take the guarded rotation once there is enough room for it.
            restoreMover(m, snapshot);
            const heading = m.momentFacing ?? { hx: m.hx, hy: m.hy };
            const retreat = Math.min(remaining, m.d);
            if (retreat > 0) {
              m.d -= retreat;
              this.advance(m, 0, false);
              if (!fitsGround(m, guardBefore, false)) restoreMover(m, snapshot);
            }
            this.turnBack(m);
            m.avoid = -(m.avoid ?? 0);
            this.advance(m, 0, false);
            m.momentFacing = { ...heading };
            recovered = fitsGround(m, guardBefore);
            if (recovered) {
              const at = this.pose(m),
                start = this.pose(snapshot, undefined, m);
              m.walked =
                (snapshot.walked ?? 0) + Math.hypot(at.x - start.x, at.y - start.y) / this.perMeter;
            }
          }
          if (recovered) {
            m.turnedAt = m.walked ?? 0;
            this.walkerRecoveryProgress.set(m, { travelled: 0, blocked: 0 });
            const pose = this.pose(m);
            this.blockedProgress.set(m, { x: pose.x, y: pose.y, hx: m.hx, hy: m.hy });
            env?.diagnostics?.recovery(m, 'walker');
          } else {
            restoreMover(m, accepted);
            this.recoverySearchRetry.set(m, RECOVERY.contactRetrySeconds);
          }
        }
        if (!fits && m.kind === 'cat') {
          m.pause = CAT.blockedPause;
          this.turnBack(m);
        }
        if (
          m.kind === 'vehicle' &&
          // An unsafe lateral return holds its accepted body until the sweep opens;
          // ordinary give-up recovery would abandon that reserved pose mid-maneuver.
          !m.maneuver &&
          m.waiting >= JUNCTION.giveUp &&
          !intentionalHold &&
          !pass?.recoveryAttempts?.has(m) &&
          distance > 1e-8 * this.perMeter
        ) {
          recoveredLines ??= new Set();
          if (this.recoverVehicle(m, fitsGround, table, recoveredLines, pass?.owns, dt)) {
            moved = 0;
            curveForward = 0;
            pass?.recovered?.(m);
            env?.diagnostics?.recovery(m, 'vehicle');
          }
        }
      }
      if (m.vehicle) {
        let travelled = Math.max(0, moved, curveForward);
        if (guard && m.kind === 'vehicle' && travelled > 0 && motionTrial.origin) {
          // Expanded curves and merges can use the whole physical budget with
          // less cursor travel. Do not brake again for that accepted distance;
          // a shorter inner arc retains the ordinary cursor pace.
          const pose = this.pose(m);
          travelled = Math.max(
            travelled,
            Math.hypot(pose.x - motionTrial.origin.x, pose.y - motionTrial.origin.y),
          );
        }
        m.v = travelled / dt;
      }
      const walkingRecovery = isWalker(m.kind) ? this.walkerRecoveryProgress.get(m) : undefined;
      this.recordFilterStep(m, before);
      if (walkingRecovery !== undefined) {
        if (moved > 0) {
          walkingRecovery.travelled += moved / this.perMeter;
          walkingRecovery.blocked = 0;
          if (walkingRecovery.travelled >= 0.5) this.walkerRecoveryProgress.delete(m);
        } else if (!intentionalHold && distance > 1e-8 * this.perMeter) {
          // An accepted reversal can have a blocked departure too. Allow
          // another checked recovery after a full eligible wait, rather than
          // requiring forward progress that the new obstacle makes impossible.
          walkingRecovery.blocked += dt;
          if (walkingRecovery.blocked >= WALK_RECOVERY.blockedTurnSeconds)
            this.walkerRecoveryProgress.delete(m);
        }
      }
      const recoveryProgress = m.kind === 'vehicle' ? this.recoveryProgress.get(m) : undefined;
      if (recoveryProgress !== undefined && moved > 0) {
        const travel = recoveryProgress + moved / this.perMeter;
        if (travel >= VEHICLES[m.vehicle!].length) this.recoveryProgress.delete(m);
        else this.recoveryProgress.set(m, travel);
      }
      if (env?.diagnostics && m.kind === 'person') {
        const width = this.geo.widths[m.line] || 4;
        if (Math.abs(m.avoid ?? 0) >= Math.max(0, width / 2 - 0.5) - 1e-8)
          env.diagnostics.tag(m, 'avoidanceLimit');
      }
      if (m.vehicle && (m.waiting ?? 0) > 0) this.motionStats.waiting++;
    }
    if (!shows || shows('person')) this.stepGatherers(dt, near, guard);
    if (!shows || shows('bird')) this.stepFlocks(dt, gustAt, near, env, observing);
    if (!this.crossingWaits.shared) this.crossingWaits.registry.resolve();
    if (!pass) this.finishEffects(clock, dt, env?.wind);
  }

  /** Trial heading is part of the body accepted by the guard, including retry and rollback. */
  private trialYaw(m: Mover, before: Mover, moved: number, lateralBudget = 0, lateralDt = 0) {
    if (m.kind === 'vehicle' && (m.maneuver || before.latYaw !== undefined)) {
      const forward = Math.abs(moved) / this.perMeter;
      const sideways = (m.lat ?? 0) - (before.lat ?? 0);
      const bound = Math.tan(Math.PI / 12);
      const target = forward > 1e-8 ? Math.max(-bound, Math.min(bound, sideways / forward)) : 0;
      let yaw = (before.latYaw ?? 0) + (target - (before.latYaw ?? 0)) * Math.min(1, forward * 1.5);
      if (
        Math.abs(yaw) <= 1e-3 &&
        m.maneuver?.kind !== 'filter' &&
        Math.abs(this.maneuverOffset(m) - this.offsetOf(m)) <= 1e-6 &&
        m.vehicle
      ) {
        const radius = Math.hypot(VEHICLES[m.vehicle].length, VEHICLES[m.vehicle].width) / 2;
        const remaining = Math.max(
          0,
          (before.speed * lateralDt) / this.perMeter - Math.hypot(forward, sideways),
        );
        if (radius * Math.abs(Math.atan(yaw)) <= remaining) yaw = 0;
      }
      if (
        forward <= 1e-8 &&
        m.vehicle &&
        (before.maneuver?.kind === 'return' ||
          (before.maneuver?.kind === 'lane' &&
            !before.maneuver.returning &&
            Math.abs(this.maneuverOffset(before) - this.offsetOf(before)) <= 1e-8))
      ) {
        const radius = Math.hypot(VEHICLES[m.vehicle].length, VEHICLES[m.vehicle].width) / 2;
        const remaining = Math.max(0, lateralBudget / this.perMeter - Math.abs(sideways));
        const angle = Math.atan(before.latYaw ?? 0);
        const change = Math.min(
          Math.abs(angle),
          remaining / radius,
          (LANE.lateral * lateralDt) / radius,
        );
        yaw = Math.tan(angle - Math.sign(angle) * change);
      }
      m.latYaw = Math.abs(yaw) > 1e-6 ? yaw : undefined;
    }
    m.roadYaw = before.roadYaw;
    if (
      !(m.kind === 'vehicle' && (m.roadShift !== undefined || before.roadYaw !== undefined)) &&
      !(isWalker(m.kind) && (m.avoid !== before.avoid || before.roadYaw !== undefined))
    )
      return;
    const forward = moved / this.perMeter;
    const sideways =
      m.kind === 'vehicle'
        ? (m.roadShift ?? 0) - (before.roadShift ?? 0)
        : (m.avoid ?? 0) - (before.avoid ?? 0);
    const target =
      forward > 1e-4
        ? Math.max(-2 * ROAD_AVOID.slope, Math.min(2 * ROAD_AVOID.slope, sideways / forward))
        : 0;
    const previous = before.roadYaw ?? 0;
    // Distance easing leaves stopped actors' headings unchanged.
    const yaw = previous + (target - previous) * Math.max(0, Math.min(1, forward * 1.5));
    m.roadYaw =
      (m.kind === 'vehicle' ? m.roadShift === undefined : !m.avoid) && Math.abs(yaw) < 1e-3
        ? undefined
        : yaw;
  }

  private pedestrianLimiter(
    dt: number,
    view?: PedestrianView,
    shows?: (kind: AgentKind) => boolean,
    near?: (x: number, y: number) => boolean,
    env?: LifeEnv,
  ): ((m: Mover, target: number) => { target: number; held: boolean }) | undefined {
    const localHumans = !shows || shows('person');
    // World occupancy can gain a returning person during scene stepping; keep its reader live.
    if (
      (!view || view.empty) &&
      (!localHumans || (!this.gatherers.length && !this.stalls.length))
    ) {
      let present = false;
      for (const m of this.movers)
        if (m.pedestrianHolds !== undefined || (localHumans && m.kind === 'person')) {
          present = true;
          break;
        }
      if (!present) return;
    }
    return (m, target) => {
      view ??= this.standalonePedestrians(shows, near, env);
      return view.empty && !m.pedestrianHolds
        ? { target, held: false }
        : this.pedestrianControl(m, target, view, dt);
    };
  }

  private standalonePedestrians(
    shows?: (kind: AgentKind) => boolean,
    near?: (x: number, y: number) => boolean,
    env?: LifeEnv,
  ): PedestrianView {
    if (shows && !shows('person')) return EMPTY_PEDESTRIANS;
    if (
      !this.movers.some((m) => m.kind === 'person') &&
      !this.gatherers.length &&
      !this.stalls.length
    )
      return EMPTY_PEDESTRIANS;
    const occupied = new Occupancy();
    const add = (owner: GroundAgent) => {
      if (near && !near(owner.x, owner.y)) return;
      const bodies = this.groundBodies(owner);
      occupied.set(owner, bodies);
    };
    for (const m of this.movers)
      if (
        m.kind === 'person' &&
        !this.scenes.hidden(m) &&
        (!env?.levels || m.rank < env.levels.person)
      )
        add(m);
    for (const g of this.gatherers) if (g.rank < gathererShare(g, env?.levels)) add(g);
    for (const s of this.stalls)
      if (s.open !== false && (!env?.levels || s.rank < env.levels.person)) add(s);
    return pedestrianView(occupied, 0);
  }

  /** Any physical member footprint reaches a junction's protected area. */
  junctionFootprint(m: Mover): boolean {
    return this.groundBodies(m).some((body) => {
      const dx = reach(body, 1, 0) * this.perMeter;
      const dy = reach(body, 0, 1) * this.perMeter;
      return this.junctionIndex.junctions.some(
        (junction) =>
          Math.abs(body.x * this.perMeter - junction.x) <= junction.radius + dx &&
          Math.abs(body.y * this.perMeter - junction.y) <= junction.radius + dy,
      );
    });
  }

  private bodyCentresOwned(
    m: Mover,
    owns?: (p: { x: number; y: number }) => boolean,
    bodies = this.groundBodies(m),
  ) {
    return bodies.every((body) => {
      const p = { x: body.x * this.perMeter, y: body.y * this.perMeter };
      return inTile(p) && (!owns || owns(p));
    });
  }

  /** Cooldown applies to failed selection only and advances on eligible simulation steps. */
  private recoverySearchReady(m: Mover, dt: number) {
    const left = (this.recoverySearchRetry.get(m) ?? 0) - dt;
    if (left > 1e-9) {
      this.recoverySearchRetry.set(m, left);
      return false;
    }
    this.recoverySearchRetry.delete(m);
    return true;
  }

  /** A recovery reverses a two-way road vehicle only through checked, source-owned space. */
  recoverVehicle(
    m: Mover,
    guard: GroundGuard,
    table: JunctionTable,
    lines: Set<number>,
    owns: ((p: { x: number; y: number }) => boolean) | undefined,
    dt: number,
  ): boolean {
    if (
      dt <= 0 ||
      m.kind !== 'vehicle' ||
      !m.vehicle ||
      this.geo.oneway?.[m.line] ||
      (lines.has(m.line) && !this.recoveryApproaches.has(m)) ||
      (this.recoveryLeaders.has(m.line) && this.recoveryLeaders.get(m.line) !== m) ||
      this.recoveryProgress.has(m)
    )
      return false;
    if (this.junctionFootprint(m)) return false;
    const before = { ...m };
    const sourceOwned = (previous = m) => {
      const bodies = this.groundBodies(m),
        oldBodies = this.groundBodies(previous);
      return (
        inTile(m) &&
        (!owns || owns(m)) &&
        this.bodyCentresOwned(m, owns, bodies) &&
        bodies.every((b, index) => {
          const old = oldBodies[index]!;
          const p = { x: b.x * this.perMeter, y: b.y * this.perMeter };
          const radius = (Math.hypot(b.length, b.width) * this.perMeter) / 2;
          return !this.junctionIndex.junctions.some(
            (j) =>
              Math.min(old.x * this.perMeter, p.x) - radius <= j.x + j.radius &&
              Math.max(old.x * this.perMeter, p.x) + radius >= j.x - j.radius &&
              Math.min(old.y * this.perMeter, p.y) - radius <= j.y + j.radius &&
              Math.max(old.y * this.perMeter, p.y) + radius >= j.y - j.radius,
          );
        })
      );
    };
    const reverse = () => {
      this.turnBack(m);
      m.curveLengthM = undefined;
      m.curveCorner = undefined;
      delete m.next;
      delete m.came;
      delete m.entered;
      delete m.junctionRoute;
      if (m.routing) m.routing = { seed: m.routing.seed, turns: m.routing.turns };
      this.advance(m, 0, false);
    };
    let candidate = this.recoveryApproaches.get(m);
    if (
      candidate &&
      (candidate.line !== m.line || candidate.from !== m.from || candidate.dir !== m.dir)
    ) {
      this.recoveryApproaches.delete(m);
      if (this.recoveryLeaders.get(candidate.line) === m)
        this.recoveryLeaders.delete(candidate.line);
      return false;
    }
    if (!candidate) {
      if (!this.recoverySearchReady(m, dt)) return false;
      // Reject-only whole-corridor inspection, including usable departure space.
      // The actual translation is executed in subsequent speed-bounded steps.
      for (const retreat of RECOVERY.retreats) {
        for (const shift of [...new Set([before.roadShift ?? 0, 0])]) {
          restoreMover(m, before);
          if (retreat * this.perMeter > m.d) continue;
          m.d -= retreat * this.perMeter;
          m.roadShift = shift;
          this.advance(m, 0, false);
          if (!sourceOwned(before) || !guard(m, before, false)) continue;
          const approach = { ...m };
          reverse();
          if (!sourceOwned(approach) || !guard(m, approach, false)) continue;
          const reversed = { ...m };
          const departure = VEHICLES[m.vehicle].length * this.perMeter;
          if (this.segment(m.from, m.from + m.dir) - m.d < departure) continue;
          this.advance(m, departure, false);
          if (!sourceOwned(reversed) || !guard(m, reversed, false)) continue;
          candidate = {
            line: before.line,
            from: before.from,
            dir: before.dir,
            d: approach.d,
            shift,
          };
          break;
        }
        if (candidate) break;
      }
      restoreMover(m, before);
      if (!candidate) {
        this.recoverySearchRetry.set(m, RECOVERY.contactRetrySeconds);
        return false;
      }
      this.recoveryApproaches.set(m, candidate);
    }
    if (this.recoveryLeaders.get(m.line) !== m) this.recoveryLeaders.set(m.line, m);
    lines.add(m.line);
    const rejected = () => {
      candidate.blocked = (candidate.blocked ?? 0) + dt;
      if (candidate.blocked >= RECOVERY.vehicleApproachSeconds - 1e-9) {
        this.recoveryApproaches.delete(m);
        if (this.recoveryLeaders.get(candidate.line) === m)
          this.recoveryLeaders.delete(candidate.line);
      }
      restoreMover(m, before);
      return false;
    };
    const dx = (candidate.d - m.d) / this.perMeter,
      dy = candidate.shift - (m.roadShift ?? 0);
    const distance = Math.hypot(dx, dy);
    const share = distance
      ? Math.min(1, (dt * Math.min(ROAD_AVOID.steer, m.speed / this.perMeter)) / distance)
      : 1;
    m.d += dx * this.perMeter * share;
    m.roadShift = (m.roadShift ?? 0) + dy * share;
    this.advance(m, 0, false);
    if (!sourceOwned(before) || !guard(m, before, false)) {
      return rejected();
    }
    if (share < 1) {
      candidate.blocked = 0;
      m.guardWait = undefined;
      m.terrainWait = undefined;
      guard(m, m);
      return false;
    }
    const approached = { ...m };
    reverse();
    if (!sourceOwned(approached) || !guard(m, approached)) {
      return rejected();
    }
    this.recoveryApproaches.delete(m);
    this.recoveryLeaders.delete(m.line);
    m.roadSteering = undefined;
    m.guardWait = undefined;
    m.terrainWait = undefined;
    table.release(m);
    lines.add(m.line);
    m.v = 0;
    m.waiting = before.waiting ?? 0;
    // Rearm only after sustained accepted travel clears the previous vehicle footprint.
    this.recoveryProgress.set(m, 0);
    const pose = this.pose(m);
    this.blockedProgress.set(m, { x: pose.x, y: pose.y, hx: m.hx, hy: m.hy });
    return true;
  }

  /**
   * Whether a step would take someone off the curb onto a crossing in front of a vehicle that
   * couldn't stop for them. One that can stop yields (pedestrians.ts), and they cross.
   */
  private trafficTooClose(m: Mover, distance: number): boolean {
    if (this.pedestrianCrossings.empty) return false;
    const pm = this.perMeter;
    const from = this.pose(m, this.pedestrianPose);
    const fx = from.x / pm,
      fy = from.y / pm;
    const crossings = this.pedestrianCrossings.entered(
      { x: fx, y: fy },
      { x: fx + (m.hx * distance) / pm, y: fy + (m.hy * distance) / pm },
    );
    if (!crossings.length) return false;
    const at: Pose = { x: 0, y: 0, hx: 0, hy: 0 };
    for (const c of crossings)
      for (const v of this.movers) {
        if (v.kind !== 'vehicle' || !v.vehicle || v.line !== c.line) continue;
        const speed = (v.v ?? v.speed) / pm;
        if (speed < WALK_GAP.movingMs) continue;
        this.pose(v, at);
        const ahead = (c.body.x - at.x / pm) * at.hx + (c.body.y - at.y / pm) * at.hy;
        const { length } = VEHICLES[v.vehicle];
        const stopping =
          (speed * speed) / (2 * kinematicsOf(v.vehicle).brake) + length / 2 + WALK_GAP.marginM;
        if (ahead > -length / 2 - c.body.length / 2 && ahead < stopping) return true;
      }
    return false;
  }

  /** A person starts turning round where they stand, from the way they face now. */
  private beginTurn(m: Mover) {
    if (m.kind !== 'person') return;
    const { hx, hy } = m.turning ? turningFacing(m.turning, m) : m;
    m.turning = { hx, hy, left: TURN_AROUND.seconds };
  }

  /** Turn a walker back where it stands: now heading for the vertex it was walking away from. */
  private turnBack(m: Mover) {
    const to = m.from + m.dir;
    m.d = this.segment(m.from, to) - m.d;
    m.from = to;
    m.dir = m.dir === 1 ? -1 : 1;
  }

  /** Frozen and seasonally hidden residents retain a burst slot until it ends. */
  private reconcileRush(): number {
    let count = 0;
    for (let pool = 0; pool < 2; pool++) {
      const movers = pool === 0 ? this.movers : this.suppressedGround?.movers.hidden;
      if (!movers) continue;
      for (let i = 0; i < movers.length; i++) {
        const m = movers[i]!;
        if ((m.rush ?? 0) <= 0) continue;
        if (
          this.scenes.raining ||
          m.kind !== 'vehicle' ||
          !RUSH_KINDS.has(m.vehicle!) ||
          this.scenes.visits.has(m) ||
          this.scenes.services.has(m) ||
          count >= DRIVE.rush.maxPerTile
        )
          m.rush = 0;
        else count++;
      }
    }
    return count;
  }

  /** Own random stream: admissions never perturb population, appearance or routing seeds. */
  private rushTick(m: Mover, dt: number, room: boolean) {
    if (this.scenes.raining || this.scenes.visits.has(m) || this.scenes.services.has(m)) {
      if (m.rush) m.rush = 0;
    } else if ((m.rush ?? 0) > 0) {
      m.rush = (m.waiting ?? 0) > 0 ? 0 : Math.max(0, m.rush! - dt);
    } else if (
      room &&
      (m.waiting ?? 0) <= 0 &&
      RUSH_KINDS.has(m.vehicle!) &&
      this.rushRng() < DRIVE.rush.chance * dt
    )
      m.rush = between(this.rushRng, DRIVE.rush.seconds);
  }

  /** Cancel a live run, reporting whether it occupied a running slot. */
  private stopRun(m: Mover): boolean {
    if ((m.run ?? 0) <= 0) return false;
    m.run = 0;
    return true;
  }

  /**
   * A random run's pace (config.ts `RUN`), or undefined while walking or in rain. Someone
   * walking alone now and then runs a few seconds while there is `room` (fewer than
   * `RUN.maxPerTile` in the tile running). A run ends early when held up or rain starts.
   */
  private runSpeed(m: Mover, dt: number, room: boolean): number | undefined {
    if (this.scenes.raining) {
      if (m.run) m.run = 0;
      return;
    }
    if ((m.run ?? 0) > 0) m.run = (m.waiting ?? 0) > 0 ? 0 : Math.max(0, m.run! - dt);
    else if (
      room &&
      (m.waiting ?? 0) <= 0 &&
      m.group?.length === 1 &&
      m.group[0]!.figure === 'adult' &&
      this.runRng() < RUN.chance * dt
    )
      m.run = between(this.runRng, RUN.seconds);
    return (m.run ?? 0) > 0 ? runPace(m, RUN.speed, this.perMeter) : undefined;
  }

  /**
   * A street dog (config.ts `DOG`): it stops to sniff, now and then lies down a long while,
   * turns back, and trots in short bursts.
   */
  private dogSpeed(m: Mover, dt: number, idle: boolean): number | undefined {
    const rng = this.dogRng;
    if (!idle) {
      m.pause = 0;
      m.lying = false;
    }
    if (m.pause > 0) {
      m.pause -= dt;
      if (m.pause <= 0) m.lying = false;
      return;
    }
    if (idle && rng() < DOG.lie.chance * dt) {
      m.pause = between(rng, DOG.lie.seconds);
      m.lying = true;
      return;
    }
    if (idle && rng() < DOG.pause.chance * dt) {
      m.pause = between(rng, DOG.pause.seconds);
      return;
    }
    if (idle && rng() < DOG.turnChance * dt) this.turnBack(m);
    if ((m.trot ?? 0) > 0) m.trot = m.trot! - dt;
    else if (rng() < DOG.trot.chance * dt) m.trot = between(rng, DOG.trot.seconds);
    return (m.trot ?? 0) > 0 ? Math.max(m.speed, DOG.trot.speed * this.perMeter) : m.speed;
  }

  /**
   * Where a flock goes next: a tree to land in (with its species' chance, life/birds.ts
   * `BirdSpec.perch`, or always if the tile has no roost), else a roost to circle, more likely
   * one of a habitat its species favors.
   */
  private pickDestination(flock: Flock, { prepare = true }: { prepare?: boolean } = {}) {
    delete flock.tapLanding;
    const roosts = this.geo.roosts.length / 2;
    const perches = this.geo.perches.length / 2;
    const spec = BIRD_SPECIES[flock.species];
    flock.stay = between(this.birdRng, BIRDS.stay);
    flock.landing = false;
    flock.feeding = false;
    flock.home = -1;
    flock.landingAttempted = false;
    flock.landingBlend = 0;
    if (perches > 0 && !spec.nocturnal && (roosts === 0 || this.birdRng() < spec.perch)) {
      flock.perch = Math.floor(this.birdRng() * perches);
    } else {
      flock.perch = -1;
      if (roosts > 1) flock.roost = this.pickRoost(flock.species, this.birdRng);
      if (roosts > 0 && spec.ground > 0 && this.birdRng() < spec.ground && prepare)
        this.prepareLanding(flock);
    }
  }

  /** Stage a complete safe layout before changing the flock or any of its bird identities. */
  flushFlock(flock: Flock, zoom = 19) {
    this.beginPointerTakeoff(flock);
    this.beginDeparture(flock);
    this.recordStartle(flock, this.emoji.observes(zoom));
    flock.perched = flock.landed = flock.landing = flock.feeding = false;
    flock.perch = flock.home = -1;
    flock.landingAttempted = false;
    flock.landingBlend = 0;
    flock.scatter = PERCH.scatter;
    delete flock.tapLanding;
    flock.stay = 20 + (flock.birds[0]?.phase ?? 0) * 10;
    let closest = Infinity;
    for (let i = 0; i < this.geo.roosts.length / 2; i++) {
      const distance = Math.hypot(
        this.geo.roosts[i * 2]! - flock.x,
        this.geo.roosts[i * 2 + 1]! - flock.y,
      );
      if (distance < closest) {
        closest = distance;
        flock.roost = i;
      }
    }
  }
  scatterFeed(at: Point, tap: LifeTap, clock: number) {
    const terrain = (this.forageTerrain ??= complete(
      prepareForageTerrainSteps(this.geo, this.perMeter, this.forageMode),
    ));
    if (!forageable('pigeon', Habitat.park, at.x, at.y, terrain, this.perMeter)) return false;
    this.tapFeed = {
      ...at,
      until: clock + 20,
      inhibited: tap.pointer === 'mouse',
      revision: tap.pointerRevision ?? 0,
      cellMeters: tap.cellMeters,
      seed: hashString(`${tap.at[0]}/${tap.at[1]}`),
    };
    return true;
  }
  /** Feed targets use fixed samples; saved tree-return anchors remain exact in prepareLanding. */
  prepareFeedLanding(flock: Flock, at: Point) {
    const spec = FORAGE_SPECIES[flock.species],
      terrain = this.forageTerrain;
    if (!spec || !terrain) return false;
    const habitat = (this.geo.roostHabitats[flock.roost] ?? Habitat.park) as Habitat;
    const ok = (p: Point) => {
      this.forageCheckCount++;
      return (
        forageable(flock.species, habitat, p.x, p.y, terrain, this.perMeter) &&
        (!this.forageGuard || this.forageGuard(p, p))
      );
    };
    const radius = Math.min(2, spec.patch) * this.perMeter;
    const center = feedSpot(at, radius, ok);
    if (!center) return false;
    const placements: Point[] = [];
    for (let i = 0; i < flock.birds.length; i++) {
      const bird = flock.birds[i]!,
        angle = bird.phase * 2 * Math.PI + i * 2.399963229728653;
      const desired = {
        x: center.x + Math.cos(angle) * radius * 0.5,
        y: center.y + Math.sin(angle) * radius * 0.5,
      };
      const fits = (p: Point) => Math.hypot(p.x - at.x, p.y - at.y) <= radius && ok(p);
      const p = fits(desired) ? desired : feedSpot(center, radius, fits, angle);
      if (!p) return false;
      placements.push({ x: p.x - center.x, y: p.y - center.y });
    }
    if (flock.perched || flock.landed) this.beginPointerTakeoff(flock);
    this.beginDeparture(flock);
    for (let i = 0; i < flock.birds.length; i++) {
      const bird = flock.birds[i]!,
        p = placements[i]!;
      bird.gx = bird.tx = p.x;
      bird.gy = bird.ty = p.y;
      bird.face = bird.phase * 2 * Math.PI;
      bird.wait = 0;
    }
    flock.lx = center.x;
    flock.ly = center.y;
    flock.landing = true;
    flock.tapLanding = true;
    flock.landingBlend = 0;
    flock.landed = flock.perched = false;
    flock.perch = -1;
    flock.home = -1;
    return true;
  }
  private prepareLanding(flock: Flock, preferred?: Point): boolean {
    flock.landingAttempted = true;
    const spec = FORAGE_SPECIES[flock.species];
    if (!spec || !this.geo.roosts.length) return false;
    const terrain = this.forageTerrain;
    if (!terrain) return false;
    const habitat = (this.geo.roostHabitats[flock.roost] ?? Habitat.park) as Habitat;
    const ok = (p: Point) => {
      this.forageCheckCount++;
      return (
        forageable(flock.species, habitat, p.x, p.y, terrain, this.perMeter) &&
        (!this.forageGuard || this.forageGuard(p, p))
      );
    };
    const origin = {
      x: this.geo.roosts[flock.roost * 2]!,
      y: this.geo.roosts[flock.roost * 2 + 1]!,
    };
    const centre = forageSpot(
      flock.species,
      habitat,
      origin,
      terrain,
      this.perMeter,
      this.forageRng,
      // A tree return retains the exact saved patch. An unsafe saved anchor declines the return.
      (p) => ok(p) && (!preferred || (p.x === preferred.x && p.y === preferred.y)),
      preferred,
    );
    if (!centre) return false;
    const patch = spec.patch * this.perMeter;
    const pickOffset = forageOffsets(
      flock.species,
      habitat,
      centre,
      terrain,
      this.perMeter,
      this.forageRng,
    );
    const placements: Point[] = [];
    for (const bird of flock.birds) {
      const turn = bird.phase * 6;
      let offset = {
        x: bird.ox * Math.cos(turn) - bird.oy * Math.sin(turn),
        y: bird.ox * Math.sin(turn) + bird.oy * Math.cos(turn),
      };
      const fits = (p: Point) =>
        ok({ x: centre.x + p.x, y: centre.y + p.y }) && Math.hypot(p.x, p.y) <= patch;
      if (!fits(offset)) {
        let found = false;
        for (let attempt = 0; attempt < FORAGE.attempts; attempt++) {
          const candidate = pickOffset();
          if (!candidate) continue;
          offset = candidate;
          if (fits(offset)) {
            found = true;
            break;
          }
        }
        if (!found) return false;
      }
      placements.push(offset);
    }
    for (let i = 0; i < flock.birds.length; i++) {
      const bird = flock.birds[i]!,
        p = placements[i]!;
      bird.gx = bird.tx = p.x;
      bird.gy = bird.ty = p.y;
      bird.face = bird.phase * 2 * Math.PI;
      bird.wait = 0;
    }
    flock.lx = centre.x;
    flock.ly = centre.y;
    flock.landing = true;
    delete flock.tapLanding;
    flock.landingBlend = 0;
    flock.landed = flock.perched = false;
    flock.perch = -1;
    return true;
  }

  /** Capture the visible layout before destination selection can replace ground offsets. */
  private beginDeparture(flock: Flock): void {
    if (!flock.landed && !flock.landing) return;
    const approach = flock.landed ? 1 : flock.landingBlend;
    const departure = flock.departureBlend ?? 0;
    const spread = flock.landed ? 1 : 1 + (3 * flock.scatter) / PERCH.scatter;
    for (const bird of flock.birds) {
      const turn = (flock.landed ? 0 : this.time * 0.8) + bird.phase * 6;
      const cos = Math.cos(turn) * spread,
        sin = Math.sin(turn) * spread;
      const ox = bird.ox * cos - bird.oy * sin,
        oy = bird.ox * sin + bird.oy * cos;
      let x = ox + ((bird.gx ?? ox) - ox) * approach,
        y = oy + ((bird.gy ?? oy) - oy) * approach;
      if (bird.departure && departure > 0) {
        x += (bird.departure.x - x) * departure;
        y += (bird.departure.y - y) * departure;
      }
      bird.departure = { x, y };
    }
    flock.departureBlend = 1;
  }

  private stepGroundFlock(flock: Flock, dt: number): void {
    const spec = FORAGE_SPECIES[flock.species];
    if (!spec) return;
    flock.bout -= dt;
    if (flock.bout <= 0) {
      flock.feeding = !flock.feeding;
      flock.bout = between(this.forageRng, flock.feeding ? spec.feed : spec.rest);
      if (!flock.feeding) {
        for (const bird of flock.birds)
          if (isForager(bird)) {
            bird.tx = bird.gx;
            bird.ty = bird.gy;
          }
        let nearest = -1,
          reach = FORAGE.reach * this.perMeter;
        if (spec.treeRest > 0 && this.geo.perches.length > 0 && this.forageRng() < spec.treeRest)
          for (let i = 0; i < this.geo.perches.length / 2; i++) {
            const distance = Math.hypot(
              this.geo.perches[i * 2]! - flock.x,
              this.geo.perches[i * 2 + 1]! - flock.y,
            );
            if (distance <= reach) {
              nearest = i;
              reach = distance;
            }
          }
        if (nearest >= 0) {
          this.beginDeparture(flock);
          flock.home = flock.roost;
          flock.landed = flock.perched = flock.landing = false;
          flock.perch = nearest;
          return;
        }
      }
    }
    if (!flock.feeding) return;
    const terrain = this.forageTerrain;
    if (!terrain) return;
    const habitat = (this.geo.roostHabitats[flock.roost] ?? Habitat.park) as Habitat;
    const context = this.forageContext;
    context.x = flock.x;
    context.y = flock.y;
    context.lx = flock.lx;
    context.ly = flock.ly;
    context.perMeter = this.perMeter;
    context.species = flock.species;
    context.habitat = habitat;
    context.terrain = terrain;
    for (const bird of flock.birds)
      if (isForager(bird)) stepForager(bird, spec, dt, this.forageRng, context);
    rebaseForagers(flock, flock.birds, spec.patch * this.perMeter);
  }

  /**
   * Whether someone out (below their kind's `levels`, if given) comes within a sitting flock's
   * `wary` distance (life/birds.ts): walking or driving by, a dog twice as far. People standing
   * still, sitting, and dogs lying down leave it be.
   */
  private disturbed(flock: Flock, levels?: Activity, folklore?: { x: number; y: number }): boolean {
    if (
      folklore &&
      Math.hypot(folklore.x - flock.x, folklore.y - flock.y) < FOLKLORE.flockRadius * this.perMeter
    )
      return true;
    const { wary } = BIRD_SPECIES[flock.species];
    if (wary <= 0) return false;
    const reach = wary * this.perMeter;
    const within = (x: number, y: number, r: number) =>
      (x - flock.x) ** 2 + (y - flock.y) ** 2 < r * r;
    for (const m of this.movers) {
      if (this.ownership && !this.ownership(m)) continue;
      if (levels && m.rank >= levels[m.kind]) continue;
      if (this.momentHost.moments.busy(m)) continue;
      if (m.pause > 0 && m.kind !== 'train') continue;
      if (within(m.x, m.y, m.kind === 'dog' ? 2 * reach : reach)) return true;
    }
    for (const g of this.gatherers) {
      if (this.momentHost.moments.busy(g)) continue;
      if (this.ownership && !this.ownership(g)) continue;
      if (g.behavior === 'sit' || g.pause > 0) continue;
      if (g.rank >= gathererShare(g, levels)) continue;
      if (within(g.x, g.y, reach)) return true;
    }
    return false;
  }

  /** A roost for a flock of `species`, weighted by how much it favors each one's habitat. */
  private pickRoost(species: BirdSpecies, rng: () => number): number {
    const { habitats } = BIRD_SPECIES[species];
    const kinds = this.geo.roostHabitats;
    const weight = (i: number) =>
      // Any roost now and then, so a flock is never stuck over one.
      0.1 + habitats[HABITAT_NAMES[kinds[i] ?? Habitat.park]!];
    let total = 0;
    for (let i = 0; i < kinds.length; i++) total += weight(i);
    let pick = rng() * total;
    for (let i = 0; i < kinds.length; i++) {
      pick -= weight(i);
      if (pick < 0) return i;
    }
    return kinds.length - 1;
  }

  /**
   * Move the flocks on. A sitting flock (in a tree, or on the ground) stays its while, unless a
   * gust through the crown or someone coming near flushes it; in the rain (`env`) it sits it out,
   * and flying flocks that perch head for the trees, those that land seek a safe ground patch. The
   * wind pushes circling flocks downwind, and faster round the downwind side. Bats flit.
   */
  private stepFlocks(
    dt: number,
    gustAt?: (x: number, y: number) => number,
    near?: (x: number, y: number) => boolean,
    env?: LifeEnv,
    observing = false,
  ) {
    const { roosts, perches } = this.geo;
    const count = roosts.length / 2;
    const sheltering = (env?.rain ?? 0) >= BIRD_WEATHER.shelter;
    // The wind, scaled by its strength, in tile axes.
    const wind = env?.wind;
    const wx = wind ? wind.dir[0] * wind.strength : 0;
    const wy = wind ? wind.dir[1] * wind.strength : 0;
    const folklore =
      env?.folkloreDisturber &&
      lngLatToTile(this.tile, env.folkloreDisturber.lng, env.folkloreDisturber.lat);
    let pointer: FlockPointer | undefined;
    this.birdFlightStep.dt = dt;
    if (env?.pointer) {
      pointer = this.flockPointer;
      const at = lngLatToTile(this.tile, ...env.pointer.lngLat);
      pointer.x = at.x;
      pointer.y = at.y;
      pointer.cellMeters = env.pointer.cellMeters;
      this.pointerInside ??= new WeakSet();
    }
    let feed = this.tapFeed;
    if (feed && (env?.emojiTime?.clock ?? env?.clock ?? this.time) >= feed.until)
      this.tapFeed = feed = undefined;
    if (feed?.inhibited && env?.tapPointer && env.tapPointer.revision > feed.revision) {
      const reach =
        Math.max(
          ...this.flocks
            .filter((f) => !!FORAGE_SPECIES[f.species])
            .map((f) => BIRD_SPECIES[f.species].wary + this.flockExtent(f) / this.perMeter),
          BIRD_POINTER.cells * feed.cellMeters,
        ) * this.perMeter;
      if (
        env.tapPointer.left ||
        (pointer && Math.hypot(pointer.x - feed.x, pointer.y - feed.y) > reach)
      )
        feed.inhibited = false;
    }
    for (const flock of this.flocks) {
      if (pointer) pointer.radius = undefined;
      if (near && !near(flock.x, flock.y) && !flyingBirdNear(flock, near)) continue;
      if (this.ownership && !this.ownership(flock)) continue;
      if (
        feed &&
        !feed.inhibited &&
        FORAGE_SPECIES[flock.species] &&
        !flock.landing &&
        !flock.landed &&
        !flock.takeoff &&
        flock.scatter <= 0 &&
        !flock.birds.some((b) => !!b.flight) &&
        Math.hypot(flock.x - feed.x, flock.y - feed.y) <= FORAGE.reach * this.perMeter &&
        (!pointer || !this.pointerNear(flock, pointer, feed, true))
      )
        this.prepareFeedLanding(flock, feed);
      if (flock.takeoff) {
        flock.takeoff.age += dt;
        if (flock.takeoff.age >= flock.takeoff.seconds) {
          delete flock.takeoff;
          for (const bird of flock.birds) delete bird.takeoff;
        }
      }
      if (flock.departureBlend)
        flock.departureBlend = Math.max(0, flock.departureBlend - dt / FORAGE.settleSeconds);
      const spec = BIRD_SPECIES[flock.species];
      const speed = spec.speed * this.perMeter;
      const sitting = flock.perched || flock.landed;
      if (pointer && !sitting && !flock.takeoff) this.beginBirdFlights(flock, pointer, observing);
      flock.scatter = Math.max(0, flock.scatter - dt);
      // Sitting out the rain, a flock doesn't count down its stay.
      const committed = flock.landing || (flock.home >= 0 && flock.perch >= 0 && !flock.perched);
      if (!(sheltering && sitting) && !committed) flock.stay -= dt;
      if (sitting) {
        const gust = flock.perched ? (gustAt?.(flock.x, flock.y) ?? 0) : 0;
        const pointerFlush = pointer ? this.pointerNear(flock, pointer) : false;
        if (pointerFlush) this.recordStartle(flock, observing);
        const flushed =
          gust >= PERCH.flush || this.disturbed(flock, env?.levels, folklore) || pointerFlush;
        if (flushed || (!sheltering && flock.stay <= 0)) {
          if (!flushed && flock.perched && flock.home >= 0) {
            flock.roost = flock.home;
            if (
              this.forageRng() < FORAGE.returnChance &&
              this.prepareLanding(flock, { x: flock.lx, y: flock.ly })
            ) {
              flock.home = -1;
              if (flock.flightBounds) this.stepBirdFlights(flock, pointer);
              continue;
            }
          }
          if (pointerFlush) this.beginPointerTakeoff(flock);
          this.beginDeparture(flock);
          flock.perched = false;
          flock.landed = false;
          if (flushed) flock.scatter = PERCH.scatter;
          this.pickDestination(flock, { prepare: !flushed });
          // Flushed, it keeps clear a while (circling a roost, or hovering where it is if the
          // tile has none) before settling again.
          if (flushed) {
            flock.perch = -1;
            flock.landing = false;
            flock.landingAttempted = false;
          }
        } else if (flock.landed && !sheltering) {
          this.stepGroundFlock(flock, dt);
        }
        if (flock.flightBounds) this.stepBirdFlights(flock, pointer);
        continue;
      }
      if (
        !committed &&
        flock.stay <= 0 &&
        (count > 1 || perches.length > 0 || (spec.ground > 0 && count > 0))
      ) {
        this.pickDestination(flock);
      }
      // Rain: those that perch head for the trees, those that land seek a safe ground patch.
      if (sheltering && flock.scatter === 0 && flock.perch < 0 && !flock.landing) {
        if (spec.perch > 0 && perches.length > 0) {
          flock.perch = Math.floor(this.birdRng() * (perches.length / 2));
        } else if (spec.ground > 0 && count > 0 && !flock.landingAttempted) {
          this.prepareLanding(flock);
        }
      }
      if (flock.landing)
        flock.landingBlend = Math.min(1, flock.landingBlend + dt / FORAGE.settleSeconds);
      // Flying to a tree or prepared ground patch: straight there, nudged downwind, then settle.
      let to =
        flock.perch >= 0
          ? { x: perches[flock.perch * 2]!, y: perches[flock.perch * 2 + 1]! }
          : flock.landing && (count > 0 || flock.tapLanding)
            ? { x: flock.lx, y: flock.ly }
            : undefined;
      if (pointer && to && this.pointerNear(flock, pointer, to, true)) {
        this.recordStartle(flock, observing);
        pointer.radius = undefined;
        this.beginDeparture(flock);
        flock.scatter = PERCH.scatter;
        this.pickDestination(flock, { prepare: false });
        flock.perch = -1;
        flock.landing = false;
        flock.landingAttempted = false;
        to = undefined;
      }
      if (to) {
        const dx = to.x - flock.x;
        const dy = to.y - flock.y;
        const distance = Math.hypot(dx, dy);
        const step = speed * 1.4 * dt;
        const detour =
          pointer && distance > step
            ? this.pointerDetour(flock, pointer, step, dx / distance, dy / distance)
            : undefined;
        if (detour) {
          flock.x += detour.x * step;
          flock.y += detour.y * step;
          [flock.hx, flock.hy] = [detour.x, detour.y];
        } else if (distance <= step) {
          if (pointer) pointer.radius = undefined;
          flock.x = to.x;
          flock.y = to.y;
          if (flock.perch >= 0) {
            flock.perched = true;
            if (flock.home >= 0)
              flock.stay = between(this.forageRng, FORAGE_SPECIES[flock.species]!.rest);
          } else if (flock.landingBlend === 1) {
            flock.landed = true;
            flock.landing = false;
            const forage = FORAGE_SPECIES[flock.species]!;
            flock.stay = between(this.forageRng, FORAGE.visit);
            flock.feeding = true;
            flock.bout = between(this.forageRng, forage.feed);
            for (const bird of flock.birds)
              if (isForager(bird)) {
                bird.tx = bird.gx;
                bird.ty = bird.gy;
                bird.face = this.forageRng() * 2 * Math.PI;
                bird.wait = between(this.forageRng, forage.peck);
              }
          }
        } else {
          // Less as it comes in, so it still arrives.
          const nudge = speed * 0.2 * dt * Math.min(1, distance / (20 * this.perMeter));
          flock.x += (dx / distance) * step + wx * nudge;
          flock.y += (dy / distance) * step + wy * nudge;
        }
        if (distance > 0 && !detour) [flock.hx, flock.hy] = [dx / distance, dy / distance];
        if (pointer) this.avoidPointer(flock, pointer, dt, speed, observing);
        if (flock.flightBounds) this.stepBirdFlights(flock, pointer);
        continue;
      }
      if (count === 0) {
        if (pointer) this.avoidPointer(flock, pointer, dt, speed, observing);
        if (flock.flightBounds) this.stepBirdFlights(flock, pointer);
        continue;
      }
      // Circle the roost, its circle pushed downwind; the flock's center chases the point on the
      // circle a little faster than it moves, so it catches up after moving on to another roost.
      const drift = BIRD_WEATHER.drift * this.perMeter;
      const along = -Math.sin(flock.angle) * wx + Math.cos(flock.angle) * wy;
      flock.angle += (speed / flock.radius) * dt * (1 + BIRD_WEATHER.push * Math.max(0, along));
      let radius = flock.radius;
      let jx = 0;
      let jy = 0;
      if (spec.nocturnal) {
        // Bats flit: the circle breathes, and they jink side to side.
        radius *= 1 + 0.3 * Math.sin(this.time * 2.3 + flock.rank * 17);
        jx = Math.sin(this.time * 7 + flock.rank * 31) * 2 * this.perMeter;
        jy = Math.cos(this.time * 5 + flock.rank * 23) * 2 * this.perMeter;
      }
      const tx = roosts[flock.roost * 2]! + wx * drift + Math.cos(flock.angle) * radius + jx;
      const ty = roosts[flock.roost * 2 + 1]! + wy * drift + Math.sin(flock.angle) * radius + jy;
      const dx = tx - flock.x;
      const dy = ty - flock.y;
      const distance = Math.hypot(dx, dy);
      const reach = Math.min(distance, speed * 1.4 * dt);
      if (distance > 0) {
        flock.x += (dx / distance) * reach;
        flock.y += (dy / distance) * reach;
        [flock.hx, flock.hy] = [dx / distance, dy / distance];
      }
      if (pointer) this.avoidPointer(flock, pointer, dt, speed, observing);
      if (flock.flightBounds) this.stepBirdFlights(flock, pointer);
    }
  }

  /** Nearby airborne birds retain their velocity and respond individually, without RNG draws. */
  private beginBirdFlights(flock: Flock, pointer: FlockPointer, observing: boolean) {
    const spec = BIRD_SPECIES[flock.species];
    const speed = spec.speed * this.perMeter * 1.4;
    const reach = Math.max(spec.wary, BIRD_POINTER.cells * pointer.cellMeters) * this.perMeter;
    const margin = birdFlightMargin(speed, BIRD_FLIGHT);
    const bound = this.flockBound(flock);
    const bounds = flock.flightBounds;
    if (
      (flock.x - pointer.x) ** 2 + (flock.y - pointer.y) ** 2 > (reach + margin + bound) ** 2 &&
      (!bounds ||
        pointer.x < bounds.minX - reach - margin ||
        pointer.x > bounds.maxX + reach + margin ||
        pointer.y < bounds.minY - reach - margin ||
        pointer.y > bounds.maxY + reach + margin)
    )
      return;
    const spread = birdSpread(flock);
    const wobble = this.time * 0.8;
    for (let i = 0; i < flock.birds.length; i++) {
      const bird = flock.birds[i]!;
      if (bird.flight) continue;
      birdOffset(flock, bird, birdTurn(flock, bird, wobble), spread, this.birdOffset);
      const x = flock.x + this.birdOffset.x;
      const y = flock.y + this.birdOffset.y;
      const distance2 = (x - pointer.x) ** 2 + (y - pointer.y) ** 2;
      if (distance2 >= (reach + margin) ** 2) continue;
      bird.flight = {
        x,
        y,
        hx: flock.hx,
        hy: flock.hy,
        speed,
        phase: (bird.phase + i * 0.61803398875) % 1,
      };
      flock.flightBounds ??= { minX: x, minY: y, maxX: x, maxY: y };
      if (distance2 < reach * reach) this.recordStartle(flock, observing);
    }
  }

  /** Follow independent escape curves, then rejoin the moving formation when the route is clear. */
  private stepBirdFlights(flock: Flock, pointer?: FlockPointer) {
    const step = this.birdFlightStep;
    const spec = BIRD_SPECIES[flock.species];
    step.speed = spec.speed * this.perMeter * 1.4;
    step.resting = flock.perched || flock.landed;
    if (pointer) {
      step.pointer = this.birdFlightPointer;
      step.pointer.x = pointer.x;
      step.pointer.y = pointer.y;
      step.pointer.reach =
        Math.max(spec.wary, BIRD_POINTER.cells * pointer.cellMeters) * this.perMeter;
    } else step.pointer = undefined;
    const bounds = flock.flightBounds!;
    bounds.minX = bounds.minY = Infinity;
    bounds.maxX = bounds.maxY = -Infinity;
    const spread = birdSpread(flock);
    const wobble = this.time * 0.8;
    for (const bird of flock.birds) {
      if (!bird.flight) continue;
      birdFormationOffset(flock, bird, birdTurn(flock, bird, wobble), spread, this.birdOffset);
      step.targetX = flock.x + this.birdOffset.x;
      step.targetY = flock.y + this.birdOffset.y;
      if (stepBirdFlight(bird.flight, step, BIRD_FLIGHT)) {
        delete bird.flight;
        continue;
      }
      bounds.minX = Math.min(bounds.minX, bird.flight.x);
      bounds.minY = Math.min(bounds.minY, bird.flight.y);
      bounds.maxX = Math.max(bounds.maxX, bird.flight.x);
      bounds.maxY = Math.max(bounds.maxY, bird.flight.y);
    }
    if (bounds.minX === Infinity) delete flock.flightBounds;
  }

  /** Preserve each bird's position through a staggered, smoothly accelerated mouse flush. */
  private beginPointerTakeoff(flock: Flock) {
    const spread = birdSpread(flock);
    const wobble = this.time * 0.8;
    let seconds = 0;
    let extent = 0;
    for (let i = 0; i < flock.birds.length; i++) {
      const bird = flock.birds[i]!;
      if (bird.flight) continue;
      const turn = birdTurn(flock, bird, wobble);
      birdOffset(flock, bird, turn, spread, this.birdOffset);
      // Existing phase plus slot identity separates even coincident birds without RNG draws.
      const reaction = (bird.phase + i * 0.61803398875) % 1;
      const delay = reaction * BIRD_TAKEOFF.stagger;
      const duration =
        BIRD_TAKEOFF.seconds[0] +
        (BIRD_TAKEOFF.seconds[1] - BIRD_TAKEOFF.seconds[0]) * ((reaction * 1.7) % 1);
      bird.takeoff = {
        x: flock.x + this.birdOffset.x,
        y: flock.y + this.birdOffset.y,
        delay,
        seconds: duration,
        face: isForager(bird) && flock.landed ? bird.face : bird.phase * 2 * Math.PI,
      };
      extent = Math.max(extent, Math.hypot(this.birdOffset.x, this.birdOffset.y));
      seconds = Math.max(seconds, delay + duration);
    }
    flock.takeoff = { x: flock.x, y: flock.y, age: 0, seconds, extent };
  }

  /** Rendered offsets are evaluated only near the mouse or its target. */
  private flockExtent(flock: Flock, formation = false) {
    const spread = birdSpread(flock);
    const wobble = this.time * 0.8;
    let extent = 0;
    for (const bird of flock.birds) {
      const turn = birdTurn(flock, bird, wobble);
      if (formation) birdFormationOffset(flock, bird, turn, spread, this.birdOffset);
      else birdOffset(flock, bird, turn, spread, this.birdOffset);
      extent = Math.max(extent, Math.hypot(this.birdOffset.x, this.birdOffset.y));
    }
    return extent;
  }

  /** Conservative formation envelope, including resting birds still waiting to take off. */
  private flockBound(flock: Flock) {
    const spec = BIRD_SPECIES[flock.species];
    let bound =
      Math.max(4 * spec.spread[1], 2 * (FORAGE_SPECIES[flock.species]?.patch ?? 0), PERCH.spread) *
      this.perMeter;
    if (flock.takeoff)
      bound = Math.max(
        bound,
        Math.hypot(flock.x - flock.takeoff.x, flock.y - flock.takeoff.y) + flock.takeoff.extent,
      );
    return bound;
  }

  private pointerRadius(flock: Flock, pointer: FlockPointer, target?: Point, destination = false) {
    const spec = BIRD_SPECIES[flock.species];
    const reach = Math.max(spec.wary, BIRD_POINTER.cells * pointer.cellMeters) * this.perMeter;
    const margin =
      flock.flightBounds && (!target || destination)
        ? birdFlightMargin(spec.speed * this.perMeter * 1.4, BIRD_FLIGHT)
        : 0;
    const bound = this.flockBound(flock);
    const distance2 = (flock.x - pointer.x) ** 2 + (flock.y - pointer.y) ** 2;
    if (
      distance2 > (reach + margin + bound) ** 2 &&
      (!target ||
        (target.x - pointer.x) ** 2 + (target.y - pointer.y) ** 2 > (reach + margin + bound) ** 2)
    )
      return 0;
    // The navigation anchor stays clear, while each independent bird steers around the mouse.
    return (
      (pointer.radius ??= reach + this.flockExtent(flock, flock.flightBounds !== undefined)) +
      margin
    );
  }

  private pointerNear(flock: Flock, pointer: FlockPointer, target?: Point, destination = false) {
    const radius = this.pointerRadius(flock, pointer, target, destination);
    const at = target ?? flock;
    return radius > 0 && (at.x - pointer.x) ** 2 + (at.y - pointer.y) ** 2 < radius ** 2;
  }

  private recordStartle(flock: Flock, observing: boolean) {
    if (observing && !this.startled.includes(flock)) this.startled.push(flock);
  }

  private avoidPointer(
    flock: Flock,
    pointer: FlockPointer,
    dt: number,
    speed: number,
    observing: boolean,
  ) {
    const radius = this.pointerRadius(flock, pointer);
    const dx = flock.x - pointer.x;
    const dy = flock.y - pointer.y;
    const distance2 = dx * dx + dy * dy;
    if (radius <= 0 || distance2 >= radius * radius) {
      this.pointerInside!.delete(flock);
      return;
    }
    if (!this.pointerInside!.has(flock)) this.recordStartle(flock, observing);
    this.pointerInside!.add(flock);
    const distance = Math.sqrt(distance2);
    const hx = distance > 1e-8 ? dx / distance : flock.hx;
    const hy = distance > 1e-8 ? dy / distance : flock.hy;
    const move = Math.min(radius - distance, BIRD_POINTER.flee * speed * 1.4 * dt);
    flock.x += hx * move;
    flock.y += hy * move;
    [flock.hx, flock.hy] = [hx, hy];
  }

  /** A blocked target leg spends its normal flight step tangentially instead of stalling. */
  private pointerDetour(
    flock: Flock,
    pointer: FlockPointer,
    step: number,
    hx: number,
    hy: number,
  ): Point | undefined {
    const radius = this.pointerRadius(flock, pointer);
    if (radius === 0) return;
    const dx = flock.x - pointer.x;
    const dy = flock.y - pointer.y;
    const distance2 = dx * dx + dy * dy;
    if (distance2 < radius * radius) {
      // Independent flyers need room to bank, even before the navigation anchor clears that margin.
      const physical = this.pointerRadius(flock, pointer, flock);
      if (!flock.flightBounds || distance2 < physical * physical || dx * hx + dy * hy >= 0) return;
    } else if ((dx + hx * step) ** 2 + (dy + hy * step) ** 2 >= radius * radius) return;
    const distance = Math.sqrt(distance2);
    const cross = dx * hy - dy * hx;
    const side = Math.abs(cross) > 1e-8 ? Math.sign(cross) : flock.rank < 0.5 ? 1 : -1;
    this.flockDetour.x = (-dy / distance) * side;
    this.flockDetour.y = (dx / distance) * side;
    return this.flockDetour;
  }

  /** Seconds simulated so far. */
  get elapsed() {
    return this.time;
  }
}

/** A train's cars to draw, front to back, each on the track behind the head. */
export function trainCars(life: TileLife, m: Mover): VisibleAgent[] {
  const { tile, perMeter } = life;
  const trail = [m.x, m.y, ...m.train!.trail];
  const out: VisibleAgent[] = [];
  let back = 0;
  for (const car of m.train!.cars) {
    const { length } = VEHICLES[car];
    const at = alongTrail(trail, (back + length / 2) * perMeter);
    back += length + TRAIN.coupling;
    if (!at) break;
    const [lng, lat] = tileToLngLat(tile, at);
    out.push({
      kind: 'train',
      lng,
      lat,
      ahead: tileToLngLat(tile, { x: at.x + at.hx * perMeter, y: at.y + at.hy * perMeter }),
      side: tileToLngLat(tile, { x: at.x - at.hy * perMeter, y: at.y + at.hx * perMeter }),
      vehicle: car,
      paint: m.paint,
      flap: 0,
    });
  }
  return out;
}

/** An agent to draw. */
export type VisibleAgent = {
  beacon?: Beacon;
  /** Source provenance, stable through holds; only ordinary mapped person movers set this. */
  mappedPersonMover?: boolean;
  /** Serializable event membership for discarding a superseded formation on host commands. */
  event?: true;
  emoji?: EmojiCue;
  /** Assigned only in item mode; global fallback keeps the ordinary agent shape. */
  inspectionId?: number;
  /** Candle clock token: running offset >= 0, held time encoded as -time - 2. */
  effectClock?: number;
  /** Stable candle-pool phase seed in per-item mode. */
  candleSeed?: number;
  speech?: SpeechCue;
  /** A transient airborne ball, packed before the ordinary person figure dispatch. */
  prop?: 'ball' | 'event';
  eventGround?: string;
  eventRole?: 'altar' | 'seated';
  eventFootprint?: { length: number; width: number };
  eventScenery?: boolean;
  glyph?: string;
  /** Cars of a train are admitted together under the visible-agent cap. */
  consist?: object;
  covered?: boolean;
  kind: AgentKind;
  lng: number;
  lat: number;
  /** A point 1 m ahead, for the heading on screen (movers only). */
  ahead?: [number, number];
  /**
   * Vehicles and boats: a point 1 m to the right, for their width on screen; their kind and
   * paint; and whether it is parked (lamps off).
   */
  side?: [number, number];
  vehicle?: CraftType;
  paint?: number;
  parked?: boolean;
  /** Detailed motor vehicles only: local side and simulation-clock blink phase. */
  turnSignal?: TurnSignal;
  lamps?: VehicleLamps;
  /** People: holding a candle (lit at dusk and night). */
  candle?: boolean;
  /**
   * People walking together, or a vendor beside their cart (life/draw.ts `drawPeople`). Without
   * it, a person is one adult in `paint` (or the theme's person color), stepping with `flap`.
   */
  people?: readonly PersonLook[];
  /** People in a boat (a procession's paddlers): drawn over the water, not on land. */
  aboard?: boolean;
  /** Paddlers: at the reach (0) or the pull (1) of their stroke (life/people.ts). */
  stroke?: 0 | 1;
  /**
   * A line over the water instead of a boat (life/draw.ts `drawLine`): a rope or a pole, as
   * [lng, lat] points, its cells painted in turn from `paints`, and a glyph at its tip.
   */
  line?: LifeLineShape;
  /** Birds: which wing glyph (0 or 1). */
  flap: number;
  /** Birds: their species and pose (life/birds.ts); `ahead` is where they face. */
  bird?: { species: BirdSpecies; pose: BirdPose };
};

export type LifeTile = { key: string; tile: TileId; life: LifeGeometry };
type LifeHistory = { ceded: TileId[]; quotas: Partial<Record<Mover['kind'], number>> };
type LifeDonor = {
  key: string;
  life: TileLife;
  masks: readonly TileId[];
  movers: readonly Mover[];
};

/** The weather people react to: how hard it rains (0–1) and the sun's altitude (degrees). */
export type LifeWeather = { rain: number; sunAltitude: number };

/** Every tile's agents: kept in step with the tiles on screen. */
/** A line the life layer draws over the water (`VisibleAgent.line`). */
export type LifeLineShape = {
  points: readonly [number, number][];
  paints: readonly number[];
  tip?: { glyph: string; paint: number };
};

/** The procession under way: which, how far through (0–1), and whether it is the live one. */
export type ProcessionRun = { id: string; progress: number; live: boolean; time?: EventTime };

type GroundTerrain = {
  key: string;
  seasonalKey: string;
  blocked: PolygonIndex;
  hardBlocked: PolygonIndex;
  vehicleBlocked: PolygonIndex;
  seasonal: PolygonIndex;
  water: PolygonIndex;
  roadAccess: RoadAccess;
  trees: PolygonIndex;
  origins: Map<TileLife, { x: number; y: number; scale: number }>;
  ref?: TileLife;
};
export class LifeWorld {
  private signalPresses?: SignalPresses;
  get signalOffsets(): SignalOffsets | undefined {
    return this.signalPresses?.snapshot();
  }
  private tapSignal(tap: LifeTap) {
    if (!tap.signal) return false;
    for (const life of this.tiles.values()) {
      const signal = life.signals.signals.find(
        (s) => s.seed === tap.signal!.seed && s.a < 0 === tap.signal!.midBlock,
      );
      if (!signal) continue;
      const midBlock = signal.a < 0;
      const presses = (this.signalPresses ??= new SignalPresses());
      const before = signalState(signal.seed, this.clock, midBlock, presses.offsets);
      if (presses.press(signal.seed, midBlock, this.clock)) {
        let count = 0;
        for (const tile of this.tiles.values()) {
          tile.signals.offsets = presses.offsets;
          tile.crossingWaits.signalOffsets = presses.offsets;
          for (const m of tile.movers)
            if (
              (before.a === 'green' || before.b === 'green') &&
              count < 4 &&
              m.kind === 'vehicle' &&
              this.owns(tile, m) &&
              tile.signals.caught(m, signal.seed, midBlock, this.clock)
            ) {
              tile.requestEmoji(m, 'driver', 'angry', this.emojiClock);
              count++;
            }
        }
      }
      return true;
    }
    return false;
  }
  private barkUntil?: WeakMap<Mover, number>;
  tapSources?: TapSources;
  tapReceipts?: readonly TapReceipt[];
  enableTaps() {
    this.tapSources ??= new TapSources();
  }
  private tapOwner(owner: object) {
    for (const life of this.tiles.values()) {
      const mover = life.movers.find((m) => m === owner);
      if (mover) return { life, mover };
    }
  }
  private tapPerson(owner: object) {
    for (const life of this.tiles.values()) {
      const person =
        life.movers.find((m) => m === owner && m.kind === 'person') ??
        life.gatherers.find((g) => g === owner);
      if (person) return { life, person };
    }
  }
  private eventTaps?: EventTaps;
  private syncEventTaps(create = false) {
    if (!create && !this.eventTaps) return;
    const run = this.procession();
    const scope = run && `${run.id}/${this.eventScope(run)}`;
    if (this.eventTaps && this.eventTaps.scope !== scope) {
      this.eventTaps.clear();
      this.eventTaps = undefined;
    }
    if (create && scope)
      this.eventTaps ??= new EventTaps(
        scope,
        this.momentOptions,
        this.emojiMemory,
        this.emojiObserver,
        this.scenes.get(run.id)!.route.kind,
      );
    return this.eventTaps;
  }
  private stepEventTaps(dt: number, zoom = 19) {
    const state = this.syncEventTaps();
    if (!state) return;
    const visible = new Set(
      (this.tapSources?.latest() ?? []).flatMap((t) => (t?.agent.event ? [t.owner] : [])),
    );
    state.step(dt, zoom, this.emojiClock, visible);
    if (state.idle) {
      state.clear();
      this.eventTaps = undefined;
    }
  }
  private tapProcession(tap: LifeTap, minutes: number, zoom: number) {
    if (!this.procession()) return false;
    const targets = this.tapSources?.read(tap)?.targets ?? [];
    const distance = (agent: VisibleAgent) => {
      return (
        (Math.hypot(
          (agent.lng - tap.at[0]) * Math.cos((tap.at[1] * Math.PI) / 180),
          agent.lat - tap.at[1],
        ) *
          MERCATOR_METERS) /
        360
      );
    };
    if (
      !targets.some(
        (t) =>
          t?.agent.event &&
          (t.agent.vehicle === 'pagoda' || t.agent.glyph === ProcessionGlyph.andas) &&
          distance(t.agent) <= 6 * tap.cellMeters,
      )
    )
      return tap.crowd === true;
    if (zoom < MOMENTS.zoom) return true;
    const seen = new Set<object>();
    const crowd = targets
      .flatMap((target, index) => {
        if (
          !target?.agent.event ||
          target.agent.kind !== 'person' ||
          target.agent.prop ||
          target.agent.vehicle ||
          target.agent.aboard ||
          seen.has(target.owner)
        )
          return [];
        seen.add(target.owner);
        return [{ target, index, distance: distance(target.agent) }];
      })
      .sort((a, b) => a.distance - b.distance || a.index - b.index)
      .slice(0, 8);
    const state = this.syncEventTaps(true)!;
    for (const { target } of crowd) state.react(target.owner, this.emojiClock, 'festive', 3);
    for (const { target } of crowd)
      if (state.request(target, this.emojiClock, minutes, 'procession-cheer')) break;
    return true;
  }
  private tapPeople(
    tap: LifeTap,
    reach: number,
    cap: number,
    mood: EmojiMood,
    duration = 2.5,
    eligible?: (target: TapTarget) => boolean,
  ) {
    const ref = this.tiles.values().next().value;
    if (!ref) return;
    const at = lngLatToTile(ref.tile, ...tap.at),
      seen = new Set<object>();
    const people = (this.tapSources?.latest() ?? [])
      .flatMap((target, index) => {
        if (
          !target ||
          target.agent.kind !== 'person' ||
          target.agent.vehicle ||
          target.agent.prop ||
          target.agent.aboard ||
          (eligible && !eligible(target)) ||
          seen.has(target.owner)
        )
          return [];
        seen.add(target.owner);
        const p = lngLatToTile(ref.tile, target.agent.lng, target.agent.lat),
          distance = Math.hypot(p.x - at.x, p.y - at.y) / ref.perMeter;
        return distance <= reach ? [{ target, distance, index }] : [];
      })
      .sort((a, b) => a.distance - b.distance || a.index - b.index)
      .slice(0, cap);
    for (const { target } of people) {
      const person = this.tapPerson(target.owner);
      person?.life.requestEmoji(target.owner, 'person', mood, this.emojiClock, duration);
    }
  }
  private tapAgent(target: TapTarget, minutes = 720, zoom = 19, rain = 0) {
    if (target.agent.vehicle === 'cart') {
      for (const life of this.tiles.values()) {
        const stall = [...life.allStalls()].find((s) => s === target.owner);
        if (!stall) continue;
        if (stall.open === false || rain >= MOMENTS.rain) return;
        const visible = new Set(
          this.tapSources?.latest().flatMap((t) => (t ? [t.owner] : [])) ?? [],
        );
        if (
          !life.scenes.purchase(
            stall,
            life.movers.filter((m) => visible.has(m) && this.owns(life, m)),
          )
        )
          life.requestEmoji(stall, 'person', 'wave', this.emojiClock);
        return;
      }
    }
    if (target.agent.kind === 'person' && !target.agent.vehicle && zoom >= MOMENTS.zoom) {
      if (target.agent.event && !target.agent.prop) {
        const state = this.syncEventTaps(true);
        if (state?.request(target, this.emojiClock, minutes, 'greeting'))
          state.react(target.owner, this.emojiClock, 'wave', 2.5);
        return;
      }
      for (const life of this.tiles.values()) {
        const person =
          life.movers.find((m) => m === target.owner && m.kind === 'person') ??
          life.gatherers.find((g) => g === target.owner);
        if (!person) continue;
        if (life.momentHost.sceneHost.request(person, this.emojiClock, minutes))
          life.requestEmoji(person, 'person', 'wave', this.emojiClock, 2.5, 0, 8);
        return;
      }
    }
    const owned = this.tapOwner(target.owner);
    if (!owned) return;
    const { life, mover } = owned;
    if (mover.kind === 'dog' || mover.kind === 'cat') {
      if (mover.lying || mover.pause > 0) {
        life.wake(mover, this.clock);
        life.requestEmoji(mover, mover.kind, 'yawn', this.emojiClock);
      } else if (mover.kind === 'dog' && !((this.barkUntil?.get(mover) ?? 0) > this.emojiClock)) {
        const dogs = life.movers
          .map((m, index) => ({ m, index, distance: Math.hypot(m.x - mover.x, m.y - mover.y) }))
          .filter(
            ({ m, distance }) =>
              m.kind === 'dog' &&
              distance <= 40 * life.perMeter &&
              !((this.barkUntil?.get(m) ?? 0) > this.emojiClock),
          )
          .sort(
            (a, b) =>
              Number(b.m === mover) - Number(a.m === mover) ||
              a.distance - b.distance ||
              a.m.rank - b.m.rank ||
              a.index - b.index,
          )
          .slice(0, 6);
        this.barkUntil ??= new WeakMap();
        dogs.forEach(({ m }, index) => {
          const delay = index === 0 ? 0 : 0.4 + ((index - 1) * 0.8) / Math.max(1, dogs.length - 2);
          this.barkUntil!.set(m, this.emojiClock + delay + 2.5);
          life.requestEmoji(m, 'dog', 'bark', this.emojiClock, 2.5, delay);
        });
      }
      return;
    }
    if (mover.kind !== 'vehicle' && !mover.train) return;
    life.requestEmoji(mover, 'driver', 'honk', this.emojiClock);
    const at = mover.train
      ? life.pose(mover)
      : lngLatToTile(life.tile, target.agent.lng, target.agent.lat);
    const forward = mover.train
      ? { x: at.x + mover.hx, y: at.y + mover.hy }
      : lngLatToTile(life.tile, ...(target.agent.ahead ?? [target.agent.lng, target.agent.lat]));
    const distance = Math.hypot(forward.x - at.x, forward.y - at.y) || 1;
    const hx = (forward.x - at.x) / distance,
      hy = (forward.y - at.y) / distance;
    const seen = new Set<object>();
    let count = 0;
    for (const candidate of this.tapSources?.latest() ?? []) {
      if (
        !candidate ||
        candidate.agent.kind !== 'person' ||
        candidate.agent.vehicle ||
        seen.has(candidate.owner)
      )
        continue;
      seen.add(candidate.owner);
      const p = lngLatToTile(life.tile, candidate.agent.lng, candidate.agent.lat);
      const dx = p.x - at.x,
        dy = p.y - at.y;
      const ahead = (dx * hx + dy * hy) / life.perMeter;
      const side = Math.abs(dx * hy - dy * hx) / life.perMeter;
      if (ahead < 0 || ahead > 25 || side > (mover.train ? 8 : 3)) continue;
      const person = this.tapOwner(candidate.owner);
      if (!person || person.life.scenes.visits.has(person.mover)) continue;
      person.life.hurry(person.mover, this.clock);
      person.life.requestEmoji(person.mover, 'person', 'rushing', this.emojiClock);
      if (++count >= 8) break;
    }
  }
  private tapTree(tap: LifeTap, zoom: number) {
    let selected: { life: TileLife; flock: Flock; distance: number } | undefined;
    for (const life of this.tiles.values()) {
      const at = lngLatToTile(life.tile, ...tap.at);
      for (const flock of life.flocks) {
        if (!flock.perched || !this.owns(life, flock)) continue;
        const distance = Math.hypot(flock.x - at.x, flock.y - at.y) / life.perMeter;
        if (distance <= 1.5 * tap.cellMeters && (!selected || distance < selected.distance))
          selected = { life, flock, distance };
      }
    }
    if (!selected) return false;
    const perch = selected.flock.perch;
    for (const flock of selected.life.flocks)
      if (flock.perched && flock.perch === perch && this.owns(selected.life, flock))
        selected.life.flushFlock(flock, zoom);
    return true;
  }
  private tapRice(tap: LifeTap) {
    for (const life of this.tiles.values()) {
      const at = lngLatToTile(life.tile, ...tap.at);
      if (inTile(at) && this.owns(life, at)) return life.scatterFeed(at, tap, this.emojiClock);
    }
    return false;
  }
  private resolveTaps(taps: readonly LifeTap[] | undefined, minutes = 720, zoom = 19, rain = 0) {
    this.tapReceipts =
      taps?.length && this.tapSources
        ? taps.slice(0, 4).map((tap) =>
            resolveTap(tap, this.tapSources!, {
              folklore: (id, tap) => {
                if (!this.folklore.tap(id, this.emojiClock)) return false;
                this.tapPeople(tap, 10, 6, 'scared');
                return true;
              },
              agent: (target) => this.tapAgent(target, minutes, zoom, rain),
              signal: (tap) => this.tapSignal(tap),
              procession: (tap) => this.tapProcession(tap, minutes, zoom),
              carnival: (tap) => this.tapPeople({ ...tap, at: tap.carnival!.at }, 15, 8, 'party'),
              candle: (tap) => {
                if (!this.seasonalConfig?.visitors) return;
                this.tapPeople({ ...tap, at: tap.candle!.at }, 6, 8, 'pray', 2.5, (target) => {
                  const person = this.tapPerson(target.owner)?.person;
                  return !!person && 'seasonal' in person && person.seasonal === 'visitors';
                });
              },
              tree: (tap) => this.tapTree(tap, zoom),
              rice: (tap) => this.tapRice(tap),
            }),
          )
        : undefined;
  }
  private readonly folklore: FolkloreObserver;
  setFolklore(config: RuntimeFolklore | undefined) {
    this.folklore.setConfig(config);
  }
  visibleFolklore(zoom: number, center: readonly [number, number]) {
    return this.folklore.packet(zoom, center);
  }
  private sampleFolklore(
    weather: Pick<LifeEnv, 'minutes' | 'folkloreDate'> | undefined,
    dt: number,
  ) {
    if (!this.folklore.configured) return;
    const sources = [...this.tiles].map(([key, life]) => ({
      key,
      tile: life.tile,
      geo: life.geo,
      perMeter: life.perMeter,
      owns: (p: { x: number; y: number }) => this.owns(life, p),
    }));
    this.folklore.step(
      sources,
      { minutes: weather?.minutes, calendar: weather?.folkloreDate, clock: this.emojiClock, dt },
      (geometry, ghosts) => {
        const bodies: FolkloreBody[] = [],
          pose: Pose = { x: 0, y: 0, hx: 0, hy: 0 };
        const minX = Math.min(...ghosts.map((p) => p.x)),
          maxX = Math.max(...ghosts.map((p) => p.x)),
          minY = Math.min(...ghosts.map((p) => p.y)),
          maxY = Math.max(...ghosts.map((p) => p.y));
        for (const life of this.tiles.values()) {
          const frame = frameBetween(life.tile, geometry.ref.tile),
            scale = frame.scale / geometry.ref.perMeter;
          for (const m of life.movers) {
            if (
              (m.kind !== 'person' && m.kind !== 'vehicle') ||
              !inTile(m) ||
              !this.owns(life, m) ||
              !life.visibleMover(m, this.lastLevels, this.lastCrowd)
            )
              continue;
            const p = life.pose(m, pose),
              x = frame.x / geometry.ref.perMeter + p.x * scale,
              y = frame.y / geometry.ref.perMeter + p.y * scale,
              size = m.vehicle ? VEHICLES[m.vehicle] : undefined;
            const length = size?.length ?? 0.6,
              width = size?.width ?? 0.5,
              reach = Math.max(
                m.kind === 'person' ? 3 : 0,
                Math.hypot(length / 2 + 0.35, width / 2 + 0.35),
              );
            // Filter the posed center, including lane/curve displacement and any body rotation.
            if (x + reach < minX || x - reach > maxX || y + reach < minY || y - reach > maxY)
              continue;
            bodies.push({
              x,
              y,
              hx: p.hx,
              hy: p.hy,
              length,
              width,
              walker: m.kind === 'person',
            });
          }
        }
        return bodies;
      },
    );
  }
  private emergencyConfig?: EmergencyConfig;
  emergencyRouter?: EmergencyRouter;
  emergencyDispatch?: EmergencyDispatch;
  private emergencyRegions?: readonly (readonly [number, number])[];
  private emergencyOwners(): EmergencyOwner[] {
    const owners: EmergencyOwner[] = [],
      seen = new Set<Mover>();
    for (const life of new Set([
      ...this.tiles.values(),
      ...[...this.retired.values()].map((r) => r.life),
    ]))
      for (const mover of [...life.residentMovers(), ...life.pending.map((p) => p.mover)])
        if (mover.emergency && !seen.has(mover)) {
          seen.add(mover);
          owners.push({ life, mover });
        }
    return owners;
  }
  private activityNear(life: TileLife, bounds: LngLatBounds | undefined, margin: number) {
    const ordinary = viewIn(life.tile, bounds, margin);
    if (!this.emergencyDispatch || !this.emergencyRegions?.length) return ordinary;
    const centers = this.emergencyRegions.map((p) => lngLatToTile(life.tile, ...p)),
      radius = 120 * life.perMeter;
    return (x: number, y: number) =>
      ordinary(x, y) || centers.some((p) => Math.hypot(x - p.x, y - p.y) <= radius);
  }
  private releaseEmergency({ life, mover }: EmergencyOwner) {
    this.junctions.release(mover);
    this.inspection?.forgetOwner(mover, this.clock);
    life.release(mover);
    this.emergencyDispatch?.release(mover);
  }

  configureEmergency(config?: EmergencyConfig, data?: EmergencyData) {
    if (!config && !data && !this.emergencyConfig && !this.emergencyRouter) return;
    this.emergencyConfig = config;
    this.setEmergency(data);
  }
  /** Optional geography changes preserve ordinary populations and static terrain. */
  setEmergency(data?: EmergencyData) {
    const lives = [
      ...this.tiles.values(),
      ...[...this.retired.values()].map((entry) => entry.life),
    ];
    for (const life of lives) {
      for (const mover of [...life.residentMovers()])
        if (mover.emergency) {
          this.junctions.release(mover);
          this.inspection?.forgetOwner(mover, this.clock);
          life.release(mover);
        }
      for (let i = life.pending.length - 1; i >= 0; i--)
        if (life.pending[i]!.mover.emergency) life.pending.splice(i, 1);
    }
    const config = this.emergencyConfig;
    this.emergencyRouter = undefined;
    this.emergencyDispatch = undefined;
    this.emergencyRegions = undefined;
    if (
      config &&
      (config.ambulance?.max || config.police?.max || config.fire?.max) &&
      data &&
      isEmergencyData(data)
    ) {
      const router = new EmergencyRouter(data);
      if (
        router.network.nodes.length &&
        router.network.edges.length &&
        (!config.ambulance?.max ||
          router.network.targets.some((target) => target.kind === 'hospital')) &&
        (!config.police?.max ||
          router.network.targets.some((target) => target.kind === 'police')) &&
        (!config.fire?.max ||
          (router.network.targets.some((target) => target.kind === 'fire') &&
            router.network.targets.some((target) => target.kind === 'building')))
      )
        this.emergencyRouter = router;
    }
    for (const life of lives) life.emergencyRouter = this.emergencyRouter;
    if (config && this.emergencyRouter)
      this.emergencyDispatch = new EmergencyDispatch(config, this.emergencyRouter);
  }
  readonly crossingReservations = new CrossingReservations();
  private crossingCellMeters = 0;
  private retainCrossingClaims() {
    if (this.crossingReservations.empty) return;
    const active = new Set<string>();
    for (const life of this.tiles.values()) {
      if (!life.crossingWaits.records.length) continue;
      for (const owner of life.movers) {
        const wait = owner.crossingWait?.waiting;
        if (wait && this.owns(life, owner)) active.add(wait.owner);
      }
      for (const owner of life.gatherers) {
        const wait = owner.crossingWait?.waiting;
        if (wait && this.owns(life, owner)) active.add(wait.owner);
      }
    }
    this.crossingReservations.retain(active);
  }
  private sourceSerial = 0;
  private readonly nextSourceId = () => ++this.sourceSerial;
  private puffPacket = EMPTY_PUFFS;
  private effectCellMeters = 0;
  private readonly puffSources = new Map<number, number>();
  private readonly actorSources = new Map<VisibleAgent, number>();
  private readonly birdOffset: Point = { x: 0, y: 0 };
  private readonly puffSelector = new PuffSelector();
  /** Reply-owned storage: transferring a frame cannot detach simulation state. */
  get visiblePuffs() {
    return this.puffPacket;
  }
  private readonly umbrellas = new UmbrellaMotion();
  private umbrellaMotionVisible = false;
  private cityLife: Pick<CityLifeConfig, 'schedules'> | undefined;
  setShopSchedule(shops: ShopSchedule | undefined) {
    this.cityLife = shops ? { schedules: { shops } } : undefined;
  }
  private seasons: readonly SimulationSeason[] = [];
  private seasonalConfig: SimulationSeason | undefined;
  private seasonalTerrainKey = '';
  setSeasons(seasons: readonly SimulationSeason[]) {
    if (seasons === this.seasons) return;
    this.seasons = seasons;
    this.seasonsDirty = true;
  }
  private seasonsDirty = false;
  private readonly eventTrimmedStalls = new Set<TileLife>();
  /** Retired tiles retain their carts and reconcile the season when they return. */
  private readonly appliedSeasons = new WeakMap<TileLife, SimulationSeason | null>();
  private readonly stallAnchors = new WeakMap<TileLife, readonly SeasonAnchor[]>();
  private readonly stallBounds = new WeakMap<TileLife, readonly number[]>();
  private readonly stallInputs = new WeakMap<
    TileLife,
    {
      config: SimulationSeason;
      anchors: readonly SeasonAnchor[];
      neighbors: readonly TileLife[];
      quota: number;
    }
  >();

  /** Include buffered geography so neighboring roads and finer owners invalidate admission. */
  private seasonalBounds(life: TileLife): readonly number[] {
    const saved = this.stallBounds.get(life);
    if (saved) return saved;
    let minX = 0,
      minY = 0,
      maxX = EXTENT,
      maxY = EXTENT;
    const add = (x: number, y: number) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    for (let i = 0; i < life.geo.coords.length; i += 2)
      add(life.geo.coords[i]!, life.geo.coords[i + 1]!);
    for (const area of life.geo.areas ?? [])
      for (const ring of area.rings) for (const p of ring) add(p.x, p.y);
    let margin = 100;
    for (const width of life.geo.widths) margin = Math.max(margin, width);
    for (const r of physicalSeasonalRecords(life.geo)) {
      const points = r.kind === 'carnival' ? carnivalRing(r) : [r.at];
      for (const p of points) {
        const q = lngLatToTile(life.tile, ...p);
        add(q.x, q.y);
      }
      if (r.kind === 'christmas-tree') margin = Math.max(margin, r.radius_m);
    }
    const padding = margin * life.perMeter,
      scale = EXTENT * 2 ** life.tile.z;
    const bounds = [
      (life.tile.x * EXTENT + minX - padding) / scale,
      (life.tile.y * EXTENT + minY - padding) / scale,
      (life.tile.x * EXTENT + maxX + padding) / scale,
      (life.tile.y * EXTENT + maxY + padding) / scale,
    ];
    this.stallBounds.set(life, bounds);
    return bounds;
  }

  private readonly appliedCrowds = new WeakMap<TileLife, string>();

  private syncSeason(season: string | null | undefined) {
    const config = this.seasons.find(
      (s) =>
        s.id === season && (s.stalls || s.installations?.length || s.visitors || s.congregations),
    );
    const changed = config?.id !== this.seasonalConfig?.id;
    if (!changed && !this.seasonsDirty) {
      this.seasonalConfig = config;
      return;
    }
    const physical = (s: SimulationSeason | undefined) =>
      s?.installations?.some((i) => i.kind === 'christmas-tree' || i.kind === 'carnival');
    const hadPhysical = physical(this.seasonalConfig);
    const seasonalKey = this.physicalSeasonKey(this.tiles.values(), config);
    if (seasonalKey !== this.seasonalTerrainKey) {
      this.groundTerrain = undefined;
      this.eventTileDescriptors = undefined;
    }
    this.seasonalTerrainKey = seasonalKey;
    this.seasonalConfig = config;
    this.seasonsDirty = false;
    const crowdKey =
      config?.visitors || config?.congregations
        ? JSON.stringify([config.visitors, config.congregations])
        : '';
    for (const life of this.tiles.values()) {
      if ((this.appliedCrowds.get(life) ?? '') !== crowdKey) {
        life.clearSeasonalGatherers((owner) => this.inspection?.forgetOwner(owner, this.clock));
        this.appliedCrowds.delete(life);
      }
      const previous = this.appliedSeasons.get(life) ?? null;
      if (previous !== (config ?? null)) {
        const before = previous?.stalls,
          after = config?.stalls;
        if (
          !before ||
          !after ||
          before.radius_m !== after.radius_m ||
          before.per_tile !== after.per_tile ||
          before.near.length !== after.near.length ||
          !before.near.every((kind) => after.near.includes(kind))
        )
          life.clearSeasonalStalls();
        // Equivalent carts keep their scenes, but still recheck terrain and ownership.
        this.stallInputs.delete(life);
      }
      this.appliedSeasons.set(life, config ?? null);
    }
    if (
      !this.groundTerrain &&
      this.tiles.size &&
      (hadPhysical ||
        physical(config) ||
        [...this.tiles.values()].some((life) => life.hasSuppressedActors))
    )
      this.groundGuard();
    let admissionGuard: ReturnType<typeof this.groundGuard> | undefined;
    const guardForAdmission = () =>
      (admissionGuard ??= this.groundGuard(0, undefined, undefined, true));
    if (crowdKey && config) {
      const pending: TileLife[] = [];
      for (const life of this.tiles.values()) {
        if (this.appliedCrowds.get(life) === crowdKey) continue;
        const visitors =
          config.visitors &&
          (life.geo.graves?.length ||
            life.geo.memorialSites?.length ||
            (!life.geo.memorialSites && life.geo.cemeteryAreas?.some((area) => !area.hasBurials)));
        const congregations =
          config.congregations &&
          life.geo.placeLandmarks?.some(([, id]) => config.congregations!.landmarks.includes(id));
        if (visitors || congregations) pending.push(life);
        else this.appliedCrowds.set(life, crowdKey);
      }
      if (pending.length) {
        const guard = guardForAdmission();
        for (const life of pending) {
          life.admitSeasonalGatherers(
            config,
            (owner, before) => this.owns(life, owner) && guard(life, owner, before),
            (owner) => guard.remove(owner),
          );
          this.appliedCrowds.set(life, crowdKey);
        }
      }
    }
    if (!config?.stalls) return;
    const lives = [...this.tiles.values()];
    const anchors = lives.flatMap((life) => {
      let found = this.stallAnchors.get(life);
      if (!found) {
        found = collectSeasonAnchors([{ tile: life.tile, life: life.geo }]);
        this.stallAnchors.set(life, found);
      }
      return found;
    });
    const changedTiles = lives.flatMap((life) => {
      const nearby = anchors.filter((a) => {
        if (
          a.kind === 'market'
            ? !seasonMarkets(config.stalls!.near)
            : !config.stalls!.near.includes(a.kind)
        )
          return false;
        const reach = (config.stalls!.radius_m + (a.radius_m ?? 0)) * life.perMeter;
        const p = lngLatToTile(life.tile, ...a.at);
        return p.x >= -reach && p.y >= -reach && p.x <= EXTENT + reach && p.y <= EXTENT + reach;
      });
      const bounds = this.seasonalBounds(life);
      const neighbors = lives.filter((other) => {
        const b = this.seasonalBounds(other);
        return (
          b[0]! <= bounds[2]! && b[2]! >= bounds[0]! && b[1]! <= bounds[3]! && b[3]! >= bounds[1]!
        );
      });
      const previous = this.stallInputs.get(life);
      const quota = Math.max(0, MAX_TILE_AGENTS - life.population);
      this.stallInputs.set(life, { config, anchors: nearby, neighbors, quota });
      if (
        previous?.config === config &&
        previous.quota === quota &&
        nearby.length === previous.anchors.length &&
        nearby.every((a) => previous.anchors.includes(a)) &&
        neighbors.length === previous.neighbors.length &&
        neighbors.every((n) => previous.neighbors.includes(n))
      )
        return [];
      if (!nearby.length && !life.seasonalStalls.length) return [];
      return [{ life, anchors: nearby }];
    });
    if (!changedTiles.length) return;
    const guard = guardForAdmission();
    for (const { life, anchors } of changedTiles) {
      const near = seasonProximity(
        life.tile,
        anchors,
        config.stalls.near,
        config.stalls.radius_m,
        seasonMarkets(config.stalls.near),
      );
      for (let i = life.seasonalStalls.length - 1; i >= 0; i--) {
        const stall = life.seasonalStalls[i]!;
        if (
          this.owns(life, stall) &&
          near(stall.x, stall.y) &&
          life.canIdle(stall) &&
          guard(life, stall)
        )
          continue;
        guard.remove(stall);
        life.scenes.removeStall(stall);
        life.seasonalStalls.splice(i, 1);
      }
      life.clearSeasonalStalls(
        Math.min(config.stalls.per_tile, Math.max(0, MAX_TILE_AGENTS - life.population)),
      );
      life.admitSeasonalStalls(
        config.stalls,
        anchors,
        (owner, before) => this.owns(life, owner) && guard(life, owner, before),
      );
    }
  }
  /** Called on season/tile changes or preparation, never by ordinary terrain-key reads. */
  private physicalSeasonKey(lives: Iterable<TileLife>, config: SimulationSeason | undefined) {
    if (!config?.installations?.length) return '';
    const records: string[] = [];
    const found = new Set<string>();
    for (const life of lives)
      for (const record of physicalSeasonalRecords(life.geo)) {
        if (
          found.has(record.id) ||
          (record.kind !== 'christmas-tree' &&
            (record.kind !== 'carnival' || record.style === 'midway')) ||
          !admitsInstallation(record, config)
        )
          continue;
        found.add(record.id);
        records.push(
          JSON.stringify([
            record.id,
            record.season,
            record.installation,
            record.anchor,
            record.kind,
            record.at,
            record.kind === 'carnival'
              ? [record.style, record.size_m, record.angle_deg]
              : record.radius_m,
          ]),
        );
      }
    return records.length ? JSON.stringify(records.sort()) : '';
  }
  private terrainKey(keys: readonly string[], seasonalKey = this.seasonalTerrainKey) {
    return keys.join('|') + (seasonalKey ? `|installations:${seasonalKey}` : '');
  }
  readonly inspection?: LifeInspection;
  preparationEpoch = 0;
  hasBootstrapped() {
    return this.bootstrapped;
  }
  updateView(view: LifeViewContext) {
    this.viewContext = view;
  }
  *prepareTile(entry: LifeTile): Generator<void, TileLife, void> {
    const life = yield* new TileLife(
      entry.tile,
      entry.life,
      hashString(entry.key),
      this.traffic,
      true,
      this.momentOptions,
      'world',
      { memory: this.emojiMemory, enabled: this.emojiObserver },
    ).prepare();
    if (this.emergencyRouter) life.emergencyRouter = this.emergencyRouter;
    if (this.profiler) {
      this.profiler.registerPopulation(entry.key, life.movers);
      (this.preparedRegistered ??= new WeakSet()).add(life);
    }
    return life;
  }
  resident(key: string): TileLife | undefined {
    const saved = this.retired.get(key);
    return (
      this.tiles.get(key) ??
      (saved && this.clock - saved.at < RETIRE.seconds ? saved.life : undefined)
    );
  }
  active(key: string): TileLife | undefined {
    return this.tiles.get(key);
  }
  preparedExpired(key: string, life: TileLife) {
    return this.history.has(life) && this.resident(key) !== life;
  }
  activeEntries(): LifeTile[] {
    return [...this.tiles].map(([key, life]) => ({ key, tile: life.tile, life: life.geo }));
  }
  private viewContext?: LifeViewContext;
  private bootstrapped = false;
  private previouslyVisible = new WeakSet<Mover>();
  private birthCursor = 0;
  private birthCredit = 0;
  private readonly junctions = new JunctionTable();
  private readonly reciprocalBlockers = new WeakMap<Mover, { other: Mover; at: number }>();
  private readonly passingActors = new WeakMap<Mover, Mover>();
  private readonly failedYield = new WeakMap<Mover, number>();
  private readonly yieldingActors = new WeakMap<
    Mover,
    {
      priority: Mover;
      tile: TileId;
      x: number;
      y: number;
      clearance: number;
      anchor: readonly Body[];
      travelled: number;
      route?: readonly { x: number; y: number }[];
    }
  >();
  private readonly junctionTraffic = new JunctionTraffic();
  private crossingGeometryVersion = 0;
  private preparedCrossingVersion = -1;
  private readonly dirtyCrossingConsumers = new Set<TileLife>();

  private roadCache = new WorldRoadCache();
  private readonly metricTerrain = new WeakMap<
    TileLife,
    {
      origin: string;
      laneBounds: readonly [number, number, number, number];
      blocked: Polygon[];
      hardBlocked: Polygon[];
      vehicleBlocked: Polygon[];
      water: Polygon[];
      trees: Polygon[];
    }
  >();
  private readonly laneReaders = new WeakMap<
    TileLife,
    {
      ref: TileLife | undefined;
      origin: string;
      sources: TileLife[];
      seasonal: string;
      parking: string;
      closure: PolygonIndex | undefined;
      reader: LaneTerrain;
    }
  >();
  /** Weak ownership releases evicted agents. A stored body never aliases the next trial. */
  private groundBuffers = new WeakMap<object, { live: Body[]; trial: Body[] }>();
  private readonly groundPrevious: Body[] = [];
  private readonly groundSample: Body[] = [];
  private railTopology?: {
    key: string;
    routes: { life: TileLife; line: number; id: number; ends: string[] }[][];
  };
  private groundTerrain?: GroundTerrain;
  private eventTileDescriptors?: {
    terrain: GroundTerrain;
    tiles: { life: TileLife; x: number; y: number; endX: number; endY: number; units: number }[];
  };
  private preparedTerrain = new WeakMap<TileLife, GroundTerrain>();
  private preparedSettled = new WeakSet<TileLife>();
  private preparationTouched = new WeakSet<TileLife>();
  private seamWait = new WeakMap<Mover, { key: string; at: number }>();
  private rejectedSeams = new WeakMap<
    Mover,
    { key: string; seconds: number; at: number; queued: boolean; final?: boolean }
  >();
  private readonly queuedSeams = new Map<Mover, TileLife>();
  private seamRejectionKey(source: TileLife, m: Pick<Mover, 'line' | 'dir'>, target?: TileLife) {
    return `${source.tile.z}/${source.tile.x}/${source.tile.y}/${m.line}/${m.dir}/${target?.tile.z}/${target?.tile.x}/${target?.tile.y}`;
  }
  private clearSeamRecovery(m: Mover) {
    this.rejectedSeams.delete(m);
    this.queuedSeams.delete(m);
  }
  private preparedRegistered?: WeakSet<TileLife>;
  private readonly idleSample: Body[] = [];

  private canIdle(life: TileLife, owner: GroundAgent): boolean {
    // Eviction releases cached origins immediately; rebuild before using surviving visitors.
    if (!this.groundTerrain) this.groundGuard();
    const terrain = this.groundTerrain!;
    const o = terrain.origins.get(life);
    if (!o) return life.roadTerrain.access.allows(life.groundBodies(owner), false);
    const bodies = life.groundBodies(owner, 0, this.idleSample);
    for (const b of bodies) {
      b.x = o.x + b.x * o.scale;
      b.y = o.y + b.y * o.scale;
      b.length *= o.scale;
      b.width *= o.scale;
    }
    return terrain.roadAccess.allows(bodies, false) && !terrain.seasonal.hits(bodies);
  }
  private arrivals = new Map<string, { rng: () => number; left: number; occupied: boolean }>();
  private readonly tiles = new Map<string, TileLife>();
  private readonly retired = new Map<string, { life: TileLife; at: number }>();
  private readonly history = new WeakMap<TileLife, LifeHistory>();
  private covers = new Map<TileLife, readonly TileId[]>();
  private mixedZoom = false;
  private traffic: ResolvedTraffic;
  private readonly scenes = new Map<string, ProcessionScene | GroundProcessionScene>();
  /** Seconds simulated, for played processions. */
  private clock = 0;
  private emojiClock = 0;
  private played:
    | {
        id: string;
        start: number;
        elapsed: number;
        timing?: EventTiming;
        time?: { progress: number; value: EventTime };
      }
    | undefined;
  private suspendedLiveOwners?: {
    id: string;
    occurrence?: string;
    owners: Map<string, object>;
    adoption?: {
      scene: GroundProcessionScene;
      state: ReturnType<GroundProcessionScene['saveAdoption']>;
    };
  };
  private eventAgents: VisibleAgent[] = [];
  private eventReservations?: {
    terrain: GroundTerrain;
    scope: string;
    scene: GroundProcessionScene;
    actors: { token: object; body: Body; owner: TileLife }[];
    spans: { token: object; body: Body }[];
  };
  private eventOwners = new Map<string, object>();
  private eventGrounds = groundsForRoutes([]);
  /** Event cheer exchange ids by event kind, from the dialogue catalog. */
  private cheers?: ReturnType<typeof eventCheers>;
  private trafficClosureCache?: {
    scene: GroundProcessionScene | ProcessionScene;
    terrain: GroundTerrain;
    index: PolygonIndex | undefined;
  };
  private readonly reconciledActors = new WeakMap<
    TileLife,
    {
      terrain: GroundTerrain;
      closure?: PolygonIndex;
      movers: number;
      parked: number;
      stalls: number;
      gatherers: number;
    }
  >();
  private live: { id: string; progress: number; occurrence?: string } | undefined;
  /** Who is out and how hard it rains, as last drawn (`visible`): the flocks react to them. */
  private lastLevels: Activity | undefined;
  private lastCrowd = 1;
  private lastRain = 0;
  readonly emojiMemory = new EmojiMemory();
  private emojiView?: LifeEnv['emojiView'];
  setEmojiView(view: Parameters<LifeWorld['visible']>) {
    this.emojiView = {
      levels: typeof view[1] === 'number' ? activityLevels(view[1]) : view[1],
      crowd: view[5] ?? 1,
      bounds: view[4],
    };
  }

  /** `traffic`: the city's vehicle mix (its pack's `traffic`), over the default. */
  constructor(
    traffic?: TrafficMix,
    private readonly profiler?: FrameProfiler,
    private readonly momentOptions?: MomentOptions,
    itemInspection = false,
    private readonly emojiObserver = true,
    folklore = true,
  ) {
    this.folklore = new FolkloreObserver(folklore);
    this.traffic = resolveTraffic(traffic);
    if (itemInspection) this.inspection = new LifeInspection();
    this.momentOptions = { ...momentOptions, memory: new DialogueMemory() };
  }

  /** Change the vehicle mix: every tile's agents spawn again with it. */
  setTraffic(traffic?: TrafficMix) {
    this.traffic = resolveTraffic(traffic);
    this.clearTiles();
  }

  /** Explicit reset; an empty view sync instead retains frozen agents briefly. */
  clearTiles() {
    this.eventTaps?.clear();
    this.eventTaps = undefined;
    this.signalPresses = undefined;
    this.barkUntil = undefined;
    this.tapSources?.clear();
    this.tapReceipts = undefined;
    this.folklore.clear();
    this.emergencyDispatch?.clear();
    this.emergencyRegions = undefined;
    this.releaseEventActors(false, true);
    for (const tile of this.tiles.values()) tile.disposeEmoji();
    for (const { life } of this.retired.values()) life.disposeEmoji();
    this.emojiMemory.reset();
    this.emojiView = undefined;
    this.puffPacket = EMPTY_PUFFS;
    this.puffSources.clear();
    this.actorSources.clear();
    this.puffSelector.clear();
    this.seasonalConfig = undefined;
    this.seasonalTerrainKey = '';
    this.seasonsDirty = false;
    this.inspection?.clear();
    this.momentOptions?.memory?.clear();
    this.preparationEpoch++;
    this.preparedTerrain = new WeakMap();
    this.preparedSettled = new WeakSet();
    this.preparationTouched = new WeakSet();
    this.seamWait = new WeakMap();
    this.rejectedSeams = new WeakMap();
    this.queuedSeams.clear();
    this.preparedRegistered = undefined;
    this.profiler?.clearContinuity();
    for (const tile of this.tiles.values()) tile.momentHost.clear();
    for (const { life } of this.retired.values()) life.momentHost.clear();
    this.tiles.clear();
    this.crossingGeometryVersion++;
    this.retired.clear();
    this.covers.clear();
    this.mixedZoom = false;
    this.junctions.clear();
    this.dirtyCrossingConsumers.clear();
    this.crossingReservations.clear();
    this.arrivals.clear();
    this.groundTerrain = undefined;
    this.eventTileDescriptors = undefined;
    this.groundBuffers = new WeakMap();
    this.roadCache = new WorldRoadCache();
    this.railTopology = undefined;
    this.viewContext = undefined;
    this.bootstrapped = false;
    this.previouslyVisible = new WeakSet();
    this.birthCursor = this.birthCredit = 0;
  }

  private pruneRetired(cap = true) {
    for (const [key, entry] of this.retired)
      if (this.clock - entry.at >= RETIRE.seconds) {
        entry.life.momentHost.clear();
        for (const owner of [...entry.life.movers, ...entry.life.gatherers])
          entry.life.crossingWaits.release(owner);
        entry.life.disposeEmoji();
        if (this.emergencyDispatch)
          for (const mover of [...entry.life.residentMovers()])
            if (mover.emergency) this.releaseEmergency({ life: entry.life, mover });
        this.retired.delete(key);
      }
    if (cap)
      while (this.retired.size > RETIRE.max) {
        const key = this.retired.keys().next().value!;
        const life = this.retired.get(key)!.life;
        life.momentHost.clear();
        for (const owner of [...life.movers, ...life.gatherers]) life.crossingWaits.release(owner);
        life.disposeEmoji();
        if (this.emergencyDispatch)
          for (const mover of [...life.residentMovers()])
            if (mover.emergency) this.releaseEmergency({ life, mover });
        this.retired.delete(key);
      }
  }

  private owns(life: TileLife, p: { x: number; y: number }) {
    // Uniform-zoom steady state has no covered footprints.
    return !this.mixedZoom || !masked(life.tile, p, this.covers.get(life));
  }

  /** Revive frozen tiles, then reconcile only regions whose zoom ownership changed. */
  sync(
    tiles: readonly LifeTile[],
    focus?: readonly [number, number],
    view?: LifeViewContext,
    prepared?: ReadonlyMap<string, TileLife>,
    bootstrap = false,
  ) {
    if (!tiles.length) this.folklore.clear(true);
    if (view) this.viewContext = view;
    const gradual = !!this.viewContext && this.bootstrapped && !bootstrap;
    const start = this.profiler?.time();
    try {
      this.pruneRetired(false);
      const previous = new Set(this.tiles.values());
      const oldCovers = this.covers;
      const before: LifeDonor[] = [...this.tiles].map(([key, life]) => ({
        key,
        life,
        movers: [...life.movers],
        masks: [...(oldCovers.get(life) ?? []), ...(this.history.get(life)?.ceded ?? [])],
      }));
      for (const [key, { life }] of this.retired)
        before.push({
          key,
          life,
          movers: [...life.movers],
          masks: [...(this.history.get(life)?.ceded ?? [])],
        });
      const keep = new Set<string>();
      const added = new Set<TileLife>();
      let changed = false;
      const spawnStart = this.profiler?.time();
      for (const { key, tile, life } of tiles) {
        keep.add(key);
        if (!this.tiles.has(key)) {
          const saved = this.retired.get(key);
          const fresh =
            saved?.life ??
            prepared?.get(key) ??
            new TileLife(
              tile,
              life,
              hashString(key),
              this.traffic,
              false,
              this.momentOptions,
              'world',
              { memory: this.emojiMemory, enabled: this.emojiObserver },
            );
          this.retired.delete(key);
          if (this.emergencyRouter) fresh.emergencyRouter = this.emergencyRouter;
          fresh.crossingWaits.registry = this.crossingReservations;
          fresh.crossingWaits.shared = true;
          if (this.signalPresses) {
            fresh.signals.offsets = this.signalPresses.offsets;
            fresh.crossingWaits.signalOffsets = this.signalPresses.offsets;
          }
          this.tiles.set(key, fresh);
          if (saved)
            for (const m of fresh.movers)
              if (this.rejectedSeams.get(m)?.queued) this.queuedSeams.set(m, fresh);
          this.reconciledActors.delete(fresh);
          if (!saved) {
            if (!this.preparedRegistered?.has(fresh))
              this.profiler?.registerPopulation(key, fresh.movers);
            added.add(fresh);
            this.history.set(fresh, { ceded: [], quotas: {} });
          } else this.profiler?.countContinuity('revivals', fresh.movers.length);
          changed = true;
        }
      }
      if (added.size && spawnStart !== undefined)
        this.profiler!.add('spawn', this.profiler!.time() - spawnStart);
      for (const key of this.tiles.keys())
        if (!keep.has(key)) {
          const life = this.tiles.get(key)!;
          this.roadCache.forget(life);
          life.effects.pause(this.clock);
          life.freezeEmoji();
          life.clearSeasonalGatherers((owner) => this.inspection?.forgetOwner(owner, this.clock));
          this.appliedCrowds.delete(life);
          this.retired.set(key, { life, at: this.clock });
          this.tiles.delete(key);
          for (const [m, owner] of this.queuedSeams) if (owner === life) this.queuedSeams.delete(m);
          changed = true;
        }
      if (changed) {
        this.crossingGeometryVersion++;
        this.releaseEventActors(false, true);
        this.seasonsDirty = true;
        this.seasonalTerrainKey = this.physicalSeasonKey(this.tiles.values(), this.seasonalConfig);
        this.groundTerrain = undefined;
        this.eventTileDescriptors = undefined;
        for (const life of prepared?.values() ?? []) {
          const terrain = this.preparedTerrain.get(life);
          if (terrain?.key === this.terrainKey([...this.tiles.keys()]))
            this.groundTerrain = terrain;
          this.preparedTerrain.delete(life);
        }
        this.railTopology = undefined;
        this.covers = new Map();
        const live = [...this.tiles.values()];
        this.mixedZoom = live.some((life) => life.tile.z !== live[0]!.tile.z);
        for (const life of live) {
          const finer = live.filter(
            (other) => other.tile.z > life.tile.z && overlaps(life.tile, other.tile),
          );
          if (finer.length) {
            const masks: TileId[] = [];
            for (const other of finer) cede(masks, other.tile, life.tile);
            this.covers.set(life, masks);
          }
        }
      }
      if (changed && this.groundTerrain) this.revalidateTerrain();
      let activationGuard: WorldGroundGuard | undefined;
      if (added.size) {
        const guard = this.groundGuard(0, added);
        if ([...added].every((life) => this.preparedSettled.has(life))) activationGuard = guard;
        const settleStart = this.profiler?.time();
        for (const tile of added)
          if (!this.preparedSettled.has(tile))
            tile.settleGround((owner, before) => guard(tile, owner, before));
        for (const tile of added)
          if (!this.preparedSettled.has(tile))
            tile.settleAnimals((owner, before) => guard(tile, owner, before));
        if (
          [...added].some((tile) => !this.preparedSettled.has(tile) && tile.geo.commerce?.length)
        ) {
          const commerceGuard = this.groundGuard();
          for (const tile of added)
            tile.admitCommerce((owner, before) => commerceGuard(tile, owner, before));
        }
        if (settleStart !== undefined)
          this.profiler!.add('settle', this.profiler!.time() - settleStart);
        for (const life of added) {
          const quotas = this.history.get(life)!.quotas;
          for (const m of life.residentMovers())
            if (inTile(m)) quotas[m.kind] = (quotas[m.kind] ?? 0) + 1;
          if (!gradual) this.profiler?.countContinuity('births', life.movers.length);
          if (gradual)
            for (const m of [...life.movers]) {
              if (
                !['vehicle', 'boat', 'person', 'train'].includes(m.kind) ||
                !life.scenes.transferable(m)
              )
                continue;
              life.pending.push({ mover: m, at: life.elapsed });
              life.release(m);
            }
          if (this.preparedSettled.has(life)) {
            // Prepared ordinary travelers are checked on birth; local actors and bootstrap
            // residents must fit the occupancy at this actual frame boundary.
            for (let i = life.movers.length - 1; i >= 0; i--) {
              const m = life.movers[i]!;
              if ((m.kind === 'vehicle' || isWalker(m.kind)) && !guard(life, m))
                life.movers.splice(i, 1);
            }
            for (let i = life.gatherers.length - 1; i >= 0; i--)
              if (!guard(life, life.gatherers[i]!)) life.gatherers.splice(i, 1);
          }
        }
      }
      if (changed) {
        const destinations = [...this.tiles.values()].sort(
          (a, b) =>
            b.tile.z - a.tile.z ||
            `${a.tile.z}/${a.tile.x}/${a.tile.y}`.localeCompare(
              `${b.tile.z}/${b.tile.x}/${b.tile.y}`,
            ),
        );
        const transferred = new Set<Mover>();
        let guard = activationGuard;
        for (const target of destinations) {
          const donors = before.filter(
            (d) => d.life.tile.z !== target.tile.z && overlaps(d.life.tile, target.tile),
          );
          const was = oldCovers.get(target);
          if (!donors.length || (previous.has(target) && !was?.length)) continue;
          const gained = (p: { x: number; y: number }) =>
            inTile(p) &&
            this.owns(target, p) &&
            (!previous.has(target) || masked(target.tile, p, was));
          guard ??= this.groundGuard();
          this.carry(target, donors, gained, transferred, guard, focus);
        }
        // Cede geographic territory, not just successfully snapped individual movers.
        for (const donor of before) {
          const history = this.history.get(donor.life)!;
          for (const target of destinations) {
            if (
              target === donor.life ||
              target.tile.z === donor.life.tile.z ||
              !overlaps(target.tile, donor.life.tile)
            )
              continue;
            for (const footprint of ownedFootprints(target.tile, this.covers.get(target)))
              cede(history.ceded, footprint, donor.life.tile);
          }
        }
        // Live owners reclaim their uncovered territory; retired owners retain their tombstones.
        for (const life of this.tiles.values())
          this.history.get(life)!.ceded = [...(this.covers.get(life) ?? [])];
        // Revivals need the same immediately available cell guard as fresh settlement.
        if (this.tiles.size && !this.groundTerrain) this.groundGuard();
      }
      for (const life of this.tiles.values())
        for (const m of life.movers) if (!this.owns(life, m)) this.junctions.release(m);
      this.junctions.begin(new Set(this.tiles.values()));
      this.pruneRetired();
      this.retainCrossingClaims();
      if (tiles.length) this.bootstrapped = true;
    } finally {
      if (start !== undefined) this.profiler!.add('sync', this.profiler!.time() - start);
    }
  }

  private carry(
    target: TileLife,
    donors: readonly LifeDonor[],
    gained: (p: { x: number; y: number }) => boolean,
    transferred: Set<Mover>,
    guard: ReturnType<LifeWorld['groundGuard']>,
    focus?: readonly [number, number],
  ) {
    const center = focus
      ? lngLatToTile(target.tile, focus[0], focus[1])
      : { x: EXTENT / 2, y: EXTENT / 2 };
    const membership = new Map(donors.map((donor) => [donor.life, new Set(donor.life.movers)]));
    for (const kind of ['vehicle', 'boat', 'train', 'person'] as const) {
      const quota = this.history.get(target)!.quotas[kind] ?? 0;
      let count =
        target.movers.filter((m) => m.kind === kind && inTile(m)).length +
        target.pending.filter((p) => p.mover.kind === kind && inTile(p.mover)).length;
      const limit = Math.max(quota, count);
      const candidates = donors
        .flatMap((d) => {
          const f = frameBetween(d.life.tile, target.tile);
          return d.movers.flatMap((m, index) => {
            if (
              transferred.has(m) ||
              m.kind !== kind ||
              !inTile(m) ||
              masked(d.life.tile, m, d.masks)
            )
              return [];
            const x = f.x + m.x * f.scale,
              y = f.y + m.y * f.scale;
            if (gained({ x, y }) && !d.life.scenes.transferable(m)) {
              this.profiler?.countContinuity('attempts');
              this.profiler?.countContinuity('localScene');
              return [];
            }
            return gained({ x, y })
              ? [{ ...d, m, index, x, y, distance: (x - center.x) ** 2 + (y - center.y) ** 2 }]
              : [];
          });
        })
        .sort(
          (a, b) =>
            Number(!!b.m.emergency) - Number(!!a.m.emergency) ||
            a.m.rank - b.m.rank ||
            a.distance - b.distance ||
            a.key.localeCompare(b.key) ||
            a.index - b.index,
        );
      const consumed = new Set<PendingSeed>();
      const pendingPool = new Set(
        target.pending.filter(
          (p) => !p.mover.emergency && p.mover.kind === kind && gained(p.mover),
        ),
      );
      const replacements = new Set(
        target.movers.filter(
          (m) =>
            m.kind === kind &&
            !m.emergency &&
            gained(m) &&
            !transferred.has(m) &&
            !(this.viewContext && this.previouslyVisible.has(m)) &&
            target.scenes.transferable(m),
        ),
      );
      for (const c of candidates) {
        if (!membership.get(c.life)!.has(c.m)) continue;
        this.profiler?.countContinuity('attempts');
        let replace: Mover | undefined;
        const pending = c.m.emergency
          ? undefined
          : nearestReplacement(pendingPool, c, (seed) => seed.mover);
        if (
          !pending &&
          ((c.m.emergency ? target.population >= MAX_TILE_AGENTS : count >= limit) ||
            kind === 'train')
        ) {
          replace = nearestReplacement(replacements, c, (m) => m);
          if (!replace && kind !== 'train') {
            this.profiler?.countContinuity('capQuota');
            continue;
          }
        }
        const accepted = target.adoptFrom(
          c.m,
          c.life,
          {
            replace,
            crossingClock: this.clock,
            crossingMinimum: this.crossingCellMeters,
            snapM: kind === 'train' ? TRAIN.handover : ADOPT.snap,
            reject: this.profiler && ((reason) => this.profiler!.countContinuity(reason)),
          },
          (preview) =>
            gained(preview) &&
            (kind !== 'person' || walkingTransfer(target, c.life, c.m, preview)) &&
            ((kind !== 'vehicle' && kind !== 'person') ||
              guard(
                target,
                preview,
                kind === 'person' ? walkingBefore(target, c.life, c.m, preview) : undefined,
                replace,
                false,
                c.m,
                this.profiler && ((reason) => this.profiler!.countContinuity(reason)),
              )),
        );
        if (!accepted) continue;
        membership.get(c.life)!.delete(c.m);
        if (pending) {
          pendingPool.delete(pending);
          consumed.add(pending);
        }
        if (replace) replacements.delete(replace);
        this.profiler?.countContinuity('transfers');
        this.junctions.rebind(
          c.m,
          target,
          [...this.tiles].find(([, life]) => life === target)![0],
          c.life,
        );
        if (this.junctions.movement(c.m)) this.dirtyCrossingConsumers.add(target);
        if (replace) {
          this.junctions.release(replace);
          guard.remove(replace);
        }
        guard.remove(c.m);
        if (kind === 'vehicle' || kind === 'person') guard(target, c.m);
        if (!replace && !pending) count++;
        transferred.add(c.m);
      }
      if (consumed.size) {
        let kept = 0;
        for (const seed of target.pending) if (!consumed.has(seed)) target.pending[kept++] = seed;
        target.pending.length = kept;
      }
    }
  }

  /** One metric coordinate system for all tiles, so clearance also works across a seam. */
  private *prepareGroundTerrain(
    entries: readonly [string, TileLife][],
    profile = false,
  ): Generator<void, GroundTerrain, void> {
    const lives = entries.map(([, life]) => life);
    const ref = lives[0];
    const config = this.seasonalConfig;
    const seasonalKey = this.physicalSeasonKey(lives, config);
    const blocked = new PolygonIndex();
    const hasSeating = lives.some((life) =>
      life.geo.areas?.some((area) => area.kind === 'blocked' && !area.water && area.seating),
    );
    const terrain: GroundTerrain = {
      key: this.terrainKey(
        entries.map(([key]) => key),
        seasonalKey,
      ),
      seasonalKey,
      ref,
      blocked,
      hardBlocked: hasSeating ? new PolygonIndex() : blocked,
      vehicleBlocked: new PolygonIndex(),
      seasonal: new PolygonIndex(),
      water: new PolygonIndex(),
      trees: new PolygonIndex(),
      roadAccess: new RoadAccess([], []),
      origins: new Map(),
    };
    const origin = (life: TileLife) => {
      const found = terrain.origins.get(life);
      if (found) return found;
      const at = metricFrame(life, ref!);
      terrain.origins.set(life, at);
      return at;
    };
    const terrainStart = profile ? this.profiler?.time() : undefined;
    const contributions = [];
    for (const life of lives) {
      const o = origin(life);
      const key = `${o.x},${o.y},${o.scale}`;
      let cached = this.metricTerrain.get(life);
      if (!cached || cached.origin !== key) {
        cached = {
          origin: key,
          laneBounds: [Infinity, Infinity, -Infinity, -Infinity],
          blocked: [],
          hardBlocked: [],
          vehicleBlocked: [],
          water: [],
          trees: [],
        };
        const metric = (polygon: Polygon) =>
          polygon.map((ring) =>
            ring.map((p) => ({
              x: o.x + (p.x / life.perMeter) * o.scale,
              y: o.y + (p.y / life.perMeter) * o.scale,
            })),
          );
        for (const a of life.geo.areas ?? []) {
          if (
            a.kind !== 'parking-exclusion' &&
            a.kind !== 'blocked' &&
            a.kind !== 'vehicle-blocked'
          )
            continue;
          const polygon = metric(a.rings);
          if (a.kind === 'parking-exclusion') cached.trees.push(polygon);
          if (a.kind === 'blocked') {
            (a.water ? cached.water : cached.blocked).push(polygon);
            if (!a.water && !a.seating) cached.hardBlocked.push(polygon);
          }
          if (a.kind === 'vehicle-blocked') cached.vehicleBlocked.push(polygon);
        }
        const bounds = [Infinity, Infinity, -Infinity, -Infinity];
        for (const polygons of [cached.blocked, cached.vehicleBlocked])
          for (const polygon of polygons)
            for (const ring of polygon)
              for (const p of ring) {
                bounds[0] = Math.min(bounds[0]!, p.x);
                bounds[1] = Math.min(bounds[1]!, p.y);
                bounds[2] = Math.max(bounds[2]!, p.x);
                bounds[3] = Math.max(bounds[3]!, p.y);
              }
        cached.laneBounds = [bounds[0]!, bounds[1]!, bounds[2]!, bounds[3]!];
        this.metricTerrain.set(life, cached);
      }
      yield;
      contributions.push({ owner: life, terrain: life.roadTerrain, ...o });
      for (const polygon of cached.trees) yield* terrain.trees.addSteps(polygon);
    }
    if (ref && config?.installations?.length) {
      const found = new Set<string>();
      for (const life of lives)
        for (const record of physicalSeasonalRecords(life.geo)) {
          if (
            found.has(record.id) ||
            (record.kind !== 'christmas-tree' &&
              (record.kind !== 'carnival' || record.style === 'midway')) ||
            !admitsInstallation(record, config)
          )
            continue;
          found.add(record.id);
          const at = lngLatToTile(ref.tile, ...record.at);
          const radius = record.kind === 'carnival' ? 0 : record.radius_m / Math.cos(Math.PI / 16);
          const ring =
            record.kind === 'carnival'
              ? carnivalRing(record).map((p) => {
                  const q = lngLatToTile(ref.tile, ...p);
                  return { x: q.x / ref.perMeter, y: q.y / ref.perMeter };
                })
              : Array.from({ length: 17 }, (_, i) => ({
                  x: at.x / ref.perMeter + Math.cos((i * Math.PI) / 8) * radius,
                  y: at.y / ref.perMeter + Math.sin((i * Math.PI) / 8) * radius,
                }));
          yield* terrain.blocked.addSteps([ring]);
          if (terrain.hardBlocked !== terrain.blocked) yield* terrain.hardBlocked.addSteps([ring]);
          yield* terrain.seasonal.addSteps([ring]);
          yield* terrain.trees.addSteps([ring]);
        }
    }
    const roadsStart = profile ? this.profiler?.time() : undefined;
    terrain.roadAccess = yield* this.roadCache.buildSteps(contributions);
    if (roadsStart !== undefined)
      this.profiler!.add('terrainRoads', this.profiler!.time() - roadsStart);
    for (const life of lives) {
      const cached = this.metricTerrain.get(life)!;
      for (const polygon of cached.blocked) yield* terrain.blocked.addSteps(polygon);
      if (terrain.hardBlocked !== terrain.blocked)
        for (const polygon of cached.hardBlocked) yield* terrain.hardBlocked.addSteps(polygon);
      for (const polygon of cached.vehicleBlocked) yield* terrain.vehicleBlocked.addSteps(polygon);
      for (const polygon of cached.water) yield* terrain.water.addSteps(polygon);
    }
    if (terrainStart !== undefined)
      this.profiler!.add('terrainRebuild', this.profiler!.time() - terrainStart);
    return terrain;
  }

  discardPreparation(life: TileLife) {
    this.preparedTerrain.delete(life);
    if (this.history.has(life) || !this.preparationTouched.has(life)) return false;
    this.preparedSettled.delete(life);
    this.preparationTouched.delete(life);
    return true;
  }

  *prepareActivation(
    entries: readonly LifeTile[],
    ready: ReadonlyMap<string, TileLife>,
  ): Generator<void, void, void> {
    const keep = new Set(entries.map((entry) => entry.key));
    const next = new Map([...this.tiles].filter(([key]) => keep.has(key)));
    for (const entry of entries)
      if (!next.has(entry.key)) {
        const life = ready.get(entry.key) ?? this.resident(entry.key);
        if (!life) return;
        next.set(entry.key, life);
      }
    const terrain = yield* this.prepareGroundTerrain([...next]);
    for (const life of ready.values()) this.preparedTerrain.set(life, terrain);
    const fresh = new Set(
      [...ready.values()].filter(
        (life) => !this.history.has(life) && !this.preparedSettled.has(life),
      ),
    );
    if (fresh.size) {
      for (const life of fresh) this.preparationTouched.add(life);
      // The sandbox reads current neighbors, but only the private ready tile is modified.
      // Its terrain and reservations are detached from the live world's frame.
      const sandbox = new LifeWorld();
      for (const [key, life] of next) sandbox.tiles.set(key, life);
      sandbox.groundTerrain = terrain;
      sandbox.seasonalConfig = this.seasonalConfig;
      sandbox.seasonalTerrainKey = terrain.seasonalKey;
      sandbox.lastLevels = this.lastLevels;
      sandbox.lastCrowd = this.lastCrowd;
      sandbox.mixedZoom = [...next.values()].some(
        (life) => life.tile.z !== next.values().next().value!.tile.z,
      );
      for (const life of next.values()) {
        const finer = [...next.values()].filter(
          (other) => other.tile.z > life.tile.z && overlaps(life.tile, other.tile),
        );
        if (finer.length)
          sandbox.covers.set(
            life,
            finer.map((other) => other.tile),
          );
      }
      for (const life of fresh) life.setIdleGuard((owner) => sandbox.canIdle(life, owner));
      for (const life of fresh) sandbox.reconcileSeasonalTerrain(life);
      const guard = yield* sandbox.groundGuardSteps(0, fresh);
      for (const life of fresh)
        yield* life.settleGroundSteps((owner, before) => guard(life, owner, before));
      for (const life of fresh)
        yield* life.settleAnimalsSteps((owner, before) => guard(life, owner, before));
      const commerceGuard = yield* sandbox.groundGuardSteps();
      for (const life of fresh)
        yield* life.admitCommerceSteps((owner, before) => commerceGuard(life, owner, before));
      for (const life of fresh) this.preparedSettled.add(life);
    }
    // Serialization buffers are prepared privately too; the worker transfers them once.
    yield* terrain.blocked.toFlatSteps();
    if (terrain.hardBlocked !== terrain.blocked) yield* terrain.hardBlocked.toFlatSteps();
    yield* terrain.roadAccess.roads.toFlatSteps();
    yield* terrain.roadAccess.forbidden.toFlatSteps();
    yield* terrain.trees.toFlatSteps();
  }

  private revalidateTerrain() {
    const terrain = this.groundTerrain!;
    const origin = (life: TileLife) => terrain.origins.get(life)!;
    const toRef = (o: { x: number; y: number; scale: number }, b: Body): Body => {
      b.x = o.x + b.x * o.scale;
      b.y = o.y + b.y * o.scale;
      b.length *= o.scale;
      b.width *= o.scale;
      return b;
    };
    for (const life of this.tiles.values()) life.setIdleGuard((owner) => this.canIdle(life, owner));
    // A neighboring buffered crown can invalidate an already admitted parking placement.
    const revalidateStart = this.profiler?.time();
    for (const life of this.tiles.values()) {
      const o = origin(life);
      this.reconcileSeasonalTerrain(life);
      for (let i = life.gatherers.length - 1; i >= 0; i--)
        if (life.gatherers[i]!.behavior === 'sit' && !life.canIdle(life.gatherers[i]!))
          life.gatherers.splice(i, 1);
      for (let i = life.parked.length - 1; i >= 0; i--) {
        const p = life.parked[i]!,
          spec = VEHICLES[p.vehicle];
        const body = toRef(o, {
          ...p,
          x: p.x / life.perMeter,
          y: p.y / life.perMeter,
          length: spec.length,
          width: spec.width,
        });
        if (this.groundTerrain!.trees.hits([body])) life.parked.splice(i, 1);
      }
      // Revalidate physical vendor footprints on terrain changes, independent of zoom.
      for (let i = life.stalls.length - 1; i >= 0; i--) {
        const stall = life.stalls[i]!;
        const sample = life.groundBodies(stall, 0, this.groundSample);
        for (const body of sample) toRef(o, body);
        if (
          !this.groundTerrain!.roadAccess.allows(sample, false) ||
          this.groundTerrain!.seasonal.hits(sample)
        ) {
          life.scenes.removeStall(stall);
          life.stalls.splice(i, 1);
        }
      }
    }
    if (revalidateStart !== undefined)
      this.profiler!.add('terrainRevalidate', this.profiler!.time() - revalidateStart);
  }

  private reconcileSeasonalTerrain(life: TileLife) {
    const terrain = this.groundTerrain!;
    const o = terrain.origins.get(life);
    if (!o) return;
    const closure = this.trafficClosure();
    const saved = this.reconciledActors.get(life);
    if (
      saved?.terrain === terrain &&
      saved.closure === closure &&
      saved.movers === life.movers.length &&
      saved.parked === life.parked.length &&
      saved.stalls === life.stalls.length &&
      saved.gatherers === life.gatherers.length
    )
      return;
    if (saved?.terrain !== terrain || saved.closure !== closure)
      life.setLaneTerrain(this.laneTerrain(life));
    const transform = (body: Body) => {
      body.x = o.x + body.x * o.scale;
      body.y = o.y + body.y * o.scale;
      body.length *= o.scale;
      body.width *= o.scale;
      return body;
    };
    life.setForageGuard((from, to) => {
      // Read the current shared index so retired tiles do not retain old terrain copies.
      const current = this.groundTerrain;
      const at = current?.origins.get(life);
      if (!current || !at) return false;
      const body = segmentBody(
        { x: from.x / life.perMeter, y: from.y / life.perMeter },
        { x: to.x / life.perMeter, y: to.y / life.perMeter },
        0.01,
      );
      body.x = at.x + body.x * at.scale;
      body.y = at.y + body.y * at.scale;
      body.length *= at.scale;
      body.width *= at.scale;
      return !current.blocked.hits([body]);
    });
    life.reconcileSeasonalActors(
      (owner) => {
        const vehicle = 'kind' in owner && owner.kind === 'vehicle';
        if (!terrain.seasonal.polygons.length && (!closure || !vehicle)) return false;
        const bodies = life.groundBodies(owner, 0, this.groundSample);
        for (const body of bodies) transform(body);
        return terrain.seasonal.hits(bodies) || (!!closure && vehicle && closure.hits(bodies));
      },
      (p) => {
        const spec = VEHICLES[p.vehicle];
        const bodies = [
          transform({
            ...p,
            x: p.x / life.perMeter,
            y: p.y / life.perMeter,
            length: spec.length,
            width: spec.width,
          }),
        ];
        return terrain.seasonal.hits(bodies) || !!closure?.hits(bodies);
      },
      terrain.seasonal.polygons.length > 0 || !!closure,
    );
    this.reconciledActors.set(life, {
      terrain,
      closure,
      movers: life.movers.length,
      parked: life.parked.length,
      stalls: life.stalls.length,
      gatherers: life.gatherers.length,
    });
  }

  /** Ordinary traffic yields the full carriageway for the active street event. */
  private trafficClosure() {
    const id =
      this.played?.id ??
      (this.live && this.live.progress >= 0 && this.live.progress < 1 ? this.live.id : undefined);
    const scene = id && this.scenes.get(id);
    const terrain = this.groundTerrain;
    if (!scene || !terrain?.ref) {
      this.trafficClosureCache = undefined;
      return undefined;
    }
    // Checked for every agent: rings are built once per scene and terrain, none included.
    if (this.trafficClosureCache?.scene === scene && this.trafficClosureCache.terrain === terrain)
      return this.trafficClosureCache.index;
    const rings = trafficRings(scene.route),
      ref = terrain.ref;
    const index = rings.length ? new PolygonIndex() : undefined;
    const metric = ([lng, lat]: [number, number]) => {
      const q = lngLatToTile(ref.tile, lng, lat);
      return { x: q.x / ref.perMeter, y: q.y / ref.perMeter };
    };
    for (const ring of rings) index!.add([ring.map(metric)]);
    this.trafficClosureCache = { scene, terrain, index };
    return index;
  }

  private reconcileEventTraffic() {
    if (this.groundTerrain)
      for (const life of this.tiles.values()) this.reconcileSeasonalTerrain(life);
  }

  private groundGuard(
    minimum = 0,
    fresh?: ReadonlySet<TileLife>,
    bounds?: LngLatBounds,
    allBodies = false,
    region?: ReadonlySet<TileLife>,
    admitEvents = false,
    eventBounds?: LngLatBounds,
    shows?: (kind: Mover['kind']) => boolean,
  ) {
    return complete(
      this.groundGuardSteps(
        minimum,
        fresh,
        bounds,
        allBodies,
        region,
        false,
        admitEvents,
        eventBounds,
        shows,
      ),
    );
  }

  /** The guard's fixed vehicle obstacles, seen from one tile in its metres (lane bends). */
  private laneTerrain(life: TileLife): LaneTerrain | undefined {
    const { seasonal, origins, ref } = this.groundTerrain!;
    const o = origins.get(life);
    if (!o) return;
    const [x0, y0, x1, y1] = life.laneQueryBounds();
    if (!Number.isFinite(x0)) return;
    const bounds: [number, number, number, number] = [
      o.x + x0 * o.scale,
      o.y + y0 * o.scale,
      o.x + x1 * o.scale,
      o.y + y1 * o.scale,
    ];
    const touches = ([a0, b0, a1, b1]: readonly number[]) =>
      a0! <= bounds[2] + 0.01 &&
      a1! >= bounds[0] - 0.01 &&
      b0! <= bounds[3] + 0.01 &&
      b1! >= bounds[1] - 0.01;
    const sources = [...this.tiles.values()].filter((other) => {
      const cached = this.metricTerrain.get(other),
        at = origins.get(other);
      // Missing/mismatched preparation metadata is conservatively retained as a dependency.
      return (
        !cached ||
        !at ||
        cached.origin !== `${at.x},${at.y},${at.scale}` ||
        touches(cached.laneBounds)
      );
    });
    const seasonalKey = JSON.stringify(
      seasonal.polygons.filter((polygon) => touches(boundsOf(polygon[0]!))),
    );
    const originKey = `${o.x}/${o.y}/${o.scale}`;
    const parkingBodies: Body[] = [];
    for (const source of this.tiles.values()) {
      const at = origins.get(source);
      if (!at) continue;
      for (const parked of source.parked) {
        if (!this.owns(source, parked)) continue;
        const spec = VEHICLES[parked.vehicle];
        const body = {
          x: at.x + (parked.x / source.perMeter) * at.scale,
          y: at.y + (parked.y / source.perMeter) * at.scale,
          hx: parked.hx,
          hy: parked.hy,
          length: spec.length * at.scale,
          width: spec.width * at.scale,
        };
        if (touches(boundsOf(bodyCorners(body)))) parkingBodies.push(body);
      }
    }
    const parkingKey = JSON.stringify(parkingBodies);
    const closure = this.trafficClosure();
    const previous = this.laneReaders.get(life);
    if (
      previous &&
      previous.ref === ref &&
      previous.origin === originKey &&
      previous.seasonal === seasonalKey &&
      previous.parking === parkingKey &&
      previous.closure === closure &&
      previous.sources.length === sources.length &&
      previous.sources.every((source, i) => source === sources[i])
    )
      return previous.reader;
    // Parking is a fixed physical obstacle just like a mapped curb. Plan the
    // bend before reaching it; every actual move still uses the swept guard.
    const parking = new PolygonIndex();
    for (const body of parkingBodies) parking.add([bodyCorners(body)]);
    const sample: Body[] = [{ x: 0, y: 0, hx: 0, hy: 0, length: 0, width: 0 }];
    const reader: LaneTerrain = {
      near: (x0, y0, x1, y1) => {
        const ax = o.x + x0 * o.scale,
          ay = o.y + y0 * o.scale,
          bx = o.x + x1 * o.scale,
          by = o.y + y1 * o.scale;
        const current = this.groundTerrain!;
        return (
          current.blocked.near(ax, ay, bx, by) ||
          current.vehicleBlocked.near(ax, ay, bx, by) ||
          parking.near(ax, ay, bx, by) ||
          !!this.trafficClosure()?.near(ax, ay, bx, by)
        );
      },
      hits: (body) => {
        const b = sample[0]!;
        b.x = o.x + body.x * o.scale;
        b.y = o.y + body.y * o.scale;
        b.hx = body.hx;
        b.hy = body.hy;
        b.length = body.length * o.scale;
        b.width = body.width * o.scale;
        const current = this.groundTerrain!;
        return (
          current.blocked.hits(sample) ||
          current.vehicleBlocked.hits(sample) ||
          parking.hits(sample) ||
          !!this.trafficClosure()?.hits(sample)
        );
      },
    };
    this.laneReaders.set(life, {
      ref,
      origin: originKey,
      sources,
      seasonal: seasonalKey,
      parking: parkingKey,
      closure,
      reader,
    });
    return reader;
  }

  private *groundGuardSteps(
    minimum = 0,
    fresh?: ReadonlySet<TileLife>,
    bounds?: LngLatBounds,
    allBodies = false,
    region?: ReadonlySet<TileLife>,
    cooperative = true,
    admitEvents = false,
    eventBounds?: LngLatBounds,
    shows?: (kind: Mover['kind']) => boolean,
  ): Generator<void, WorldGroundGuard, void> {
    const buildStart = this.profiler?.time();
    const ref = this.tiles.values().next().value;
    const occupied = new Occupancy();
    const admission = eventBounds ? new Occupancy() : occupied;
    const reservations = new Map<GroundAgent, readonly Body[]>();
    const physicalReservations = new Map<GroundAgent, readonly Body[]>();
    const eventDenials = new WeakSet<object>();
    // Ordinary attendants are visible query bodies, but are not collision reservations.
    let queryOnly: Occupancy | undefined;
    const key = this.terrainKey([...this.tiles.keys()]);
    const rebuild = this.groundTerrain?.key !== key;
    if (rebuild) this.groundTerrain = yield* this.prepareGroundTerrain([...this.tiles], true);
    if (this.eventReservations && this.eventReservations.terrain !== this.groundTerrain)
      this.releaseEventActors(false, true);
    const { blocked, vehicleBlocked, water } = this.groundTerrain!;
    const origin = (life: TileLife) => {
      const found = this.groundTerrain!.origins.get(life);
      if (found) return found;
      const scale = 2 ** (ref!.tile.z - life.tile.z);
      const at = {
        x: ((life.tile.x * scale - ref!.tile.x) * EXTENT) / ref!.perMeter,
        y: ((life.tile.y * scale - ref!.tile.y) * EXTENT) / ref!.perMeter,
        scale: (scale * life.perMeter) / ref!.perMeter,
      };
      this.groundTerrain!.origins.set(life, at);
      return at;
    };
    const buffer = (owner: object) => {
      let pair = this.groundBuffers.get(owner);
      if (!pair) this.groundBuffers.set(owner, (pair = { live: [], trial: [] }));
      return pair;
    };
    const toRef = (o: ReturnType<typeof origin>, b: Body): Body => {
      b.x = o.x + b.x * o.scale;
      b.y = o.y + b.y * o.scale;
      b.length *= o.scale;
      b.width *= o.scale;
      return b;
    };
    const owners = new WeakMap<object, TileLife>();
    const physicalShapes = new WeakMap<object, Body[]>();
    const physicalShape = (owner: object, b: Body, i: number): Body => {
      const life = owners.get(owner);
      if (!life) return b; // Parked bodies already use physical dimensions.
      let shapes = physicalShapes.get(owner);
      if (!shapes) {
        shapes = life.groundBodies(owner as GroundAgent).map((p) => toRef(origin(life), p));
        physicalShapes.set(owner, shapes);
      }
      const p = shapes[i] ?? physicalReservations.get(owner as GroundAgent)?.[i - shapes.length];
      if (!p) return b;
      p.x = b.x;
      p.y = b.y;
      p.hx = b.hx;
      p.hy = b.hy;
      return p;
    };
    const bodies = (life: TileLife, owner: GroundAgent, out: Body[], identity = owner) => {
      // A detached preview can be in a destination frame while its actor still
      // belongs to the source. Physical dimensions and yielding use that owner.
      if (!owners.has(identity)) owners.set(identity, life);
      const o = origin(life);
      life.groundBodies(owner, minimum, out, identity);
      for (const b of out) toRef(o, b);
      return out;
    };
    if (rebuild) {
      this.revalidateTerrain();
      for (const life of this.tiles.values()) life.setLaneTerrain(this.laneTerrain(life));
    }
    const closure = this.trafficClosure();
    if (!rebuild)
      for (const life of this.tiles.values())
        if (closure || life.hasSuppressedActors) this.reconcileSeasonalTerrain(life);
    const roadAccess = this.groundTerrain!.roadAccess;
    const diagnostics = this.profiler?.lifeDiagnostics;
    const diagnoseOccupancy =
      diagnostics &&
      ((owner: GroundAgent, next: readonly Body[], ignore?: object, physicalOnly = false) => {
        const blocker = occupied.firstConflict(
          owner,
          next,
          ignore,
          physicalOnly ? physicalShape : undefined,
        );
        const tags: string[] = [];
        if (blocker && 'kind' in blocker) {
          const m = blocker as Mover;
          if (bandVisibility(LIFE_ZOOM[m.kind], diagnostics.zoom) < 1) tags.push('hiddenAtZoom');
          if (this.lastLevels && m.rank >= this.lastLevels[m.kind] * diagnostics.crowd)
            tags.push('hiddenByCrowd');
          if (
            'kind' in owner &&
            owner.kind === 'vehicle' &&
            m.kind === 'vehicle' &&
            owner.hx * m.hx + owner.hy * m.hy < 0
          )
            tags.push('opposingVehicle');
        } else if (blocker && this.lastLevels) {
          const ground = blocker as Gatherer | Stall;
          if (bandVisibility(LIFE_ZOOM.person, diagnostics.zoom) < 1) tags.push('hiddenAtZoom');
          const level =
            'place' in ground
              ? this.lastLevels.places[ground.place]
              : 'shirt' in ground
                ? this.lastLevels.person
                : undefined;
          if (level !== undefined && ground.rank >= level * diagnostics.crowd)
            tags.push('hiddenByCrowd');
        }
        diagnostics.reject(owner, 'occupancy', blocker, tags);
      });
    let visited = 0;
    for (const life of this.tiles.values()) {
      if (region && !region.has(life)) continue;
      const o = origin(life);
      const near = bounds && this.activityNear(life, bounds, 100 * life.perMeter);
      const inView = (p: { x: number; y: number }) => !near || near(p.x, p.y);
      const admissionNear = eventBounds && viewIn(life.tile, eventBounds, 100 * life.perMeter);
      const inAdmission = (p: { x: number; y: number }) =>
        !!eventBounds && (!admissionNear || admissionNear(p.x, p.y));
      const standing = (p: Parked | Stall, vehicle: CraftType) => {
        if ((!inView(p) && !inAdmission(p)) || !this.owns(life, p)) return;
        const { length, width } = VEHICLES[vehicle];
        const { perMeter } = life;
        const out = buffer(p).live;
        const b = out[0] ?? (out[0] = { x: 0, y: 0, hx: 0, hy: 0, length: 0, width: 0 });
        b.x = p.x / perMeter;
        b.y = p.y / perMeter;
        b.hx = p.hx;
        b.hy = p.hy;
        b.length = length;
        b.width = width;
        b.kind = vehicle === 'cart' ? BODY_KIND.fixed : BODY_KIND.vehicle;
        out.length = 1;
        toRef(o, b);
        if (inView(p)) occupied.set(p, out);
        if (inAdmission(p)) admission.set(p, out);
      };
      for (const p of life.parked) {
        standing(p, p.vehicle);
        if (cooperative && ++visited % 32 === 0) yield;
      }
      // Closed carts and those above the vendor level aren't drawn (`visible`), so aren't there.
      for (const s of life.seasonalStalls.length ? life.allStalls() : life.stalls) {
        if (cooperative && ++visited % 32 === 0) yield;
        const moving =
          inView(s) &&
          (allBodies ||
            ((!shows || shows('person')) &&
              s.open !== false &&
              (!this.lastLevels || s.rank < this.lastLevels.person)));
        const admitting = inAdmission(s);
        if ((!moving && !admitting) || !this.owns(life, s)) continue;
        const out = bodies(life, s, buffer(s).live);
        if (admitting) admission.set(s, out);
        if (moving) {
          if (allBodies || life.seasonalStalls.includes(s)) occupied.set(s, out);
          else {
            // Admission retains the complete inflated cart/attendant pair. Ordinary
            // movement reserves the physical cart without mutating that shared pair.
            occupied.set(s, [
              {
                ...out[0]!,
                length: VEHICLES.cart.length * o.scale,
                width: VEHICLES.cart.width * o.scale,
              },
            ]);
            (queryOnly ??= new Occupancy()).set(s, [out[1]!]);
          }
        }
      }
      if (fresh?.has(life)) continue;
      for (const m of life.movers) {
        if (cooperative && ++visited % 32 === 0) yield;
        if (
          this.owns(life, m) &&
          !life.scenes.hidden(m) &&
          (m.kind === 'vehicle' || isWalker(m.kind)) &&
          ((inView(m) &&
            (allBodies || !shows || shows(m.kind)) &&
            (allBodies || !this.lastLevels || m.rank < this.lastLevels[m.kind])) ||
            inAdmission(m))
        ) {
          const out = bodies(life, m, buffer(m).live);
          if (
            inView(m) &&
            (allBodies || !shows || shows(m.kind)) &&
            (allBodies || !this.lastLevels || m.rank < this.lastLevels[m.kind])
          )
            occupied.set(m, out);
          if (inAdmission(m)) admission.set(m, out);
        }
      }
      for (const g of life.gatherers) {
        if (cooperative && ++visited % 32 === 0) yield;
        if (
          this.owns(life, g) &&
          ((inView(g) &&
            (allBodies || !shows || shows('person')) &&
            (allBodies || g.rank < gathererShare(g, this.lastLevels))) ||
            inAdmission(g))
        ) {
          const out = bodies(life, g, buffer(g).live);
          if (
            inView(g) &&
            (allBodies || !shows || shows('person')) &&
            (allBodies || g.rank < gathererShare(g, this.lastLevels))
          )
            occupied.set(g, out);
          if (inAdmission(g)) admission.set(g, out);
        }
      }
    }
    const run = this.procession();
    const scene = run && this.scenes.get(run.id);
    if (admitEvents) {
      for (const life of this.tiles.values()) life.eventPopulation = 0;
      this.eventAgents = [];
    }
    if (ref && run && scene instanceof GroundProcessionScene) {
      const scope = this.eventScope(run);
      if (admitEvents) {
        const cached = (this.eventReservations = {
          terrain: this.groundTerrain!,
          scope,
          scene,
          actors: [] as { token: object; body: Body; owner: TileLife }[],
          spans: [] as { token: object; body: Body }[],
        });
        const candidates = scene.agents(run.progress, this.clock, {
          scope,
          inspection: this.inspection,
          owner: (id) => {
            let owner = this.eventOwners.get(id);
            if (!owner) this.eventOwners.set(id, (owner = {}));
            return owner;
          },
        });
        const arrivals = scene.route.kind === 'mass' ? new Occupancy() : undefined;
        const terrain = this.groundTerrain!;
        if (this.eventTileDescriptors?.terrain !== terrain)
          this.eventTileDescriptors = {
            terrain,
            tiles: [...this.tiles.values()]
              .sort((a, b) => b.tile.z - a.tile.z)
              .map((life) => {
                const o = origin(life),
                  units = life.perMeter / o.scale;
                return {
                  life,
                  x: o.x,
                  y: o.y,
                  endX: o.x + EXTENT / units,
                  endY: o.y + EXTENT / units,
                  units,
                };
              }),
          };
        const tiles = this.eventTileDescriptors.tiles;
        const at = { x: 0, y: 0 },
          ahead = { x: 0, y: 0 },
          local = { x: 0, y: 0 };
        const toMetric = (q: [number, number], out: { x: number; y: number }) => {
          const at = lngLatToTile(ref.tile, q[0], q[1]);
          out.x = at.x / ref.perMeter;
          out.y = at.y / ref.perMeter;
          return out;
        };
        const bridgeAllows = (body: Body) => {
          const points = bodyCorners(body).map((point) =>
            tileToLngLat(ref.tile, {
              x: point.x * ref.perMeter,
              y: point.y * ref.perMeter,
            }),
          );
          return eventBridgeAllows(scene.ground, points);
        };
        for (const agent of candidates) {
          const projected = lngLatToTile(ref.tile, agent.lng, agent.lat);
          at.x = projected.x / ref.perMeter;
          at.y = projected.y / ref.perMeter;
          let owner: TileLife | undefined;
          for (const descriptor of tiles) {
            if (
              at.x < descriptor.x ||
              at.x >= descriptor.endX ||
              at.y < descriptor.y ||
              at.y >= descriptor.endY
            )
              continue;
            local.x = (at.x - descriptor.x) * descriptor.units;
            local.y = (at.y - descriptor.y) * descriptor.units;
            if (this.owns(descriptor.life, local)) {
              owner = descriptor.life;
              break;
            }
          }
          if (!owner || owner.population >= MAX_TILE_AGENTS) continue;
          toMetric(agent.ahead!, ahead);
          const dx = ahead.x - at.x,
            dy = ahead.y - at.y,
            d = Math.hypot(dx, dy) || 1;
          let token = this.eventOwners.get(eventActor(agent)!);
          if (!token) this.eventOwners.set(eventActor(agent)!, (token = {}));
          const dimensions = eventBodySize(agent);
          const out = buffer(token).live;
          const body = out[0] ?? (out[0] = { x: 0, y: 0, hx: 0, hy: 0, length: 0, width: 0 });
          body.x = at.x;
          body.y = at.y;
          body.hx = dx / d;
          body.hy = dy / d;
          body.length = dimensions.length;
          body.width = dimensions.width;
          body.kind = agent.vehicle ? BODY_KIND.vehicle : BODY_KIND.human;
          out.length = 1;
          if (
            (!agent.eventScenery &&
              (admission.conflicts(token, out) > 0 || arrivals?.conflicts(token, out))) ||
            (agent.eventRole ? this.groundTerrain!.hardBlocked : blocked).hits(out) ||
            (water.hits(out) && !bridgeAllows(body))
          )
            continue;
          if (!agent.eventScenery) cached.actors.push({ token, body, owner });
          if (!agent.eventScenery) arrivals?.set(token, out);
          owner.eventPopulation++;
          this.eventAgents.push(agent);
        }
        for (const span of scene.spans(run.progress)) {
          const a = toMetric(span.a, at),
            b = toMetric(span.b, ahead),
            dx = b.x - a.x,
            dy = b.y - a.y,
            length = Math.hypot(dx, dy);
          if (length)
            cached.spans.push({
              token: span,
              body: {
                ...segmentBody(a, b),
                width: span.width,
                kind: BODY_KIND.human,
              },
            });
        }
      }
      const cached = this.eventReservations;
      if (cached?.scene === scene && cached.scope === scope) {
        // Formations compare against ordinary bodies before reserving their authored spacing.
        // Auxiliary guards replay these metric bodies without admission or owner projection.
        for (const { token, body } of cached.actors) occupied.set(token, [body]);
        for (const { token, body } of cached.spans) occupied.set(token, [body]);
      }
    }
    if (buildStart !== undefined)
      this.profiler!.add('clearanceBuild', this.profiler!.time() - buildStart);
    const physicalSample = (
      life: TileLife,
      owner: GroundAgent,
      sample: readonly Body[],
      cached?: Body[],
    ): Body[] => {
      const physical = cached ?? life.groundBodies(owner).map((b) => toRef(origin(life), b));
      for (let i = 0; i < physical.length; i++) {
        const p = physical[i]!,
          s = sample[i]!;
        p.x = s.x;
        p.y = s.y;
        p.hx = s.hx;
        p.hy = s.hy;
      }
      return physical;
    };
    // This helper is allocated once per guard, and invoked only on rejection.
    // Terrain escape and conflict escape retain their distinct acceptance checks.
    const previousPhysical = (
      life: TileLife,
      owner: GroundAgent,
      previous: readonly Body[],
      identity: GroundAgent,
      ignore?: object,
      cached?: Body[],
    ) => {
      const physical = physicalSample(life, owner, previous, cached);
      const score = occupied.conflicts(identity, physical, ignore, physicalShape);
      return { physical, score, before: physical.map((b) => ({ ...b })) };
    };
    const check = (
      life: TileLife,
      owner: GroundAgent,
      before?: GroundAgent,
      ignore?: object,
      reserve = true,
      identity: GroundAgent = owner,
      reject?: (reason: ContinuityRejection) => void,
      previousLife: TileLife = life,
    ) => {
      eventDenials.delete(identity);
      if (!this.owns(life, owner)) return true;
      const crossingTrial = life.crossingWaits.prepare(owner, before, minimum);
      if (!life.crossingWaits.permits(owner, before, this.clock, minimum, crossingTrial))
        return false;
      const onFoot = !('kind' in owner) || isWalker(owner.kind);
      const pair = buffer(owner);
      const next = bodies(life, owner, pair.trial);
      const previous = before ? bodies(previousLife, before, this.groundPrevious, identity) : next;
      let physical: Body[] | undefined;
      const endScore = occupied.conflicts(identity, next, ignore);
      // A clear destination needs no inherited-overlap score. Intermediate
      // poses still compare against the complete previous bodies below.
      const oldScore = before && endScore > 0 ? occupied.conflicts(identity, previous, ignore) : 0;
      let physicalOnly = false;
      let oldPhysicalScore = 0;
      let physicalBefore: Body[] | undefined;
      // Existing overlaps at a density change may escape, but never deepen or tunnel through.
      if (endScore > 0 && (oldScore === 0 || endScore >= oldScore - 1e-6)) {
        if (before && minimum > 0) {
          ({
            physical,
            score: oldPhysicalScore,
            before: physicalBefore,
          } = previousPhysical(life, owner, previous, identity, ignore, physical));
          const score = occupied.conflicts(
            identity,
            (physical = physicalSample(life, owner, next, physical)),
            ignore,
            physicalShape,
          );
          physicalOnly = score === 0 || (oldPhysicalScore > 0 && score < oldPhysicalScore - 1e-6);
        }
        if (!physicalOnly) {
          diagnoseOccupancy?.(identity, next, ignore);
          reject?.('occupancy');
          return false;
        }
      }
      let distance = 0,
        turns = 1;
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity,
        radius = 0;
      for (let i = 0; i < next.length; i++) {
        const b = next[i]!,
          a = previous[i]!;
        distance = Math.max(distance, Math.hypot(b.x - a.x, b.y - a.y));
        turns = Math.max(turns, Math.ceil(Math.hypot(b.hx - a.hx, b.hy - a.hy) * 8));
        x0 = Math.min(x0, a.x, b.x);
        y0 = Math.min(y0, a.y, b.y);
        x1 = Math.max(x1, a.x, b.x);
        y1 = Math.max(y1, a.y, b.y);
        radius = Math.max(
          radius,
          Math.hypot(a.length, a.width) / 2,
          Math.hypot(b.length, b.width) / 2,
        );
      }
      // The half-diagonal encloses every intermediate heading along the whole move.
      x0 -= radius;
      y0 -= radius;
      x1 += radius;
      y1 += radius;
      const crossing = 'kind' in owner || 'walker' in owner;
      const blockedNear = blocked.near(x0, y0, x1, y1);
      const closureNear = !onFoot && !!closure?.near(x0, y0, x1, y1);
      const curbNear =
        !onFoot && vehicleBlocked.polygons.length > 0 && vehicleBlocked.near(x0, y0, x1, y1);
      const waterNear = onFoot && water.near(x0, y0, x1, y1);
      const roadNear = onFoot && roadAccess.near(x0, y0, x1, y1, crossing);
      const steps = Math.max(1, Math.ceil(distance / 0.3), turns);
      // Raster spacing is a preference, while physical terrain and swept collision
      // clearance are mandatory. Resolve inflation-only denials on the reject path.
      let escape: ((sample: readonly Body[]) => boolean) | undefined;
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const sample = this.groundSample;
        sample.length = next.length;
        for (let i = 0; i < next.length; i++) {
          const b = next[i]!;
          const a = previous[i]!;
          const hx = a.hx + (b.hx - a.hx) * t,
            hy = a.hy + (b.hy - a.hy) * t;
          const norm = Math.hypot(hx, hy) || 1;
          const s = sample[i] ?? (sample[i] = { x: 0, y: 0, hx: 0, hy: 0, length: 0, width: 0 });
          s.x = a.x + (b.x - a.x) * t;
          s.y = a.y + (b.y - a.y) * t;
          s.hx = hx / norm;
          s.hy = hy / norm;
          if (a.hx * b.hx + a.hy * b.hy < -0.95) {
            const start = Math.atan2(a.hy, a.hx);
            const delta = Math.atan2(a.hx * b.hy - a.hy * b.hx, a.hx * b.hx + a.hy * b.hy);
            s.hx = Math.cos(start + delta * t);
            s.hy = Math.sin(start + delta * t);
          }
          s.length = b.length;
          s.width = b.width;
        }
        if (
          (blockedNear && blocked.hits(sample)) ||
          (closureNear && closure!.hits(sample)) ||
          (curbNear && vehicleBlocked.hits(sample)) ||
          (waterNear && water.hits(sample)) ||
          (roadNear && !roadAccess.allows(sample, crossing))
        ) {
          if (before && minimum > 0 && !escape) {
            const terrainPhysical = (physical = physicalSample(life, owner, next, physical));
            if (
              terrainPhysical.some((b, i) => b.length < next[i]!.length || b.width < next[i]!.width)
            ) {
              const physicalLegal = (sample: readonly Body[]) => {
                for (let i = 0; i < sample.length; i++) {
                  const p = terrainPhysical[i]!,
                    s = sample[i]!;
                  p.x = s.x;
                  p.y = s.y;
                  p.hx = s.hx;
                  p.hy = s.hy;
                }
                return (
                  (!blockedNear || !blocked.hits(terrainPhysical)) &&
                  (!closureNear || !closure!.hits(terrainPhysical)) &&
                  (!curbNear || !vehicleBlocked.hits(terrainPhysical)) &&
                  (!waterNear || !water.hits(terrainPhysical)) &&
                  (!roadNear || roadAccess.allows(terrainPhysical, crossing))
                );
              };
              const legalBefore = physicalLegal(previous);
              escape = (sample) => legalBefore && physicalLegal(sample);
            } else escape = () => false;
          }
          const mayEscape = escape?.(sample);
          if (!mayEscape) {
            if (
              closureNear &&
              closure!.hits((physical = physicalSample(life, owner, sample, physical)))
            )
              eventDenials.add(identity);
            if (diagnostics) {
              const reason =
                blockedNear && blocked.hits(sample)
                  ? 'building'
                  : waterNear && water.hits(sample)
                    ? 'water'
                    : 'road';
              diagnostics.reject(identity, reason);
            }
            reject?.('terrain');
            return false;
          }
          if (!physicalOnly) {
            physicalOnly = true;
            ({
              physical,
              score: oldPhysicalScore,
              before: physicalBefore,
            } = previousPhysical(life, owner, previous, identity, ignore, physical));
          }
        }
        // The endpoint's complete inflated bodies were checked above. A clear
        // endpoint also encloses its physical sample; only intermediate poses
        // and endpoints retaining a conflict need another pairwise check.
        let increased =
          step === steps && endScore === 0
            ? 0
            : occupied.conflicts(
                identity,
                physicalOnly ? (physical = physicalSample(life, owner, sample, physical)) : sample,
                ignore,
                physicalOnly ? physicalShape : undefined,
                physicalOnly ? physicalBefore : previous,
              );
        if (increased > 0 && !physicalOnly && before && minimum > 0) {
          ({
            physical,
            score: oldPhysicalScore,
            before: physicalBefore,
          } = previousPhysical(life, owner, previous, identity, ignore, physical));
          const end = occupied.conflicts(
            identity,
            (physical = physicalSample(life, owner, next, physical)),
            ignore,
            physicalShape,
          );
          if (end === 0 || (oldPhysicalScore > 0 && end < oldPhysicalScore - 1e-6)) {
            physicalOnly = true;
            increased = occupied.conflicts(
              identity,
              (physical = physicalSample(life, owner, sample, physical)),
              ignore,
              physicalShape,
              physicalBefore,
            );
          }
        }
        if (increased > 0) {
          diagnoseOccupancy?.(identity, sample, ignore);
          reject?.('occupancy');
          return false;
        }
      }
      if (reserve) {
        life.crossingWaits.accept(
          owner,
          before,
          this.clock,
          minimum,
          () => life.movers.indexOf(identity as Mover),
          crossingTrial,
        );
        queryOnly?.delete(identity);
        const reserved = reservations.get(identity);
        occupied.set(identity, reserved ? [...next, ...reserved] : next);
        pair.trial = pair.live;
        pair.live = next;
      }
      return true;
    };
    const remove = (owner: object) => {
      occupied.delete(owner);
      queryOnly?.delete(owner);
      reservations.delete(owner as GroundAgent);
      physicalReservations.delete(owner as GroundAgent);
      owners.delete(owner);
      physicalShapes.delete(owner);
    };
    const reserveSeam = (life: TileLife, preview: Mover, identity: Mover) => {
      const reserved = bodies(life, preview, []).map((b) => ({ ...b }));
      reservations.set(identity, reserved);
      physicalReservations.set(
        identity,
        life.groundBodies(preview).map((b) => toRef(origin(life), b)),
      );
      occupied.set(identity, [...occupied.bodies(identity), ...reserved]);
    };
    const views = new Map<TileLife, PedestrianView>();
    const pedestrians = (life: TileLife) => {
      let view = views.get(life);
      if (!view)
        views.set(life, (view = pedestrianView(occupied, minimum, origin(life), queryOnly)));
      return view;
    };
    const clearSeam = (
      life: TileLife,
      preview: Mover,
      identity: Mover,
      reject?: (reason: ContinuityRejection) => void,
    ) => {
      const physical = life.groundBodies(preview).map((b) => toRef(origin(life), b));
      // The predicted boundary is future space, so it cannot inherit conflicts
      // from another predicted pose through the ordinary escape exception.
      if (blocked.hits(physical)) {
        diagnostics?.reject(identity, 'building');
        reject?.('terrain');
        return false;
      }
      if (occupied.firstConflict(identity, physical, undefined, physicalShape)) {
        diagnoseOccupancy?.(identity, physical, undefined, true);
        reject?.('occupancy');
        return false;
      }
      return true;
    };
    const roadQueue = (life: TileLife, preview: Mover, identity: Mover) => {
      if (identity.kind !== 'vehicle') return false;
      const road = life.geo.lineIds?.[preview.line];
      if (
        road === undefined ||
        !usableLines.vehicle.includes(life.geo.kinds[preview.line]! as LifeLine)
      )
        return false;
      const physical = life.groundBodies(preview).map((b) => toRef(origin(life), b));
      const blocker = occupied.firstConflict(identity, physical, undefined, physicalShape);
      if (!blocker || !('kind' in blocker) || !('speed' in blocker)) return false;
      const other = blocker as Mover,
        otherLife = owners.get(other),
        source = owners.get(identity);
      if (
        !source ||
        !otherLife ||
        other.kind !== 'vehicle' ||
        !other.vehicle ||
        otherLife.geo.lineIds?.[other.line] !== road
      )
        return false;
      const heading = life.pose(preview),
        ahead = otherLife.pose(other);
      if (heading.hx * ahead.hx + heading.hy * ahead.hy < 0.95) return false;
      const at = source.pose(identity),
        frame = frameBetween(source.tile, otherLife.tile);
      return (
        (ahead.x - frame.x - at.x * frame.scale) * heading.hx +
          (ahead.y - frame.y - at.y * frame.scale) * heading.hy >
        0
      );
    };
    const contact = (life: TileLife, m: Mover, trial = m) => {
      if (this.inspection?.owner === m || m.speed <= 0) return;
      if (this.clock - (this.failedYield.get(m) ?? -Infinity) < RECOVERY.contactRetrySeconds)
        return;
      const physical = life.groundBodies(trial, 0, [], m).map((b) => toRef(origin(life), b));
      const blocker = occupied.firstConflict(m, physical, undefined, physicalShape);
      if (!blocker || !('kind' in blocker) || !('speed' in blocker)) return;
      const other = blocker as Mover,
        otherLife = owners.get(other);
      if (this.clock - (this.failedYield.get(other) ?? -Infinity) < RECOVERY.contactRetrySeconds)
        return;
      if (!otherLife || this.inspection?.owner === other || other.speed <= 0 || other.pause > 0)
        return;
      const visiting = otherLife.scenes.visits.get(other);
      if (visiting && visiting.state !== 'approach' && visiting.state !== 'return') return;
      const ownVisit = life.scenes.visits.get(m);
      if (ownVisit && ownVisit.state !== 'approach' && ownVisit.state !== 'return') return;
      if (otherLife.scenes.held(other) || life.scenes.held(m)) return;
      this.reciprocalBlockers.set(m, { other, at: this.clock });
      const reciprocal = this.reciprocalBlockers.get(other);
      if (
        reciprocal?.other !== m ||
        this.clock - reciprocal.at > RECOVERY.reciprocalSeconds ||
        this.yieldingActors.has(m) ||
        this.yieldingActors.has(other)
      )
        return;
      const age = (owner: Mover, tile: TileLife) =>
        Math.max(owner.waiting ?? 0, tile.scenes.visits.get(owner)?.blocked ?? 0);
      const key = (owner: Mover, tile: TileLife) =>
        `${tile.tile.z}/${tile.tile.x}/${tile.tile.y}/${String(tile.movers.indexOf(owner)).padStart(5, '0')}`;
      const first =
        Number(this.junctions.granted(m)) - Number(this.junctions.granted(other)) ||
        age(m, life) - age(other, otherLife) ||
        -key(m, life).localeCompare(key(other, otherLife));
      const priority = first >= 0 ? m : other,
        yielder = first >= 0 ? other : m;
      // A road vehicle retains its committed route; a walker searches a holding
      // corridor. Two vehicles retain their existing checked recovery controller.
      if (!isWalker(yielder.kind)) return;
      const priorityLife = first >= 0 ? life : otherLife;
      const radius = (actor: Mover, tile: TileLife) => {
        const pose = tile.pose(actor);
        return Math.max(
          ...tile
            .groundBodies(actor)
            .map(
              (body) =>
                Math.hypot(body.x - pose.x / tile.perMeter, body.y - pose.y / tile.perMeter) +
                Math.hypot(body.length, body.width) / 2,
            ),
        );
      };
      const point = priorityLife.pose(priority);
      const at = origin(priorityLife);
      const anchor = occupied
        .bodies(yielder)
        .slice(0, (first >= 0 ? otherLife : life).groundBodies(yielder).length)
        .map((body, i) => {
          const physical = physicalShape(yielder, body, i);
          return {
            ...physical,
            x: (physical.x - at.x) / at.scale,
            y: (physical.y - at.y) / at.scale,
            length: physical.length / at.scale,
            width: physical.width / at.scale,
          };
        });
      this.yieldingActors.set(yielder, {
        priority,
        tile: priorityLife.tile,
        x: point.x,
        y: point.y,
        clearance: 2 * (radius(m, life) + radius(other, otherLife)) + 0.5,
        anchor,
        travelled: 0,
      });
      this.passingActors.set(priority, yielder);
    };
    const yielding = (m: Mover) => {
      const decision = this.yieldingActors.get(m);
      if (!decision) return;
      const life = owners.get(decision.priority);
      if (!life) {
        this.yieldingActors.delete(m);
        return;
      }
      const point = life.pose(decision.priority),
        frame = frameBetween(life.tile, decision.tile);
      const pm = 1 / metersPerUnit(decision.tile);
      const distance =
        Math.hypot(
          frame.x + point.x * frame.scale - decision.x,
          frame.y + point.y * frame.scale - decision.y,
        ) / pm;
      decision.travelled = Math.max(decision.travelled, distance);
      let cleared = distance > decision.clearance;
      if (!cleared && decision.travelled >= 0.5 && decision.anchor.length) {
        // On a short route, the complete rear can pass the original holding
        // anchor before travelling twice both bounding radii. A checked turn
        // away can also clear it. Return movement still uses the swept guard.
        const direction = life.scenes.travelHeading(decision.priority, true),
          scale = (life.perMeter * frame.scale) / pm;
        const extent = (body: Body) =>
          (Math.abs(body.hx * direction.hx + body.hy * direction.hy) * body.length +
            Math.abs(-body.hy * direction.hx + body.hx * direction.hy) * body.width) /
          2;
        const front = Math.max(
          ...decision.anchor.map(
            (body) => body.x * direction.hx + body.y * direction.hy + extent(body),
          ),
        );
        const rear = Math.min(
          ...life.groundBodies(decision.priority).map((body) => {
            const physical = {
              ...body,
              x: frame.x / pm + body.x * scale,
              y: frame.y / pm + body.y * scale,
              length: body.length * scale,
              width: body.width * scale,
            };
            return physical.x * direction.hx + physical.y * direction.hy - extent(physical);
          }),
        );
        cleared = rear > front + 0.15;
      }
      if (cleared) {
        this.yieldingActors.delete(m);
        return;
      }
      return decision.priority;
    };
    const holding = (life: TileLife, m: Mover, changedOnly = false) => {
      const decision = this.yieldingActors.get(m);
      const priorityLife = decision && owners.get(decision.priority);
      if (!decision || !priorityLife) return true;
      const route = priorityLife.scenes.visits.get(decision.priority)?.path;
      if (changedOnly && decision.route === route) return true;
      const waiting = life.groundBodies(m).map((body) => toRef(origin(life), body));
      const moving = priorityLife
        .groundBodies(decision.priority)
        .map((body) => toRef(origin(priorityLife), body));
      const priority = decision.priority,
        o = origin(priorityLife);
      const start = {
        x: o.x + (priority.x / priorityLife.perMeter) * o.scale,
        y: o.y + (priority.y / priorityLife.perMeter) * o.scale,
      };
      const path = priorityLife.scenes.travelPath(priority, true);
      const direction = priorityLife.scenes.travelHeading(priority, true);
      const points = path?.length
        ? path.map((point) => ({
            x: o.x + (point.x / priorityLife.perMeter) * o.scale,
            y: o.y + (point.y / priorityLife.perMeter) * o.scale,
          }))
        : [
            {
              x: start.x + direction.hx * decision.clearance,
              y: start.y + direction.hy * decision.clearance,
            },
          ];
      // Prove the whole retained visit path, including any later return through
      // the holding area. Linear sweeps avoid sampling long routes at each metre.
      let previous = start,
        heading = { hx: moving[0]!.hx, hy: moving[0]!.hy };
      const clear = (point: { x: number; y: number }, hx: number, hy: number) =>
        moving.every((body) => {
          const sample = {
            ...body,
            x: body.x + point.x - start.x,
            y: body.y + point.y - start.y,
            hx,
            hy,
          };
          return waiting.every((other) => !bodiesOverlap(sample, other));
        });
      for (const point of points) {
        const length = Math.hypot(point.x - previous.x, point.y - previous.y);
        if (length < 1e-8) continue;
        const hx = (point.x - previous.x) / length,
          hy = (point.y - previous.y) / length;
        const angle = Math.atan2(
            heading.hx * hy - heading.hy * hx,
            heading.hx * hx + heading.hy * hy,
          ),
          initial = Math.atan2(heading.hy, heading.hx);
        for (let turn = 0; turn <= 8; turn++) {
          const bearing = initial + (angle * turn) / 8;
          if (!clear(previous, Math.cos(bearing), Math.sin(bearing))) return false;
        }
        for (const body of moving) {
          const sample = {
            ...body,
            x: body.x + previous.x - start.x,
            y: body.y + previous.y - start.y,
            hx,
            hy,
          };
          const target = {
            x: body.x + point.x - start.x,
            y: body.y + point.y - start.y,
          };
          if (waiting.some((other) => sweptBodyOverlap(sample, target, other))) return false;
        }
        previous = point;
        heading = { hx, hy };
      }
      decision.route = route;
      return true;
    };
    const holdingCorridor = (life: TileLife, m: Mover, before: Mover) => {
      const previous = life.groundBodies(before, 0, [], m).map((body) => toRef(origin(life), body));
      return life.groundBodies(m).every((body, i) => {
        const next = toRef(origin(life), body),
          old = previous[i]!;
        return (
          Math.hypot(next.hx - old.hx, next.hy - old.hy) < 1e-8 &&
          !blocked.sweptHits(old, next) &&
          !water.sweptHits(old, next) &&
          !roadAccess.forbidden.sweptHits(old, next)
        );
      });
    };
    const passing = (m: Mover) => {
      const other = this.passingActors.get(m);
      return !!other && yielding(other) === m;
    };
    const cancelYield = (m: Mover) => {
      const decision = this.yieldingActors.get(m);
      this.yieldingActors.delete(m);
      this.failedYield.set(m, this.clock);
      if (decision) this.failedYield.set(decision.priority, this.clock);
    };
    const methods = {
      eventDenied: (owner: object) => eventDenials.has(owner),
      remove,
      reserveSeam,
      clearSeam,
      roadQueue,
      contact,
      yielding,
      holding,
      holdingCorridor,
      passing,
      cancelYield,
      pedestrians,
    };
    if (!this.profiler) return Object.assign(check, methods);
    return Object.assign((...args: Parameters<typeof check>) => {
      const start = this.profiler!.time();
      this.profiler!.check();
      try {
        return check(...args);
      } finally {
        this.profiler!.add('clearanceChecks', this.profiler!.time() - start);
      }
    }, methods);
  }

  /**
   * The terrain the main-thread cell packer needs, versioned by identity. Callers must not mutate
   * the returned indexes.
   */
  cellTerrain() {
    const ref = this.groundTerrain?.ref;
    const terrain = this.groundTerrain;
    if (!ref || !terrain) return undefined;
    return {
      version: terrain,
      events: this.eventGrounds,
      blocked: terrain.blocked,
      hardBlocked: terrain.hardBlocked,
      ref: { tile: ref.tile, perMeter: ref.perMeter },
      forbidden: terrain.roadAccess.forbidden,
      roads: terrain.roadAccess.roads,
      trees: terrain.trees,
    };
  }

  /** Whole ASCII cells must obey the same ground rules, even when wider than a figure. */
  groundCellGuard(toCell: (lng: number, lat: number) => [number, number], terrainOnly = false) {
    const ref = this.groundTerrain?.ref;
    const terrain = this.groundTerrain;
    if (!ref || !terrain) return undefined;
    return makeCellGuard(
      ref,
      terrain.roadAccess,
      terrain.trees,
      toCell,
      this.eventGrounds,
      terrain.blocked,
      terrain.hardBlocked,
      terrainOnly,
    );
  }

  /**
   * Move every tile's agents on by `dt` seconds. `gustAt(lng, lat)` is how hard the wind blows
   * in a tree's crown there (life/wind.ts strength × glyphs/select.ts treeGust); a strong gust
   * flushes birds out of the tree. With `zoom`, only the kinds that show at it move (config.ts
   * `LIFE_ZOOM`): the others wait, unseen, until they show. With `bounds` (the view's), only
   * those near it move (`STEP_MARGIN_M`), trains aside. With `wind` (in world axes, x east and
   * y south), circling flocks drift with it; they also shelter from the rain, and take off
   * from whoever comes near, as last drawn (`visible`).
   */
  step(
    dt: number,
    gustAt?: (lng: number, lat: number) => number,
    zoom?: number,
    bounds?: LngLatBounds,
    wind?: LifeEnv['wind'],
    weather?: Pick<
      LifeEnv,
      'rain' | 'minutes' | 'season' | 'date' | 'folkloreDate' | 'sunAltitude' | 'windPreset'
    >,
    cellMeters = 0,
    cellAspect = DEFAULT_CELLS.aspect,
    effectCellMeters = cellMeters,
    pointer?: readonly [number, number],
    taps?: readonly LifeTap[],
    tapPointer?: TapPointer,
  ) {
    this.tapReceipts = undefined;
    this.syncSeason(weather?.season);
    if (this.seasonalConfig) for (const tile of this.tiles.values()) this.trimSeasonalStalls(tile);
    const clamped = Math.min(MAX_STEP_S, Math.max(0, dt));
    // Timed playback follows accepted viewer time, while physical movement keeps its safe step.
    // Otherwise a slow drawing frame stretches the scheduled event and its displayed clock.
    if (this.played?.timing) this.played.elapsed += Math.max(0, dt);
    this.effectCellMeters = effectCellMeters;
    this.crossingCellMeters = cellMeters;
    if (clamped === 0) {
      this.resolveTaps(taps, weather?.minutes, zoom, weather?.rain ?? this.lastRain);
      this.stepEventTaps(0, zoom);
      this.sampleFolklore(weather, 0);
      return;
    }
    if (bounds && this.viewContext) this.viewContext = { ...this.viewContext, bounds };
    this.clock += clamped;
    this.emojiClock += Math.max(0, dt);
    this.resolveTaps(taps, weather?.minutes, zoom, weather?.rain ?? this.lastRain);
    this.stepEventTaps(Math.max(0, dt), zoom);
    this.pruneRetired();
    if (!this.tiles.size) {
      this.folklore.clear(true);
      this.arrivals.clear();
      return;
    }
    if (this.emergencyDispatch) {
      this.emergencyRegions = [
        ...this.emergencyOwners()
          .filter((o) => [...this.tiles.values()].includes(o.life))
          .map((o) => tileToLngLat(o.life.tile, o.mover)),
        ...this.emergencyRouter!.network.targets.filter(
          (t) => t.kind === 'fire' || t.kind === 'police',
        )
          .filter((t) =>
            [...this.tiles.values()].some((life) => {
              const p = lngLatToTile(life.tile, ...t.at);
              return inTile(p) && this.owns(life, p);
            }),
          )
          .map((t) => t.at),
      ];
    }
    const shows =
      zoom === undefined
        ? undefined
        : (kind: AgentKind) => bandVisibility(LIFE_ZOOM[kind], zoom) >= 1;
    const env: LifeEnv = {
      inspecting: this.inspection?.owner,
      clock: this.clock,
      emojiTime: { clock: this.emojiClock, dt: Math.max(0, dt) },
      levels: this.lastLevels,
      rain: this.lastRain,
      wind,
      effectCellMeters,
      nextSourceId: this.nextSourceId,
      ...weather,
      diagnostics: this.profiler?.lifeDiagnostics,
      cityLife: this.cityLife,
      emojiSeasons: this.seasons,
      emojiView: this.emojiView,
      ...(pointer ? { pointer: { lngLat: pointer, cellMeters } } : {}),
      ...(tapPointer ? { tapPointer } : {}),
    };
    this.sampleFolklore(weather, Math.max(0, dt));
    const folklore = this.folklore.manananggal;
    if (folklore && folklore.alpha > 0.001) env.folkloreDisturber = folklore;
    const event = this.procession();
    const eventScene = event && this.scenes.get(event.id);
    const groundEvent = eventScene instanceof GroundProcessionScene;
    // Global event admission needs every body rank; ordinary movement retains its normal
    // activity, view and query-only attendant rules while replaying those reservations.
    const guard = this.groundGuard(
      cellMeters,
      undefined,
      bounds,
      !!this.emergencyDispatch,
      undefined,
      true,
      groundEvent ? eventGroundBounds(eventScene.ground) : undefined,
      shows,
    );
    const owners = [...this.tiles.values()].sort((a, b) => b.tile.z - a.tile.z);
    const ownerAt = (source: TileLife, p: { x: number; y: number }) =>
      owners.find((life) => {
        const f = frameBetween(source.tile, life.tile);
        const q = { x: f.x + p.x * f.scale, y: f.y + p.y * f.scale };
        return inTile(q) && this.owns(life, q);
      });
    const seamQueue = (source: TileLife, m: Mover) => {
      if (m.kind !== 'vehicle') return false;
      const seam = seamAhead(source, m, this.covers.get(source) ?? [], 12 * source.perMeter);
      const target = seam && ownerAt(source, seam.preview);
      if (!seam || !target || target === source) return false;
      const preview = target.projectFrom(seam.preview, source, { insideTile: true });
      return !!preview && guard.roadQueue(target, preview, m);
    };
    this.junctions.begin(new Set(this.tiles.values()));
    const eligibility = new Map<TileLife, (m: Mover) => boolean>();
    const recoveries = new Map<TileLife, Set<number>>();
    const recoveryAttempts = new Set<Mover>();
    let recoveredNow: Set<Mover> | undefined;
    const heldForRecovery = (life: TileLife, m: Mover) => {
      if (
        !life.scenes.transferable(m) ||
        (m.kind === 'vehicle' &&
          (life.signals.vehicleLimit(m, clamped, this.clock, { target: m.speed, cap: Infinity }) ||
            life.courtesyHeld(m, guard.pedestrians(life), clamped)))
      )
        return true;
      if (!seamQueue(life, m)) return false;
      // A mapped leader owns this queue. Its ordinary recovery remains eligible.
      this.clearSeamRecovery(m);
      return true;
    };
    for (const tile of this.tiles.values()) {
      const near = this.activityNear(tile, bounds, STEP_MARGIN_M * tile.perMeter);
      const active = (m: Mover) =>
        this.owns(tile, m) &&
        (!shows || shows(m.kind)) &&
        near(m.x, m.y) &&
        (!env.levels || m.rank < env.levels[m.kind]) &&
        !tile.scenes.hidden(m);
      eligibility.set(tile, active);
      tile.prepareRecovery(active, env.inspecting);
    }
    for (const [m, tile] of this.queuedSeams) {
      const active = eligibility.get(tile);
      if (!active || !tile.movers.includes(m) || !this.rejectedSeams.get(m)?.queued) {
        this.clearSeamRecovery(m);
        continue;
      }
      if (env.inspecting === m || !active(m) || heldForRecovery(tile, m)) continue;
      let lines = recoveries.get(tile);
      if (!lines) recoveries.set(tile, (lines = new Set()));
      recoveryAttempts.add(m);
      if (
        tile.recoverVehicle(
          m,
          (owner, before, reserve) =>
            this.owns(tile, owner) && guard(tile, owner, before, undefined, reserve),
          this.junctions,
          lines,
          (p) => this.owns(tile, p),
          clamped,
        )
      ) {
        (recoveredNow ??= new Set()).add(m);
        this.clearSeamRecovery(m);
        this.seamWait.delete(m);
        env.diagnostics?.recovery(m, 'seam');
      }
    }
    for (const tile of this.tiles.values()) tile.prepareTraffic(eligibility.get(tile)!);
    this.junctionTraffic.begin(this.tiles.values().next().value!);
    for (const tile of this.tiles.values())
      for (const m of tile.movers) if (eligibility.get(tile)!(m)) this.junctionTraffic.add(tile, m);
    const crossingGeometryChanged = this.preparedCrossingVersion !== this.crossingGeometryVersion;
    if (crossingGeometryChanged || this.dirtyCrossingConsumers.size) {
      const sources = [...this.tiles.values()];
      for (const tile of sources) {
        if (!crossingGeometryChanged && !this.dirtyCrossingConsumers.has(tile)) continue;
        const bounds = tile.junctionCrossings.bounds(this.junctions);
        tile.junctionCrossings.prepare(
          sources.filter((source) => tile.junctionCrossings.relevant(source, bounds)),
          crossingGeometryChanged ? this.crossingGeometryVersion : undefined,
          bounds,
        );
      }
      this.dirtyCrossingConsumers.clear();
      this.preparedCrossingVersion = this.crossingGeometryVersion;
    }

    for (const [key, tile] of this.tiles)
      tile.requestJunctions(
        this.junctions,
        eligibility.get(tile)!,
        this.clock,
        key,
        this.junctionTraffic,
        guard.pedestrians(tile),
      );
    this.junctions.resolve(this.clock);
    const trains = trainLimits(
      [...this.tiles.values()],
      clamped,
      this.mixedZoom ? (life, m) => this.owns(life, m) : undefined,
      env.inspecting,
    );
    const seamLimits = new Map<Mover, SeamLimit>();
    const intents: {
      source: TileLife;
      target: TileLife;
      m: Mover;
      before: Mover;
      boundary: Mover;
    }[] = [];
    const inbound = new Map<TileLife, number>();
    const rejected = (life: TileLife, m: Mover, key: string, final = false) => {
      if (heldForRecovery(life, m)) return;
      let history = this.rejectedSeams.get(m);
      if (history?.key !== key) {
        history = { key, seconds: 0, at: -1, queued: false, final };
        this.rejectedSeams.set(m, history);
      } else if (final) history.final = true;
      if (history.at !== this.clock) {
        history.seconds += clamped;
        history.at = this.clock;
      }
      history.queued = history.seconds >= SEAMS.rejectedSeconds;
      if (history.queued) this.queuedSeams.set(m, life);
    };
    for (const source of this.tiles.values())
      for (const m of source.movers) {
        if (
          env.inspecting === m ||
          (m.kind !== 'vehicle' && m.kind !== 'boat') ||
          !eligibility.get(source)!(m) ||
          !source.scenes.transferable(m)
        )
          continue;
        const history = this.rejectedSeams.get(m);
        const pm = source.perMeter,
          k = kinematicsOf(m.vehicle);
        const length = m.vehicle ? VEHICLES[m.vehicle].length : 0;
        const reach = Math.max(
          12 * pm,
          (m.v ?? m.speed) ** 2 / (2 * k.brake * pm) + (length + 2) * pm,
        );
        // Cheap uniform-tile rejection keeps the additional work off ordinary inner-tile traffic.
        if (!this.covers.has(source) && Math.min(m.x, m.y, EXTENT - m.x, EXTENT - m.y) > reach) {
          if (history) this.clearSeamRecovery(m);
          continue;
        }
        const seam = seamAhead(source, m, this.covers.get(source) ?? [], reach);
        if (!seam) {
          this.seamWait.delete(m);
          if (history) this.clearSeamRecovery(m);
          continue;
        }
        this.profiler?.countContinuity('attempts');
        const target = ownerAt(source, seam.preview);
        let rejectionKey: string | undefined;
        if (history) {
          rejectionKey = this.seamRejectionKey(source, m, target);
          if (history.key !== rejectionKey) this.clearSeamRecovery(m);
        }
        if (!target || target === source) {
          const key = `${source.tile.z}/${source.tile.x}/${source.tile.y}/${seam.preview.line}/${seam.preview.dir}`;
          let wait = this.seamWait.get(m);
          if (wait?.key !== key) {
            wait = { key, at: source.elapsed };
            this.seamWait.set(m, wait);
          }
          if (source.elapsed - wait.at >= SEAMS.missingSeconds) continue;
        } else this.seamWait.delete(m);
        const reject =
          this.profiler &&
          ((reason: ContinuityRejection) => {
            this.profiler!.countContinuity(reason);
            this.profiler!.lifeDiagnostics?.tag(m, 'rejectedSeam');
            this.profiler!.lifeDiagnostics?.tag(m, `seam:${reason}`);
          });
        let preview: Mover | undefined;
        if (!target || target === source) reject?.('ownership');
        else if (target.population + (inbound.get(target) ?? 0) >= MAX_TILE_AGENTS)
          reject?.('capQuota');
        else preview = target.projectFrom(seam.preview, source, { reject, insideTile: true });
        const safe =
          preview &&
          target &&
          (m.kind === 'boat'
            ? this.boatRoom(target, preview, m, intents)
            : guard.clearSeam(target, preview, m, reject) &&
              guard(target, preview, seam.preview, undefined, false, m, reject, source));
        if (safe && target && preview) {
          // A successful preflight ends preflight refusals. Final handover
          // refusals end only when adoption succeeds, not at its next preview.
          if (history && !history.final) this.clearSeamRecovery(m);
          guard.reserveSeam(target, preview, m);
          inbound.set(target, (inbound.get(target) ?? 0) + 1);
          intents.push({ source, target, m, before: { ...m }, boundary: seam.preview });
          seamLimits.set(m, { room: Infinity, crossing: true, boundary: seam.preview });
        } else {
          if (target && target !== source)
            rejected(source, m, rejectionKey ?? this.seamRejectionKey(source, m, target));
          seamLimits.set(m, {
            room: Math.max(0, seam.distance - (length / 2 + FOLLOW.minGap) * pm),
            crossing: false,
          });
        }
      }
    for (const tile of this.tiles.values()) {
      const inTile = gustAt
        ? (x: number, y: number) => gustAt(...tileToLngLat(tile.tile, { x, y }))
        : undefined;
      const near = bounds && this.activityNear(tile, bounds, STEP_MARGIN_M * tile.perMeter);
      tile.step(
        clamped,
        inTile,
        shows,
        near,
        env,
        Object.assign(
          (
            owner: GroundAgent,
            before?: GroundAgent,
            reserve?: boolean,
            reject?: (reason: ContinuityRejection) => void,
          ) => guard(tile, owner, before, undefined, reserve, owner, reject),
          {
            eventDenied: (owner: object) => guard.eventDenied(owner),
            pedestrians: guard.pedestrians(tile),
            contact: (mover: Mover, trial?: Mover) => guard.contact(tile, mover, trial),
            holding: (mover: Mover, changedOnly?: boolean) =>
              guard.holding(tile, mover, changedOnly),
            holdingCorridor: (mover: Mover, before: Mover) =>
              guard.holdingCorridor(tile, mover, before),
            passing: (mover: Mover) => guard.passing(mover),
            cancelYield: (mover: Mover) => guard.cancelYield(mover),
            yielding: (mover: Mover) => guard.yielding(mover),
          },
        ),
        {
          crossingGuard: true,
          pedestrians: guard.pedestrians(tile),
          junctions: this.junctions,
          trains,
          momentView: { zoom: zoom ?? MOMENTS.zoom, cellWidth: cellMeters, cellAspect },
          seams: seamLimits,
          owns: this.covers.has(tile) ? (p) => this.owns(tile, p) : undefined,
          recoveredLines: recoveries.get(tile),
          recoveryAttempts,
          recoveredNow,
          recovered: (m) => this.clearSeamRecovery(m),
        },
      );
    }
    // All original owners have stepped once. New owners start stepping on the next frame.
    const effectOwners = intents.length ? new Map<Mover, TileLife>() : undefined;
    for (const { source, target, m, before, boundary } of intents) {
      // The preview is already 1 mm beyond the boundary. Do not attempt early
      // adoption while the matching nudge still leaves the cursor source-owned.
      const clipped =
        Math.hypot(m.x - boundary.x, m.y - boundary.y) <= (0.001 + 1e-8) * source.perMeter;
      if (ownerAt(source, m) !== target && !clipped) continue;
      const held = this.junctions.movement(m);
      const reject =
        this.profiler?.lifeDiagnostics &&
        ((reason: ContinuityRejection) => this.profiler!.lifeDiagnostics!.tag(m, `seam:${reason}`));
      if (
        target.adoptFrom(
          m,
          source,
          {
            nudgeM: clipped ? 0.001 : 0,
            reject,
            insideTile: true,
            crossingClock: this.clock,
            crossingMinimum: cellMeters,
          },

          (preview) =>
            inTile(preview) &&
            this.owns(target, preview) &&
            (m.kind === 'boat'
              ? this.boatRoom(target, preview, m, [])
              : guard(target, preview, m, undefined, false, m, reject, source)),
        )
      ) {
        this.profiler?.countContinuity('transfers');
        this.clearSeamRecovery(m);
        effectOwners!.set(m, target);
        if (held) {
          this.junctions.rebind(
            m,
            target,
            [...this.tiles].find(([, life]) => life === target)![0],
            source,
          );
          this.dirtyCrossingConsumers.add(target);
        }
        guard.remove(m);
        if (m.kind === 'vehicle') guard(target, m, m);
      } else {
        // A final pose/clearance check can fail after a bend or another actor's accepted step.
        this.profiler?.lifeDiagnostics?.tag(m, 'rejectedSeam');
        rejected(source, m, this.seamRejectionKey(source, before, target), true);
        // Keep the original owner at its last safe pose instead of hiding it beyond the seam.
        restoreMover(m, before);
        m.v = 0;
        guard.remove(m);
        if (m.kind === 'vehicle') guard(source, m);
      }
    }
    for (const tile of this.tiles.values())
      tile.finishEffects(this.clock, clamped, wind, effectOwners);
    // Trains run on from tile to tile; one leaving the tiles on screen is gone.
    let leaving: { from: TileLife; m: Mover }[] | undefined;
    for (const tile of this.tiles.values()) {
      for (const m of tile.takeLeavers(
        this.mixedZoom ? (m) => trains.has(m) && !this.owns(tile, m) : undefined,
      ))
        (leaving ??= []).push({ from: tile, m });
    }
    for (const { from, m } of leaving ?? []) {
      const dx = m.x < 0 ? -1 : m.x >= EXTENT ? 1 : 0;
      const dy = m.y < 0 ? -1 : m.y >= EXTENT ? 1 : 0;
      const destinations = this.mixedZoom
        ? [...this.tiles.values()].sort((a, b) => b.tile.z - a.tile.z)
        : this.tiles.values();
      for (const next of destinations) {
        const { tile } = next;
        if (this.mixedZoom) {
          if (next === from) continue;
          const f = frameBetween(from.tile, tile);
          const p = { x: f.x + m.x * f.scale, y: f.y + m.y * f.scale };
          if (!inTile(p) || !this.owns(next, p)) continue;
          if (tile.z === from.tile.z) next.adopt(m, dx, dy);
          else {
            // takeLeavers releases array ownership; restore it for transactional zoom admission.
            from.movers.push(m);
            if (!next.adoptFrom(m, from, { snapM: TRAIN.handover })) from.release(m);
          }
          break;
        }
        if (tile.z === from.tile.z && tile.x === from.tile.x + dx && tile.y === from.tile.y + dy) {
          next.adopt(m, dx, dy);
          break;
        }
      }
    }
    if (!shows || shows('train')) this.stepArrivals(clamped);
    this.retireStalled();
    this.admitBirths(clamped);
    if (this.emergencyDispatch && (!shows || shows('vehicle')) && this.viewContext) {
      const owners = this.emergencyOwners();
      this.emergencyDispatch.step(
        clamped,
        owners,
        ({ life, mover }) =>
          [...this.tiles.values()].includes(life) &&
          life.movers.includes(mover) &&
          this.owns(life, mover) &&
          !!eligibility.get(life)?.(mover) &&
          !this.inspection?.held(mover) &&
          !life.scenes.hidden(mover),
        ({ life, mover }) => outsideView(life, life.groundBodies(mover), this.viewContext!, 0),
        ({ life, mover }) => {
          const stop = life.emergencyArrival(mover);
          return (
            !!stop &&
            stop.remaining <= EMERGENCY.arrivalM &&
            (mover.v ?? 0) <= 0.1 * life.perMeter &&
            Math.abs(life.offsetOf(mover) - stop.curb) <= EMERGENCY.curbToleranceM
          );
        },
        (request) => this.spawnEmergency(request),
        (owner) => this.releaseEmergency(owner),
      );
    }
    this.retainCrossingClaims();
    this.crossingReservations.resolve();
    if (this.seasonalConfig) for (const tile of this.tiles.values()) this.trimSeasonalStalls(tile);
    if (this.profiler)
      for (const [key, life] of this.tiles)
        for (const m of life.movers) {
          const diagnostics = this.profiler.lifeDiagnostics;
          if (!this.profiler.tracing(m) && !diagnostics?.tracks(m)) continue;
          const [lng, lat] = tileToLngLat(life.tile, life.pose(m));
          if (diagnostics?.position(m, lng, lat, key)) {
            if (this.seamWait.has(m)) diagnostics.tag(m, 'rejectedSeam');
            if (life.junctionFootprint(m)) diagnostics.tag(m, 'junctionFootprint');
          }
          this.profiler.traceTraveler(m, { at: this.clock, tile: key, event: 'step', lng, lat });
        }
  }

  /** Connected running routes share an arrival clock, including duplicated buffered lines. */
  private boatRoom(
    target: TileLife,
    preview: Mover,
    identity: Mover,
    reserved: readonly { source: TileLife; target: TileLife; m: Mover }[],
  ) {
    const bodies = target.groundBodies(preview);
    for (const life of this.tiles.values()) {
      const f = frameBetween(life.tile, target.tile);
      const scale = (f.scale * life.perMeter) / target.perMeter;
      for (const m of life.movers) {
        if (m === identity || m.kind !== 'boat' || !this.owns(life, m)) continue;
        const other = life.groundBodies(m).map((b) => ({
          ...b,
          x: f.x / target.perMeter + b.x * scale,
          y: f.y / target.perMeter + b.y * scale,
          length: b.length * scale + FOLLOW.minGap * 2,
          width: b.width * scale,
        }));
        if (bodies.some((a) => other.some((b) => bodiesOverlap(a, b)))) return false;
      }
    }
    for (const intent of reserved) {
      if (intent.m.kind !== 'boat' || intent.target !== target) continue;
      const projected = target.projectFrom(intent.m, intent.source);
      if (
        projected &&
        bodies.some((a) => target.groundBodies(projected).some((b) => bodiesOverlap(a, b)))
      )
        return false;
    }
    return true;
  }
  /**
   * A vehicle that fixed obstacles have held for `STALL.terrainSeconds` (a mapped road narrower
   * than its traffic, say), or that the guard has refused every move for `STALL.anySeconds` (two
   * bodies locked together), would hold up everyone behind it for good. It leaves once nobody
   * can see it go. Waiting at a signal or in a queue isn't refused movement and doesn't count.
   */
  private retireStalled() {
    const view = this.viewContext;
    if (!view) return;
    for (const life of this.tiles.values())
      for (let i = life.movers.length - 1; i >= 0; i--) {
        const m = life.movers[i]!;
        if (
          m.kind === 'vehicle' &&
          ((m.terrainWait ?? 0) >= STALL.terrainSeconds ||
            (m.guardWait ?? 0) >= STALL.anySeconds) &&
          this.owns(life, m) &&
          outsideView(life, life.groundBodies(m), view, 0)
        ) {
          if (m.emergency) this.releaseEmergency({ life, mover: m });
          else life.release(m);
        }
      }
  }

  private admitBirths(dt: number) {
    const context = {
      view: this.viewContext,
      lives: [...this.tiles.values()],
      credit: this.birthCredit,
      cursor: this.birthCursor,
      owns: (life: TileLife, point: { x: number; y: number }) => this.owns(life, point),
      guard: (life: TileLife) => {
        // Ground actors stay within their buffered owner and adjacent tiles. Include every
        // overlapping coarse/fine owner in a full one-tile halo; trains/boats check globally.
        const region = new Set(
          [...this.tiles.values()].filter((other) => {
            const f = frameBetween(other.tile, life.tile);
            return (
              f.x < 2 * EXTENT &&
              f.y < 2 * EXTENT &&
              f.x + EXTENT * f.scale > -EXTENT &&
              f.y + EXTENT * f.scale > -EXTENT
            );
          }),
        );
        return this.groundGuard(0, undefined, undefined, true, region);
      },
      boatRoom: (life: TileLife, mover: Mover) => this.boatRoom(life, mover, mover, []),
      count: this.profiler && ((event: ContinuityCounter) => this.profiler!.countContinuity(event)),
    };
    admitBirths(context, dt);
    this.birthCredit = context.credit;
    this.birthCursor = context.cursor;
  }

  /** Admit complete bodies against freshly accepted ordinary births and prior dispatches. */
  private spawnEmergency(request: EmergencyRequest): EmergencyOwner | undefined {
    const view = this.viewContext,
      router = this.emergencyRouter;
    if (!view || !router) return;
    const { kind, run, attempt, station } = request,
      craft = emergencyCraft(kind),
      spec = VEHICLES[craft];
    const seed = hashString(`${kind}/${run}/${attempt}`),
      candidates: (EmergencyOwner & { stationEntry: boolean })[] = [];
    const path =
      kind === 'fire' && station && request.target
        ? router.path(router.targets.get(station)!.at, request.target)
        : undefined;
    for (const life of [...this.tiles.values()].sort(
      (a, b) => a.tile.z - b.tile.z || a.tile.x - b.tile.x || a.tile.y - b.tile.y,
    )) {
      if (life.population >= MAX_TILE_AGENTS) continue;
      for (let line = 0; line < life.geo.kinds.length; line++) {
        const rule = spawnRules[life.geo.kinds[line]! as LifeLine].find(
          (r) => r.kind === 'vehicle',
        );
        if (!rule) continue;
        for (const dir of [1, -1] as const) {
          if (life.geo.oneway?.[line] && life.geo.oneway[line] !== dir) continue;
          const baseSpeedMps =
            (rule.speed[0] + ((rule.speed[1] - rule.speed[0]) * seed) / 0x1_0000_0000) * spec.speed;
          const m: Mover = {
            kind: 'vehicle',
            vehicle: craft,
            line,
            dir,
            from: life.geo.starts[line]!,
            d: 0,
            speed: baseSpeedMps * life.perMeter,
            v: 0,
            paint: kind === 'ambulance' ? 11 : kind === 'police' ? 5 : 3,
            lane: 0,
            pause: 0,
            rank: 0,
            x: 0,
            y: 0,
            hx: 1,
            hy: 0,
            routing: { seed, turns: 0 },
            emergency: {
              id: `${kind}/${run}`,
              kind,
              phase: kind === 'police' ? 'patrol' : 'responding',
              lights: kind !== 'police',
              baseSpeedMps,
              remaining: 0,
              offscreen: 0,
              run,
              ...(station && { station }),
              ...(request.target && { target: request.target }),
            },
          };
          const distances = entryDistances(
            life,
            m,
            view,
            Math.max(BIRTHS.margin, view.spawnMarginM) + spec.length / 2 + 1,
          );
          if (station) {
            const target = router.targets.get(station)!;
            if (life.geo.lineIds?.[line] === hashString(target.road)) {
              const p = lngLatToTile(life.tile, ...target.at),
                c = life.geo.coords;
              let along = 0;
              for (let v = life.geo.starts[line]!; v < life.geo.starts[line + 1]! - 1; v++) {
                const ax = c[v * 2]!,
                  ay = c[v * 2 + 1]!,
                  dx = c[v * 2 + 2]! - ax,
                  dy = c[v * 2 + 3]! - ay,
                  length = Math.hypot(dx, dy);
                const t = length
                  ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / length ** 2))
                  : 0;
                if (Math.hypot(p.x - ax - t * dx, p.y - ay - t * dy) <= 3 * life.perMeter)
                  distances.unshift({ line, distance: along + t * length });
                along += length;
              }
            }
          }
          for (const entrance of distances) {
            const candidate = life.placeSeed({ ...m, line: entrance.line }, entrance.distance);
            if (
              !candidate ||
              !inTile(candidate) ||
              !this.owns(life, candidate) ||
              !outsideView(
                life,
                life.birthBodies(candidate),
                view,
                Math.max(BIRTHS.margin, view.spawnMarginM),
              )
            )
              continue;
            const point = tileToLngLat(life.tile, candidate),
              heading = [candidate.hx, candidate.hy] as const;
            if (kind === 'ambulance') {
              const route = router.routeAt(point, 'hospital', heading);
              if (!route || route.cost < EMERGENCY.approachM) continue;
              candidate.emergency = { ...candidate.emergency!, target: route.target.id };
            } else if (
              kind === 'fire' &&
              (!path?.length ||
                !router
                  .positions(point, heading)
                  .some((p) =>
                    path.some(
                      (leg) =>
                        leg.edge === p.edge &&
                        leg.dir === p.dir &&
                        (p.t - leg.fromT) * p.dir >= -0.03 &&
                        (leg.toT - p.t) * p.dir >= -0.03,
                    ),
                  ))
            )
              continue;
            if (
              kind === 'fire' &&
              (router.routeAt(point, request.target!, heading)?.cost ?? 0) < EMERGENCY.approachM
            )
              continue;
            candidates.push({
              life,
              mover: candidate,
              stationEntry:
                !!station &&
                Math.hypot(
                  ...(() => {
                    const p = lngLatToTile(life.tile, ...router.targets.get(station)!.at);
                    return [candidate.x - p.x, candidate.y - p.y] as [number, number];
                  })(),
                ) <=
                  3 * life.perMeter,
            });
          }
        }
      }
    }
    if (!candidates.length) return;
    const preferred = candidates.filter((c) => c.stationEntry),
      choices = preferred.length
        ? [...preferred, ...candidates.filter((c) => !c.stationEntry)]
        : candidates;
    let guard: ReturnType<LifeWorld['groundGuard']> | undefined;
    const context = {
      lives: [...this.tiles.values()],
      credit: 0,
      cursor: 0,
      owns: (life: TileLife, point: { x: number; y: number }) => this.owns(life, point),
      guard: () => (guard ??= this.groundGuard(0, undefined, undefined, true)),
      boatRoom: () => false,
    };
    for (let i = 0; i < Math.min(32, choices.length); i++) {
      const owner = choices[(preferred.length ? i : seed + i) % choices.length]!,
        { life, mover } = owner;
      if (!birthFits(context, life, mover, context.guard())) continue;
      life.movers.push(mover);
      guard!(life, mover);
      return owner;
    }
  }

  /** Connected running routes share an arrival clock, including duplicated buffered lines. */
  private arrivalRoutes() {
    const tileKey = [...this.tiles.keys()].join('|');
    if (this.railTopology?.key === tileKey) return this.railTopology.routes;
    const lines: { life: TileLife; line: number; id: number; ends: string[] }[] = [];
    const ends = new Map<string, number>();
    const ids = new Map<number, number>();
    const parents: number[] = [];
    const root = (i: number): number => {
      while (parents[i] !== i) {
        parents[i] = parents[parents[i]!]!;
        i = parents[i]!;
      }
      return i;
    };
    for (const life of this.tiles.values())
      for (let line = 0; line < life.geo.kinds.length; line++) {
        if (life.geo.kinds[line] !== LifeLine.rail) continue;
        const id =
          life.geo.lineIds?.[line] ??
          hashString(`${life.tile.z}/${life.tile.x}/${life.tile.y}/${line}`);
        const endpoint = (v: number) => {
          // Quantize world Mercator coordinates at roughly one meter, independent of tile zoom.
          const scale = MERCATOR_METERS / (EXTENT * 2 ** life.tile.z);
          return `${Math.round((life.tile.x * EXTENT + life.geo.coords[v * 2]!) * scale)}/${Math.round((life.tile.y * EXTENT + life.geo.coords[v * 2 + 1]!) * scale)}`;
        };
        const entry = {
          life,
          line,
          id,
          ends: [endpoint(life.geo.starts[line]!), endpoint(life.geo.starts[line + 1]! - 1)],
        };
        const index = lines.length;
        parents.push(index);
        lines.push(entry);
        const same = ids.get(id);
        if (same !== undefined) parents[root(index)] = root(same);
        else ids.set(id, index);
        for (const key of entry.ends) {
          const other = ends.get(key);
          if (other !== undefined) parents[root(index)] = root(other);
          else ends.set(key, index);
        }
      }
    const routes = new Map<number, typeof lines>();
    lines.forEach((line, i) => {
      const key = root(i),
        route = routes.get(key);
      if (route) route.push(line);
      else routes.set(key, [line]);
    });
    this.railTopology = { key: tileKey, routes: [...routes.values()] };
    return this.railTopology.routes;
  }

  private stepArrivals(dt: number) {
    const keep = new Set<string>();
    for (const route of this.arrivalRoutes()) {
      const key = [...new Set(route.map((r) => r.id))].sort((a, b) => a - b).join('/');
      keep.add(key);
      let clock = this.arrivals.get(key);
      if (!clock) {
        const rng = random(hashString(key) ^ 0x47bd5c31);
        this.arrivals.set(
          key,
          (clock = { rng, left: between(rng, TRAIN.arrivals), occupied: false }),
        );
      }
      const occupied = route.some((r) =>
        r.life.movers.some((m) => m.train && m.line === r.line && this.owns(r.life, m)),
      );
      if (occupied) {
        clock.occupied = true;
        continue;
      }
      if (clock.occupied) {
        clock.left = between(clock.rng, TRAIN.arrivals);
        clock.occupied = false;
      }
      clock.left -= dt * (this.lastLevels?.train ?? 1);
      if (clock.left > 0) continue;
      // Try the longest track fragments first; short isolated tracks cannot hold a train.
      const meters = (r: (typeof route)[number]) => r.life.lineLength(r.line) / r.life.perMeter;
      const ordered = [...route].sort((a, b) => meters(b) - meters(a) || a.id - b.id);
      const arrived = ordered.some((r) =>
        r.life.arrive(
          r.line,
          clock.rng,
          this.covers.has(r.life) ? (m) => this.owns(r.life, m) : undefined,
        ),
      );
      clock.left = arrived ? between(clock.rng, TRAIN.arrivals) : 10;
      clock.occupied = arrived;
    }
    for (const key of this.arrivals.keys()) if (!keep.has(key)) this.arrivals.delete(key);
  }

  /** Host commands use the current route to retain only compatible ordinary drawables. */
  processionRoute(id: string | undefined) {
    return id ? this.scenes.get(id)?.route : undefined;
  }
  /** The city's processions (its `<slug>.processions.json`). */
  setProcessions(routes: readonly ProcessionRoute[]) {
    this.played = undefined;
    this.live = undefined;
    this.suspendedLiveOwners = undefined;
    this.releaseEventActors();
    this.eventGrounds = groundsForRoutes(routes);
    this.scenes.clear();
    for (const route of routes)
      this.scenes.set(
        route.id,
        route.kind === 'fluvial' ? new ProcessionScene(route) : new GroundProcessionScene(route),
      );
    this.reconcileEventTraffic();
  }

  /** Play a procession from its start, as a time-lapse (`ProcessionScene.playDuration`). */
  play(id: string, timing?: EventTiming): boolean {
    if (!this.scenes.has(id)) return false;
    this.eventTaps?.clear();
    this.eventTaps = undefined;
    if (!this.played && this.live) {
      const scene = this.scenes.get(this.live.id);
      this.suspendedLiveOwners = {
        ...this.live,
        owners: new Map(this.eventOwners),
        ...(scene instanceof GroundProcessionScene &&
          scene.route.kind === 'mass' && {
            adoption: { scene, state: scene.saveAdoption() },
          }),
      };
    }
    const adopted = this.handover(id);
    this.played = { id, start: this.clock, elapsed: 0, timing };
    this.releaseEventActors(false, adopted);
    this.reconcileEventTraffic();
    return true;
  }

  stop() {
    if (this.played) this.finishPlayback();
  }

  private finishPlayback() {
    const scene = this.played && this.scenes.get(this.played.id);
    if (this.played?.id !== this.live?.id && scene instanceof GroundProcessionScene) scene.reset();
    this.played = undefined;
    this.releaseEventActors(false);
    const saved = this.suspendedLiveOwners;
    if (
      saved &&
      this.live &&
      saved.id === this.live.id &&
      saved.occurrence === this.live.occurrence
    ) {
      if (saved.adoption) saved.adoption.scene.restoreAdoption(saved.adoption.state);
      for (const [id, owner] of saved.owners) this.eventOwners.set(id, owner);
    }
    this.suspendedLiveOwners = undefined;
    this.reconcileEventTraffic();
  }

  private eventScope(run: ProcessionRun) {
    return run.live ? `live/${this.live?.occurrence ?? run.id}` : `play/${this.played?.start}`;
  }

  private handover(id: string) {
    const previous = this.procession();
    const next = this.scenes.get(id);
    if (
      next instanceof GroundProcessionScene &&
      next.route.kind === 'mass' &&
      previous &&
      next.route.follows === previous.id
    ) {
      const old = this.scenes.get(previous.id);
      const scope = this.eventScope(previous);
      next.adopt(
        old instanceof ProcessionScene
          ? old.arrivalCrowd(previous.progress, this.clock, scope, this.inspection)
          : this.eventAgents,
      );
      if (old instanceof ProcessionScene)
        for (const [id, owner] of old.arrivalOwners(scope)) this.eventOwners.set(id, owner);
      return true;
    } else if (next instanceof GroundProcessionScene) next.reset();
    return false;
  }

  private trimSeasonalStalls(life: TileLife) {
    const before = life.seasonalStalls.length;
    life.clearSeasonalStalls(Math.max(0, MAX_TILE_AGENTS - life.population));
    if (life.eventPopulation && life.seasonalStalls.length < before)
      this.eventTrimmedStalls.add(life);
  }

  private releaseEventActors(reset = true, retainOwners = false) {
    this.eventAgents = [];
    this.eventReservations = undefined;
    if (!retainOwners) this.eventOwners.clear();
    for (const life of this.tiles.values()) life.eventPopulation = 0;
    // Re-admit trimmed sites once capacity returns, even when season and quota agree
    // with the inputs saved before the event. Keep the shared budget during playback.
    for (const life of this.eventTrimmedStalls) this.stallInputs.delete(life);
    if (this.eventTrimmedStalls.size) this.seasonsDirty = true;
    this.eventTrimmedStalls.clear();
    if (reset)
      for (const scene of this.scenes.values())
        if (scene instanceof GroundProcessionScene) scene.reset();
  }

  /** The procession under way by its schedule, and how far through it is; or none. */
  setLive(id: string | undefined, progress = 0, occurrence?: string) {
    if (!(progress >= 0 && progress < 1)) id = undefined;
    if (id !== this.live?.id || occurrence !== this.live?.occurrence) {
      const adopted = !this.played && id ? this.handover(id) : false;
      if (!this.played) this.releaseEventActors(false, adopted);
      else {
        const old = this.live && this.scenes.get(this.live.id);
        if (this.live?.id !== this.played.id && old instanceof GroundProcessionScene) old.reset();
      }
      this.suspendedLiveOwners = undefined;
    }
    this.live = id && this.scenes.has(id) ? { id, progress, occurrence } : undefined;
    this.syncEventTaps();
    this.reconcileEventTraffic();
  }

  /** The procession to show: one being played, else a live one. */
  procession(): ProcessionRun | undefined {
    if (this.played) {
      const duration = this.scenes.get(this.played.id)!.playDuration;
      const progress =
        (this.played.timing ? this.played.elapsed : this.clock - this.played.start) / duration;
      if (progress < 1) {
        if (this.played.timing && this.played.time?.progress !== progress)
          this.played.time = { progress, value: eventTime(this.played.timing, progress) };
        return {
          id: this.played.id,
          progress,
          live: false,
          ...(this.played.time && { time: this.played.time.value }),
        };
      }
      this.finishPlayback();
    }
    return this.live && { id: this.live.id, progress: this.live.progress, live: true };
  }

  get size() {
    return this.tiles.size;
  }

  /** The same frozen/running clock used by traffic stopping and fixture colors. */
  get signalClock() {
    return this.clock;
  }

  /** Fill a walker's ordinary look with its realised canopy, preserving seated figures. */
  private umbrellaLook(
    look: PersonLook,
    walker: Walker,
    share: number,
    zoom: number,
    clock: number,
  ): PersonLook {
    if (walker.figure !== 'adult') return look;
    const want = underUmbrella(walker, share);
    const open =
      zoom >= UMBRELLA_MOTION.zoom ? this.umbrellas.look(walker, want, clock) : Number(want);
    if (open > 0) {
      if (open < 1) look.canopy = { open, figure: look.figure, paint: look.paint };
      look.figure = 'umbrella';
      look.paint = walker.canopy;
    }
    return look;
  }

  /**
   * The agents to draw at `zoom` and time of day: those whose kind shows at the zoom and who
   * are out (config.ts `activityLevels`), movers only inside their own tile (tiles overlap in their
   * buffers), at most `MAX_VISIBLE_AGENTS`, nearest `center` first. The `weather` opens
   * umbrellas (config.ts `umbrellaShare`). With `bounds` (the view's), those well outside them
   * are left out before any are placed.
   */
  visible(
    zoom: number,
    levelsOrDaylight: Activity | number,
    center: [number, number],
    weather: LifeWeather = { rain: 0, sunAltitude: 0 },
    bounds?: LngLatBounds,
    crowd = 1,
    maxAgents = MAX_VISIBLE_AGENTS,
  ): VisibleAgent[] {
    const umbrellaMotionVisible = zoom >= UMBRELLA_MOTION.zoom;
    if (umbrellaMotionVisible && !this.umbrellaMotionVisible) this.umbrellas.reset();
    this.umbrellaMotionVisible = umbrellaMotionVisible;
    // A bare number is the daylight, with no clock (config.ts `activityLevels`).
    const levels =
      typeof levelsOrDaylight === 'number' ? activityLevels(levelsOrDaylight) : levelsOrDaylight;
    this.lastLevels = levels;
    this.lastCrowd = crowd;
    this.lastRain = weather.rain;
    const shows = (kind: AgentKind) => bandVisibility(LIFE_ZOOM[kind], zoom) >= 1;
    const out: VisibleAgent[] = [];
    const tapOwners = this.tapSources;
    tapOwners?.begin();
    const diagnostics = this.profiler?.lifeDiagnostics;
    diagnostics?.beginVisible();
    this.actorSources.clear();
    let collectPuffs = false;
    if (shows('vehicle') && levels.vehicle > 0)
      for (const life of this.tiles.values())
        if (life.puffs.size) {
          collectPuffs = true;
          break;
        }
    const inspection = this.inspection;
    inspection?.begin(this.clock);
    // Choose the plain fallback once, outside the per-actor loop.
    const normalPush: (owner: object, agent: VisibleAgent) => number = inspection
      ? (owner, agent) => {
          tapOwners?.present(owner, agent);
          return out.push(inspection.present(owner, agent));
        }
      : (owner, agent) => {
          tapOwners?.present(owner, agent);
          return out.push(agent);
        };
    const present = diagnostics
      ? (owner: object, agent: VisibleAgent) => {
          const n = normalPush(owner, agent);
          diagnostics.view(owner, out[n - 1]!);
          return n;
        }
      : normalPush;
    const push = (owner: object, agent: VisibleAgent) => {
      const cue = this.emojiMemory.cue(owner);
      if (
        cue &&
        !agent.speech &&
        !agent.aboard &&
        !agent.parked &&
        !agent.prop &&
        (!agent.consist ||
          (agent.vehicle === 'locomotive' && cue.subject === 'driver' && cue.mood === 'honk')) &&
        agent.vehicle !== 'carabao'
      )
        agent.emoji = cue;
      return present(owner, agent);
    };
    let birdCues: Map<VisibleAgent, Flock> | undefined;
    const owners = zoom >= MOMENTS.zoom ? new Map<object, VisibleAgent>() : undefined;
    const balls: { agent: VisibleAgent; a: object; b: object }[] = [];
    const umbrellas = umbrellaShare(weather.rain, weather.sunAltitude);
    // A procession closes the river to other boats, and always shows.
    const run = this.procession();
    const scene = run && this.scenes.get(run.id)!;
    const eventTaps = this.syncEventTaps();
    const staged =
      scene instanceof GroundProcessionScene
        ? this.eventAgents
            .filter(
              (a) =>
                shows(a.kind) &&
                (!bounds ||
                  (a.lng >= bounds[0] &&
                    a.lng <= bounds[2] &&
                    a.lat >= bounds[1] &&
                    a.lat <= bounds[3])),
            )
            .slice(0, maxAgents)
            .map((raw) => {
              const a = eventTaps ? identifyEventActor({ ...raw }, eventActor(raw)!) : raw;
              const owner = this.eventOwners.get(eventActor(a)!)!;
              const agent = inspection
                ? identifyEventActor(inspection.present(owner, a), eventActor(a)!)
                : a;
              tapOwners?.present(owner, agent);
              return agent;
            })
        : scene
          ? scene.agents(run.progress, this.clock, {
              boats: shows('boat'),
              crowds: zoom >= PROCESSION.crowdZoom,
              crews: zoom >= PROCESSION.crewZoom,
              bounds,
              inspection,
              scope: this.eventScope(run),
              ...(tapOwners && {
                observe: (owner: object, agent: VisibleAgent) => {
                  tapOwners.present(owner, agent);
                },
              }),
            })
          : [];
    for (const agent of staged) agent.event = true;
    // A few of the event's people pray, wave or call out its cheers, in turns.
    if (scene && staged.length) {
      this.cheers ??= eventCheers(
        this.momentOptions?.enabled === false ? undefined : this.momentOptions?.dialogue,
      );
      assignEventCues(staged, scene.route.kind, this.clock, {
        cheers: this.cheers[scene.route.kind],
        emoji: this.emojiObserver,
      });
    }
    // Explicit reactions take precedence over the running event's background cues.
    if (eventTaps && tapOwners)
      for (const agent of staged) {
        const owner = tapOwners.owner(agent);
        if (owner) eventTaps.attach(owner, agent);
      }
    for (const life of this.tiles.values()) {
      const { tile, perMeter } = life;
      if (life.tapFeed && this.emojiClock >= life.tapFeed.until) life.tapFeed = undefined;
      if (life.tapFeed && shows('bird')) {
        const feed = life.tapFeed;
        for (const offset of feedCrumbs(feed.seed)) {
          const [lng, lat] = tileToLngLat(tile, {
            x: feed.x + offset.x * perMeter,
            y: feed.y + offset.y * perMeter,
          });
          if (
            !bounds ||
            (lng >= bounds[0] && lng <= bounds[2] && lat >= bounds[1] && lat <= bounds[3])
          )
            out.push({ kind: 'person', prop: 'event', glyph: '.', lng, lat, flap: 0 });
        }
      }
      const inView = viewIn(tile, bounds, VIEW_MARGIN_M * perMeter);
      for (const m of life.movers) {
        if (!this.owns(life, m)) continue;
        if (!shows(m.kind) || !life.visibleMover(m, levels, crowd)) continue;
        if (scene instanceof ProcessionScene && m.kind === 'boat') continue;
        if (m.x < 0 || m.x >= EXTENT || m.y < 0 || m.y >= EXTENT) continue;
        if (m.train) {
          if (this.viewContext && !outsideView(life, life.birthBodies(m), this.viewContext, 0))
            this.previouslyVisible.add(m);
          // A train is long, and there are few: all its cars, wherever its head is.
          for (const car of trainCars(life, m)) push(m, { ...car, consist: m.train });
          continue;
        }
        if (!inView(m.x, m.y)) continue;
        if (this.viewContext) this.previouslyVisible.add(m);
        this.profiler?.observeVisible(m, m.kind === 'vehicle' || m.kind === 'boat');
        // Keep right, in a lane that fits the road: offset to the right of the heading (tile y
        // points down).
        const { x, y, hx, hy } = life.pose(m);
        const [lng, lat] = tileToLngLat(tile, { x, y });
        let ahead = tileToLngLat(tile, { x: x + hx * perMeter, y: y + hy * perMeter });
        const creature = this.folklore.manananggal;
        if (m.kind === 'dog' && creature && creature.alpha > 0.001) {
          const at = lngLatToTile(tile, creature.lng, creature.lat),
            dx = at.x - x,
            dy = at.y - y,
            distance = Math.hypot(dx, dy);
          if (distance > 1e-9 && distance <= FOLKLORE.dogRadius * perMeter)
            ahead = tileToLngLat(tile, {
              x: x + (dx / distance) * perMeter,
              y: y + (dy / distance) * perMeter,
            });
        }
        if (m.vehicle) {
          const side = tileToLngLat(tile, { x: x - hy * perMeter, y: y + hx * perMeter });
          const motor =
            m.kind === 'vehicle' &&
            hasTurnSignals(m.vehicle) &&
            VEHICLES[m.vehicle].length >= STAMP_MIN_CELLS * this.effectCellMeters;
          const effects = motor ? vehicleEffects(m) : undefined;
          const lamps = motor
            ? visibleLamps(
                m.vehicle,
                effects?.brake,
                life.scenes.held(m) || emergencyParked(m),
                m.routing,
                inspection?.clock(m, this.clock) ?? this.clock,
              )
            : undefined;
          const agent: VisibleAgent = {
            kind: m.kind,
            lng,
            lat,
            ahead,
            side,
            vehicle: m.vehicle,
            paint: m.paint,
            turnSignal:
              m.kind === 'vehicle' && lamps?.kind !== 'hazard'
                ? visibleTurnSignal(
                    m.routing,
                    inspection?.clock(m, this.clock) ?? this.clock,
                    m.laneSignal,
                  )
                : undefined,
            flap: 0,
          };
          if (lamps) agent.lamps = lamps;
          if (m.emergency) {
            if (emergencyParked(m)) agent.parked = true;
            const beacon = emergencyBeacon(
              m.emergency,
              m.routing?.seed ?? 0,
              inspection?.clock(m, this.clock) ?? this.clock,
            );
            if (beacon) agent.beacon = beacon;
          }
          if (collectPuffs && effects?.sourceId !== undefined)
            this.actorSources.set(agent, effects.sourceId);
          push(m, agent);
        } else if (m.group) {
          const stride = Math.floor((m.walked ?? 0) / PEOPLE.stride);
          const clock = inspection?.clock(m, this.clock) ?? this.clock;
          // Steering and turning change the drawn facing, while every member
          // retains the centre accepted in the physical formation's frame.
          const place = (w: { lateral: number; back: number }, member: number) => {
            const wait = m.crossingWait?.waiting?.poses[member];
            if (wait) {
              const dx = (m.x - x) / perMeter + wait.x,
                dy = (m.y - y) / perMeter + wait.y;
              return {
                lateral: -hy * dx + hx * dy,
                back: -(hx * dx + hy * dy),
              };
            }
            const formation = m.momentFacing ?? m;
            if (formation.hx === hx && formation.hy === hy)
              return { lateral: w.lateral, back: w.back };
            const wx = -formation.hy * w.lateral - formation.hx * w.back,
              wy = formation.hx * w.lateral - formation.hy * w.back;
            return { lateral: -hy * wx + hx * wy, back: -(hx * wx + hy * wy) };
          };
          const people = m.group.map((w, member) =>
            this.umbrellaLook(
              {
                figure: w.figure,
                paint: w.shirt,
                ...place(w, member),
                // Standing still, feet together.
                flap:
                  m.pause > 0 || (m.crossingWait?.waiting && !m.crossingWait.waiting.releasing)
                    ? 0
                    : (stride + w.step) & 1,
                pose: life.momentHost.pose(m, member),
              },
              w,
              umbrellas,
              zoom,
              clock,
            ),
          );
          const speech = life.momentHost.moments.speech(m) ?? life.momentHost.scenes.speech(m);
          const agent: VisibleAgent = {
            kind: m.kind,
            lng,
            lat,
            ahead,
            flap: 0,
            people,
            ...(speech && {
              speech: { ...speech, id: `${tile.z}/${tile.x}/${tile.y}:${speech.id}` },
            }),
            mappedPersonMover:
              m.kind === 'person' &&
              people.every((look) => look.figure !== 'seated' && look.figure !== 'rower')
                ? true
                : undefined,
          };
          push(m, agent);
          owners?.set(m, agent);
        } else if (m.kind === 'dog' || m.kind === 'cat') {
          // Standing, sniffing, or lying down, it keeps still.
          const still = m.pause > 0 || life.scenes.still(m);
          const cat = m.kind === 'cat';
          // Cats sit (2) or groom (3); lying dogs use their resting silhouette (2).
          const stillFlap = cat ? (m.grooming ? 3 : 2) : m.lying ? 2 : 0;
          const stride = cat ? CAT.stride : DOG.stride;
          const flap = still ? stillFlap : Math.floor((m.walked ?? 0) / stride) & 1;
          push(m, {
            kind: m.kind,
            lng,
            lat,
            ahead,
            paint: m.paint,
            flap,
          });
        } else {
          push(m, {
            kind: m.kind,
            lng,
            lat,
            ahead,
            flap: 0,
            mappedPersonMover: m.kind === 'person' ? true : undefined,
          });
        }
      }
      if (shows('person')) {
        for (const s of life.seasonalStalls.length ? life.allStalls() : life.stalls) {
          if (!this.owns(life, s)) continue;
          if (!vendorAttendance(s, levels, crowd) || !inTile(s)) continue;
          if (!inView(s.x, s.y)) continue;
          const [lng, lat] = tileToLngLat(tile, s);
          const speech = life.momentHost.scenes.speech(s);
          const agent: VisibleAgent = {
            kind: 'person',
            lng,
            lat,
            ahead: tileToLngLat(tile, { x: s.x + s.hx * perMeter, y: s.y + s.hy * perMeter }),
            side: tileToLngLat(tile, { x: s.x - s.hy * perMeter, y: s.y + s.hx * perMeter }),
            vehicle: 'cart',
            covered: s.covered,
            paint: s.paint,
            flap: 0,
            people: [
              {
                figure: 'adult',
                paint: s.shirt,
                lateral: s.side,
                back: 0,
                flap: 0,
                pose: life.momentHost.pose(s),
              },
            ],
            ...(speech && {
              speech: { ...speech, id: `${tile.z}/${tile.x}/${tile.y}:${speech.id}` },
            }),
          };
          push(s, agent);
        }
      }
      if (shows('person')) {
        for (const g of life.gatherers) {
          if (!this.owns(life, g)) continue;
          if (g.rank >= gathererShare(g, levels) * crowd || !inView(g.x, g.y)) continue;
          const w = g.walker;
          const figure = g.behavior === 'sit' ? 'seated' : w.figure;
          const still = g.pause > 0 || g.behavior === 'sit';
          const look = this.umbrellaLook(
            {
              figure,
              paint: w.shirt,
              lateral: 0,
              back: 0,
              // Standing still (or sitting), feet together.
              flap: still ? 0 : (Math.floor(g.walked / PEOPLE.stride) + w.step) & 1,
              pose: life.momentHost.pose(g) ?? (still && g.momentFacing ? 'attentive' : undefined),
            },
            w,
            umbrellas,
            zoom,
            inspection?.clock(g, this.clock) ?? this.clock,
          );
          const at = (x: number, y: number) => tileToLngLat(tile, { x, y });
          if (g.carabao !== undefined) {
            // The carabao a pace ahead, its farmer walking beside it.
            const x = g.x + g.hx * 1.8 * perMeter;
            const y = g.y + g.hy * 1.8 * perMeter;
            const [lng, lat] = at(x, y);
            push(g, {
              kind: 'person',
              lng,
              lat,
              ahead: at(x + g.hx * perMeter, y + g.hy * perMeter),
              side: at(x - g.hy * perMeter, y + g.hx * perMeter),
              vehicle: 'carabao',
              paint: g.carabao,
              flap: 0,
              people: [{ ...look, lateral: 1 }],
            });
          } else {
            const wait = g.crossingWait?.waiting?.poses[0];
            const gx = g.x + (wait?.x ?? 0) * perMeter,
              gy = g.y + (wait?.y ?? 0) * perMeter;
            const [lng, lat] = at(gx, gy);
            const { hx, hy } = wait ?? g.momentFacing ?? g;
            const ahead = at(gx + hx * perMeter, gy + hy * perMeter);
            const agent: VisibleAgent = {
              kind: 'person',
              lng,
              lat,
              ahead,
              flap: 0,
              people: [look],
            };
            const speech = life.momentHost.moments.speech(g) ?? life.momentHost.scenes.speech(g);
            if (speech)
              agent.speech = { ...speech, id: `${tile.z}/${tile.x}/${tile.y}:${speech.id}` };
            push(g, agent);
            owners?.set(g, agent);
          }
        }
      }
      if (zoom >= MOMENTS.zoom)
        for (const ball of life.momentHost.moments.balls()) {
          const [lng, lat] = tileToLngLat(tile, ball);
          balls.push({
            a: ball.a,
            b: ball.b,
            agent: { kind: 'person', prop: 'ball', glyph: '•', lng, lat, flap: 0 },
          });
        }
      if (bandVisibility(PARKED.zoom, zoom) >= 1) {
        for (const p of life.parked) {
          if (!this.owns(life, p)) continue;
          if (p.x < 0 || p.x >= EXTENT || p.y < 0 || p.y >= EXTENT || !inView(p.x, p.y)) continue;
          const [lng, lat] = tileToLngLat(tile, p);
          push(p, {
            kind: 'vehicle',
            lng,
            lat,
            ahead: tileToLngLat(tile, { x: p.x + p.hx * perMeter, y: p.y + p.hy * perMeter }),
            side: tileToLngLat(tile, { x: p.x - p.hy * perMeter, y: p.y + p.hx * perMeter }),
            vehicle: p.vehicle,
            paint: p.paint,
            parked: true,
            flap: 0,
          });
        }
      }
      // Standby trains: the tile that owns a siding draws its whole train, lamps off.
      if (shows('train')) {
        for (const p of life.standby) {
          if (!this.owns(life, p)) continue;
          const [lng, lat] = tileToLngLat(tile, p);
          push(p, {
            kind: 'train',
            lng,
            lat,
            ahead: tileToLngLat(tile, { x: p.x + p.hx * perMeter, y: p.y + p.hy * perMeter }),
            side: tileToLngLat(tile, { x: p.x - p.hy * perMeter, y: p.y + p.hx * perMeter }),
            vehicle: p.vehicle,
            paint: p.paint,
            parked: true,
            flap: 0,
          });
        }
      }
      if (!shows('bird')) continue;
      for (const flock of life.flocks) {
        if (!this.owns(life, flock)) continue;
        const spec = BIRD_SPECIES[flock.species];
        const flockCue = this.emojiMemory.cue(flock);
        const out_ = spec.nocturnal ? levels.night : levels.bird;
        if (
          flock.rank >= out_ * crowd ||
          (!inView(flock.x, flock.y) && !flyingBirdNear(flock, inView))
        )
          continue;
        const wobble = life.elapsed * 0.8;
        const sitting = flock.perched || flock.landed;
        const heading = Math.atan2(flock.hy, flock.hx);
        // Tree perching and scattered flight keep their original spread; ground has its own layout.
        const spread = birdSpread(flock);
        for (const bird of flock.birds) {
          const turn = birdTurn(flock, bird, wobble);
          const ground = isForager(bird) && flock.landed && !bird.flight;
          birdOffset(flock, bird, turn, spread, this.birdOffset);
          const x = this.birdOffset.x + flock.x;
          const y = this.birdOffset.y + flock.y;
          const [lng, lat] = tileToLngLat(tile, { x, y });
          const birdTime = life.elapsed;
          const waiting = bird.takeoff !== undefined && takeoffProgress(flock, bird) === 0;
          const resting = (sitting && !bird.flight) || waiting;
          const flap = resting ? 0 : Math.floor(birdTime * spec.flap + bird.phase * 2) & 1;
          const pose = resting ? BirdPose.perched : flap === 1 ? BirdPose.raised : BirdPose.spread;
          // Flying, each faces a little off the flock's way; sitting, each its own way.
          const peck =
            ground && flock.feeding && bird.wait > 0 && weather.rain < BIRD_WEATHER.shelter
              ? Math.floor(birdTime * 3 + bird.phase * 7) & 1
                ? 0.25
                : -0.25
              : 0;
          const face = bird.flight
            ? Math.atan2(bird.flight.hy, bird.flight.hx)
            : bird.takeoff && flock.takeoff
              ? takeoffProgress(flock, bird) === 0
                ? bird.takeoff.face
                : Math.atan2(y - bird.takeoff.y, x - bird.takeoff.x)
              : ground
                ? bird.face + peck
                : sitting
                  ? bird.phase * 2 * Math.PI
                  : heading + (bird.phase - 0.5) * 0.6;
          const ahead = tileToLngLat(tile, {
            x: x + Math.cos(face) * perMeter,
            y: y + Math.sin(face) * perMeter,
          });
          const n = push(bird, {
            kind: 'bird',
            lng,
            lat,
            ahead,
            flap,
            bird: { species: flock.species, pose },
          });
          if (flockCue) (birdCues ??= new Map()).set(out[n - 1]!, flock);
        }
      }
    }
    const withBirdCues = (admitted: VisibleAgent[]) => {
      if (!birdCues) return admitted;
      const anchors = new Map<Flock, VisibleAgent>();
      const inside = (a: VisibleAgent) =>
        !bounds ||
        (a.lng >= bounds[0] && a.lng <= bounds[2] && a.lat >= bounds[1] && a.lat <= bounds[3]);
      for (const agent of admitted) {
        const flock = birdCues.get(agent);
        if (!flock) continue;
        const prior = anchors.get(flock);
        if (!prior || (!inside(prior) && inside(agent))) anchors.set(flock, agent);
      }
      for (const [flock, agent] of anchors) agent.emoji = this.emojiMemory.cue(flock);
      return admitted;
    };
    const withBalls = (admitted: VisibleAgent[]) => {
      if (!balls.length) return admitted;
      const kept = new Set(admitted);
      // The cap counts ordinary records. Procession prefix and trains are protected.
      let count = 0;
      for (
        let i = scene instanceof GroundProcessionScene ? 0 : staged.length;
        i < admitted.length;
        i++
      )
        if (admitted[i]!.kind !== 'train') count++;
      let spare = Math.max(0, maxAgents - count);
      for (const ball of balls) {
        if (spare <= 0) break;
        const a = owners?.get(ball.a),
          b = owners?.get(ball.b);
        if (a && b && kept.has(a) && kept.has(b)) {
          admitted.push(ball.agent);
          spare--;
        }
      }
      return admitted;
    };
    const eventCount = scene instanceof GroundProcessionScene ? staged.length : 0;
    if (out.length + eventCount <= maxAgents) {
      const result = this.withPuffs(withBirdCues(withBalls([...staged, ...out])), center, bounds);
      const admitted = inspection?.finish(result) ?? result;
      diagnostics?.admitted(admitted);
      tapOwners?.finish(admitted);
      return admitted;
    }
    const [cx, cy] = center;
    // Each one's distance worked out once, not in every comparison.
    const groups = new Map<object, { agents: VisibleAgent[]; d: number; index: number }>();
    for (let index = 0; index < out.length; index++) {
      const agent = out[index]!;
      const key = agent.consist ?? agent;
      const d = (agent.lng - cx) ** 2 + (agent.lat - cy) ** 2;
      const group = groups.get(key);
      if (group) {
        group.agents.push(agent);
        group.d = Math.min(group.d, d);
      } else groups.set(key, { agents: [agent], d, index });
    }
    const nearest = [...groups.values()].sort((a, b) => a.d - b.d);
    const kept = staged.slice();
    const selected: (typeof nearest)[number][] = [];
    let count = eventCount;
    for (const group of nearest) {
      if (group.agents[0]!.kind === 'train') {
        selected.push(group);
        continue;
      }
      if (count + group.agents.length > maxAgents) continue;
      selected.push(group);
      count += group.agents.length;
    }
    for (const group of selected.sort((a, b) => a.index - b.index)) kept.push(...group.agents);
    const result = this.withPuffs(withBirdCues(withBalls(kept)), center, bounds);
    const admitted = inspection?.finish(result, true) ?? result;
    diagnostics?.admitted(admitted);
    tapOwners?.finish(admitted);
    return admitted;
  }

  private withPuffs(
    agents: VisibleAgent[],
    center: [number, number],
    bounds: LngLatBounds | undefined,
  ) {
    const sources = this.puffSources;
    sources.clear();
    if (!this.actorSources.size) {
      this.puffPacket = EMPTY_PUFFS;
      return agents;
    }
    for (let i = 0; i < agents.length; i++) {
      const source = this.actorSources.get(agents[i]!);
      if (source !== undefined) sources.set(source, i);
    }
    this.actorSources.clear();
    this.puffPacket = this.puffSelector.select(
      this.tiles.values(),
      sources,
      center,
      this.clock,
      (tile) => viewIn(tile, bounds, 0),
    );
    return agents;
  }
}
