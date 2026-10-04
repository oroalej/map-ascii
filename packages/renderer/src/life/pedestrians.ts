/** Vehicle-only readers of the live ground index; all inputs and distances are local metres. */
import {
  BODY_KIND,
  boundsOf,
  corridorDistance,
  type Body,
  type Occupancy,
  type Point,
  type Polygon,
} from './occupancy';
import { FOLLOW, PEDESTRIAN, type Kinematics } from './config';
import { approach } from './motion';
import { LifeLine, type LifeGeometry } from './geometry';
import { EXTENT, MERCATOR_METERS } from '../raster/geometry';
import type { TileId } from '../tiles';
import type { SignalControl } from './signals';

export type PedestrianView = {
  readonly empty: boolean;
  readonly minimum: number;
  walkersAhead(
    x: number,
    y: number,
    hx: number,
    hy: number,
    halfWidth: number,
    range: number,
    excludedAreas?: readonly Polygon[],
  ): number;
  walkersInArea(polygon: Polygon, predicate?: (body: Readonly<Body>) => boolean): boolean;
};
export const EMPTY_PEDESTRIANS: PedestrianView = {
  empty: true,
  minimum: 0,
  walkersAhead: () => Infinity,
  walkersInArea: () => false,
};
// Prepared query geometry is owned by this module and remains unchanged after preparation.
const preparedAreas = new WeakSet<Polygon>();
function preparedArea(polygon: Polygon): Polygon {
  preparedAreas.add(polygon);
  return polygon;
}

export function pedestrianView(
  occupied: Occupancy,
  minimum: number,
  frame = { x: 0, y: 0, scale: 1 },
): PedestrianView {
  return new IndexedPedestrians(occupied, minimum, frame);
}

/** Shared methods keep readers small and stable across frames and tile coordinate systems. */
class IndexedPedestrians implements PedestrianView {
  constructor(
    private readonly occupied: Occupancy,
    readonly minimum: number,
    private readonly frame: { x: number; y: number; scale: number },
  ) {}
  get empty() {
    return !this.occupied.hasHumans;
  }
  private polygonToRef(p: Polygon): Polygon {
    const { frame } = this;
    if (frame.x === 0 && frame.y === 0 && frame.scale === 1 && preparedAreas.has(p)) return p;
    return p.map((ring) =>
      ring.map((p) => ({ x: frame.x + p.x * frame.scale, y: frame.y + p.y * frame.scale })),
    );
  }
  walkersAhead(
    x: number,
    y: number,
    hx: number,
    hy: number,
    halfWidth: number,
    range: number,
    excludedAreas?: readonly Polygon[],
  ) {
    const { frame } = this;
    return (
      this.occupied.nearestInCorridor(
        frame.x + x * frame.scale,
        frame.y + y * frame.scale,
        hx,
        hy,
        halfWidth * frame.scale,
        range * frame.scale,
        BODY_KIND.human,
        undefined,
        excludedAreas?.map((area) => this.polygonToRef(area)),
      ) / frame.scale
    );
  }
  walkersInArea(polygon: Polygon, predicate?: (body: Readonly<Body>) => boolean) {
    const { frame } = this;
    return this.occupied.someInArea(
      this.polygonToRef(polygon),
      BODY_KIND.human,
      predicate &&
        ((b) =>
          predicate({
            ...b,
            x: (b.x - frame.x) / frame.scale,
            y: (b.y - frame.y) / frame.scale,
            length: b.length / frame.scale,
            width: b.width / frame.scale,
          })),
    );
  }
}

/** One chord of the actual lane/fillet path, with accumulated metric distance. */
export type PedestrianSegment = {
  x: number;
  y: number;
  hx: number;
  hy: number;
  length: number;
  ahead: number;
  line: number;
};
export const pedestrianRange = (velocity: number, length: number, k: Kinematics) =>
  Math.min(
    PEDESTRIAN.maxRange,
    (velocity * velocity) / (2 * k.brake) + length / 2 + FOLLOW.minGap + PEDESTRIAN.lookaheadPad,
  );
