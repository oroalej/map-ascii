/**
 * The life layer's simulation (SPEC.md §4 "Life layer"): vehicles, people, and boats moving
 * along the lines of the tiles on screen, and flocks of birds circling over parks, trees, and
 * water. Agents live in tile units, per tile; a tile's agents are spawned from a seed made of its
 * key when it comes into view, so the same tile always starts with the same agents. Pure TS: the
 * renderer projects the agents onto the cell grid (passes.ts `lifePass`).
 */
import {
  bandVisibility,
  type PlaceKind,
  type ProcessionRoute,
  type TrafficMix,
} from '@atlas/shared';
import { EXTENT, lngLatToTile, metersPerUnit, tileToLngLat } from '../raster/geometry';
import type { TileId } from '../tiles';
import {
  activityLevels,
  type Activity,
  BIRDS,
  CARABAO_SHARE,
  PERCH,
  DEFAULT_ROAD_WIDTH_M,
  FOLLOW,
  laneOffset,
  LIFE_ZOOM,
  MAX_STEP_S,
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
  usableLines,
  VENDORS,
  type AgentKind,
  type PlaceBehavior,
} from './config';
import { LifeLine, PLACE_CODES, PLACE_STRIDE, type LifeGeometry } from './geometry';
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

export { hashString, random } from './random';

const NO_MOVERS: readonly Mover[] = [];

/** Agents this far outside the view's bounds are still placed, m: a vehicle half in view shows. */
const VIEW_MARGIN_M = 30;

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

