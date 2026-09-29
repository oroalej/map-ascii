/**
 * River processions (SPEC.md §4 "Processions"): a pagoda barge towed by columns of paddle
 * boats (voyadores) down a river, escort boats around them, and crowds along both banks, some
 * holding candles. The route comes from the city's `<slug>.processions.json` (the pipeline's
 * step 07). Pure TS, like the rest of the life layer: `agents()` gives what to draw at a point
 * of the procession, and `liveProgress()` whether one is under way at a moment.
 */
import type { ProcessionRoute, ProcessionSchedule } from '@atlas/shared';
import { hashString, random } from './random';
import type { VisibleAgent } from './simulate';
import { VEHICLES, type CraftType } from './vehicles';

export const PROCESSION = {
  /** A played procession takes this long, s: a time-lapse of the real one. */
  playSeconds: 180,
  columns: 3,
  ranks: 8,
  escorts: 10,
  /** Between ranks and between columns of voyadores, m. */
  rankGap: 16,
  columnGap: 5,
  /** Escorts keep this far to either side of the route, m. */
  escortBand: [9, 15] as const,
  /** Crowds stand this far to either side of the route, m (water and roofs hide the rest). */
  crowdBand: [12, 45] as const,
  /** People per meter of each bank. */
  crowdPerMeter: 0.35,
  /** Everyone within this far of the pagoda, or of the landing, is out; elsewhere, a share. */
  crowdNear: 150,
  crowdShare: 0.25,
  /** The share of people holding candles (lit at dusk and night). */
  candles: 0.6,
  /** Crowds show from this zoom (boats from the boats' zoom band). */
  crowdZoom: 16,
} as const;

type Point = [number, number];

type Person = {
  s: number;
  side: number;
  off: number;
  rank: number;
  candle: boolean;
  phase: number;
};
type Escort = { along: number; off: number; vehicle: CraftType; paint: number; phase: number };

const pick = <T>(rng: () => number, list: readonly T[]) => list[Math.floor(rng() * list.length)]!;

/** One procession's boats and crowds along its route. */
export class ProcessionScene {
  readonly length: number;
  private readonly origin: Point;
  private readonly kx: number;
  private readonly ky: number;
  /** The route in meters east and north of its start, and the distance to each point. */
  private readonly points: Point[];
  private readonly along: number[];
  private readonly voyadores: { paint: number; phase: number }[] = [];
  private readonly escorts: Escort[] = [];
  private readonly people: Person[] = [];
  private readonly formation: { columns: number; ranks: number };

  constructor(readonly route: ProcessionRoute) {
    const [lng0, lat0] = route.route[0]!;
    this.origin = [lng0, lat0];
    this.kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
    this.ky = 110_540;
    this.points = route.route.map(([lng, lat]) => [(lng - lng0) * this.kx, (lat - lat0) * this.ky]);
    this.along = [0];
    for (let i = 1; i < this.points.length; i++) {
      const [ax, ay] = this.points[i - 1]!;
      const [bx, by] = this.points[i]!;
      this.along.push(this.along[i - 1]! + Math.hypot(bx - ax, by - ay));
    }
    this.length = this.along.at(-1)!;

    const rng = random(hashString(route.id));
    const columns = route.formation?.columns ?? PROCESSION.columns;
    const ranks = route.formation?.ranks ?? PROCESSION.ranks;
    this.formation = { columns, ranks };
    for (let i = 0; i < columns * ranks; i++) {
      this.voyadores.push({ paint: pick(rng, VEHICLES.voyador.paints), phase: rng() * 6.28 });
    }
    const span = this.formationLength();
    for (let i = 0; i < (route.formation?.escorts ?? PROCESSION.escorts); i++) {
      const vehicle: CraftType = rng() < 0.6 ? 'banca' : 'motorboat';
      const [lo, hi] = PROCESSION.escortBand;
      this.escorts.push({
        along: -30 + rng() * (span + 40),
        off: (rng() < 0.5 ? -1 : 1) * (lo + (hi - lo) * rng()),
        vehicle,
        paint: pick(rng, VEHICLES[vehicle].paints),
        phase: rng() * 6.28,
      });
    }
    const count = Math.floor(this.length * PROCESSION.crowdPerMeter);
    for (const side of [-1, 1]) {
      for (let i = 0; i < count; i++) {
        const [lo, hi] = PROCESSION.crowdBand;
        this.people.push({
          s: rng() * this.length,
          side,
          off: lo + (hi - lo) * rng(),
          rank: rng(),
          candle: rng() < PROCESSION.candles,
          phase: rng() * 6.28,
        });
      }
    }
  }

