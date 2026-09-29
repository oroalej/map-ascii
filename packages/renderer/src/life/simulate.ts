/**
 * The life layer's simulation (SPEC.md §4 "Life layer"): vehicles, people, and boats moving
 * along the lines of the tiles on screen, and flocks of birds circling over parks, trees, and
 * water. Agents live in tile units, per tile; a tile's agents are spawned from a seed made of its
 * key when it comes into view, so the same tile always starts with the same agents. Pure TS: the
 * renderer projects the agents onto the cell grid (passes.ts `lifePass`).
 */
import { bandVisibility, type ProcessionRoute, type TrafficMix } from '@atlas/shared';
import { EXTENT, metersPerUnit, tileToLngLat } from '../raster/geometry';
import type { TileId } from '../tiles';
import {
  activity,
  BIRDS,
  PERCH,
  DEFAULT_ROAD_WIDTH_M,
  FOLLOW,
  laneOffset,
  LIFE_ZOOM,
  MAX_STEP_S,
  MAX_TILE_AGENTS,
  MAX_VISIBLE_AGENTS,
  PARKED,
  PERSON_PAUSE,
  PERSON_TURN_CHANCE,
  ROAD_MARGIN_M,
  spawnRules,
  usableLines,
  type AgentKind,
} from './config';
import type { LifeGeometry, LifeLine } from './geometry';
import {
  pickVehicle,
  resolveTraffic,
  trafficRoadFor,
  VEHICLES,
  type CraftType,
  type ResolvedTraffic,
} from './vehicles';
import { PROCESSION, ProcessionScene } from './procession';
import { hashString, random } from './random';

export { hashString, random } from './random';

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
};

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
  /** Tile units per meter. */
  readonly perMeter: number;
  private readonly rng: () => number;
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
    for (let line = 0; line < lines; line++) this.spawnOn(line);
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
        };
        // Start somewhere along the line.
        this.advance(mover, rng() * this.lineLength(line), false);
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
      if (!road || road === 'river' || width < PARKED.minWidth || rng() >= PARKED.chance) continue;
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
      return;
    }
    const code = options[Math.floor(this.rng() * options.length)]!;
    m.line = code >> 1;
    const fromStart = (code & 1) === 0;
    m.from = fromStart ? this.first(m.line) : this.last(m.line);
    m.dir = fromStart ? 1 : -1;
  }

  /**
   * Following (config.ts `FOLLOW`): each vehicle's or boat's speed for this step, slowed behind
   * the nearest one ahead on its line, going its way, that it can't pass side by side. Queues
   * across junctions, cross traffic, and tile borders are not looked at.
   */
  private followSpeeds(): Float64Array {
    const { movers, perMeter } = this;
    const speeds = new Float64Array(movers.length);
    const groups = new Map<number, number[]>();
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i]!;
      speeds[i] = m.speed;
      if (!m.vehicle) continue;
      const key = m.line * 2 + (m.dir === 1 ? 1 : 0);
      const group = groups.get(key);
      if (group) group.push(i);
      else groups.set(key, [i]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      // Meters along the line in the direction of travel, and each one's lateral offset.
      const progress = new Map<number, number>();
      const offsets = new Map<number, number>();
      for (const i of group) {
        const m = movers[i]!;
        progress.set(i, (m.dir * this.along[m.from]! + m.d) / perMeter);
        offsets.set(i, this.offsetOf(m));
      }
      group.sort((a, b) => progress.get(a)! - progress.get(b)! || a - b);
      for (let k = 0; k < group.length - 1; k++) {
        const i = group[k]!;
        const me = VEHICLES[movers[i]!.vehicle!];
        for (let l = k + 1; l < group.length; l++) {
          const j = group[l]!;
          const them = VEHICLES[movers[j]!.vehicle!];
          const apart = Math.abs(offsets.get(i)! - offsets.get(j)!);
          if (apart >= (me.width + them.width) / 2 - FOLLOW.squeeze) continue;
          const gap = progress.get(j)! - progress.get(i)! - (me.length + them.length) / 2;
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
   * a point (tile units), which can flush birds out of it.
   */
  step(dt: number, gustAt?: (x: number, y: number) => number) {
    this.time += dt;
    const { rng } = this;
    const speeds = this.followSpeeds();
    for (const [i, m] of this.movers.entries()) {
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
        }
      }
      this.advance(m, speeds[i]! * dt);
    }
    this.stepFlocks(dt, gustAt);
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
  /** Birds: which wing glyph (0 or 1). */
  flap: number;
};

export type LifeTile = { key: string; tile: TileId; life: LifeGeometry };

/** Every tile's agents: kept in step with the tiles on screen. */
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
   * flushes birds out of the tree.
   */
  step(dt: number, gustAt?: (lng: number, lat: number) => number) {
    const clamped = Math.min(MAX_STEP_S, Math.max(0, dt));
    if (clamped === 0) return;
    this.clock += clamped;
    for (const tile of this.tiles.values()) {
      const inTile = gustAt
        ? (x: number, y: number) => gustAt(...tileToLngLat(tile.tile, { x, y }))
        : undefined;
      tile.step(clamped, inTile);
    }
  }

  /** The city's processions (its `<slug>.processions.json`). */
  setProcessions(routes: readonly ProcessionRoute[]) {
    this.scenes.clear();
    for (const route of routes) this.scenes.set(route.id, new ProcessionScene(route));
    if (this.played && !this.scenes.has(this.played.id)) this.played = undefined;
  }

  /** Play a procession from its start, as a time-lapse (`PROCESSION.playSeconds`). */
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
      const progress = (this.clock - this.played.start) / PROCESSION.playSeconds;
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
   * are out (config.ts `activity`), movers only inside their own tile (tiles overlap in their
   * buffers), at most `MAX_VISIBLE_AGENTS`, nearest `center` first.
   */
  visible(zoom: number, daylight: number, center: [number, number]): VisibleAgent[] {
    const shows = (kind: AgentKind) => bandVisibility(LIFE_ZOOM[kind], zoom) >= 1;
    const out: VisibleAgent[] = [];
    // A procession closes the river to other boats, and always shows.
    const run = this.procession();
    const scene = run && this.scenes.get(run.id)!;
    const staged = scene
      ? scene.agents(run.progress, this.clock, {
          boats: shows('boat'),
          crowds: zoom >= PROCESSION.crowdZoom,
        })
      : [];
    for (const life of this.tiles.values()) {
      const { tile, perMeter } = life;
      for (const m of life.movers) {
        if (!shows(m.kind) || m.rank >= activity(m.kind, daylight)) continue;
        if (scene && m.kind === 'boat') continue;
        if (m.x < 0 || m.x >= EXTENT || m.y < 0 || m.y >= EXTENT) continue;
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
        } else {
          out.push({ kind: m.kind, lng, lat, ahead, flap: 0 });
        }
      }
      if (bandVisibility(PARKED.zoom, zoom) >= 1) {
        for (const p of life.parked) {
          if (p.x < 0 || p.x >= EXTENT || p.y < 0 || p.y >= EXTENT) continue;
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
      if (!shows('bird')) continue;
      const birdsOut = activity('bird', daylight);
      for (const flock of life.flocks) {
        if (flock.rank >= birdsOut) continue;
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
    const distance = (a: VisibleAgent) => (a.lng - cx) ** 2 + (a.lat - cy) ** 2;
    return [
      ...staged,
      ...out.sort((a, b) => distance(a) - distance(b)).slice(0, MAX_VISIBLE_AGENTS),
    ];
  }
}
