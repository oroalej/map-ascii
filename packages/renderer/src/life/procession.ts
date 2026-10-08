/**
 * River processions (SPEC.md §4 "Processions"): a pagoda barge towed by columns of paddle
 * boats (voyadores) along a river, escorts ahead, a flotilla of small boats behind, and crowds
 * along both banks, some holding candles. The route and the river's banks along it come from
 * the city's `<slug>.processions.json` (the pipeline's step 07). Pure TS, like the rest of the
 * life layer: `agents()` gives what to draw at a point of the procession, and `liveProgress()`
 * whether one is under way at a moment.
 *
 * It moves the way a towed procession does: in surges, with halts along the way, the lead
 * boats setting off first and the pagoda and the flotilla following a moment later, and every
 * boat swaying a little on its own.
 */
import {
  nthWeekdayDay,
  PROCESSION_DEFAULTS,
  PROCESSION_LIMITS,
  type FluvialRoute,
  type ProcessionSchedule,
} from '@atlas/shared';
import { localTime } from './clock';
import type { LifeInspection } from './inspection';
import { FIGURE_SIZE_M, SHIRT_PAINTS } from './people';
import { hashString, random } from './random';
import type { VisibleAgent } from './simulate';
import { identifyEventActor } from './event-actors';
import { Paint, PENNANT_GLYPH, VEHICLES, type CraftType } from './vehicles';

export const PROCESSION = {
  /**
   * A played procession is a time-lapse of the real one: at this speed along its route (m/s),
   * taking at least `playSeconds`.
   */
  playSpeed: 10,
  eventActors: PROCESSION_LIMITS.actors,
  throng: {
    streamLength: 300,
    stream: 0.9,
    tail: 0.6,
    verge: 0.7,
    /** Procession spectators far ahead, and those left once it has passed by `gather` m. */
    waiting: 0.35,
    passed: 0.15,
    gather: 300,
    mass: 0.95,
    bank: 0.7,
    uniforms: [3, 4, 5, 6, 7, 8, 9, 10] as const,
  },
  mass: { queueSpread: 0.15, arrivalEnd: 0.25, disperseStart: 0.75 },
  street: {
    crowdTail: 500,
    leading: 3,
    andasGap: 4,
    imageGap: 8,
    marshalGap: 8,
    devoteeGap: 8,
    guardGap: 8,
    bandGap: 5,
    contingentGap: 6,
    vehicleGap: 6,
    tailPadding: 10,
  },
  playSeconds: 180,
  columns: PROCESSION_DEFAULTS.fluvial.columns,
  ranks: PROCESSION_DEFAULTS.fluvial.ranks,
  /** Escorts ahead of the formation, and small boats following the pagoda. */
  escorts: PROCESSION_DEFAULTS.fluvial.escorts,
  /** Tow ropes are this much longer than the gap they span at rest, m, so they sag at halts. */
  ropeSlack: 1.5,
  /** Poles along the pagoda's sides, leaning out: how many, and how long seen from above, m. */
  poles: 10,
  poleLength: 4.5,
  followers: PROCESSION_DEFAULTS.fluvial.followers,
  /** Between ranks and between columns of voyadores, m (columns close up where it's narrow). */
  rankGap: 19,
  columnGap: 5,
  /** Boats keep this far from the banks, m. */
  bankMargin: 1,
  /** Banks, m to either side, where a route has none measured. */
  defaultBank: 8,
  /** Halts: one per this many meters of route (at least 2), each this share of the run. */
  haltEvery: 350,
  haltShare: [0.03, 0.06] as const,
  /** How much the speed surges and slackens between halts (±). */
  surge: 0.35,
  /** How far behind the rank ahead of it each rank moves, as a share of the run. */
  rankLag: 0.0015,
  /** People per meter of each bank, and how far back from the water they stand, m. */
  crowdPerMeter: 0.35,
  crowdDepth: [1, 30] as const,
  /** Everyone within this far of the pagoda, the start, or the landing is out; elsewhere, a share. */
  crowdNear: 150,
  crowdShare: 0.25,
  /** The share of people holding candles (lit at dusk and night). */
  candles: 0.6,
  /** Crowds show from this zoom (boats from the boats' zoom band). */
  crowdZoom: 16,
  /**
   * Voyadores' paddlers (life/people.ts `rower`): `pairs` of them seated down each voyador,
   * `beside` m either side of its center line, all pulling in time at `strokeRate` strokes a
   * second. They show from `crewZoom`, where the hull is a few cells wide.
   */
  crew: { pairs: 10, beside: 0.45, strokeRate: 1.2 },
  crewZoom: 19.5,
} as const;