export function pedestrianLimit(
  view: PedestrianView,
  path: Iterable<PedestrianSegment>,
  halfWidth: number,
  length: number,
  target: number,
  k: Kinematics,
  pm: number,
  dt: number,
  excluded?: readonly Polygon[],
  range = Infinity,
): number {
  if (target <= 0 || view.empty) return target;
  let nearest = Infinity;
  for (const p of path) {
    if (p.ahead >= range - 1e-7) break;
    const d = view.walkersAhead(
      p.x,
      p.y,
      p.hx,
      p.hy,
      halfWidth,
      Math.min(p.length, range - p.ahead),
      excluded,
    );
    nearest = Math.min(nearest, p.ahead + d);
  }
  if (!Number.isFinite(nearest)) return target;
  const room = Math.max(0, nearest - FOLLOW.minGap - length / 2 - k.brake * dt * dt);
  return Math.min(target, approach(room * pm, 0, k.brake * pm));
}

/** Geographic values only: immutable records survive tile and zoom adoption. */
export type PedestrianHold = Readonly<{
  key: string;
  x: number;
  y: number;
  radius: number;
  elapsed: number;
  expired: boolean;
}>;
export type PedestrianCrossing = {
  polygon: Polygon;
  body: Body;
  entrances: readonly [Point, Point];
  entranceAreas: readonly [Polygon, Polygon];
  line: number;
  controlled: boolean;
  identity: Pick<PedestrianHold, 'key' | 'x' | 'y' | 'radius'>;
};
const CROSSING_BIN = 12;
const DIRECT_CROSSINGS = 8;
const NO_HOLDS: readonly PedestrianHold[] = [];
const bin = (x: number, y: number) => (x + 32768) * 65536 + y + 32768;
function* bins(points: readonly Point[]) {
  const [x0, y0, x1, y1] = boundsOf(points);
  for (let y = Math.floor(y0 / CROSSING_BIN); y <= Math.floor(y1 / CROSSING_BIN); y++)
    for (let x = Math.floor(x0 / CROSSING_BIN); x <= Math.floor(x1 / CROSSING_BIN); x++)
      yield bin(x, y);
}