  /** From the pagoda's stern to the lead voyador's bow, m. */
  private formationLength() {
    return VEHICLES.pagoda.length / 2 + 6 + (this.formation.ranks - 1) * PROCESSION.rankGap + 6;
  }

  /** The point `s` m along the route and the route's direction there (a unit vector). */
  private at(s: number): { x: number; y: number; tx: number; ty: number } {
    const { points, along } = this;
    let i = 1;
    while (i < points.length - 1 && along[i]! < s) i++;
    const [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    const length = along[i]! - along[i - 1]! || 1;
    const tx = (bx - ax) / length;
    const ty = (by - ay) / length;
    const t = s - along[i - 1]!;
    return { x: ax + tx * t, y: ay + ty * t, tx, ty };
  }

  private lngLat(x: number, y: number): [number, number] {
    return [this.origin[0] + x / this.kx, this.origin[1] + y / this.ky];
  }

  /** A boat `s` m along the route, `off` m to the right of it, facing downstream. */
  private boat(s: number, off: number, vehicle: CraftType, paint: number): VisibleAgent {
    const { x, y, tx, ty } = this.at(s);
    // The right of the direction of travel, with y pointing north.
    const [rx, ry] = [ty, -tx];
    const px = x + rx * off;
    const py = y + ry * off;
    const [lng, lat] = this.lngLat(px, py);
    return {
      kind: 'boat',
      lng,
      lat,
      ahead: this.lngLat(px + tx, py + ty),
      side: this.lngLat(px + rx, py + ry),
      vehicle,
      paint,
      flap: 0,
    };
  }

  /** The pagoda's distance along the route at `progress` (0–1): from before the start to the landing. */
  pagodaAt(progress: number) {
    const lead = this.formationLength();
    return -lead + progress * (this.length + lead);
  }

  /**
   * What to draw `progress` (0–1) of the way through, `time` s into it (for sway and jitter):
   * the boats between the start and the landing, and, from `PROCESSION.crowdZoom`, the crowds.
   */
  agents(progress: number, time: number, { boats = true, crowds = true } = {}): VisibleAgent[] {
    const out: VisibleAgent[] = [];
    const pagoda = this.pagodaAt(Math.min(1, Math.max(0, progress)));
    const onRoute = (s: number) => s >= 0 && s <= this.length;
    if (boats) {
      if (onRoute(pagoda)) out.push(this.boat(pagoda, 0, 'pagoda', 0));
      const { columns, ranks } = this.formation;
      const front = VEHICLES.pagoda.length / 2 + 6 + VEHICLES.voyador.length / 2;
      for (let r = 0; r < ranks; r++) {
        for (let c = 0; c < columns; c++) {
          const v = this.voyadores[r * columns + c]!;
          const s = pagoda + front + r * PROCESSION.rankGap;
          if (!onRoute(s)) continue;
          const off =
            (c - (columns - 1) / 2) * PROCESSION.columnGap + Math.sin(time * 0.8 + v.phase) * 0.3;
          out.push(this.boat(s, off, 'voyador', v.paint));
        }
      }
      for (const e of this.escorts) {
        const s = pagoda + e.along + Math.sin(time * 0.3 + e.phase) * 2;
        if (onRoute(s)) out.push(this.boat(s, e.off, e.vehicle, e.paint));
      }
    }
    if (crowds) {
      const landing = this.length;
      for (const p of this.people) {
        const near =
          Math.abs(p.s - pagoda) < PROCESSION.crowdNear || landing - p.s < PROCESSION.crowdNear;
        if (!near && p.rank >= PROCESSION.crowdShare) continue;
        const { x, y, tx, ty } = this.at(p.s);
        const off = p.side * p.off;
        const sway = Math.sin(time * 1.3 + p.phase) * 0.3;
        const [lng, lat] = this.lngLat(x + ty * off + tx * sway, y - tx * off + ty * sway);
        out.push({ kind: 'person', lng, lat, flap: 0, candle: p.candle });
      }
    }
    return out;
  }
}

/** A date's calendar day, as days since 1970-01-01. */
const dayNumber = (year: number, month: number, day: number) =>
  Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);

/** The local date and minutes past midnight of `date` in `timezone`. */
function localTime(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    day: dayNumber(get('year'), get('month'), get('day')),
    minutes: get('hour') * 60 + get('minute') + date.getSeconds() / 60,
  };
}

/** The day a schedule falls on in `year`, as days since 1970-01-01. */
export function scheduledDay(schedule: ProcessionSchedule, year: number): number {
  const first = dayNumber(year, schedule.month, 1);
  // 1970-01-01 was a Thursday (4).
  const firstWeekday = (first + 4) % 7;
  const nth = first + ((schedule.weekday - firstWeekday + 7) % 7) + (schedule.nth - 1) * 7;
  return nth + schedule.offset_days;
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