type Point = [number, number];

type Person = {
  id: string;
  candleSeed: number;
  s: number;
  side: number;
  back: number;
  rank: number;
  candle: boolean;
  phase: number;
  /** Where they stand (m), and the route's direction there; they only sway in place. */
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** How far right of the route's line they stand, m (negative: on the left bank). */
  off: number;
};

/** A view's bounds, [west, south, east, north] in degrees. */
export type LngLatBounds = readonly [number, number, number, number];

/** How a boat sways on its own: across (m), along (m), and its heading (radians). */
type Sway = { wander: number; period: number; surge: number; yaw: number; phase: number };

/** A boat of the procession, placed relative to the pagoda. */
type Boat = {
  vehicle: CraftType;
  paint: number;
  /** Ahead of the pagoda's center, m (negative: behind). */
  along: number;
  /** Across the channel: a share of the water on its side (-1 left bank … 1 right bank). */
  lane: number;
  /** A fixed offset across, m. */
  across: number;
  /** How far behind the lead its motion runs, as a share of the run. */
  lag: number;
  sway: Sway;
  /** Voyador columns: which one, so they close up together. */
  column?: number;
  rank?: number;
  /** Which way its tow rope sags at rest. */
  sag?: 1 | -1;
};

/** Where a boat is, in meters: its center, heading (a unit vector), and length. */
type Placed = { x: number; y: number; hx: number; hy: number; length: number; width: number };

/** A pole on the pagoda: where along it (-0.5 stern … 0.5 bow), which side, and its lean. */
type Pole = { along: number; side: 1 | -1; lean: number; phase: number };

const pick = <T>(rng: () => number, list: readonly T[]) => list[Math.floor(rng() * list.length)]!;
const between = (rng: () => number, lo: number, hi: number) => lo + (hi - lo) * rng();
const DEG = Math.PI / 180;

/** Samples of the motion profile. */
const PROFILE_SAMPLES = 512;

/**
 * How far along a procession is at each moment of its run: a table of distance (0–1) by time
 * (0–1) that holds still at halts and surges and slackens between them. Seeded, so every
 * visitor sees the same run.
 */
export function motionProfile(seed: number, length: number): Float64Array {
  const rng = random(seed);
  const count = Math.max(2, Math.round(length / PROCESSION.haltEvery));
  const halts: [number, number][] = [];
  for (let k = 0; k < count; k++) {
    const center = 0.1 + (0.8 * (k + 0.5 + (rng() - 0.5) * 0.4)) / count;
    const half = between(rng, ...PROCESSION.haltShare) / 2;
    halts.push([center - half, center + half]);
  }
  const [f1, f2] = [between(rng, 3, 5), between(rng, 9, 13)];
  const [p1, p2] = [rng() * 6.28, rng() * 6.28];
  const ease = 0.012;
  const speed = (u: number) => {
    let w =
      1 +
      PROCESSION.surge *
        (0.6 * Math.sin(2 * Math.PI * f1 * u + p1) + 0.4 * Math.sin(2 * Math.PI * f2 * u + p2));
    for (const [a, b] of halts) {
      if (u >= a && u <= b) return 0;
      // Slow into a halt and pick up out of it.
      const d = u < a ? a - u : u - b;
      if (d < ease) w *= d / ease;
    }
    return Math.max(0, w);
  };
  const table = new Float64Array(PROFILE_SAMPLES + 1);
  for (let i = 1; i <= PROFILE_SAMPLES; i++) {
    table[i] = table[i - 1]! + speed((i - 0.5) / PROFILE_SAMPLES);
  }
  const total = table[PROFILE_SAMPLES]!;
  for (let i = 0; i <= PROFILE_SAMPLES; i++) table[i] = table[i]! / total;
  return table;
}

