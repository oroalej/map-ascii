import type { SimulationSeason } from './seasonal-simulation';
import { DEFAULT_CELLS } from '../density';
import { MOMENTS } from './moments';
/**
 * The life layer's simulation (SPEC.md §4 "Life layer"): vehicles, people, and boats moving
 * along the lines of the tiles on screen, and flocks of birds circling over parks, trees, and
 * water. Agents live in tile units, per tile; a tile's agents are spawned from a seed made of its
 * key when it comes into view, so the same tile always starts with the same agents. Pure TS: the
 * renderer projects the agents onto the cell grid (passes.ts `lifePass`).
 */
import { makeCellGuard } from './cell-guard';
import type { SpeechCue } from './moments';
import { frameBetween, overlaps, masked, cede, ownedFootprints } from './frames';
import {
  projectMover,
  SegmentGrid,
  nearestReplacement,
  walkingBefore,
  walkingTransfer,
  type AdoptionOptions,
} from './continuity';
import type { ContinuityCounter, ContinuityRejection } from './diagnostics';
import { seamAhead, SEAMS } from './seams';
import { complete } from './cooperate';
import { admitBirths, outsideView, type LifeViewContext, type PendingSeed } from './births';
import type { FrameProfiler } from '../profile';
import {
  bandVisibility,
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
  CARABAO_SHARE,
  CAT,
  DOG,
  isWalker,
  PERCH,
  DEFAULT_ROAD_WIDTH_M,
  FOLLOW,
  FILLET,
  JUNCTION,
  kinematicsOf,
  laneOffset,
  LIFE_ZOOM,
  MAX_STEP_S,
  RETIRE,
  ADOPT,
  MAX_TILE_AGENTS,
  MAX_TILE_GATHERERS,
  MAX_VISIBLE_AGENTS,
  PARKED,
  PEOPLE,
  PERSON_PAUSE,
  PERSON_TURN_CHANCE,
  PLACES,
  ROAD_MARGIN_M,
  spawnRules,
  TRAIN,
  umbrellaShare,
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
  physicalSeasonalRecords,
  type LifeGeometry,
} from './geometry';
import { DOG_PAINTS } from './dogs';
import { CAT_PAINTS } from './cats';
import { LocalScenes } from './interactions';
import { LifeInspection } from './inspection';
import { UmbrellaMotion } from './umbrellas';
import { MomentHost, type MomentOptions } from './moments-host';
import { DialogueMemory } from './dialogue';
import { SignalControl } from './signals';
import { approach, nextSpeed } from './motion';
import { fillet, curvePose, type Pose, type Curve } from './curves';
import { JunctionIndex, JunctionTable } from './junctions';
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
import { collectSeasonAnchors, seasonProximity, type SeasonAnchor } from './seasonal';
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
  bodiesOverlap,
  segmentCrossing,
  Occupancy,
  PolygonIndex,
  memberSize,
  animalSize,
  type Body,
  type Polygon,
} from './occupancy';
import {
  prepareRoadTerrainSteps,
  RoadAccess,
  WorldRoadCache,
  transformPolygon,
  type PreparedRoadTerrain,
} from './terrain';

export { hashString, random } from './random';

const NO_MOVERS: readonly Mover[] = [];
type GroundAgent = Mover | Gatherer | Stall;
type GroundGuard = (owner: GroundAgent, before?: GroundAgent) => boolean;
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
) => boolean) & {
  remove(owner: object): void;
  reserveSeam(life: TileLife, preview: Mover, identity: Mover): void;
};
export type StepPass = {
  junctions: JunctionTable;
  trains?: ReadonlyMap<Mover, TrainLimit>;
  owns?: (p: { x: number; y: number }) => boolean;
  seams?: ReadonlyMap<Mover, { room: number; crossing: boolean }>;
  momentView?: { zoom: number; cellWidth: number; cellAspect: number };
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

/** Something that moves along lines: a vehicle, a person, a dog, or a boat. */
export type Mover = {
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
  /** Seconds left standing still (people and dogs). */
  pause: number;
  /** Dogs: seconds left trotting, and whether their pause is lying down (config.ts `DOG`). */
  trot?: number;
  lying?: boolean;
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
  inspecting?: object;
  clock?: number;
  minutes?: number;
  cityLife?: Pick<CityLifeConfig, 'schedules'>;
  season?: string | null;
  levels?: Activity;
  rain: number;
  wind?: { dir: readonly [number, number]; strength: number };
};

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

export type Bird = { ox: number; oy: number; phase: number };

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
  /** Flying down to its roost to settle on the ground there, and settled (life/birds.ts `ground`). */
  landing: boolean;
  landed: boolean;
  /** Seconds left of scattering, after a gust flushed it out of a tree. */
  scatter: number;
  /** Circling: angle (radians), radius (tile units), and seconds until it moves on. */
  angle: number;
  radius: number;
  stay: number;
  rank: number;
  birds: Bird[];
};

/** The agents of one tile. */
export class TileLife {
  private inspected?: object;
  readonly momentHost: MomentHost;
  private readonly walkerRng: () => number;
  private seamLimits?: StepPass['seams'];
  private adoptionGrid?: SegmentGrid;
  private ownership?: (p: { x: number; y: number }) => boolean;
  private readonly commerceStallsRng: () => number;
  private readonly commercePeopleRng: () => number;
  private commerceAdmitted = false;
  junctionIndex!: JunctionIndex;
  private readonly localJunctions = new JunctionTable();
  private readonly trafficGroups = new Map<number, number[]>();
  /** Aggregate controller counters for deterministic regression/performance fixtures. */
  readonly motionStats = { steps: 0, hardCaps: 0, waiting: 0 };
  signals!: SignalControl;
  scenes!: LocalScenes;
  private readonly catRng: () => number;
  readonly movers: Mover[] = [];
  /** Inert seeds: never stepped, drawn, colliding, visiting sites or donating. */
  readonly pending: PendingSeed[] = [];
  birthCredit = 0;
  readonly flocks: Flock[] = [];
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
  get population() {
    return this.movers.length + (this.suppressedGround?.movers.hidden.length ?? 0);
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
    const near = seasonProximity(this.tile, anchors, config.near, config.radius_m, true);
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
    if (!preview || (admit && !admit(preview))) return false;
    if (replace) this.release(replace);
    source.release(m);
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
    m.next = preview.next;
    m.came = preview.came;
    m.junctionRoute = preview.junctionRoute;
    m.waiting = preview.waiting;
    m.routing = preview.routing;
    m.train = preview.train;
    this.movers.push(m);
    return true;
  }