/** Something that moves along lines: a vehicle, a person, or a boat. */
export type Mover = {
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
  /** Vehicles and boats: which kind, and its paint (vehicles.ts `Paint`). */
  vehicle?: CraftType;
  paint: number;
  /** Vehicles: which of the lanes on its side of the road it keeps to, 0–1 (`laneOffset`). */
  lane: number;
  /** Seconds left standing still (people). */
  pause: number;
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
  /** The flock's center, in tile units. */
  x: number;
  y: number;
  /** The roost it circles (an index into `roosts` pairs). */
  roost: number;
  /** The tree it flies to or sits in (an index into `perches` pairs), or -1. */
  perch: number;
  /** Sitting in that tree. */
  perched: boolean;
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
  readonly movers: Mover[] = [];
  readonly flocks: Flock[] = [];
  readonly parked: Parked[] = [];
  /** Trains standing by on sidings: one entry per car (`spawnStandby`). */
  readonly standby: Parked[] = [];
  /** Street vendors with their carts (`spawnStalls`). */
  readonly stalls: Stall[] = [];
  /** People at places: churches, schools, pitches, benches, fields (`spawnGatherers`). */
  readonly gatherers: Gatherer[] = [];
  /** Tile units per meter. */
  readonly perMeter: number;
  private readonly rng: () => number;
  /** Scratch for `followSpeeds`, by mover: its speed, progress along its line, and offset. */
  private speeds = new Float64Array(0);
  private progress = new Float64Array(0);
  private offsets = new Float64Array(0);
  /** How people look and where vendors stand: its own stream, so no one else moves for it. */
  private readonly looks: () => number;
  /** People at places: their own stream, so no one else moves for them. */
  private readonly placeRng: () => number;
  /** Road lines with vehicles parked along their curbs; traffic drives on what is left. */
  private readonly parkingLines = new Set<number>();
  /** Per vertex, the distance along its line from the line's first vertex, in tile units. */
  private readonly along: Float64Array;
  /** Line ends by position: packed position → line * 2 + (0 start, 1 end). */
  private readonly ends = new Map<number, number[]>();
  private time = 0;

  constructor(
    readonly tile: TileId,
    readonly geo: LifeGeometry,
    seed: number,
    private readonly traffic: ResolvedTraffic = resolveTraffic(),
  ) {
    this.perMeter = 1 / metersPerUnit(tile);
    this.rng = random(seed);
    this.looks = random(seed ^ 0xc2b2ae35);
    this.placeRng = random(seed ^ 0x27d4eb2f);
    const lines = geo.kinds.length;
    this.along = new Float64Array(geo.coords.length / 2);
    for (let line = 0; line < lines; line++) {
      this.addEnd(this.first(line), line * 2);
      this.addEnd(this.last(line), line * 2 + 1);
      for (let v = this.first(line) + 1; v <= this.last(line); v++) {
        this.along[v] = this.along[v - 1]! + this.segment(v - 1, v);
      }
    }
    // Parking first, on its own random stream: it narrows the lanes, but doesn't change who
    // else is out.
    this.spawnParked(random(seed ^ 0x9e3779b9));
    this.spawnStandby(random(seed ^ 0x85ebca6b));
    for (let line = 0; line < lines; line++) this.spawnOn(line);
    this.spawnStalls();
    this.spawnGatherers();
    this.spawnFlocks();
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

  private lineLength(line: number) {
    let length = 0;
    for (let v = this.first(line); v < this.last(line); v++) length += this.segment(v, v + 1);
    return length;
  }

  private spawnOn(line: number) {
    const kind = this.geo.kinds[line]! as LifeLine;
    const rules = spawnRules[kind];
    const road = trafficRoadFor[kind];
    const meters = this.lineLength(line) / this.perMeter;
    if (!rules || meters === 0) return;
    const { rng } = this;
    for (const rule of rules) {
      const count = Math.floor(meters / rule.spacing + rng());
      for (let i = 0; i < count && this.movers.length < MAX_TILE_AGENTS; i++) {
        const dir = rng() < 0.5 ? 1 : -1;
        let speed = between(rng, rule.speed);
        let vehicle: CraftType | undefined;
        let paint = 0;
        let lane = 0;
        let train: Train | undefined;
        if (rule.kind === 'train') {
          const coaches = Math.round(between(rng, TRAIN.coaches));
          const cars: RailCraft[] = ['locomotive', ...Array<RailCraft>(coaches).fill('coach')];
          paint = TRAIN_PAINTS[Math.floor(rng() * TRAIN_PAINTS.length)]!;
          train = { cars, trail: [], reverse: false, edge: false, stopX: NaN, stopY: NaN };
        }
        if ((rule.kind === 'vehicle' || rule.kind === 'boat') && road) {
          vehicle = pickVehicle(this.traffic[road], rng());
          const spec = VEHICLES[vehicle];
          speed = Math.min(speed * spec.speed, spec.maxSpeed ?? Infinity);
          paint = spec.paints[Math.floor(rng() * spec.paints.length)]!;
          if (rule.kind === 'vehicle') lane = rng();
        }
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
        if (rule.kind === 'person') {
          mover.group = this.spawnGroup();
          // Somewhere in their stride, so a crowd doesn't step in time.
          mover.walked = this.looks() * 2 * PEOPLE.stride;
        }
        // Start somewhere along the line.
        this.advance(mover, rng() * this.lineLength(line), false);
        // A train pulls in until the track behind it holds all its cars.
        if (train) {
          this.moveTrain(mover, trainLength(train.cars) * this.perMeter);
          mover.pause = 0;
        }
        this.movers.push(mover);
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
    if (m.kind !== 'vehicle' || !m.vehicle) return 0;
    const spec = VEHICLES[m.vehicle];
    return laneOffset(this.roadWidth(m.line), spec.width, m.lane, spec.curb);
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
   * Street vendors (config.ts `VENDORS`): carts along side streets, paths, and around parks,
   * more of them near markets, each by a road's curb or beside a path, facing along it.
   */
  private spawnStalls() {
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
        const p = this.pointAt(line, looks() * length);
        const side = looks() < 0.5 ? 1 : -1;
        const offset =
          kind === LifeLine.roadMinor
            ? (geo.widths[line] || DEFAULT_ROAD_WIDTH_M) / 2 - VENDORS.curb
            : VENDORS.beside;
        // Right of the line's direction for `side` 1; the vendor stands on the far side.
        const o = offset * perMeter * side;
        this.stalls.push({
          x: p.x - p.hy * o,
          y: p.y + p.hx * o,
          hx: p.hx,
          hy: p.hy,
          paint: paints[Math.floor(looks() * paints.length)]!,
          shirt: SHIRT_PAINTS[Math.floor(looks() * SHIRT_PAINTS.length)]!,
          side,
          rank: looks(),
        });
      }
    }
  }

  /**
   * People at places (config.ts `PLACES`): around churches and schools (on their grounds, or
   * around their buildings), running about pitches, at monuments and fountains, on benches, and
   * working the fields, at most `MAX_TILE_GATHERERS`. At a school, most are children.
   */
  private spawnGatherers() {
    const { geo, perMeter } = this;
    const rng = this.placeRng;
    for (let i = 0; i < geo.places.length; i += PLACE_STRIDE) {
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
      for (let n = 0; n < count && this.gatherers.length < MAX_TILE_GATHERERS; n++) {
        const figure = place === 'school' && rng() < 0.6 ? 'child' : 'adult';
        const g: Gatherer = {
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
          g.x = cx + (n - (count - 1) / 2) * 0.5 * perMeter;
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
        this.gatherers.push(g);
      }
    }
  }

  /**
   * Where someone at a place walks next: across the pitch (players); to the end of their row,
   * then along the next row over, back the other way (farm workers); or a few meters round the
   * building, monument, or fountain they stand by, or across the grounds they stand on.
   */
  private nextTarget(g: Gatherer) {
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
  private stepGatherers(dt: number) {
    const rng = this.placeRng;
    for (const g of this.gatherers) {
      if (g.behavior === 'sit') continue;
      if (g.pause > 0) {
        g.pause -= dt;
        continue;
      }
      const dx = g.tx - g.x;
      const dy = g.ty - g.y;
      const dist = Math.hypot(dx, dy);
      const move = g.speed * dt;
      if (dist <= move) {
        g.x = g.tx;
        g.y = g.ty;
        g.pause = between(rng, PLACES[g.place].pause);
        this.nextTarget(g);
        continue;
      }
      g.hx = dx / dist;
      g.hy = dy / dist;
      g.x += g.hx * move;
      g.y += g.hy * move;
      g.walked += move / this.perMeter;
    }
  }

  /**
   * Parked vehicles (config.ts `PARKED`): on parking lots' stalls, and along both curbs of
   * some wide roads, facing the traffic on their side.
   */
  private spawnParked(rng: () => number) {
    const { geo, perMeter } = this;
    const shares = this.traffic.parked;
    const park = (x: number, y: number, hx: number, hy: number, vehicle: CraftType) => {
      if (this.parked.length >= MAX_TILE_AGENTS) return;
      const paints = VEHICLES[vehicle].paints;
      const paint = paints[Math.floor(rng() * paints.length)]!;
      this.parked.push({ x, y, hx, hy, vehicle, paint });
    };
    for (let i = 0; i < geo.spots.length; i += 4) {
      const vehicle = pickVehicle(shares, rng());
      if (rng() < PARKED.lotTaken) {
        park(geo.spots[i]!, geo.spots[i + 1]!, geo.spots[i + 2]!, geo.spots[i + 3]!, vehicle);
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
          const vehicle = pickVehicle(shares, rng());
          const spec = VEHICLES[vehicle];
          const center = at + (spec.length / 2) * perMeter;
          at += (spec.length + PARKED.gap) * perMeter;
          if (at > length) break;
          if (rng() >= PARKED.taken) continue;
          const p = this.pointAt(line, center);
          const offset = (width / 2 - spec.width / 2 - ROAD_MARGIN_M) * perMeter * side;
          // Right of the line's own direction for `side` 1, facing along it; left, facing back.
          park(p.x - p.hy * offset, p.y + p.hx * offset, p.hx * side, p.hy * side, vehicle);
        }
      }
    }
  }

  /**
   * A train standing by on each siding, spur, or yard track (config.ts `TRAIN.standby`): a
   * locomotive and as many coaches as fit, from `margin` m in from the siding's start. A siding
   * belongs to the tile holding its first vertex, so each gets one train, however many tiles'
   * buffers it reaches into.
   */
  private spawnStandby(rng: () => number) {
    const { geo, perMeter } = this;
    const { margin, coaches } = TRAIN.standby;
    for (let line = 0; line < geo.kinds.length; line++) {
      if (geo.kinds[line] !== LifeLine.siding) continue;
      const x = geo.coords[this.first(line) * 2]!;
      const y = geo.coords[this.first(line) * 2 + 1]!;
      if (x < 0 || x >= EXTENT || y < 0 || y >= EXTENT) continue;
      const cars: RailCraft[] = [
        'locomotive',
        ...Array<RailCraft>(Math.round(between(rng, coaches))).fill('coach'),
      ];
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

  private spawnFlocks() {
    const { rng, geo } = this;
    const roosts = geo.roosts.length / 2;
    const perches = geo.perches.length / 2;
    const flocks = Math.min(BIRDS.flocksPerTile, roosts + perches);
    for (let f = 0; f < flocks; f++) {
      // A tile with only trees starts its flocks in them.
      const inTree = roosts === 0;
      const roost = inTree ? 0 : Math.floor(rng() * roosts);
      const perch = inTree ? Math.floor(rng() * perches) : -1;
      const home = inTree ? geo.perches : geo.roosts;
      const at = inTree ? perch : roost;
      const size = Math.round(between(rng, BIRDS.flockSize));
      const birds: Bird[] = [];
      for (let b = 0; b < size; b++) {
        const angle = rng() * 2 * Math.PI;
        const spread = between(rng, BIRDS.spread) * this.perMeter;
        birds.push({ ox: Math.cos(angle) * spread, oy: Math.sin(angle) * spread, phase: rng() });
      }
      this.flocks.push({
        x: home[at * 2]!,
        y: home[at * 2 + 1]!,
        roost,
        perch,
        perched: inTree,
        scatter: 0,
        angle: rng() * 2 * Math.PI,
        radius: between(rng, BIRDS.orbit) * this.perMeter,
        stay: between(rng, BIRDS.stay),
        rank: rng(),
        birds,
      });
    }
  }

  /** Move a mover `distance` tile units along its lines, turning at junctions and dead ends. */
  private advance(m: Mover, distance: number, junctions = true) {
    const { coords } = this.geo;
    let left = distance;
    // Bounded, so zero-length segments can't loop forever.
    for (let guard = 0; guard < 256; guard++) {
      const to = m.from + m.dir;
      const length = this.segment(m.from, to);
      if (m.d + left < length) {
        m.d += left;
        break;
      }
      left -= length - m.d;
      m.d = 0;
      m.from = to;
      const atEnd = m.dir === 1 ? to === this.last(m.line) : to === this.first(m.line);
      if (atEnd) {
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
  }

  /** At a line's end: carry on along another usable line that starts or ends here, else U-turn. */
  private turn(m: Mover) {
    const arrived = m.line * 2 + (m.dir === 1 ? 1 : 0);
    const usable = usableLines[m.kind];
    const options = (this.ends.get(this.endKey(m.from)) ?? []).filter(
      (code) => code !== arrived && usable.includes(this.geo.kinds[code >> 1]! as LifeLine),
    );
    if (options.length === 0) {
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
    const code = m.train
      ? this.straightest(m, options)
      : options[Math.floor(this.rng() * options.length)]!;
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
    for (let left = distance; left > 0 && !train.reverse; left -= crumb) {
      const [px, py] = [m.x, m.y];
      this.advance(m, Math.min(left, crumb));
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
  takeLeavers(): readonly Mover[] {
    let out: Mover[] | undefined;
    for (let i = this.movers.length - 1; i >= 0; i--) {
      const m = this.movers[i]!;
      if (!m.train || (m.x >= 0 && m.x < EXTENT && m.y >= 0 && m.y < EXTENT)) continue;
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
  private atStation(m: Mover): boolean {
    const train = m.train!;
    const { stations } = this.geo;
    const reach = TRAIN.stationReach * this.perMeter;
    // Pulling out of its last stop; once well clear of it, it may stop there again on its way
    // back.
    if (Math.hypot(m.x - train.stopX, m.y - train.stopY) < TRAIN.stationGap * this.perMeter) {
      return false;
    }
    train.stopX = train.stopY = NaN;
    for (let i = 0; i < stations.length; i += 2) {
      if (Math.hypot(stations[i]! - m.x, stations[i + 1]! - m.y) <= reach) {
        train.stopX = m.x;
        train.stopY = m.y;
        return true;
      }
    }
    return false;
  }

  /**
   * Following (config.ts `FOLLOW`): each vehicle's or boat's speed for this step, slowed behind
   * the nearest one ahead on its line, going its way, that it can't pass side by side. Queues
   * across junctions, cross traffic, and tile borders are not looked at.
   */
  private followSpeeds(shows?: (kind: AgentKind) => boolean): Float64Array {
    const { movers, perMeter } = this;
    // Reused between steps; grown when there are more movers.
    if (this.speeds.length < movers.length) {
      const size = Math.max(movers.length, 2 * this.speeds.length);
      this.speeds = new Float64Array(size);
      this.progress = new Float64Array(size);
      this.offsets = new Float64Array(size);
    }
    const { speeds, progress, offsets } = this;
    const groups = new Map<number, number[]>();
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i]!;
      speeds[i] = m.speed;
      if (!m.vehicle || (shows && !shows(m.kind))) continue;
      const key = m.line * 2 + (m.dir === 1 ? 1 : 0);
      const group = groups.get(key);
      if (group) group.push(i);
      else groups.set(key, [i]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      // Meters along the line in the direction of travel, and each one's lateral offset.
      for (const i of group) {
        const m = movers[i]!;
        progress[i] = (m.dir * this.along[m.from]! + m.d) / perMeter;
        offsets[i] = this.offsetOf(m);
      }
      group.sort((a, b) => progress[a]! - progress[b]! || a - b);
      for (let k = 0; k < group.length - 1; k++) {
        const i = group[k]!;
        const me = VEHICLES[movers[i]!.vehicle!];
        for (let l = k + 1; l < group.length; l++) {
          const j = group[l]!;
          const them = VEHICLES[movers[j]!.vehicle!];
          const apart = Math.abs(offsets[i]! - offsets[j]!);
          if (apart >= (me.width + them.width) / 2 - FOLLOW.squeeze) continue;
          const gap = progress[j]! - progress[i]! - (me.length + them.length) / 2;
          const fits = Math.max(0, (gap - FOLLOW.minGap) / FOLLOW.headway) * perMeter;
          speeds[i] = Math.min(speeds[i]!, fits);
          break;
        }
      }
    }
    return speeds;
  }

  /**
   * Move everything on by `dt` seconds. `gustAt` is how hard the wind blows in a tree's crown at
   * a point (tile units), which can flush birds out of it. With `shows`, only the kinds it shows
   * move (the others wait where they are, unseen).
   */
  step(
    dt: number,
    gustAt?: (x: number, y: number) => number,
    shows?: (kind: AgentKind) => boolean,
  ) {
    this.time += dt;
    const { rng } = this;
    const speeds = this.followSpeeds(shows);
    for (const [i, m] of this.movers.entries()) {
      if (shows && !shows(m.kind)) continue;
      if (m.train) {
        if (m.train.edge) continue;
        if (m.pause > 0) {
          m.pause -= dt;
          continue;
        }
        if (m.train.reverse) this.reverseTrain(m);
        if (this.atStation(m)) {
          m.pause = between(rng, TRAIN.dwell);
          continue;
        }
        this.moveTrain(m, m.speed * dt);
        continue;
      }
      if (m.kind === 'person') {
        if (m.pause > 0) {
          m.pause -= dt;
          continue;
        }
        if (rng() < PERSON_PAUSE.chance * dt) {
          m.pause = between(rng, PERSON_PAUSE.seconds);
          continue;
        }
        if (rng() < PERSON_TURN_CHANCE * dt) {
          // Turn back: now heading for the vertex it was walking away from.
          const to = m.from + m.dir;
          m.d = this.segment(m.from, to) - m.d;
          m.from = to;
          m.dir = m.dir === 1 ? -1 : 1;
          // The group turns round where it stands: the one on the right is now on the left.
          for (const walker of m.group ?? []) {
            walker.lateral = -walker.lateral;
            walker.back = -walker.back;
          }
        }
        m.walked = (m.walked ?? 0) + (speeds[i]! * dt) / this.perMeter;
      }
      this.advance(m, speeds[i]! * dt);
    }
    if (!shows || shows('person')) this.stepGatherers(dt);
    if (!shows || shows('bird')) this.stepFlocks(dt, gustAt);
  }

  /**
   * Where a flock goes next: a tree to land in (with chance `PERCH.chance`, or always if the
   * tile has no roost), else a roost to circle.
   */
  private pickDestination(flock: Flock) {
    const roosts = this.geo.roosts.length / 2;
    const perches = this.geo.perches.length / 2;
    flock.stay = between(this.rng, BIRDS.stay);
    if (perches > 0 && (roosts === 0 || this.rng() < PERCH.chance)) {
      flock.perch = Math.floor(this.rng() * perches);
    } else {
      flock.perch = -1;
      if (roosts > 1) flock.roost = Math.floor(this.rng() * roosts);
    }
  }

  private stepFlocks(dt: number, gustAt?: (x: number, y: number) => number) {
    const { roosts, perches } = this.geo;
    const count = roosts.length / 2;
    const speed = BIRDS.speed * this.perMeter;
    for (const flock of this.flocks) {
      flock.scatter = Math.max(0, flock.scatter - dt);
      flock.stay -= dt;
      // In a tree: stay a while, unless a gust through the crown flushes the flock out.
      if (flock.perched) {
        const flushed = (gustAt?.(flock.x, flock.y) ?? 0) >= PERCH.flush;
        if (flushed || flock.stay <= 0) {
          flock.perched = false;
          if (flushed) flock.scatter = PERCH.scatter;
          this.pickDestination(flock);
          // Flushed, it keeps clear of the trees a while (circling a roost, or hovering where
          // it is if the tile has none) before landing again.
          if (flushed) flock.perch = -1;
        }
        continue;
      }
      if (flock.stay <= 0 && (count > 1 || perches.length > 0)) this.pickDestination(flock);
      // Flying to a tree: straight there, then land.
      if (flock.perch >= 0) {
        const dx = perches[flock.perch * 2]! - flock.x;
        const dy = perches[flock.perch * 2 + 1]! - flock.y;
        const distance = Math.hypot(dx, dy);
        const step = speed * 1.4 * dt;
        if (distance <= step) {
          flock.x += dx;
          flock.y += dy;
          flock.perched = true;
        } else {
          flock.x += (dx / distance) * step;
          flock.y += (dy / distance) * step;
        }
        continue;
      }
      if (count === 0) continue;
      // Circle the roost; the flock's center chases the point on the circle a little faster
      // than it moves, so it catches up after moving on to another roost.
      flock.angle += (speed / flock.radius) * dt;
      const tx = roosts[flock.roost * 2]! + Math.cos(flock.angle) * flock.radius;
      const ty = roosts[flock.roost * 2 + 1]! + Math.sin(flock.angle) * flock.radius;
      const dx = tx - flock.x;
      const dy = ty - flock.y;
      const distance = Math.hypot(dx, dy);
      const reach = Math.min(distance, speed * 1.4 * dt);
      if (distance > 0) {
        flock.x += (dx / distance) * reach;
        flock.y += (dy / distance) * reach;
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
};

export type LifeTile = { key: string; tile: TileId; life: LifeGeometry };

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

export class LifeWorld {
  private readonly tiles = new Map<string, TileLife>();
  private traffic: ResolvedTraffic;
  private readonly scenes = new Map<string, ProcessionScene>();
  /** Seconds simulated, for played processions. */
  private clock = 0;
  private played: { id: string; start: number } | undefined;
  private live: { id: string; progress: number } | undefined;

  /** `traffic`: the city's vehicle mix (its pack's `traffic`), over the default. */
  constructor(traffic?: TrafficMix) {
    this.traffic = resolveTraffic(traffic);
  }

  /** Change the vehicle mix: every tile's agents spawn again with it. */
  setTraffic(traffic?: TrafficMix) {
    this.traffic = resolveTraffic(traffic);
    this.tiles.clear();
  }

  /** Spawn agents for tiles that came into view and drop those of tiles that left it. */
  sync(tiles: readonly LifeTile[]) {
    const keep = new Set<string>();
    for (const { key, tile, life } of tiles) {
      keep.add(key);
      if (!this.tiles.has(key)) {
        this.tiles.set(key, new TileLife(tile, life, hashString(key), this.traffic));
      }
    }
    for (const key of this.tiles.keys()) if (!keep.has(key)) this.tiles.delete(key);
  }

  /**
   * Move every tile's agents on by `dt` seconds. `gustAt(lng, lat)` is how hard the wind blows
   * in a tree's crown there (life/wind.ts strength × glyphs/select.ts treeGust); a strong gust
   * flushes birds out of the tree. With `zoom`, only the kinds that show at it move (config.ts
   * `LIFE_ZOOM`): the others wait, unseen, until they show.
   */
  step(dt: number, gustAt?: (lng: number, lat: number) => number, zoom?: number) {
    const clamped = Math.min(MAX_STEP_S, Math.max(0, dt));
    if (clamped === 0) return;
    this.clock += clamped;
    const shows =
      zoom === undefined
        ? undefined
        : (kind: AgentKind) => bandVisibility(LIFE_ZOOM[kind], zoom) >= 1;
    for (const tile of this.tiles.values()) {
      const inTile = gustAt
        ? (x: number, y: number) => gustAt(...tileToLngLat(tile.tile, { x, y }))
        : undefined;
      tile.step(clamped, inTile, shows);
    }
    // Trains run on from tile to tile; one leaving the tiles on screen is gone.
    let leaving: { from: TileId; m: Mover }[] | undefined;
    for (const tile of this.tiles.values()) {
      for (const m of tile.takeLeavers()) (leaving ??= []).push({ from: tile.tile, m });
    }
    for (const { from, m } of leaving ?? []) {
      const dx = m.x < 0 ? -1 : m.x >= EXTENT ? 1 : 0;
      const dy = m.y < 0 ? -1 : m.y >= EXTENT ? 1 : 0;
      for (const next of this.tiles.values()) {
        const { tile } = next;
        if (tile.z === from.z && tile.x === from.x + dx && tile.y === from.y + dy) {
          next.adopt(m, dx, dy);
          break;
        }
      }
    }
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
  setLive(id: string | undefined, progress = 0) {
    this.live = id && this.scenes.has(id) ? { id, progress } : undefined;
  }

  /** The procession to show: one being played, else a live one. */
  procession(): ProcessionRun | undefined {
    if (this.played) {
      const duration = this.scenes.get(this.played.id)!.playDuration;
      const progress = (this.clock - this.played.start) / duration;
      if (progress < 1) return { id: this.played.id, progress, live: false };
      this.played = undefined;
    }
    return this.live && { ...this.live, live: true };
  }

  get size() {
    return this.tiles.size;
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
  ): VisibleAgent[] {
    // A bare number is the daylight, with no clock (config.ts `activityLevels`).
    const levels =
      typeof levelsOrDaylight === 'number' ? activityLevels(levelsOrDaylight) : levelsOrDaylight;
    const shows = (kind: AgentKind) => bandVisibility(LIFE_ZOOM[kind], zoom) >= 1;
    const out: VisibleAgent[] = [];
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
        })
      : [];
    for (const life of this.tiles.values()) {
      const { tile, perMeter } = life;
      const inView = viewIn(tile, bounds, VIEW_MARGIN_M * perMeter);
      for (const m of life.movers) {
        if (!shows(m.kind) || m.rank >= levels[m.kind]) continue;
        if (scene && m.kind === 'boat') continue;
        if (m.x < 0 || m.x >= EXTENT || m.y < 0 || m.y >= EXTENT) continue;
        if (m.train) {
          // A train is long, and there are few: all its cars, wherever its head is.
          for (const car of trainCars(life, m)) out.push(car);
          continue;
        }
        if (!inView(m.x, m.y)) continue;
        // Keep right, in a lane that fits the road: offset to the right of the heading (tile y
        // points down).
        const lane = life.offsetOf(m) * perMeter;
        const x = m.x - m.hy * lane;
        const y = m.y + m.hx * lane;
        const [lng, lat] = tileToLngLat(tile, { x, y });
        const ahead = tileToLngLat(tile, { x: x + m.hx * perMeter, y: y + m.hy * perMeter });
        if (m.vehicle) {
          const side = tileToLngLat(tile, { x: x - m.hy * perMeter, y: y + m.hx * perMeter });
          out.push({
            kind: m.kind,
            lng,
            lat,
            ahead,
            side,
            vehicle: m.vehicle,
            paint: m.paint,
            flap: 0,
          });
        } else if (m.group) {
          const stride = Math.floor((m.walked ?? 0) / PEOPLE.stride);
          const people = m.group.map((w): PersonLook => ({
            figure: w.figure === 'adult' && w.umbrella < umbrellas ? 'umbrella' : w.figure,
            paint: w.figure === 'adult' && w.umbrella < umbrellas ? w.canopy : w.shirt,
            lateral: w.lateral,
            back: w.back,
            // Standing still, feet together.
            flap: m.pause > 0 ? 0 : (stride + w.step) & 1,
          }));
          out.push({ kind: m.kind, lng, lat, ahead, flap: 0, people });
        } else {
          out.push({ kind: m.kind, lng, lat, ahead, flap: 0 });
        }
      }
      if (shows('person')) {
        const vendorsOut = levels.person;
        for (const s of life.stalls) {
          if (s.rank >= vendorsOut || s.x < 0 || s.x >= EXTENT || s.y < 0 || s.y >= EXTENT)
            continue;
          if (!inView(s.x, s.y)) continue;
          const [lng, lat] = tileToLngLat(tile, s);
          out.push({
            kind: 'person',
            lng,
            lat,
            ahead: tileToLngLat(tile, { x: s.x + s.hx * perMeter, y: s.y + s.hy * perMeter }),
            side: tileToLngLat(tile, { x: s.x - s.hy * perMeter, y: s.y + s.hx * perMeter }),
            vehicle: 'cart',
            paint: s.paint,
            flap: 0,
            people: [{ figure: 'adult', paint: s.shirt, lateral: s.side, back: 0, flap: 0 }],
          });
        }
      }
      if (shows('person')) {
        for (const g of life.gatherers) {
          if (g.rank >= levels.places[g.place] || !inView(g.x, g.y)) continue;
          const w = g.walker;
          const shaded = w.figure === 'adult' && w.umbrella < umbrellas;
          const still = g.pause > 0 || g.behavior === 'sit';
          const look: PersonLook = {
            figure: shaded ? 'umbrella' : w.figure,
            paint: shaded ? w.canopy : w.shirt,
            lateral: 0,
            back: 0,
            // Standing still (or sitting), feet together.
            flap: still ? 0 : (Math.floor(g.walked / PEOPLE.stride) + w.step) & 1,
          };
          const at = (x: number, y: number) => tileToLngLat(tile, { x, y });
          if (g.carabao !== undefined) {
            // The carabao a pace ahead, its farmer walking beside it.
            const x = g.x + g.hx * 1.8 * perMeter;
            const y = g.y + g.hy * 1.8 * perMeter;
            const [lng, lat] = at(x, y);
            out.push({
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
            const ahead = at(g.x + g.hx * perMeter, g.y + g.hy * perMeter);
            out.push({ kind: 'person', lng, lat, ahead, flap: 0, people: [look] });
          }
        }
      }
      if (bandVisibility(PARKED.zoom, zoom) >= 1) {
        for (const p of life.parked) {
          if (p.x < 0 || p.x >= EXTENT || p.y < 0 || p.y >= EXTENT || !inView(p.x, p.y)) continue;
          const [lng, lat] = tileToLngLat(tile, p);
          out.push({
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
          const [lng, lat] = tileToLngLat(tile, p);
          out.push({
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
      const birdsOut = levels.bird;
      for (const flock of life.flocks) {
        if (flock.rank >= birdsOut || !inView(flock.x, flock.y)) continue;
        const wobble = life.elapsed * 0.8;
        // Perched, the birds sit still and close in the crown; flushed, they scatter outward.
        const perchSpread = PERCH.spread / BIRDS.spread[1];
        const spread = flock.perched ? perchSpread : 1 + (3 * flock.scatter) / PERCH.scatter;
        for (const bird of flock.birds) {
          const turn = flock.perched ? bird.phase * 6 : wobble + bird.phase * 6;
          const cos = Math.cos(turn) * spread;
          const sin = Math.sin(turn) * spread;
          const [lng, lat] = tileToLngLat(tile, {
            x: flock.x + bird.ox * cos - bird.oy * sin,
            y: flock.y + bird.ox * sin + bird.oy * cos,
          });
          const flap = flock.perched
            ? 0
            : Math.floor(life.elapsed * BIRDS.flap + bird.phase * 2) & 1;
          out.push({ kind: 'bird', lng, lat, flap });
        }
      }
    }
    if (out.length <= MAX_VISIBLE_AGENTS) return [...staged, ...out];
    const [cx, cy] = center;
    // Each one's distance worked out once, not in every comparison.
    const nearest = out
      .map((agent) => ({ agent, d: (agent.lng - cx) ** 2 + (agent.lat - cy) ** 2 }))
      .sort((a, b) => a.d - b.d);
    const kept = staged.slice();
    for (let i = 0; i < MAX_VISIBLE_AGENTS; i++) kept.push(nearest[i]!.agent);
    return kept;
  }
}