/** A motion profile's distance (0–1) at time `u` (clamped to 0–1). */
export function profileAt(table: Float64Array, u: number): number {
  const x = Math.min(1, Math.max(0, u)) * PROFILE_SAMPLES;
  const i = Math.min(PROFILE_SAMPLES - 1, Math.floor(x));
  return table[i]! + (table[i + 1]! - table[i]!) * (x - i);
}

/** Index of the first endpoint at or beyond a distance, clamped to a route segment. */
export function segmentIndex(along: ArrayLike<number>, distance: number): number {
  let lo = 1,
    hi = along.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (along[mid]! < distance) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Shared metric-route sampling. Skip leading zero-length edges; an entirely flat route faces east. */
export function routePolyline(points: readonly Point[]) {
  const along = [0];
  for (let i = 1; i < points.length; i++)
    along.push(
      along[i - 1]! +
        Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]),
    );
  return {
    points,
    along,
    at(distance: number) {
      const s = Math.max(0, Math.min(along.at(-1)!, distance));
      let i = segmentIndex(along, s);
      while (i < points.length - 1 && along[i] === along[i - 1]) i++;
      const a = points[i - 1]!,
        b = points[i]!,
        length = along[i]! - along[i - 1]!,
        t = length ? (s - along[i - 1]!) / length : 0,
        hx = length ? (b[0] - a[0]) / length : 1,
        hy = length ? (b[1] - a[1]) / length : 0;
      return { x: a[0] + hx * t * length, y: a[1] + hy * t * length, hx, hy, index: i - 1, t };
    },
  };
}

/** One procession's boats and crowds along its route. */
export class ProcessionScene {
  private liveOwners?: { scope: string; keys: WeakMap<object, object> };
  private playedOwners?: { scope: string; keys: WeakMap<object, object> };

  private owner(scope: string, actor: object) {
    const field = scope.startsWith('live/') ? 'liveOwners' : 'playedOwners';
    let owners = this[field];
    if (owners?.scope !== scope) this[field] = owners = { scope, keys: new WeakMap() };
    let owner = owners.keys.get(actor);
    if (!owner) owners.keys.set(actor, (owner = {}));
    return owner;
  }
  readonly length: number;
  private readonly origin: Point;
  private readonly kx: number;
  private readonly ky: number;
  /** The route in meters east and north of its start, and the distance to each point. */
  private readonly points: Point[];
  private readonly along: number[];
  private readonly polyline: ReturnType<typeof routePolyline>;
  private readonly banks: readonly (readonly [number, number])[] | undefined;
  private readonly boats: Boat[] = [];
  private readonly poles: Pole[] = [];
  private readonly people: Person[] = [];
  private readonly profile: Float64Array;
  private readonly formation: { columns: number; ranks: number };
  /** The pagoda's lag behind the lead, as a share of the run. */
  private readonly pagodaLag: number;