/** Cached road associations and metric quads; neither walkers nor tiles are retained here. */
export class PedestrianCrossings {
  private readonly index = new Map<number, PedestrianCrossing[]>();
  private readonly lines = new Map<number, PedestrianCrossing[]>();
  get empty() {
    return this.index.size === 0;
  }
  constructor(
    private readonly tile: TileId,
    private readonly pm: number,
  ) {}
  *prepare(geo: LifeGeometry, signals: SignalControl): Generator<void, void, void> {
    const quads = new Map<number, Polygon[]>();
    for (const area of geo.areas ?? []) {
      yield;
      if (area.kind !== 'crossing') continue;
      const ring = area.rings[0];
      if (!ring || ring.length < 4) continue;
      const polygon = preparedArea([
        ring.slice(0, 4).map((p) => ({ x: p.x / this.pm, y: p.y / this.pm })),
      ]);
      for (const key of bins(polygon[0]!)) {
        let entries = quads.get(key);
        if (!entries) quads.set(key, (entries = []));
        entries.push(polygon);
      }
    }
    if (!quads.size) return;
    for (let line = 0; line < geo.kinds.length; line++) {
      yield;
      if (geo.kinds[line]! > LifeLine.roadMinor) continue;
      const added = new Set<Polygon>();
      for (let v = geo.starts[line]! + 1; v < geo.starts[line + 1]!; v++) {
        if ((v & 63) === 0) yield;
        const x = geo.coords[(v - 1) * 2]! / this.pm,
          y = geo.coords[(v - 1) * 2 + 1]! / this.pm,
          dx = geo.coords[v * 2]! / this.pm - x,
          dy = geo.coords[v * 2 + 1]! / this.pm - y,
          length = Math.hypot(dx, dy);
        if (!length) continue;
        const hx = dx / length,
          hy = dy / length,
          halfWidth = Math.max(0.1, geo.widths[line]! / 2);
        const candidates = new Set<Polygon>();
        for (const key of bins([
          { x: x - hy * halfWidth, y: y + hx * halfWidth },
          { x: x + hy * halfWidth, y: y - hx * halfWidth },
          { x: x + dx - hy * halfWidth, y: y + dy + hx * halfWidth },
          { x: x + dx + hy * halfWidth, y: y + dy - hx * halfWidth },
        ]))
          for (const polygon of quads.get(key) ?? []) candidates.add(polygon);
        for (const polygon of candidates) {
          if (added.has(polygon)) continue;
          const crossing = this.derive(polygon, line, hx, hy, signals);
          if (crossing.controlled) continue;
          if (!Number.isFinite(corridorDistance(crossing.body, x, y, hx, hy, halfWidth, length)))
            continue;
          added.add(polygon);
          let associated = this.lines.get(line);
          if (!associated) this.lines.set(line, (associated = []));
          associated.push(crossing);
          for (const key of bins(polygon[0]!)) {
            let entries = this.index.get(key);
            if (!entries) this.index.set(key, (entries = []));
            entries.push(crossing);
          }
        }
      }
    }
  }
  private derive(
    polygon: Polygon,
    line: number,
    hx: number,
    hy: number,
    signals: SignalControl,
  ): PedestrianCrossing {
    const ring = polygon[0]!;
    const centre = { x: 0, y: 0 };
    for (const p of ring) {
      centre.x += p.x / 4;
      centre.y += p.y / 4;
    }
    let edge = 0,
      alignment = -Infinity;
    for (let i = 0; i < 4; i++) {
      const a = ring[i]!,
        b = ring[(i + 1) % 4]!;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const score = Math.abs(((b.x - a.x) * hx + (b.y - a.y) * hy) / (d || 1));
      if (score > alignment) {
        alignment = score;
        edge = i;
      }
    }
    const entrance = (i: number) => {
      const a = ring[i]!,
        b = ring[(i + 1) % 4]!;
      const x = (a.x + b.x) / 2,
        y = (a.y + b.y) / 2;
      const distance = Math.hypot(x - centre.x, y - centre.y) || 1;
      return { x: x + (x - centre.x) / distance, y: y + (y - centre.y) / distance };
    };
    const a = ring[edge]!,
      b = ring[(edge + 1) % 4]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const ex = (b.x - a.x) / (length || 1),
      ey = (b.y - a.y) / (length || 1);
    let side = 0,
      along = 0;
    for (const p of ring) {
      along = Math.max(along, Math.abs((p.x - centre.x) * ex + (p.y - centre.y) * ey));
      side = Math.max(side, Math.abs(-(p.x - centre.x) * ey + (p.y - centre.y) * ex));
    }
    const global = this.geographic(centre);
    const scale = this.geographicScale;
    const entrances = [entrance(edge), entrance((edge + 2) % 4)] as const;
    const entranceArea = (p: Point) => {
      const reach = PEDESTRIAN.curbReach;
      return preparedArea([
        [
          { x: p.x - reach, y: p.y - reach },
          { x: p.x + reach, y: p.y - reach },
          { x: p.x + reach, y: p.y + reach },
          { x: p.x - reach, y: p.y + reach },
        ],
      ]);
    };
    return {
      polygon,
      body: { ...centre, hx: ex, hy: ey, length: along * 2, width: side * 2 },
      entrances,
      entranceAreas: [entranceArea(entrances[0]), entranceArea(entrances[1])],
      line,
      controlled: signals.controlsCrossing(line, { x: centre.x * this.pm, y: centre.y * this.pm }),
      identity: {
        key: `${Math.round(global.x)},${Math.round(global.y)}`,
        ...global,
        radius: Math.hypot(along, side) * scale,
      },
    };
  }
  private get geographicScale() {
    return (this.pm * MERCATOR_METERS) / (EXTENT * 2 ** this.tile.z);
  }
  private geographic(p: Point): Point {
    const scale = MERCATOR_METERS / (EXTENT * 2 ** this.tile.z);
    return {
      x: (this.tile.x * EXTENT + p.x * this.pm) * scale,
      y: (this.tile.y * EXTENT + p.y * this.pm) * scale,
    };
  }
  along(path: readonly PedestrianSegment[], halfWidth: number): Map<PedestrianCrossing, number> {
    const found = new Map<PedestrianCrossing, number>();
    for (const p of path) {
      const associated = this.lines.get(p.line);
      if (!associated) continue;
      // Small road-local sets cost less to scan than constructing spatial query geometry.
      let candidates: Iterable<PedestrianCrossing> = associated;
      if (associated.length > DIRECT_CROSSINGS) {
        const nearby = new Set<PedestrianCrossing>();
        for (const key of bins([
          { x: p.x - p.hy * halfWidth, y: p.y + p.hx * halfWidth },
          { x: p.x + p.hy * halfWidth, y: p.y - p.hx * halfWidth },
          {
            x: p.x + p.hx * p.length - p.hy * halfWidth,
            y: p.y + p.hy * p.length + p.hx * halfWidth,
          },
          {
            x: p.x + p.hx * p.length + p.hy * halfWidth,
            y: p.y + p.hy * p.length - p.hx * halfWidth,
          },
        ]))
          for (const c of this.index.get(key) ?? [])
            if (c.line === p.line && !c.controlled) nearby.add(c);
        candidates = nearby;
      }
      for (const c of candidates) {
        if (c.line !== p.line || c.controlled) continue;
        const d = corridorDistance(c.body, p.x, p.y, p.hx, p.hy, halfWidth, p.length);
        if (Number.isFinite(d)) found.set(c, Math.min(found.get(c) ?? Infinity, p.ahead + d));
      }
    }
    return found;
  }
  private blocked(c: PedestrianCrossing, view: PedestrianView): boolean {
    if (view.walkersInArea(c.polygon)) return true;
    const reach = PEDESTRIAN.curbReach;
    return c.entrances.some((p, i) => {
      const toward = c.entrances[1 - i]!;
      return view.walkersInArea(
        c.entranceAreas[i]!,
        (b) =>
          Math.hypot(b.x - p.x, b.y - p.y) <= reach &&
          b.hx * (toward.x - p.x) + b.hy * (toward.y - p.y) > 0,
      );
    });
  }
  limit(
    view: PedestrianView,
    path: readonly PedestrianSegment[],
    halfWidth: number,
    length: number,
    range: number,
    target: number,
    k: Kinematics,
    dt: number,
    holds: readonly PedestrianHold[] = NO_HOLDS,
  ) {
    const found = this.along(path, halfWidth);
    if (!found.size && !holds.length) return { target, holds: undefined };
    const candidates = new Map<string, { crossing: PedestrianCrossing; ahead: number }>();
    for (const [crossing, ahead] of found) {
      const previous = candidates.get(crossing.identity.key);
      if (!previous || ahead < previous.ahead)
        candidates.set(crossing.identity.key, { crossing, ahead });
    }
    const position = path[0];
    const global = position && this.geographic(position);
    const scale = this.geographicScale;
    const records: PedestrianHold[] = [];
    const used = new Set<PedestrianHold>();
    for (const { crossing: c, ahead } of candidates.values()) {
      const previous = holds.find(
        (h) =>
          h.key === c.identity.key ||
          (Math.hypot(h.x - c.identity.x, h.y - c.identity.y) <= 2 * scale &&
            Math.abs(h.radius - c.identity.radius) <= 2 * scale),
      );
      if (previous) used.add(previous);
      if (previous?.expired) {
        records.push(previous);
        continue;
      }
      const blocked =
        (previous !== undefined || ahead <= range) && !view.empty && this.blocked(c, view);
      if (!previous && !blocked) continue;
      const elapsed = Math.min(PEDESTRIAN.holdMax, (previous?.elapsed ?? 0) + (blocked ? dt : 0));
      const expired = previous?.expired || elapsed >= PEDESTRIAN.holdMax - 1e-9;
      const record =
        previous && elapsed === previous.elapsed && expired === previous.expired
          ? previous
          : { ...(previous ?? c.identity), elapsed, expired };
      records.push(record);
      // Expiry ends the courtesy hold; people in the physical lane still limit speed.
      if (!expired && blocked) {
        const room = Math.max(0, ahead - FOLLOW.minGap - length / 2 - k.brake * dt * dt);
        target = Math.min(target, approach(room * this.pm, 0, k.brake * this.pm));
      }
    }
    // Keep a crossing while the rear is still over it, even after its edge leaves forward lookahead.
    for (const h of holds) {
      if (used.has(h) || !global || !position) continue;
      const distance = Math.hypot(h.x - global.x, h.y - global.y);
      if (distance <= h.radius + (length / 2) * scale) records.push(h);
    }
    return { target, holds: records.length ? records : undefined };
  }
}