  release(m: Mover): void {
    const index = this.movers.indexOf(m);
    if (index >= 0) this.movers.splice(index, 1);
    this.scenes.release(m);
    this.localJunctions.release(m);
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
  /** How people look and where vendors stand: its own stream, so no one else moves for it. */
  private readonly looks: () => number;
  /** People at places: their own stream, so no one else moves for them. */
  private readonly placeRng: () => number;
  /** Birds' species, landings, and bats: their own stream, so no one else moves for them. */
  private readonly birdRng: () => number;
  /** Dogs: their own stream, so no one else moves for them. */
  private readonly dogRng: () => number;
  /** Road lines with vehicles parked along their curbs; traffic drives on what is left. */
  private readonly parkingLines = new Set<number>();
  /** Per vertex, the distance along its line from the line's first vertex, in tile units. */
  private readonly along: Float64Array;
  /** Line ends by position: packed position → line * 2 + (0 start, 1 end). */
  private readonly ends = new Map<number, number[]>();
  private readonly curvable: Uint8Array;
  private time = 0;
  private junctions: { x: number; y: number; radius: number }[] = [];

  constructor(
    readonly tile: TileId,
    readonly geo: LifeGeometry,
    seed: number,
    private readonly traffic: ResolvedTraffic = resolveTraffic(),
    deferred = false,
    momentOptions?: MomentOptions,
  ) {
    this.perMeter = 1 / metersPerUnit(tile);
    this.rng = random(seed);
    this.walkerRng = random(seed ^ 0x3c6ef372);
    this.routingSeed = seed;
    this.routeRng = random(seed ^ 0x2545f491);
    this.looks = random(seed ^ 0xc2b2ae35);
    this.placeRng = random(seed ^ 0x27d4eb2f);
    this.birdRng = random(seed ^ 0x165667b1);
    this.dogRng = random(seed ^ 0xd3a2646c);
    this.catRng = random(seed ^ 0x68e31da4);
    this.commerceStallsRng = random(seed ^ 0xa24baed5);
    this.commercePeopleRng = random(seed ^ 0x9fb21c65);
    const lines = geo.kinds.length;
    this.along = new Float64Array(geo.coords.length / 2);
    this.curvable = new Uint8Array(lines);
    this.momentHost = new MomentHost(this, seed, momentOptions);
    if (!deferred) complete(this.prepare());
  }

  /** The instance remains private to its preparation job until this iterator completes. */
  *prepare(): Generator<void, TileLife, void> {
    const { tile, geo, routingSeed: seed } = this;
    const lines = geo.kinds.length;
    this.roadTerrain = yield* prepareRoadTerrainSteps(geo, this.perMeter);
    for (let line = 0; line < lines; line++) {
      this.addEnd(this.first(line), line * 2);
      this.addEnd(this.last(line), line * 2 + 1);
      for (let v = this.first(line) + 1; v <= this.last(line); v++) {
        this.along[v] = this.along[v - 1]! + this.segment(v - 1, v);
        if ((v & 127) === 0) yield;
      }
      yield;
    }
    for (let line = 0; line < lines; line++)
      this.curvable[line] = Number(
        this.last(line) - this.first(line) > 1 ||
          (this.ends.get(this.endKey(this.first(line)))?.length ?? 0) > 1 ||
          (this.ends.get(this.endKey(this.last(line)))?.length ?? 0) > 1,
      );
    this.signals = new SignalControl(tile, geo, this.perMeter, this.along, true);
    yield* this.signals.prepare(tile, geo);
    this.junctionIndex = new JunctionIndex(tile, geo, this.perMeter, this.along, true);
    yield* this.junctionIndex.prepare(tile);
    // Parking first, on its own random stream: it narrows the lanes, but doesn't change who
    // else is out.
    yield* this.findJunctions();
    yield* this.spawnParked(random(seed ^ 0x9e3779b9));
    yield* this.spawnStandby(random(seed ^ 0x85ebca6b));
    for (let line = 0; line < lines; line++) yield* this.spawnOn(line);
    // Dogs last, on their own stream: they don't change who else is out.
    for (let line = 0; line < lines; line++) yield* this.spawnOn(line, true);
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
    const x = Math.round(this.geo.coords[vertex * 2]!) + 32768;
    const y = Math.round(this.geo.coords[vertex * 2 + 1]!) + 32768;
    return x * 65536 + y;
  }

  private addEnd(vertex: number, code: number) {
    const key = this.endKey(vertex);
    const list = this.ends.get(key);
    if (list) list.push(code);
    else this.ends.set(key, [code]);
  }

  private segment(a: number, b: number) {
    const { coords } = this.geo;
    return Math.hypot(coords[b * 2]! - coords[a * 2]!, coords[b * 2 + 1]! - coords[a * 2 + 1]!);
  }

  /** A line's length in tile units. */
  lineLength(line: number) {
    return this.along[this.last(line)]!;
  }

  /** Spawn the movers of `line`: its dogs with `dogs`, else everyone else. */
  private *spawnOn(line: number, dogs = false): Generator<void, void, void> {
    const kind = this.geo.kinds[line]! as LifeLine;
    const rules = spawnRules[kind];
    const road = trafficRoadFor[kind];
    const meters = this.lineLength(line) / this.perMeter;
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
        // Start somewhere along the line.
        this.advance(mover, rng() * this.lineLength(line), false);
        if (rule.kind === 'vehicle' && !this.junctionIndex.canSpawnVehicle(mover)) continue;
        // A train pulls in until the track behind it holds all its cars.
        if (train) {
          this.moveTrain(mover, trainLength(train.cars) * this.perMeter);
          mover.pause = 0;
        }
        if (rule.kind !== 'person' || usableLines.person.includes(kind)) this.movers.push(mover);
      }
    }
  }

  /** A road line's width for driving: less the parking strips along its curbs, if any. */
  private roadWidth(line: number) {
    const width = this.geo.widths[line] || DEFAULT_ROAD_WIDTH_M;
    return this.parkingLines.has(line) ? width - 2 * PARKED.strip : width;
  }

  /** How far right of its line's center a mover keeps, m: a vehicle's lane, else 0. */
  offsetOf(m: Mover): number {
    if (isWalker(m.kind)) return this.scenes.visits.has(m) ? 0 : (m.avoid ?? 0);
    if (m.kind !== 'vehicle' || !m.vehicle) return 0;
    const spec = VEHICLES[m.vehicle];
    const road = this.roadWidth(m.line);
    const normal = laneOffset(road, spec.width, m.lane, spec.curb);
    const curb = Math.max(0, road / 2 - spec.width / 2 - ROAD_MARGIN_M);
    return this.scenes.offset(m, normal, curb);
  }

  private corner(m: Mover, vertex: number): Curve | undefined {
    let incoming = vertex - m.dir,
      outgoing = vertex + m.dir;
    let inLine = m.line,
      outLine = m.line;
    const start = m.dir === 1 ? this.first(m.line) : this.last(m.line);
    const end = m.dir === 1 ? this.last(m.line) : this.first(m.line);
    if (vertex === start) {
      if (m.came === undefined) return;
      inLine = m.came >> 1;
      incoming = m.came & 1 ? this.last(inLine) - 1 : this.first(inLine) + 1;
    }
    if (vertex === end) {
      const next = m.routing?.plan?.exit ?? m.next;
      if (next === undefined || next < 0) return;
      outLine = next >> 1;
      outgoing = next & 1 ? this.last(outLine) - 1 : this.first(outLine) + 1;
    }
    const c = this.geo.coords;
    const x = c[vertex * 2]!,
      y = c[vertex * 2 + 1]!;
    const ix = x - c[incoming * 2]!,
      iy = y - c[incoming * 2 + 1]!;
    const ox = c[outgoing * 2]! - x,
      oy = c[outgoing * 2 + 1]! - y;
    const li = Math.hypot(ix, iy),
      lo = Math.hypot(ox, oy);
    if (!li || !lo) return;
    const offset = (line: number) =>
      line === m.line
        ? this.offsetOf(m)
        : m.kind === 'vehicle'
          ? laneOffset(
              this.roadWidth(line),
              VEHICLES[m.vehicle!].width,
              m.lane,
              VEHICLES[m.vehicle!].curb,
            )
          : 0;
    return fillet(
      x,
      y,
      ix / li,
      iy / li,
      ox / lo,
      oy / lo,
      li,
      lo,
      offset(inLine) * this.perMeter,
      offset(outLine) * this.perMeter,
      this.perMeter,
    );
  }

  /** Pure render/clearance pose; the route cursor stays on the centreline. */
  pose(m: Mover, out: Pose = { x: 0, y: 0, hx: 0, hy: 0 }): Pose {
    const offset = this.offsetOf(m) * this.perMeter;
    Object.assign(out, { x: m.x - m.hy * offset, y: m.y + m.hx * offset, hx: m.hx, hy: m.hy });
    if (m.momentFacing) Object.assign(out, m.momentFacing);
    if (!m.vehicle || m.train || !this.curvable[m.line]) return out;
    const reach = FILLET.maxM * this.perMeter;
    const behind = m.d <= reach ? this.corner(m, m.from) : undefined;
    if (behind && m.d <= behind.length) return curvePose(behind, m.d, out);
    const remaining = this.segment(m.from, m.from + m.dir) - m.d;
    const ahead = remaining <= reach ? this.corner(m, m.from + m.dir) : undefined;
    if (ahead && remaining <= ahead.length) return curvePose(ahead, -remaining, out);
    return out;
  }

  private curveTarget(m: Mover): number {
    if (!this.curvable[m.line]) return m.speed;
    if (
      this.last(m.line) - this.first(m.line) === 1 &&
      m.came === undefined &&
      m.routing?.plan === undefined &&
      m.next === undefined
    )
      return m.speed;
    const k = kinematicsOf(m.vehicle),
      pm = this.perMeter;
    let target = m.speed;
    const behind = this.corner(m, m.from);
    if (behind && m.d <= behind.length)
      target = Math.min(target, Math.sqrt(k.lateral * pm * behind.radius));
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
          approach(distance - curve.length, Math.sqrt(k.lateral * pm * curve.radius), k.brake * pm),
        );
    }
    return target;
  }

  /** The same meters and group slots used by the life drawing pass. */
  groundBodies(a: GroundAgent, minimum = 0, out: Body[] = []): Body[] {
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
        out[i] = { ...b, length: Math.max(b.length, minimum) };
      });
      return out;
    }
    const lane = mover ? this.offsetOf(a) : 0;
    const x = a.x / this.perMeter - a.hy * lane;
    const y = a.y / this.perMeter + a.hx * lane;
    if (mover && (a.kind === 'dog' || a.kind === 'cat')) {
      const size = animalSize(a.kind);
      const b = out[0] ?? (out[0] = { x: 0, y: 0, hx: 0, hy: 0, length: 0, width: 0 });
      Object.assign(b, {
        x,
        y,
        hx: a.hx,
        hy: a.hy,
        length: Math.max(size.length, minimum),
        width: Math.max(size.width, minimum),
      });
      out.length = 1;
      return out;
    }
    if (mover && a.vehicle) {
      const s = VEHICLES[a.vehicle];
      const b = out[0] ?? (out[0] = { x: 0, y: 0, hx: 0, hy: 0, length: 0, width: 0 });
      this.pose(a, b);
      b.x /= this.perMeter;
      b.y /= this.perMeter;
      b.length = Math.max(s.length, minimum);
      b.width = s.width;
      out.length = 1;
      return out;
    }
    const walkers = mover ? (a.group ?? []) : [a.walker];
    const { hx, hy } = a.momentFacing ?? a;
    const spacing = Math.max(1, minimum);
    for (let i = 0; i < walkers.length; i++) {
      const w = walkers[i]!;
      const b = out[i] ?? (out[i] = { x: 0, y: 0, hx: 0, hy: 0, length: 0, width: 0 });
      b.x = x - hy * w.lateral * spacing - hx * w.back * spacing;
      b.y = y + hx * w.lateral * spacing - hy * w.back * spacing;
      b.hx = hx;
      b.hy = hy;
      b.length = Math.max(memberSize(w.figure).length, minimum);
      b.width = Math.max(memberSize(w.figure).width, minimum);
    }
    out.length = walkers.length;
    return out;
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
      let fits = guard(m);
      for (let attempt = 0; !fits && attempt < 24; attempt++) {
        yield;
        this.advance(m, (3 + attempt) * this.perMeter, false);
        fits = inTile(m) && guard(m);
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
      for (let line = 0; line < this.geo.kinds.length; line++) {
        yield;
        const kind = this.geo.kinds[line];
        if (kind !== LifeLine.path && kind !== LifeLine.plaza) continue;
        const length = this.lineLength(line),
          meters = length / this.perMeter;
        if (!length) continue;
        let shops = 0;
        for (let i = 0; i < commerce.length; i += 2) {
          const p = { x: commerce[i]!, y: commerce[i + 1]! };
          for (let v = this.first(line); v < this.last(line); v++) {
            if ((v & 63) === 0) yield;
            const x = this.geo.coords[v * 2]!,
              y = this.geo.coords[v * 2 + 1]!,
              dx = this.geo.coords[(v + 1) * 2]! - x,
              dy = this.geo.coords[(v + 1) * 2 + 1]! - y;
            const t = Math.max(
              0,
              Math.min(1, ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy || 1)),
            );
            if (Math.hypot(p.x - x - dx * t, p.y - y - dy * t) <= COMMERCE.reach * this.perMeter) {
              shops++;
              break;
            }
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
          this.advance(m, rng() * length, false);
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
            if (guard(m)) this.movers.push(m);
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
    for (let line = 0; line < this.geo.kinds.length && count < CAT.maxPerTile; line++) {
      yield;
      if (!usableLines.cat.includes(this.geo.kinds[line]! as LifeLine)) continue;
      const rule = spawnRules[this.geo.kinds[line]! as LifeLine].find((r) => r.kind === 'cat');
      if (!rule) continue;
      const length = this.lineLength(line);
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
        this.advance(m, rng() * length, false);
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
    for (let line = 0; line < geo.kinds.length; line++) {
      const kind = geo.kinds[line]! as LifeLine;
      const spacing = VENDORS.spacing[kind];
      const length = this.along[this.last(line)]!;
      if (!spacing || length === 0) continue;
      const middle = this.pointAt(line, length / 2);
      const boost = nearMarket(middle.x, middle.y) ? VENDORS.marketBoost : 1;
      const count = Math.floor(((length / perMeter) * boost) / spacing + looks());
      for (let i = 0; i < count && this.stalls.length < VENDORS.maxPerTile; i++) {
        yield;
        const p = this.pointAt(line, looks() * length);
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
    const rng = this.placeRng;
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
    const rng = this.placeRng;
    for (const g of this.gatherers) {
      if (this.inspected === g) continue;
      if (this.ownership && !this.ownership(g)) continue;
      if (g.behavior === 'sit' || (near && !near(g.x, g.y))) continue;
      if (this.momentHost.moments.busy(g)) {
        g.pause = Math.max(0, g.pause - dt);
        continue;
      }
      if (!this.canIdle(g)) g.pause = 0;
      if (g.pause > 0) {
        this.momentHost.attend(g, guard);
        g.pause -= dt;
        continue;
      }
      const dx = g.tx - g.x;
      const dy = g.ty - g.y;
      const dist = Math.hypot(dx, dy);
      const move = g.speed * dt;
      const before = guard && { ...g };
      delete g.momentFacing;
      if (dist <= move) {
        g.x = g.tx;
        g.y = g.ty;
        g.pause = this.canIdle(g) ? between(rng, PLACES[g.place].pause) : 0;
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
      if (a.kind === 'blocked' || a.kind === 'parking-exclusion')
        yield* excluded.addSteps(transformPolygon(a.rings, 0, 0, 1 / perMeter));
    const sample: Body[] = [];
    const bodyOf = (x: number, y: number, hx: number, hy: number, vehicle: CraftType) => ({
      x,
      y,
      hx,
      hy,
      length: VEHICLES[vehicle].length * perMeter,
      width: VEHICLES[vehicle].width * perMeter,
    });
    const park = (x: number, y: number, hx: number, hy: number, vehicle: CraftType) => {
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
      this.parked.push({ x, y, hx, hy, vehicle, paint });
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
    for (let line = 0; line < geo.kinds.length; line++) {
      const road = trafficRoadFor[geo.kinds[line]! as LifeLine];
      const width = geo.widths[line] ?? 0;
      const onWater = road === 'river' || road === 'canal';
      if (!road || onWater || width < PARKED.minWidth || rng() >= PARKED.chance) continue;
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
          park(p.x - p.hy * offset, p.y + p.hx * offset, p.hx * side, p.hy * side, vehicle);
        }
      }
    }
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
    if (this.seamLimits?.get(m)?.crossing) return;
    const end = m.dir === 1 ? this.last(m.line) : this.first(m.line);
    if (junctions && this.exitOptions(m, end).length) return;
    const length = m.vehicle ? VEHICLES[m.vehicle].length : 0;
    const setback = (length / 2 + FOLLOW.minGap) * this.perMeter;
    return Math.max(0, m.dir * (this.along[end]! - this.along[m.from]!) - m.d - setback);
  }

  /** Move along legal lines; one-way dead ends hold instead of reversing. */
  private advance(m: Mover, distance: number, junctions = true) {
    const { coords } = this.geo;
    let left = distance;
    let moved = 0;
    // Bounded, so zero-length segments can't loop forever.
    for (let guard = 0; guard < 256 && left > 0; guard++) {
      // Also protects initial placement, oversized steps, and collision retries. Re-evaluate
      // after each junction in case this step enters a one-way line ending at a dead end.
      const room = this.oneWayEndRoom(m, junctions);
      if (room !== undefined) left = Math.min(left, room);
      if (left <= 0) break;
      const to = m.from + m.dir;
      const length = this.segment(m.from, to);
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
        if (this.seamLimits?.get(m)?.crossing) {
          m.from -= m.dir;
          m.d = length;
          break;
        }
        if (junctions) this.turn(m);
        else m.dir = m.dir === 1 ? -1 : 1;
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

  private exitOptions(m: Mover, vertex: number): number[] {
    const arrived = m.line * 2 + (m.dir === 1 ? 1 : 0);
    const usable = usableLines[m.kind];
    return (this.ends.get(this.endKey(vertex)) ?? []).filter(
      (code) =>
        code !== arrived &&
        usable.includes(this.geo.kinds[code >> 1]! as LifeLine) &&
        !(
          m.kind === 'vehicle' &&
          this.geo.oneway?.[code >> 1] &&
          this.geo.oneway[code >> 1] !== (code & 1 ? -1 : 1)
        ),
    );
  }

  private newRouting(index: number): VehicleRouting {
    return { seed: hashString(`${this.routingSeed}/turns/${index}`), turns: 0 };
  }

  /** Heading from a line end into that line, skipping repeated endpoint coordinates. */
  private endHeading(code: number): readonly [number, number] {
    const line = code >> 1;
    const dir = (code & 1) === 0 ? 1 : -1;
    const end = dir === 1 ? this.first(line) : this.last(line);
    const opposite = dir === 1 ? this.last(line) : this.first(line);
    for (let v = end + dir; dir === 1 ? v <= opposite : v >= opposite; v += dir) {
      const dx = this.geo.coords[v * 2]! - this.geo.coords[end * 2]!;
      const dy = this.geo.coords[v * 2 + 1]! - this.geo.coords[end * 2 + 1]!;
      const length = Math.hypot(dx, dy);
      if (length > 0) return [dx / length, dy / length];
    }
    return [0, 0];
  }

  private plannedExit(
    m: Mover,
    vertex: number,
    options: readonly number[],
  ): VehicleTurnPlan | undefined {
    if (!options.length || !m.routing) return;
    const pick = hashString(`${m.routing.seed}/${m.routing.turns}/${this.endKey(vertex)}`);
    const exit = options[Math.floor((pick / 0x1_0000_0000) * options.length)]!;
    const arrived = m.line * 2 + (m.dir === 1 ? 1 : 0);
    const back = this.endHeading(arrived);
    const outward = [arrived, ...options].map((code) => this.endHeading(code));
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
      radius,
      side: arms.size >= 3 ? turnSide([-back[0], -back[1]], this.endHeading(exit)) : undefined,
    };
  }

  /** Plan before speed restrictions, so waiting traffic keeps its original intention. */
  private prepareTurn(m: Mover, index: number) {
    if (!m.vehicle) return;
    if (!this.curvable[m.line]) {
      if (hasTurnSignals(m.vehicle)) m.routing ??= this.newRouting(index);
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
        m.next = options.length ? options[Math.floor(this.routeRng() * options.length)]! : -1;
      }
      return;
    }
    m.routing ??= this.newRouting(index);
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
    const movement = this.junctionIndex.movement(m, 60 * this.perMeter);
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
            (hashString(`${this.routingSeed}/${m.line}/${m.dir}`) / 0x1_0000_0000) * options.length,
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
            (hashString(`${this.routingSeed}/${line}/${dir}`) / 0x1_0000_0000) * next.length,
          )
        ]!;
    }
  }

  /** At a line's end: consume a remembered exit, else keep the existing non-motor routing. */
  private turn(m: Mover) {
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
    const reserved = m.junctionRoute?.exits[0];
    const code =
      reserved !== undefined && options.includes(reserved)
        ? reserved
        : plan
          ? plan.exit
          : m.vehicle && m.next !== undefined && options.includes(m.next)
            ? m.next
            : m.train
              ? this.straightest(m, options)
              : options[
                  Math.floor(
                    (m.vehicle
                      ? this.routeRng()
                      : m.kind === 'cat'
                        ? this.catRng()
                        : m.kind === 'dog'
                          ? this.dogRng()
                          : m.kind === 'person'
                            ? this.walkerRng()
                            : this.rng()) * options.length,
                  )
                ]!;
    m.next = undefined;
    if (m.junctionRoute)
      m.junctionRoute =
        m.junctionRoute.exits.length > 1
          ? { ...m.junctionRoute, exits: m.junctionRoute.exits.slice(1) }
          : undefined;
    m.line = code >> 1;
    const fromStart = (code & 1) === 0;
    m.from = fromStart ? this.first(m.line) : this.last(m.line);
    m.dir = fromStart ? 1 : -1;
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
    }
    this.trafficGroups.clear();
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i]!;
      if (!m.vehicle || !active(m)) continue;
      this.prepareTurn(m, i);
      this.prepareSignalRoute(m);
      this.progress[i] = (m.dir * this.along[m.from]! + m.d) / pm;
      this.offsets[i] = this.offsetOf(m);
      const key = m.line * 2 + (m.dir === 1 ? 1 : 0);
      const group = this.trafficGroups.get(key) ?? [];
      group.push(i);
      this.trafficGroups.set(key, group);
    }
    for (const group of this.trafficGroups.values())
      group.sort((a, b) => this.progress[a]! - this.progress[b]! || a - b);
  }

  requestJunctions(
    table: JunctionTable,
    active: (m: Mover) => boolean,
    clock: number,
    tileKey = '',
  ) {
    for (let index = 0; index < this.movers.length; index++) {
      const m = this.movers[index]!;
      if (m.kind !== 'vehicle' || !m.vehicle || !active(m)) continue;
      const pm = this.perMeter,
        length = VEHICLES[m.vehicle].length * pm;
      if (table.carried(m)) {
        const movement = table.movement(m)!;
        let room = Infinity;
        const ex = movement.exit.x ?? movement.junction.x,
          ey = movement.exit.y ?? movement.junction.y;
        for (const other of this.movers) {
          if (other === m || other.kind !== 'vehicle' || !other.vehicle) continue;
          const past = (other.x - ex) * movement.outHx + (other.y - ey) * movement.outHy;
          const side = Math.abs((other.x - ex) * movement.outHy - (other.y - ey) * movement.outHx);
          if (past >= 0 && side < 4 * pm)
            room = Math.min(
              room,
              past / pm - VEHICLES[other.vehicle].length / 2 - movement.junction.radius / pm,
            );
        }
        table.refreshCarried(
          m,
          (p) =>
            this.signals.allows(
              m,
              p.entry?.x ?? p.junction.x,
              p.entry?.y ?? p.junction.y,
              clock,
              Math.max(0, p.ahead),
            ),
          room,
        );
        continue;
      }
      const previous = table.movement(m);
      let movement = previous;
      if (previous) {
        const j = previous.junction;
        const past =
          (m.x - (previous.exit.x ?? j.x)) * previous.outHx +
          (m.y - (previous.exit.y ?? j.y)) * previous.outHy;
        const sameApproach =
          m.line === previous.line &&
          m.dir === previous.dir &&
          m.dir * (previous.stop - this.along[m.from]! - m.dir * m.d) > 0;
        if (!sameApproach && past > j.radius + length / 2) {
          table.release(m);
          movement = undefined;
        } else if (sameApproach && previous.ahead >= 0) {
          // Refresh a pending route as it becomes known; retain the committed route inside.
          movement = this.junctionIndex.movement(m, 60 * pm) ?? previous;
        }
      }
      movement ??= this.junctionIndex.movement(
        m,
        Math.max(
          60 * pm,
          (m.v ?? m.speed) ** 2 / (2 * kinematicsOf(m.vehicle).brake * pm) + 20 * pm,
        ),
      );
      if (!movement) continue;
      const j = movement.junction;
      const before =
        m.line === movement.line && m.dir === movement.dir
          ? m.dir * (movement.stop - this.along[m.from]! - m.dir * m.d)
          : -Infinity;
      const ahead =
        before -
        (movement.entry?.stopAlong !== undefined
          ? movement.dir * (movement.stop - movement.entry.stopAlong)
          : j.radius + JUNCTION.gap * pm) -
        length / 2;
      const inside = ahead < -0.05 * pm;
      // Do not change the incoming/outgoing movement when a holder crosses its endpoint.
      movement = { ...movement, ahead };
      const exit = movement.exit;
      let room = Infinity;
      for (const other of this.trafficGroups.get(exit.line * 2 + (exit.out === 1 ? 1 : 0)) ?? []) {
        const leader = this.movers[other]!;
        if (leader === m) continue;
        const past = this.progress[other]! * pm - exit.out * exit.along;
        if (past < 0) continue;
        room = Math.min(room, past - (VEHICLES[leader.vehicle!].length * pm) / 2 - j.radius);
      }
      const ready =
        room >= length + FOLLOW.minGap * pm &&
        this.signals.allows(
          m,
          movement.entry?.x ?? j.x,
          movement.entry?.y ?? j.y,
          clock,
          Math.max(0, ahead),
        );
      table.request({ m, life: this, tileKey, index, movement, ready, inside, room: room / pm });
    }
  }

  /** Nearest overlapping leader, including the chosen exit when this line is clear. */
  private followLimits(dt: number, table: JunctionTable): Float64Array {
    const { movers, perMeter: pm, speeds, caps, progress, offsets } = this;
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i]!;
      speeds[i] = m.speed;
      caps[i] = Infinity;
      const room = this.oneWayEndRoom(m);
      if (room !== undefined) {
        speeds[i] = Math.min(m.speed, approach(room, 0, kinematicsOf(m.vehicle).brake * pm));
        caps[i] = room / dt;
      }
    }
    const limit = (i: number, j: number, separation: number) => {
      const m = movers[i]!,
        leader = movers[j]!;
      const gap = separation - (VEHICLES[m.vehicle!].length + VEHICLES[leader.vehicle!].length) / 2;
      const room = Math.max(0, gap - FOLLOW.minGap) * pm;
      speeds[i] = Math.min(
        speeds[i]!,
        room / FOLLOW.headway,
        approach(
          room,
          this.inspected === leader ? 0 : (leader.v ?? leader.speed),
          kinematicsOf(m.vehicle).brake * pm,
        ),
      );
      caps[i] = Math.min(caps[i]!, room / dt);
    };
    const overlaps = (i: number, j: number, lane = offsets[i]!) =>
      Math.abs(lane - offsets[j]!) <
      (VEHICLES[movers[i]!.vehicle!].width + VEHICLES[movers[j]!.vehicle!].width) / 2 -
        FOLLOW.squeeze;
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
            const entry = (dir * this.along[dir === 1 ? this.first(line) : this.last(line)]!) / pm;
            const lane =
              m.kind === 'vehicle'
                ? laneOffset(
                    this.roadWidth(line),
                    VEHICLES[m.vehicle!].width,
                    m.lane,
                    VEHICLES[m.vehicle!].curb,
                  )
                : 0;
            for (const j of this.trafficGroups.get(line * 2 + (dir === 1 ? 1 : 0)) ?? []) {
              if (j === i || !overlaps(i, j, lane)) continue;
              limit(i, j, remaining + progress[j]! - entry);
              break;
            }
          }
        }
        const movement = table.movement(m);
        if (movement && !table.granted(m) && movement.ahead >= -0.05 * pm) {
          speeds[i] = Math.min(
            speeds[i],
            approach(movement.ahead, 0, kinematicsOf(m.vehicle).brake * pm),
          );
          caps[i] = Math.min(caps[i]!, Math.max(0, movement.ahead) / dt);
        }
      }
    return speeds;
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
    this.inspected = env?.inspecting;
    this.ownership = pass?.owns;
    this.seamLimits = pass?.seams;
    this.time += dt;
    const { rng } = this;
    const clock = env?.clock ?? this.time;
    this.scenes.step(
      dt,
      this.movers,
      env ?? {},
      near,
      shows,
      guard,
      (m) => this.offsetOf(m),
      (m, target, distance) => this.signals.walkDistance(m, target, distance, clock),
      pass?.owns,
      this.inspected,
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
    const table = pass?.junctions ?? this.localJunctions;
    if (!pass) {
      const active = (m: Mover) =>
        (!shows || shows(m.kind)) &&
        (!near || near(m.x, m.y)) &&
        (!env?.levels || m.rank < env.levels[m.kind]) &&
        !this.scenes.hidden(m);
      this.prepareTraffic(active);
      table.begin(new Set([this]));
      this.requestJunctions(table, active, clock);
      table.resolve(clock);
    }
    const speeds = this.followLimits(dt, table);
    const trains = pass?.trains ?? trainLimits([this], dt);
    const limit = { target: 0, cap: Infinity };
    // Walkers get a chance to clear a crossing; waiting traffic wins ties among cars.
    const order = this.movers
      .map((m, i) => ({ m, i }))
      .sort(
        (a, b) =>
          Number(isWalker(b.m.kind)) - Number(isWalker(a.m.kind)) ||
          (b.m.waiting ?? 0) - (a.m.waiting ?? 0) ||
          a.i - b.i,
      );
    for (const { i, m } of order) {
      if (this.inspected === m) continue;
      if (pass?.owns && !pass.owns(m)) continue;
      if (shows && !shows(m.kind)) continue;
      if (near && !m.train && !near(m.x, m.y)) continue;
      if (env?.levels && !m.train && m.rank >= env.levels[m.kind]) continue;
      if (this.scenes.visits.has(m)) continue;
      if (m.kind === 'vehicle') {
        if (m.vehicle) {
          limit.target = speeds[i]!;
          limit.cap = this.caps[i]!;
          this.scenes.limit(m, dt, kinematicsOf(m.vehicle).brake * this.perMeter, limit);
          const movement = table.movement(m);
          this.signals.vehicleLimit(
            m,
            dt,
            clock,
            limit,
            movement && table.granted(m) && movement.ahead < -0.05 * this.perMeter
              ? movement.key
              : undefined,
          );
          speeds[i] = limit.target;
          this.caps[i] = limit.cap;
        } else
          speeds[i] = Math.min(
            speeds[i]!,
            this.scenes.speed(m, dt),
            this.signals.vehicleSpeed(m, dt, clock),
          );
        if (this.scenes.held(m)) {
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
        const speed = this.dogSpeed(m, dt, this.canIdle(m));
        if (speed === undefined) continue;
        speeds[i] = speed;
      }
      if (m.kind === 'cat') {
        const idle = this.canIdle(m);
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
        if (this.momentHost.moments.busy(m)) {
          m.pause = Math.max(0, m.pause - dt);
          continue;
        }
        const idle = this.canIdle(m);
        if (!idle) m.pause = 0;
        if (m.pause > 0) {
          m.pause -= dt;
          continue;
        }
        if (idle && this.walkerRng() < PERSON_PAUSE.chance * dt) {
          m.pause = between(this.walkerRng, PERSON_PAUSE.seconds);
          continue;
        }
        if (idle && this.walkerRng() < PERSON_TURN_CHANCE * dt) {
          this.turnBack(m);
          // The group turns round where it stands: the one on the right is now on the left.
          for (const walker of m.group ?? []) {
            walker.lateral = -walker.lateral;
            walker.back = -walker.back;
          }
        }
      }
      const walking = isWalker(m.kind);
      if (walking) {
        speeds[i] =
          this.signals.walkDistance(
            m,
            { x: m.x + m.hx * speeds[i]! * dt, y: m.y + m.hy * speeds[i]! * dt },
            speeds[i]! * dt,
            clock,
          ) / dt;
      }
      if (m.vehicle) {
        this.motionStats.steps++;
        const seam = pass?.seams?.get(m);
        if (seam && !seam.crossing)
          speeds[i] = Math.min(
            speeds[i]!,
            approach(seam.room, 0, kinematicsOf(m.vehicle).brake * this.perMeter),
          );
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
      const distance = speeds[i]! * dt;
      // Unguarded craft have no rejected trials; avoid allocating rollback snapshots for them.
      if (m.vehicle && (!guard || m.kind !== 'vehicle')) {
        m.v = this.advance(m, distance) / dt;
        m.waiting = 0;
        continue;
      }
      const before = { ...m };
      if (walking) {
        delete m.momentFacing;
        m.avoid = (m.avoid ?? 0) * Math.max(0, 1 - dt * 0.4);
        m.walked = (m.walked ?? 0) + distance / this.perMeter;
      }
      let moved = this.advance(m, distance);
      // Standalone animal callers still enforce terrain without a world guard.
      const fitsGround =
        guard ??
        ((next: GroundAgent, previous?: GroundAgent) =>
          !('kind' in next) ||
          (next.kind !== 'cat' && next.kind !== 'dog') ||
          (this.scenes.walkable(previous ?? next, next) &&
            this.roadTerrain.access.allows(this.groundBodies(next))));
      if (m.kind === 'vehicle' || walking) {
        let fits = fitsGround(m, before);
        if (!fits) {
          // Vehicles creep; walkers also step aside, preferring the same side on successive
          // steps so detours don't oscillate. Each try is [side, share of the step].
          let tries = [
            [0, 0.5],
            [0, 0.25],
          ];
          let limit = 0;
          if (walking) {
            // Mapped sidewalk/path widths bound detours; unmeasured paths retain 1.5 m.
            const width = m.kind === 'dog' || m.kind === 'cat' ? animalSize(m.kind).width : 1;
            limit = Math.max(0, (this.geo.widths[m.line] || 4) / 2 - width / 2);
            const side = Math.sign(before.avoid ?? 0) || (i % 2 ? -1 : 1);
            tries = [
              [side, 0.5],
              [side, 0],
              [-side, 0.5],
              [-side, 0],
            ];
          }
          for (const [side, share] of tries) {
            Object.assign(m, before);
            if (walking) {
              m.avoid = Math.max(-limit, Math.min(limit, (before.avoid ?? 0) + side! * dt * 1.5));
              m.walked = (m.walked ?? 0) + (distance * share!) / this.perMeter;
            }
            moved = this.advance(m, distance * share!);
            if ((fits = fitsGround(m, before))) break;
          }
        }
        if (!fits) {
          Object.assign(m, before);
          moved = 0;
        }
        m.waiting = fits ? 0 : (before.waiting ?? 0) + dt;
        if (!fits && m.kind === 'cat') {
          m.pause = CAT.blockedPause;
          this.turnBack(m);
        }
      }
      if (m.vehicle) m.v = moved / dt;
      if (m.vehicle && (m.waiting ?? 0) > 0) this.motionStats.waiting++;
    }
    if (!shows || shows('person')) this.stepGatherers(dt, near, guard);
    if (!shows || shows('bird')) this.stepFlocks(dt, gustAt, near, env);
  }

  /** Turn a walker back where it stands: now heading for the vertex it was walking away from. */
  private turnBack(m: Mover) {
    const to = m.from + m.dir;
    m.d = this.segment(m.from, to) - m.d;
    m.from = to;
    m.dir = m.dir === 1 ? -1 : 1;
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
  private pickDestination(flock: Flock) {
    const roosts = this.geo.roosts.length / 2;
    const perches = this.geo.perches.length / 2;
    const spec = BIRD_SPECIES[flock.species];
    flock.stay = between(this.rng, BIRDS.stay);
    flock.landing = false;
    if (perches > 0 && !spec.nocturnal && (roosts === 0 || this.rng() < spec.perch)) {
      flock.perch = Math.floor(this.rng() * perches);
    } else {
      flock.perch = -1;
      if (roosts > 1) flock.roost = this.pickRoost(flock.species, this.rng);
      // Some settle on the ground there: pigeons in a park, egrets at the water's edge.
      if (roosts > 0 && spec.ground > 0 && this.birdRng() < spec.ground) flock.landing = true;
    }
  }

  /**
   * Whether someone out (below their kind's `levels`, if given) comes within a sitting flock's
   * `wary` distance (life/birds.ts): walking or driving by, a dog twice as far. People standing
   * still, sitting, and dogs lying down leave it be.
   */
  private disturbed(flock: Flock, levels?: Activity): boolean {
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
      if (levels && g.rank >= levels.places[g.place]) continue;
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
   * and flying flocks that perch head for the trees, those that land settle at their roost. The
   * wind pushes circling flocks downwind, and faster round the downwind side. Bats flit.
   */
  private stepFlocks(
    dt: number,
    gustAt?: (x: number, y: number) => number,
    near?: (x: number, y: number) => boolean,
    env?: LifeEnv,
  ) {
    const { roosts, perches } = this.geo;
    const count = roosts.length / 2;
    const sheltering = (env?.rain ?? 0) >= BIRD_WEATHER.shelter;
    // The wind, scaled by its strength, in tile axes.
    const wind = env?.wind;
    const wx = wind ? wind.dir[0] * wind.strength : 0;
    const wy = wind ? wind.dir[1] * wind.strength : 0;
    for (const flock of this.flocks) {
      if (near && !near(flock.x, flock.y)) continue;
      if (this.ownership && !this.ownership(flock)) continue;
      const spec = BIRD_SPECIES[flock.species];
      const speed = spec.speed * this.perMeter;
      const sitting = flock.perched || flock.landed;
      flock.scatter = Math.max(0, flock.scatter - dt);
      // Sitting out the rain, a flock doesn't count down its stay.
      if (!(sheltering && sitting)) flock.stay -= dt;
      if (sitting) {
        const gust = flock.perched ? (gustAt?.(flock.x, flock.y) ?? 0) : 0;
        const flushed = gust >= PERCH.flush || this.disturbed(flock, env?.levels);
        if (flushed || flock.stay <= 0) {
          flock.perched = false;
          flock.landed = false;
          if (flushed) flock.scatter = PERCH.scatter;
          this.pickDestination(flock);
          // Flushed, it keeps clear a while (circling a roost, or hovering where it is if the
          // tile has none) before settling again.
          if (flushed) {
            flock.perch = -1;
            flock.landing = false;
          }
        }
        continue;
      }
      if (flock.stay <= 0 && (count > 1 || perches.length > 0 || (spec.ground > 0 && count > 0))) {
        this.pickDestination(flock);
      }
      // Rain: those that perch head for the trees, those that land settle at their roost.
      if (sheltering && flock.scatter === 0 && flock.perch < 0 && !flock.landing) {
        if (spec.perch > 0 && perches.length > 0) {
          flock.perch = Math.floor(this.birdRng() * (perches.length / 2));
        } else if (spec.ground > 0 && count > 0) {
          flock.landing = true;
        }
      }
      // Flying to a tree, or down to its roost: straight there, nudged downwind, then settle.
      const to =
        flock.perch >= 0
          ? { x: perches[flock.perch * 2]!, y: perches[flock.perch * 2 + 1]! }
          : flock.landing && count > 0
            ? { x: roosts[flock.roost * 2]!, y: roosts[flock.roost * 2 + 1]! }
            : undefined;
      if (to) {
        const dx = to.x - flock.x;
        const dy = to.y - flock.y;
        const distance = Math.hypot(dx, dy);
        const step = speed * 1.4 * dt;
        if (distance <= step) {
          flock.x = to.x;
          flock.y = to.y;
          if (flock.perch >= 0) flock.perched = true;
          else {
            flock.landed = true;
            flock.landing = false;
          }
        } else {
          // Less as it comes in, so it still arrives.
          const nudge = speed * 0.2 * dt * Math.min(1, distance / (20 * this.perMeter));
          flock.x += (dx / distance) * step + wx * nudge;
          flock.y += (dy / distance) * step + wy * nudge;
        }
        if (distance > 0) [flock.hx, flock.hy] = [dx / distance, dy / distance];
        continue;
      }
      if (count === 0) continue;
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
    }
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
  /** Assigned only in item mode; global fallback keeps the ordinary agent shape. */
  inspectionId?: number;
  /** Candle clock token: running offset >= 0, held time encoded as -time - 2. */
  effectClock?: number;
  /** Stable candle-pool phase seed in per-item mode. */
  candleSeed?: number;
  speech?: SpeechCue;
  /** A transient airborne ball, packed before the ordinary person figure dispatch. */
  prop?: 'ball';
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
export type ProcessionRun = { id: string; progress: number; live: boolean };

type GroundTerrain = {
  key: string;
  blocked: PolygonIndex;
  seasonal: PolygonIndex;
  water: PolygonIndex;
  roadAccess: RoadAccess;
  trees: PolygonIndex;
  origins: Map<TileLife, { x: number; y: number; scale: number }>;
  ref?: TileLife;
};

export class LifeWorld {
  private readonly umbrellas = new UmbrellaMotion();
  private cityLife: Pick<CityLifeConfig, 'schedules'> | undefined;
  setShopSchedule(shops: ShopSchedule | undefined) {
    this.cityLife = shops ? { schedules: { shops } } : undefined;
  }
  private seasons: readonly SimulationSeason[] = [];
  private seasonalConfig: SimulationSeason | undefined;
  setSeasons(seasons: readonly SimulationSeason[]) {
    if (seasons === this.seasons) return;
    this.seasons = seasons;
    this.seasonsDirty = true;
  }
  private seasonsDirty = false;
  /** Retired tiles retain their carts and reconcile the season when they return. */
  private readonly appliedSeasons = new WeakMap<TileLife, string | null>();
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

  private syncSeason(season: string | null | undefined) {
    const config = this.seasons.find(
      (s) => s.id === season && (s.stalls || s.installations?.length),
    );
    const changed = config?.id !== this.seasonalConfig?.id;
    if (!changed && !this.seasonsDirty) {
      this.seasonalConfig = config;
      return;
    }
    const physical = (s: SimulationSeason | undefined) =>
      s?.installations?.some((i) => i.kind === 'christmas-tree' || i.kind === 'carnival');
    const hadPhysical = physical(this.seasonalConfig);
    if (changed && (config?.installations?.length || this.seasonalConfig?.installations?.length))
      this.groundTerrain = undefined;
    this.seasonalConfig = config;
    this.seasonsDirty = false;
    for (const life of this.tiles.values()) {
      const id = config?.id ?? null;
      if (this.appliedSeasons.get(life) !== id) {
        life.clearSeasonalStalls();
        this.stallInputs.delete(life);
      }
      this.appliedSeasons.set(life, id);
    }
    if (
      !this.groundTerrain &&
      this.tiles.size &&
      (hadPhysical ||
        physical(config) ||
        [...this.tiles.values()].some((life) => life.hasSuppressedActors))
    )
      this.groundGuard();
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
      const reach = config.stalls!.radius_m * life.perMeter;
      const nearby = anchors.filter((a) => {
        if (a.kind !== 'market' && !config.stalls!.near.includes(a.kind)) return false;
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
    const guard = this.groundGuard(0, undefined, undefined, true);
    for (const { life, anchors } of changedTiles) {
      const near = seasonProximity(
        life.tile,
        anchors,
        config.stalls.near,
        config.stalls.radius_m,
        true,
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
  private terrainKey(keys: readonly string[]) {
    return (
      keys.join('|') +
      (this.seasonalConfig?.installations?.some(
        (i) => i.kind === 'christmas-tree' || i.kind === 'carnival',
      )
        ? `|installations:${this.seasonalConfig.id}`
        : '')
    );
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
    ).prepare();
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
  private roadCache = new WorldRoadCache();
  private readonly metricTerrain = new WeakMap<
    TileLife,
    {
      origin: string;
      blocked: Polygon[];
      water: Polygon[];
      trees: Polygon[];
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
  private preparedTerrain = new WeakMap<TileLife, GroundTerrain>();
  private preparedSettled = new WeakSet<TileLife>();
  private preparationTouched = new WeakSet<TileLife>();
  private seamWait = new WeakMap<Mover, { key: string; at: number }>();
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
  private readonly scenes = new Map<string, ProcessionScene>();
  /** Seconds simulated, for played processions. */
  private clock = 0;
  private played: { id: string; start: number } | undefined;
  private live: { id: string; progress: number; occurrence?: string } | undefined;
  /** Who is out and how hard it rains, as last drawn (`visible`): the flocks react to them. */
  private lastLevels: Activity | undefined;
  private lastRain = 0;

  /** `traffic`: the city's vehicle mix (its pack's `traffic`), over the default. */
  constructor(
    traffic?: TrafficMix,
    private readonly profiler?: FrameProfiler,
    private readonly momentOptions?: MomentOptions,
    itemInspection = false,
  ) {
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
    this.seasonalConfig = undefined;
    this.seasonsDirty = false;
    this.inspection?.clear();
    this.momentOptions?.memory?.clear();
    this.preparationEpoch++;
    this.preparedTerrain = new WeakMap();
    this.preparedSettled = new WeakSet();
    this.preparationTouched = new WeakSet();
    this.seamWait = new WeakMap();
    this.preparedRegistered = undefined;
    this.profiler?.clearContinuity();
    for (const tile of this.tiles.values()) tile.momentHost.clear();
    for (const { life } of this.retired.values()) life.momentHost.clear();
    this.tiles.clear();
    this.retired.clear();
    this.covers.clear();
    this.mixedZoom = false;
    this.junctions.clear();
    this.arrivals.clear();
    this.groundTerrain = undefined;
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
        this.forgetBirds(entry.life);
        entry.life.momentHost.clear();
        this.retired.delete(key);
      }
    if (cap)
      while (this.retired.size > RETIRE.max) {
        const key = this.retired.keys().next().value!;
        const life = this.retired.get(key)!.life;
        this.forgetBirds(life);
        life.momentHost.clear();
        this.retired.delete(key);
      }
  }

  private forgetBirds(life: TileLife) {
    if (!this.inspection?.birds && !this.inspection?.recoveringBirds) return;
    for (const flock of life.flocks)
      for (const bird of flock.birds) this.inspection.forgetBird(bird);
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
            new TileLife(tile, life, hashString(key), this.traffic, false, this.momentOptions);
          this.retired.delete(key);
          this.tiles.set(key, fresh);
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
          this.retired.set(key, { life, at: this.clock });
          this.tiles.delete(key);
          changed = true;
        }
      if (changed) {
        this.seasonsDirty = true;
        this.groundTerrain = undefined;
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
            a.m.rank - b.m.rank ||
            a.distance - b.distance ||
            a.key.localeCompare(b.key) ||
            a.index - b.index,
        );
      const consumed = new Set<PendingSeed>();
      const pendingPool = new Set(
        target.pending.filter((p) => p.mover.kind === kind && gained(p.mover)),
      );
      const replacements = new Set(
        target.movers.filter(
          (m) =>
            m.kind === kind &&
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
        const pending = nearestReplacement(pendingPool, c, (seed) => seed.mover);
        if (!pending && (count >= limit || kind === 'train')) {
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
    const terrain: GroundTerrain = {
      key: this.terrainKey(entries.map(([key]) => key)),
      ref,
      blocked: new PolygonIndex(),
      seasonal: new PolygonIndex(),
      water: new PolygonIndex(),
      trees: new PolygonIndex(),
      roadAccess: new RoadAccess([], []),
      origins: new Map(),
    };
    const origin = (life: TileLife) => {
      const found = terrain.origins.get(life);
      if (found) return found;
      const scale = 2 ** (ref!.tile.z - life.tile.z);
      const at = {
        x: ((life.tile.x * scale - ref!.tile.x) * EXTENT) / ref!.perMeter,
        y: ((life.tile.y * scale - ref!.tile.y) * EXTENT) / ref!.perMeter,
        scale: (scale * life.perMeter) / ref!.perMeter,
      };
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
        cached = { origin: key, blocked: [], water: [], trees: [] };
        const metric = (polygon: Polygon) =>
          polygon.map((ring) =>
            ring.map((p) => ({
              x: o.x + (p.x / life.perMeter) * o.scale,
              y: o.y + (p.y / life.perMeter) * o.scale,
            })),
          );
        for (const a of life.geo.areas ?? []) {
          if (a.kind === 'parking-exclusion') cached.trees.push(metric(a.rings));
          if (a.kind === 'blocked') (a.water ? cached.water : cached.blocked).push(metric(a.rings));
        }
        this.metricTerrain.set(life, cached);
      }
      yield;
      contributions.push({ owner: life, terrain: life.roadTerrain, ...o });
      for (const polygon of cached.trees) yield* terrain.trees.addSteps(polygon);
    }
    if (ref && this.seasonalConfig?.installations?.length) {
      const found = new Set<string>();
      for (const life of lives)
        for (const record of physicalSeasonalRecords(life.geo)) {
          if (
            found.has(record.id) ||
            (record.kind !== 'christmas-tree' &&
              (record.kind !== 'carnival' || record.style === 'midway')) ||
            !admitsInstallation(record, this.seasonalConfig)
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
      sandbox.lastLevels = this.lastLevels;
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
    const transform = (body: Body) => {
      body.x = o.x + body.x * o.scale;
      body.y = o.y + body.y * o.scale;
      body.length *= o.scale;
      body.width *= o.scale;
      return body;
    };
    life.reconcileSeasonalActors(
      (owner) => {
        const bodies = life.groundBodies(owner, 0, this.groundSample);
        for (const body of bodies) transform(body);
        return terrain.seasonal.hits(bodies);
      },
      (p) => {
        const spec = VEHICLES[p.vehicle];
        return terrain.seasonal.hits([
          transform({
            ...p,
            x: p.x / life.perMeter,
            y: p.y / life.perMeter,
            length: spec.length,
            width: spec.width,
          }),
        ]);
      },
      terrain.seasonal.polygons.length > 0,
    );
  }

  private groundGuard(
    minimum = 0,
    fresh?: ReadonlySet<TileLife>,
    bounds?: LngLatBounds,
    allBodies = false,
    region?: ReadonlySet<TileLife>,
  ) {
    return complete(this.groundGuardSteps(minimum, fresh, bounds, allBodies, region, false));
  }

  private *groundGuardSteps(
    minimum = 0,
    fresh?: ReadonlySet<TileLife>,
    bounds?: LngLatBounds,
    allBodies = false,
    region?: ReadonlySet<TileLife>,
    cooperative = true,
  ): Generator<void, WorldGroundGuard, void> {
    const buildStart = this.profiler?.time();
    const ref = this.tiles.values().next().value;
    const occupied = new Occupancy();
    const reservations = new Map<GroundAgent, readonly Body[]>();
    const key = this.terrainKey([...this.tiles.keys()]);
    const rebuild = this.groundTerrain?.key !== key;
    if (rebuild) this.groundTerrain = yield* this.prepareGroundTerrain([...this.tiles], true);
    const { blocked, water } = this.groundTerrain!;
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
    const bodies = (life: TileLife, owner: GroundAgent, out: Body[]) => {
      const o = origin(life);
      life.groundBodies(owner, minimum, out);
      for (const b of out) toRef(o, b);
      return out;
    };
    if (rebuild) this.revalidateTerrain();
    const roadAccess = this.groundTerrain!.roadAccess;
    let visited = 0;
    for (const life of this.tiles.values()) {
      if (region && !region.has(life)) continue;
      const o = origin(life);
      const near = bounds && viewIn(life.tile, bounds, 100 * life.perMeter);
      const inView = (p: { x: number; y: number }) => !near || near(p.x, p.y);
      const standing = (p: Parked | Stall, vehicle: CraftType) => {
        if (!inView(p) || !this.owns(life, p)) return;
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
        out.length = 1;
        toRef(o, b);
        occupied.set(p, out);
      };
      for (const p of life.parked) {
        standing(p, p.vehicle);
        if (cooperative && ++visited % 32 === 0) yield;
      }
      // Closed carts and those above the vendor level aren't drawn (`visible`), so aren't there.
      for (const s of life.seasonalStalls.length ? life.allStalls() : life.stalls) {
        if (cooperative && ++visited % 32 === 0) yield;
        if (
          allBodies ||
          (s.open !== false && (!this.lastLevels || s.rank < this.lastLevels.person))
        ) {
          if (allBodies || life.seasonalStalls.includes(s)) {
            if (this.owns(life, s)) occupied.set(s, bodies(life, s, buffer(s).live));
          } else standing(s, 'cart');
        }
      }
      if (fresh?.has(life)) continue;
      for (const m of life.movers) {
        if (cooperative && ++visited % 32 === 0) yield;
        if (
          inView(m) &&
          this.owns(life, m) &&
          !life.scenes.hidden(m) &&
          (m.kind === 'vehicle' || isWalker(m.kind)) &&
          (allBodies || !this.lastLevels || m.rank < this.lastLevels[m.kind])
        )
          occupied.set(m, bodies(life, m, buffer(m).live));
      }
      for (const g of life.gatherers) {
        if (cooperative && ++visited % 32 === 0) yield;
        if (
          inView(g) &&
          this.owns(life, g) &&
          (allBodies || !this.lastLevels || g.rank < this.lastLevels.places[g.place])
        )
          occupied.set(g, bodies(life, g, buffer(g).live));
      }
    }
    if (buildStart !== undefined)
      this.profiler!.add('clearanceBuild', this.profiler!.time() - buildStart);
    const check = (
      life: TileLife,
      owner: GroundAgent,
      before?: GroundAgent,
      ignore?: object,
      reserve = true,
      identity: GroundAgent = owner,
      reject?: (reason: ContinuityRejection) => void,
    ) => {
      if (!this.owns(life, owner)) return true;
      const onFoot = !('kind' in owner) || isWalker(owner.kind);
      const pair = buffer(owner);
      const next = bodies(life, owner, pair.trial);
      const previous = before ? bodies(life, before, this.groundPrevious) : next;
      const oldScore = before ? occupied.conflicts(identity, previous, ignore) : 0;
      const endScore = occupied.conflicts(identity, next, ignore);
      // Existing overlaps at a density change may escape, but never deepen or tunnel through.
      if (endScore > 0 && (oldScore === 0 || endScore >= oldScore - 1e-6)) {
        reject?.('occupancy');
        return false;
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
      const waterNear = onFoot && water.near(x0, y0, x1, y1);
      const roadNear = onFoot && roadAccess.near(x0, y0, x1, y1, crossing);
      const steps = Math.max(1, Math.ceil(distance / 0.3), turns);
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
          s.length = b.length;
          s.width = b.width;
        }
        if (
          (blockedNear && blocked.hits(sample)) ||
          (waterNear && water.hits(sample)) ||
          (roadNear && !roadAccess.allows(sample, crossing))
        ) {
          reject?.('terrain');
          return false;
        }
        if (oldScore === 0 && occupied.conflicts(identity, sample, ignore) > 0) {
          reject?.('occupancy');
          return false;
        }
      }
      if (reserve) {
        const reserved = reservations.get(identity);
        occupied.set(identity, reserved ? [...next, ...reserved] : next);
        pair.trial = pair.live;
        pair.live = next;
      }
      return true;
    };
    const remove = (owner: object) => {
      occupied.delete(owner);
      reservations.delete(owner as GroundAgent);
    };
    const reserveSeam = (life: TileLife, preview: Mover, identity: Mover) => {
      const reserved = bodies(life, preview, []).map((b) => ({ ...b }));
      reservations.set(identity, reserved);
      occupied.set(identity, [...occupied.bodies(identity), ...reserved]);
    };
    if (!this.profiler) return Object.assign(check, { remove, reserveSeam });
    return Object.assign(
      (...args: Parameters<typeof check>) => {
        const start = this.profiler!.time();
        this.profiler!.check();
        try {
          return check(...args);
        } finally {
          this.profiler!.add('clearanceChecks', this.profiler!.time() - start);
        }
      },
      { remove, reserveSeam },
    );
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
      ref: { tile: ref.tile, perMeter: ref.perMeter },
      forbidden: terrain.roadAccess.forbidden,
      roads: terrain.roadAccess.roads,
      trees: terrain.trees,
    };
  }

  /** Whole ASCII cells must obey the same ground rules, even when wider than a figure. */
  groundCellGuard(toCell: (lng: number, lat: number) => [number, number]) {
    const ref = this.groundTerrain?.ref;
    const terrain = this.groundTerrain;
    if (!ref || !terrain) return undefined;
    return makeCellGuard(ref, terrain.roadAccess, terrain.trees, toCell);
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
    weather?: { rain: number; minutes?: number; season?: string | null },
    cellMeters = 0,
    cellAspect = DEFAULT_CELLS.aspect,
  ) {
    this.syncSeason(weather?.season);
    if (this.seasonalConfig)
      for (const tile of this.tiles.values())
        tile.clearSeasonalStalls(Math.max(0, MAX_TILE_AGENTS - tile.population));
    const clamped = Math.min(MAX_STEP_S, Math.max(0, dt));
    if (clamped === 0) return;
    if (bounds && this.viewContext) this.viewContext = { ...this.viewContext, bounds };
    this.clock += clamped;
    this.pruneRetired();
    if (!this.tiles.size) {
      this.arrivals.clear();
      return;
    }
    const shows =
      zoom === undefined
        ? undefined
        : (kind: AgentKind) => bandVisibility(LIFE_ZOOM[kind], zoom) >= 1;
    const env: LifeEnv = {
      inspecting: this.inspection?.owner,
      clock: this.clock,
      levels: this.lastLevels,
      rain: this.lastRain,
      wind,
      ...weather,
      cityLife: this.cityLife,
    };
    const guard = this.groundGuard(cellMeters, undefined, bounds);
    this.junctions.begin(new Set(this.tiles.values()));
    const eligibility = new Map<TileLife, (m: Mover) => boolean>();
    for (const tile of this.tiles.values()) {
      const near = viewIn(tile.tile, bounds, STEP_MARGIN_M * tile.perMeter);
      const active = (m: Mover) =>
        this.owns(tile, m) &&
        (!shows || shows(m.kind)) &&
        near(m.x, m.y) &&
        (!env.levels || m.rank < env.levels[m.kind]) &&
        !tile.scenes.hidden(m);
      eligibility.set(tile, active);
      tile.prepareTraffic(active);
    }
    for (const [key, tile] of this.tiles)
      tile.requestJunctions(this.junctions, eligibility.get(tile)!, this.clock, key);
    this.junctions.resolve(this.clock);
    const trains = trainLimits(
      [...this.tiles.values()],
      clamped,
      this.mixedZoom ? (life, m) => this.owns(life, m) : undefined,
      env.inspecting,
    );
    const seamLimits = new Map<Mover, { room: number; crossing: boolean }>();
    const intents: {
      source: TileLife;
      target: TileLife;
      m: Mover;
      before: Mover;
      boundary: Mover;
    }[] = [];
    const inbound = new Map<TileLife, number>();
    const owners = [...this.tiles.values()].sort((a, b) => b.tile.z - a.tile.z);
    const ownerAt = (source: TileLife, p: { x: number; y: number }) =>
      owners.find((life) => {
        const f = frameBetween(source.tile, life.tile);
        const q = { x: f.x + p.x * f.scale, y: f.y + p.y * f.scale };
        return inTile(q) && this.owns(life, q);
      });
    for (const source of this.tiles.values())
      for (const m of source.movers) {
        if (
          env.inspecting === m ||
          (m.kind !== 'vehicle' && m.kind !== 'boat') ||
          !eligibility.get(source)!(m) ||
          !source.scenes.transferable(m)
        )
          continue;
        const pm = source.perMeter,
          k = kinematicsOf(m.vehicle);
        const length = m.vehicle ? VEHICLES[m.vehicle].length : 0;
        const reach = Math.max(
          12 * pm,
          (m.v ?? m.speed) ** 2 / (2 * k.brake * pm) + (length + 2) * pm,
        );
        // Cheap uniform-tile rejection keeps the additional work off ordinary inner-tile traffic.
        if (!this.covers.has(source) && Math.min(m.x, m.y, EXTENT - m.x, EXTENT - m.y) > reach)
          continue;
        const seam = seamAhead(source, m, this.covers.get(source) ?? [], reach);
        if (!seam) {
          this.seamWait.delete(m);
          continue;
        }
        this.profiler?.countContinuity('attempts');
        const target = ownerAt(source, seam.preview);
        if (!target || target === source) {
          const key = `${source.tile.z}/${source.tile.x}/${source.tile.y}/${m.line}/${m.dir}`;
          let wait = this.seamWait.get(m);
          if (wait?.key !== key) {
            wait = { key, at: source.elapsed };
            this.seamWait.set(m, wait);
          }
          if (source.elapsed - wait.at >= SEAMS.missingSeconds) continue;
        } else this.seamWait.delete(m);
        const reject =
          this.profiler &&
          ((reason: ContinuityRejection) => this.profiler!.countContinuity(reason));
        let preview: Mover | undefined;
        if (!target || target === source) reject?.('ownership');
        else if (target.population + (inbound.get(target) ?? 0) >= MAX_TILE_AGENTS)
          reject?.('capQuota');
        else preview = target.projectFrom(seam.preview, source, { reject });
        const safe =
          preview &&
          target &&
          (m.kind === 'boat'
            ? this.boatRoom(target, preview, m, intents)
            : guard(target, preview, undefined, undefined, false, m, reject));
        if (safe && target && preview) {
          guard.reserveSeam(target, preview, m);
          inbound.set(target, (inbound.get(target) ?? 0) + 1);
          intents.push({ source, target, m, before: { ...m }, boundary: seam.preview });
          seamLimits.set(m, { room: Infinity, crossing: true });
        } else
          seamLimits.set(m, {
            room: Math.max(0, seam.distance - (length / 2 + FOLLOW.minGap) * pm),
            crossing: false,
          });
      }
    for (const tile of this.tiles.values()) {
      const inTile = gustAt
        ? (x: number, y: number) => gustAt(...tileToLngLat(tile.tile, { x, y }))
        : undefined;
      const near = bounds && viewIn(tile.tile, bounds, STEP_MARGIN_M * tile.perMeter);
      tile.step(clamped, inTile, shows, near, env, (owner, before) => guard(tile, owner, before), {
        junctions: this.junctions,
        trains,
        momentView: { zoom: zoom ?? MOMENTS.zoom, cellWidth: cellMeters, cellAspect },
        seams: seamLimits,
        owns: this.covers.has(tile) ? (p) => this.owns(tile, p) : undefined,
      });
    }
    // All original owners have stepped once. New owners start stepping on the next frame.
    for (const { source, target, m, before, boundary } of intents) {
      const clipped = Math.hypot(m.x - boundary.x, m.y - boundary.y) < 0.005 * source.perMeter;
      if (ownerAt(source, m) !== target && !clipped) continue;
      const held = this.junctions.movement(m);
      if (
        target.adoptFrom(
          m,
          source,
          { nudgeM: clipped ? 0.001 : 0 },
          (preview) =>
            inTile(preview) &&
            this.owns(target, preview) &&
            (m.kind === 'boat'
              ? this.boatRoom(target, preview, m, [])
              : guard(target, preview, undefined, undefined, false, m)),
        )
      ) {
        this.profiler?.countContinuity('transfers');
        if (held)
          this.junctions.rebind(
            m,
            target,
            [...this.tiles].find(([, life]) => life === target)![0],
            source,
          );
        guard.remove(m);
        if (m.kind === 'vehicle') guard(target, m);
      } else {
        // A final pose/clearance check can fail after a bend or another actor's accepted step.
        // Keep the original owner at its last safe pose instead of hiding it beyond the seam.
        Object.assign(m, before, { v: 0 });
        guard.remove(m);
        if (m.kind === 'vehicle') guard(source, m);
      }
    }
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
    this.admitBirths(clamped);
    if (this.seasonalConfig)
      for (const tile of this.tiles.values())
        tile.clearSeasonalStalls(Math.max(0, MAX_TILE_AGENTS - tile.population));
    if (this.profiler)
      for (const [key, life] of this.tiles)
        for (const m of life.movers) {
          if (!this.profiler.tracing(m)) continue;
          const [lng, lat] = tileToLngLat(life.tile, life.pose(m));
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

  /** The city's processions (its `<slug>.processions.json`). */
  setProcessions(routes: readonly ProcessionRoute[]) {
    this.scenes.clear();
    for (const route of routes) this.scenes.set(route.id, new ProcessionScene(route));
    if (this.played && !this.scenes.has(this.played.id)) this.played = undefined;
  }

  /** Play a procession from its start, as a time-lapse (`ProcessionScene.playDuration`). */
  play(id: string): boolean {
    if (!this.scenes.has(id)) return false;
    this.played = { id, start: this.clock };
    return true;
  }

  stop() {
    this.played = undefined;
  }

  /** The procession under way by its schedule, and how far through it is; or none. */
  setLive(id: string | undefined, progress = 0, occurrence?: string) {
    this.live = id && this.scenes.has(id) ? { id, progress, occurrence } : undefined;
  }

  /** The procession to show: one being played, else a live one. */
  procession(): ProcessionRun | undefined {
    if (this.played) {
      const duration = this.scenes.get(this.played.id)!.playDuration;
      const progress = (this.clock - this.played.start) / duration;
      if (progress < 1) return { id: this.played.id, progress, live: false };
      this.played = undefined;
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
    // A bare number is the daylight, with no clock (config.ts `activityLevels`).
    const levels =
      typeof levelsOrDaylight === 'number' ? activityLevels(levelsOrDaylight) : levelsOrDaylight;
    this.lastLevels = levels;
    this.lastRain = weather.rain;
    const shows = (kind: AgentKind) => bandVisibility(LIFE_ZOOM[kind], zoom) >= 1;
    const out: VisibleAgent[] = [];
    const inspection = this.inspection;
    inspection?.begin(this.clock);
    // Choose the plain fallback once, outside the per-actor loop.
    const push: (owner: object, agent: VisibleAgent, birdSpeed?: number) => number = inspection
      ? (owner, agent, birdSpeed) => out.push(inspection.present(owner, agent, birdSpeed))
      : (_owner, agent) => out.push(agent);
    const owners = zoom >= MOMENTS.zoom ? new Map<object, VisibleAgent>() : undefined;
    const balls: { agent: VisibleAgent; a: object; b: object }[] = [];
    const umbrellas = umbrellaShare(weather.rain, weather.sunAltitude);
    // A procession closes the river to other boats, and always shows.
    const run = this.procession();
    const scene = run && this.scenes.get(run.id)!;
    const staged = scene
      ? scene.agents(run.progress, this.clock, {
          boats: shows('boat'),
          crowds: zoom >= PROCESSION.crowdZoom,
          crews: zoom >= PROCESSION.crewZoom,
          bounds,
          inspection,
          scope: run.live
            ? `live/${this.live?.occurrence ?? run.id}`
            : `play/${this.played?.start}`,
        })
      : [];
    for (const life of this.tiles.values()) {
      const { tile, perMeter } = life;
      const inView = viewIn(tile, bounds, VIEW_MARGIN_M * perMeter);
      for (const m of life.movers) {
        if (!this.owns(life, m)) continue;
        if (life.scenes.hidden(m)) continue;
        if (!shows(m.kind) || (!m.train && m.rank >= levels[m.kind] * crowd)) continue;
        if (scene && m.kind === 'boat') continue;
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
        const ahead = tileToLngLat(tile, { x: x + hx * perMeter, y: y + hy * perMeter });
        if (m.vehicle) {
          const side = tileToLngLat(tile, { x: x - hy * perMeter, y: y + hx * perMeter });
          push(m, {
            kind: m.kind,
            lng,
            lat,
            ahead,
            side,
            vehicle: m.vehicle,
            paint: m.paint,
            turnSignal:
              m.kind === 'vehicle'
                ? visibleTurnSignal(m.routing, inspection?.clock(m, this.clock) ?? this.clock)
                : undefined,
            flap: 0,
          });
        } else if (m.group) {
          const stride = Math.floor((m.walked ?? 0) / PEOPLE.stride);
          const people = m.group.map((w, member): PersonLook => {
            const want = w.figure === 'adult' && w.umbrella < umbrellas;
            const open =
              w.figure === 'adult' && zoom >= UMBRELLA_MOTION.zoom
                ? this.umbrellas.look(w, want, inspection?.clock(m, this.clock) ?? this.clock)
                : Number(want);
            return {
              figure: open > 0 ? 'umbrella' : w.figure,
              paint: open > 0 ? w.canopy : w.shirt,
              lateral: w.lateral,
              back: w.back,
              // Standing still, feet together.
              flap: m.pause > 0 ? 0 : (stride + w.step) & 1,
              pose: life.momentHost.pose(m, member),
              ...(open > 0 &&
                open < 1 && {
                  canopy: { open, figure: w.figure, paint: w.shirt },
                }),
            };
          });
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
          });
        }
      }
      if (shows('person')) {
        const vendorsOut = levels.person * crowd;
        for (const s of life.seasonalStalls.length ? life.allStalls() : life.stalls) {
          if (!this.owns(life, s)) continue;
          if (s.open === false) continue;
          if (s.rank >= vendorsOut || s.x < 0 || s.x >= EXTENT || s.y < 0 || s.y >= EXTENT)
            continue;
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
          if (g.rank >= levels.places[g.place] * crowd || !inView(g.x, g.y)) continue;
          const w = g.walker;
          const shaded = w.figure === 'adult' && w.umbrella < umbrellas;
          const open =
            w.figure === 'adult' && zoom >= UMBRELLA_MOTION.zoom
              ? this.umbrellas.look(w, shaded, inspection?.clock(g, this.clock) ?? this.clock)
              : Number(shaded);
          const figure = g.behavior === 'sit' ? 'seated' : w.figure;
          const still = g.pause > 0 || g.behavior === 'sit';
          const look: PersonLook = {
            figure: open > 0 ? 'umbrella' : figure,
            paint: open > 0 ? w.canopy : w.shirt,
            lateral: 0,
            back: 0,
            // Standing still (or sitting), feet together.
            flap: still ? 0 : (Math.floor(g.walked / PEOPLE.stride) + w.step) & 1,
            pose: life.momentHost.pose(g) ?? (still && g.momentFacing ? 'attentive' : undefined),
            ...(open > 0 && open < 1 && { canopy: { open, figure, paint: w.shirt } }),
          };
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
            const [lng, lat] = at(g.x, g.y);
            const { hx, hy } = g.momentFacing ?? g;
            const ahead = at(g.x + hx * perMeter, g.y + hy * perMeter);
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
        const out_ = spec.nocturnal ? levels.night : levels.bird;
        if (
          flock.rank >= out_ * crowd ||
          (!inView(flock.x, flock.y) &&
            !(inspection?.recoveringBirds && flock.birds.some((bird) => inspection.hasBird(bird))))
        )
          continue;
        const wobble = life.elapsed * 0.8;
        const sitting = flock.perched || flock.landed;
        const heading = Math.atan2(flock.hy, flock.hx);
        // Perched, the birds sit still and close in the crown; on the ground, still and spread
        // out; flushed, they scatter outward.
        const perchSpread = PERCH.spread / spec.spread[1];
        const spread = flock.perched
          ? perchSpread
          : flock.landed
            ? 1
            : 1 + (3 * flock.scatter) / PERCH.scatter;
        for (const bird of flock.birds) {
          const turn = sitting ? bird.phase * 6 : wobble + bird.phase * 6;
          const cos = Math.cos(turn) * spread;
          const sin = Math.sin(turn) * spread;
          const x = flock.x + bird.ox * cos - bird.oy * sin;
          const y = flock.y + bird.ox * sin + bird.oy * cos;
          const [lng, lat] = tileToLngLat(tile, { x, y });
          const birdTime = inspection?.birds ? inspection.clock(bird, life.elapsed) : life.elapsed;
          const flap = sitting ? 0 : Math.floor(birdTime * spec.flap + bird.phase * 2) & 1;
          const pose = sitting ? BirdPose.perched : flap === 1 ? BirdPose.raised : BirdPose.spread;
          // Flying, each faces a little off the flock's way; sitting, each its own way.
          const face = sitting ? bird.phase * 2 * Math.PI : heading + (bird.phase - 0.5) * 0.6;
          const ahead = tileToLngLat(tile, {
            x: x + Math.cos(face) * perMeter,
            y: y + Math.sin(face) * perMeter,
          });
          push(
            bird,
            { kind: 'bird', lng, lat, ahead, flap, bird: { species: flock.species, pose } },
            spec.speed,
          );
        }
      }
    }
    const withBalls = (admitted: VisibleAgent[]) => {
      if (!balls.length) return admitted;
      const kept = new Set(admitted);
      // The cap counts ordinary records. Procession prefix and trains are protected.
      let count = 0;
      for (let i = staged.length; i < admitted.length; i++)
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
    if (out.length <= maxAgents) {
      const result = withBalls([...staged, ...out]);
      return inspection?.finish(result) ?? result;
    }
    const [cx, cy] = center;
    // Each one's distance worked out once, not in every comparison.
    const groups = new Map<object, { agents: VisibleAgent[]; d: number }>();
    for (const agent of out) {
      const key = agent.consist ?? agent;
      const d = (agent.lng - cx) ** 2 + (agent.lat - cy) ** 2;
      const group = groups.get(key);
      if (group) {
        group.agents.push(agent);
        group.d = Math.min(group.d, d);
      } else groups.set(key, { agents: [agent], d });
    }
    const nearest = [...groups.values()].sort((a, b) => a.d - b.d);
    const kept = staged.slice();
    let count = 0;
    for (const group of nearest) {
      if (group.agents[0]!.kind === 'train') {
        kept.push(...group.agents);
        continue;
      }
      if (count + group.agents.length > maxAgents) continue;
      kept.push(...group.agents);
      count += group.agents.length;
    }
    const result = withBalls(kept);
    return inspection?.finish(result, true) ?? result;
  }
}