  constructor(readonly route: FluvialRoute) {
    const [lng0, lat0] = route.route[0]!;
    this.origin = [lng0, lat0];
    this.kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
    this.ky = 110_540;
    this.points = route.route.map(([lng, lat]) => [(lng - lng0) * this.kx, (lat - lat0) * this.ky]);
    this.polyline = routePolyline(this.points);
    this.along = this.polyline.along;
    this.length = this.along.at(-1)!;
    this.banks = route.banks?.length === route.route.length ? route.banks : undefined;

    const seed = hashString(route.id);
    const rng = random(seed);
    this.profile = motionProfile(seed ^ 0x51ed27, this.length);
    const columns = route.formation?.columns ?? PROCESSION.columns;
    const ranks = route.formation?.ranks ?? PROCESSION.ranks;
    this.formation = { columns, ranks };
    const lag = PROCESSION.rankLag;
    this.pagodaLag = ranks * lag;
    const sway = (scale: number): Sway => ({
      wander: 1.2 * scale,
      period: between(rng, 8, 14),
      surge: 1 * scale,
      yaw: 6 * DEG * scale,
      phase: rng() * 6.28,
    });

    this.boats.push({
      vehicle: 'pagoda',
      paint: 0,
      along: 0,
      lane: 0,
      across: 0,
      lag: this.pagodaLag,
      sway: { ...sway(0.3), yaw: 2 * DEG },
    });
    // The voyadores, rank 0 nearest the pagoda; the lead rank sets off first.
    const front = VEHICLES.pagoda.length / 2 + 6 + VEHICLES.voyador.length / 2;
    for (let r = 0; r < ranks; r++) {
      for (let c = 0; c < columns; c++) {
        this.boats.push({
          vehicle: 'voyador',
          paint: pick(rng, VEHICLES.voyador.paints),
          along: front + r * PROCESSION.rankGap + between(rng, -1.5, 1.5),
          lane: 0,
          across: between(rng, -1, 1),
          lag: (ranks - 1 - r) * lag,
          sway: sway(1),
          column: c,
          rank: r,
          sag: rng() < 0.5 ? 1 : -1,
        });
      }
    }
    const perSide = Math.ceil(PROCESSION.poles / 2);
    for (let i = 0; i < PROCESSION.poles; i++) {
      const k = Math.floor(i / 2);
      this.poles.push({
        along: -0.4 + (0.8 * (k + 0.5)) / perSide,
        side: i % 2 === 0 ? 1 : -1,
        lean: between(rng, 10, 30) * DEG,
        phase: rng() * 6.28,
      });
    }
    // Escorts clear the way ahead of the lead rank.
    const lead = front + (ranks - 1) * PROCESSION.rankGap + VEHICLES.voyador.length / 2;
    const escorts = route.formation?.escorts ?? PROCESSION.escorts;
    for (let i = 0; i < escorts; i++) {
      const vehicle: CraftType = rng() < 0.6 ? 'banca' : 'motorboat';
      this.boats.push({
        vehicle,
        paint: pick(rng, VEHICLES[vehicle].paints),
        along: lead + 14 + Math.floor(i / 2) * 12 + between(rng, -2, 2),
        lane: (i % 2 === 0 ? -1 : 1) * between(rng, 0.3, 0.7),
        across: 0,
        lag: -lag,
        sway: sway(0.5),
      });
    }
    // A flotilla of small boats follows the pagoda, three abreast.
    const small: CraftType[] = ['baroto', 'rowboat', 'motorboat', 'sailboat'];
    const followers = this.route.formation?.followers ?? PROCESSION_DEFAULTS.fluvial.followers;
    for (let i = 0; i < followers; i++) {
      const row = Math.floor(i / 3);
      const vehicle =
        small[i % small.length === 0 ? Math.floor(rng() * small.length) : i % small.length]!;
      this.boats.push({
        vehicle,
        paint: pick(rng, VEHICLES[vehicle].paints),
        along: -(VEHICLES.pagoda.length / 2 + 9 + row * 9 + between(rng, -1.5, 1.5)),
        lane: ((i % 3) - 1) * 0.66,
        across: between(rng, -0.6, 0.6),
        lag: this.pagodaLag + (row + 1) * lag,
        sway: sway(0.5),
      });
    }

    const count = Math.floor(this.length * PROCESSION.crowdPerMeter);
    for (const side of [-1, 1]) {
      for (let i = 0; i < count; i++) {
        const s = rng() * this.length;
        const back = between(rng, ...PROCESSION.crowdDepth);
        const rank = rng();
        const candle = rng() < PROCESSION.candles;
        const phase = rng() * 6.28;
        const { x, y, tx, ty, left, right } = this.at(s);
        const off = side > 0 ? right + back : -(left + back);
        const id = `${this.route.id}/crowd/${this.people.length}`;
        this.people.push({
          id,
          candleSeed: hashString(id),
          s,
          side,
          back,
          rank,
          candle,
          phase,
          x,
          y,
          tx,
          ty,
          off,
        });
      }
    }
  }

  /** How long playing it takes, s (`PROCESSION.playSpeed`). */
  get playDuration() {
    return Math.max(
      PROCESSION.playSeconds,
      (this.length + this.formationLength()) / PROCESSION.playSpeed,
    );
  }

  /** From the pagoda's center to the lead voyador's bow, m. */
  private formationLength() {
    return (
      VEHICLES.pagoda.length / 2 +
      6 +
      (this.formation.ranks - 1) * PROCESSION.rankGap +
      VEHICLES.voyador.length +
      6
    );
  }

  /** The point `s` m along the route, its direction (a unit vector), and the banks there. */
  private at(s: number) {
    const sample = this.polyline.at(s),
      i = sample.index + 1,
      t = sample.t;
    let left: number = PROCESSION.defaultBank;
    let right: number = PROCESSION.defaultBank;
    if (this.banks) {
      const [la, ra] = this.banks[i - 1]!;
      const [lb, rb] = this.banks[i]!;
      left = la + (lb - la) * t;
      right = ra + (rb - ra) * t;
    }
    return { x: sample.x, y: sample.y, tx: sample.hx, ty: sample.hy, left, right };
  }

  private lngLat(x: number, y: number): [number, number] {
    return [this.origin[0] + x / this.kx, this.origin[1] + y / this.ky];
  }

  /** Whether a point (m) is inside `bounds` (none: everywhere), `margin` m around them. */
  private inside(bounds: LngLatBounds | undefined, margin: number) {
    if (!bounds) return () => true;
    const [west, south, east, north] = bounds;
    const x0 = (west - this.origin[0]) * this.kx - margin;
    const x1 = (east - this.origin[0]) * this.kx + margin;
    const y0 = (south - this.origin[1]) * this.ky - margin;
    const y1 = (north - this.origin[1]) * this.ky + margin;
    return (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  }

  /** The distance along the route of something `lag` behind the lead, `progress` into the run. */
  private travelled(progress: number, lag: number) {
    const lead = this.formationLength();
    const u = Math.min(1, Math.max(0, progress)) * (1 + this.pagodaLag) - lag;
    return -lead + profileAt(this.profile, u) * (this.length + lead);
  }

  /** The pagoda's distance along the route at `progress` (0–1): from before the start to the landing. */
  pagodaAt(progress: number) {
    return this.travelled(progress, this.pagodaLag);
  }

  /**
   * A boat `s` m along the route, `off` m right of the channel's middle (kept `width` inside
   * its banks), turned `yaw` from the direction of travel.
   */
  private place(
    s: number,
    off: number,
    vehicle: CraftType,
    yaw: number,
    here = this.at(s),
  ): Placed {
    const { x, y, tx, ty, left, right } = here;
    const { width, length } = VEHICLES[vehicle];
    const room = width / 2 + PROCESSION.bankMargin;
    const middle = (right - left) / 2;
    const lo = -left + room;
    const hi = right - room;
    const across = lo <= hi ? Math.min(hi, Math.max(lo, middle + off)) : middle;
    // The right of the direction of travel, with y pointing north.
    const [rx, ry] = [ty, -tx];
    const px = x + rx * across;
    const py = y + ry * across;
    const [hx, hy] = [
      tx * Math.cos(yaw) + ty * Math.sin(yaw),
      -tx * Math.sin(yaw) + ty * Math.cos(yaw),
    ];
    return { x: px, y: py, hx, hy, length, width };
  }

  private boatAgent(at: Placed, boat: { vehicle: CraftType; paint: number }): VisibleAgent {
    const { x, y, hx, hy } = at;
    const [lng, lat] = this.lngLat(x, y);
    return {
      kind: 'boat',
      inspectionId: undefined,
      lng,
      lat,
      ahead: this.lngLat(x + hx, y + hy),
      side: this.lngLat(x + hy, y - hx),
      vehicle: boat.vehicle,
      paint: boat.paint,
      flap: 0,
    };
  }

  /**
   * A voyador's paddlers, seated in two files down its hull in its team's color, each with the
   * paddle out over the water on their side, the whole boat pulling in time (its own beat).
   */
  private crewOf(at: Placed, boat: Boat, time: number, out: VisibleAgent[]) {
    const { pairs, beside, strokeRate } = PROCESSION.crew;
    const { x, y, hx, hy } = at;
    // The right of its heading, with y pointing north.
    const [rx, ry] = [hy, -hx];
    const reach = VEHICLES.voyador.length / 2 - 1;
    const stroke = (Math.floor(time * strokeRate * 2 + boat.sway.phase) & 1) as 0 | 1;
    // A paddler's figure is centered past their seat, over the paddle's side.
    const offset = beside + FIGURE_SIZE_M.rower / 4;
    for (let k = 0; k < pairs; k++) {
      const along = -reach + (2 * reach * k) / Math.max(1, pairs - 1);
      for (const side of [0, 1] as const) {
        const across = side === 0 ? -offset : offset;
        const px = x + hx * along + rx * across;
        const py = y + hy * along + ry * across;
        const [lng, lat] = this.lngLat(px, py);
        out.push({
          kind: 'person',
          inspectionId: undefined,
          lng,
          lat,
          ahead: this.lngLat(px + hx, py + hy),
          aboard: true,
          stroke,
          // `flap` is the side their paddle is on: left (0) or right (1).
          people: [{ figure: 'rower', paint: boat.paint, lateral: 0, back: 0, flap: side }],
          flap: 0,
        });
      }
    }
  }

  /** A line over the water through `points` (meters). */
  private lineAgent(
    points: readonly Point[],
    paints: readonly number[],
    tip?: { glyph: string; paint: number },
  ): VisibleAgent {
    const [lng, lat] = this.lngLat(...points[0]!);
    return {
      kind: 'boat',
      lng,
      lat,
      flap: 0,
      line: { points: points.map((p) => this.lngLat(...p)), paints, ...(tip ? { tip } : {}) },
    };
  }

  /**
   * A tow rope from `a` to `b` (meters), `rest` m apart at rest: pulled straight when the boats
   * are further apart than its length, else sagging to `sag`'s side.
   */
  private rope(a: Point, b: Point, rest: number, sag: number): VisibleAgent {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const length = rest + PROCESSION.ropeSlack;
    const bulge = Math.sqrt(Math.max(0, length * length - d * d)) / 2;
    // A quadratic curve whose middle is `bulge` off the straight line.
    const [nx, ny] = [((b[1] - a[1]) / d) * sag, (-(b[0] - a[0]) / d) * sag];
    const control: Point = [(a[0] + b[0]) / 2 + nx * 2 * bulge, (a[1] + b[1]) / 2 + ny * 2 * bulge];
    const points: Point[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const [u, v, w] = [(1 - t) * (1 - t), 2 * t * (1 - t), t * t];
      points.push([u * a[0] + v * control[0] + w * b[0], u * a[1] + v * control[1] + w * b[1]]);
    }
    return this.lineAgent(points, [Paint.cream]);
  }

  /** Crowd candidates for an arrival gathering, retaining their occurrence identity. */
  arrivalCrowd(
    progress: number,
    time: number,
    scope: string,
    inspection?: LifeInspection,
  ): VisibleAgent[] {
    return this.agents(progress, time, {
      boats: false,
      crowds: true,
      crews: false,
      scope,
      inspection,
      handover: true,
    }).filter((a) => a.kind === 'person' && !a.aboard);
  }
  arrivalOwners(scope: string) {
    return new Map(this.people.map((p) => [`${scope}/${p.id}`, this.owner(scope, p)]));
  }

  /**
   * What to draw `progress` (0–1) of the way through, `time` s into it (for sway and jitter):
   * the boats between the start and the landing (with `crews`, the voyadores' paddlers), and,
   * from `PROCESSION.crowdZoom`, the crowds. With `bounds`, the crowds and crews outside the view
   * are left out.
   */
  agents(
    progress: number,
    time: number,
    {
      boats = true,
      crowds = true,
      crews = false,
      handover = false,
      bounds,
      inspection,
      scope = 'live/default',
    }: {
      boats?: boolean;
      crowds?: boolean;
      crews?: boolean;
      handover?: boolean;
      bounds?: LngLatBounds;
      inspection?: LifeInspection;
      scope?: string;
    } = {},
  ): VisibleAgent[] {
    // A voyador's length, so a crew half in view still shows.
    const inView = this.inside(bounds, VEHICLES.voyador.length);
    const out: VisibleAgent[] = [];
    const ropes: VisibleAgent[] = [];
    const poles: VisibleAgent[] = [];
    const pagoda = this.pagodaAt(progress);
    const onRoute = (s: number) => s >= 0 && s <= this.length;
    const placed = new Map<Boat, Placed>();
    if (boats) {
      const { columns } = this.formation;
      for (const b of this.boats) {
        // Every column is roped to the same pagoda, so the whole connected tow is one item.
        const group = b.vehicle === 'pagoda' || b.column !== undefined ? this.boats[0]! : b;
        const owner = inspection && this.owner(scope, group);
        const actorTime = owner ? inspection.clock(owner, time) : time;
        const actorProgress = owner ? inspection.progress(owner, progress) : progress;
        const { sway } = b;
        const beat = (2 * Math.PI * actorTime) / sway.period + sway.phase;
        // Past the landing (or not yet at the start), it's out of the scene; its own sway
        // doesn't carry it over either end.
        const base = this.travelled(actorProgress, b.lag) + b.along;
        if (!onRoute(base)) continue;
        const s = Math.min(
          this.length,
          Math.max(0, base + sway.surge * Math.sin(actorTime * 2.1 + sway.phase)),
        );
        const here = this.at(s);
        const { left, right } = here;
        const water = left + right - 2 * PROCESSION.bankMargin;
        let off = b.across + sway.wander * Math.sin(beat);
        if (b.column !== undefined) {
          // Columns close up where the river narrows.
          const gap = Math.min(
            PROCESSION.columnGap,
            Math.max(0, (water - VEHICLES.voyador.width - 2) / Math.max(1, columns - 1)),
          );
          off += (b.column - (columns - 1) / 2) * gap;
        } else if (b.lane !== 0) {
          off += b.lane * (water / 2 - VEHICLES[b.vehicle].width / 2);
        }
        const at = this.place(s, off, b.vehicle, sway.yaw * Math.cos(beat), here);
        placed.set(b, at);
        const first = out.length;
        out.push(this.boatAgent(at, b));
        if (crews && b.vehicle === 'voyador' && inView(at.x, at.y)) {
          this.crewOf(at, b, actorTime, out);
        }
        if (owner)
          for (let i = first; i < out.length; i++) out[i] = inspection.present(owner, out[i]!);
      }
      this.towRopes(placed, ropes);
      const pagodaAt = placed.get(this.boats[0]!);
      if (pagodaAt)
        this.polesOn(
          pagodaAt,
          inspection ? inspection.clock(this.owner(scope, this.boats[0]!), time) : time,
          poles,
        );
    }
    if (crowds) {
      const landing = this.length;
      for (const p of this.people) {
        const near =
          Math.abs(p.s - pagoda) < PROCESSION.crowdNear ||
          p.s < PROCESSION.crowdNear ||
          landing - p.s < PROCESSION.crowdNear;
        if (!near && p.rank >= PROCESSION.crowdShare) continue;
        const { x, y, tx, ty, off } = p;
        if (!inView(x + ty * off, y - tx * off)) continue;
        const owner = inspection && this.owner(scope, p);
        const actorTime = owner ? inspection.clock(owner, time) : time;
        const sway = Math.sin(actorTime * 1.3 + p.phase) * 0.3;
        const [lng, lat] = this.lngLat(x + ty * off + tx * sway, y - tx * off + ty * sway);
        // Facing the river, a meter nearer it.
        const facing = off - Math.sign(off);
        const agent: VisibleAgent = {
          kind: 'person',
          inspectionId: undefined,
          candleSeed: p.candleSeed,
          effectClock: undefined,
          lng,
          lat,
          ahead: this.lngLat(x + ty * facing + tx * sway, y - tx * facing + ty * sway),
          // A shirt from its sway's phase, so the crowd's other draws stay as they were.
          paint: SHIRT_PAINTS[Math.floor(p.phase * 997) % SHIRT_PAINTS.length],
          flap: 0,
          candle: p.candle,
        };
        const presented = owner ? inspection.present(owner, agent) : agent;
        out.push(handover ? identifyEventActor(presented, `${scope}/${p.id}`) : presented);
      }
    }
    // Ropes under the boats, poles over the pagoda.
    return [...ropes, ...out, ...poles];
  }

  /**
   * Tow ropes: from the pagoda's bow, fanned across it, to each column's nearest voyador, then
   * from each voyador's bow to the stern of the next in its column.
   */
  private towRopes(placed: Map<Boat, Placed>, out: VisibleAgent[]) {
    const pagoda = placed.get(this.boats[0]!);
    const { columns } = this.formation;
    const bow = (p: Placed): Point => [p.x + (p.hx * p.length) / 2, p.y + (p.hy * p.length) / 2];
    const stern = (p: Placed): Point => [p.x - (p.hx * p.length) / 2, p.y - (p.hy * p.length) / 2];
    const byColumn = new Map<number, [Boat, Placed][]>();
    for (const [b, p] of placed) {
      if (b.column === undefined) continue;
      const list = byColumn.get(b.column) ?? [];
      list.push([b, p]);
      byColumn.set(b.column, list);
    }
    for (const [column, chain] of byColumn) {
      chain.sort((x, y) => x[0].rank! - y[0].rank!);
      const first = chain[0]!;
      if (pagoda && first[0].rank === 0) {
        const across = (column - (columns - 1) / 2) * (pagoda.width / columns);
        const [bx, by] = bow(pagoda);
        const from: Point = [bx + pagoda.hy * across, by - pagoda.hx * across];
        // At rest, the gap between the pagoda's bow and this voyador's stern.
        const rest = first[0].along - VEHICLES.pagoda.length / 2 - VEHICLES.voyador.length / 2;
        out.push(this.rope(from, stern(first[1]), rest, first[0].sag ?? 1));
      }
      for (let i = 1; i < chain.length; i++) {
        const [b, p] = chain[i]!;
        const [pb, pp] = chain[i - 1]!;
        if (b.rank !== pb.rank! + 1) continue;
        const rest = b.along - pb.along - VEHICLES.voyador.length;
        out.push(this.rope(bow(pp), stern(p), rest, b.sag ?? 1));
      }
    }
  }

  /** The pagoda's poles, leaning out from its sides and swaying, each with a pennant. */
  private polesOn(pagoda: Placed, time: number, out: VisibleAgent[]) {
    const { x, y, hx, hy, length, width } = pagoda;
    // Right of its heading, with y pointing north.
    const [rx, ry] = [hy, -hx];
    for (const pole of this.poles) {
      const base: Point = [
        x + hx * pole.along * length + (rx * (pole.side * width)) / 2,
        y + hy * pole.along * length + (ry * (pole.side * width)) / 2,
      ];
      const lean = pole.lean + 8 * DEG * Math.sin(time * 0.7 + pole.phase);
      const out_ = pole.side * Math.cos(lean);
      const forward = Math.sin(lean);
      const tip: Point = [
        base[0] + (rx * out_ + hx * forward) * PROCESSION.poleLength,
        base[1] + (ry * out_ + hy * forward) * PROCESSION.poleLength,
      ];
      out.push(
        this.lineAgent([base, tip], [Paint.yellow, Paint.graphite], {
          glyph: PENNANT_GLYPH,
          paint: Paint.white,
        }),
      );
    }
  }
}

/** The day a schedule falls on in `year`, as days since 1970-01-01. */
export function scheduledDay(schedule: ProcessionSchedule, year: number): number {
  return nthWeekdayDay(schedule, year);
}

/**
 * How far through its scheduled run a procession is at `date` (0–1), or undefined when it
 * isn't under way.
 */
export function liveProgress(schedule: ProcessionSchedule, date: Date): number | undefined {
  const local = localTime(date, schedule.timezone);
  const [h, m] = schedule.start.split(':').map(Number) as [number, number];
  const since =
    (local.day - scheduledDay(schedule, local.year)) * 1440 + local.minutes - (h * 60 + m);
  return since >= 0 && since < schedule.duration_min ? since / schedule.duration_min : undefined;
}
