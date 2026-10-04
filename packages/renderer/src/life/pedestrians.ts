/** Vehicle-only readers of the live ground index; all inputs and distances are local metres. */
import {
  BODY_KIND,
  binKeys,
  corridorDistance,
  type Body,
  type Occupancy,
  type Point,
  type Polygon,
} from './occupancy';
import { FOLLOW, PEDESTRIAN, type Kinematics } from './config';
import { stopBefore, stoppingReach } from './motion';
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
  walkersAlong(path: Iterable<PedestrianSegment>, halfWidth: number, range: number): number;
};
export const EMPTY_PEDESTRIANS: PedestrianView = {
  empty: true,
  minimum: 0,
  walkersAhead: () => Infinity,
  walkersInArea: () => false,
  walkersAlong: () => Infinity,
};
// Prepared query geometry is owned by this module and remains unchanged after preparation.
const preparedAreas = new WeakSet<Polygon>();
type MetricFrame = Readonly<{ x: number; y: number; scale: number }>;
const convertedAreas = new WeakMap<MetricFrame, WeakMap<Polygon, Polygon>>();
function preparedArea(polygon: Polygon): Polygon {
  preparedAreas.add(polygon);
  return polygon;
}

export function pedestrianView(
  occupied: Occupancy,
  minimum: number,
  frame = { x: 0, y: 0, scale: 1 },
  queryOnly?: Occupancy,
): PedestrianView {
  return new IndexedPedestrians(occupied, minimum, frame, queryOnly);
}

/** Shared methods keep readers small and stable across frames and tile coordinate systems. */
class IndexedPedestrians implements PedestrianView {
  private readonly candidateBodies: Body[] = [];
  constructor(
    private readonly occupied: Occupancy,
    readonly minimum: number,
    private readonly frame: MetricFrame,
    private readonly queryOnly?: Occupancy,
  ) {}
  private readonly predicateBody: Body = { x: 0, y: 0, hx: 0, hy: 0, length: 0, width: 0 };
  get empty() {
    return !this.occupied.hasHumans && !this.queryOnly?.hasHumans;
  }
  private polygonToRef(p: Polygon): Polygon {
    const { frame } = this;
    const prepared = preparedAreas.has(p);
    if (frame.x === 0 && frame.y === 0 && frame.scale === 1 && prepared) return p;
    let cached: WeakMap<Polygon, Polygon> | undefined;
    if (prepared) {
      cached = convertedAreas.get(frame);
      if (!cached) convertedAreas.set(frame, (cached = new WeakMap()));
      const found = cached.get(p);
      if (found) return found;
    }
    const converted = p.map((ring) =>
      ring.map((p) => ({ x: frame.x + p.x * frame.scale, y: frame.y + p.y * frame.scale })),
    );
    cached?.set(p, converted);
    return converted;
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
    const query = (occupied: Occupancy) =>
      occupied.nearestInCorridor(
        frame.x + x * frame.scale,
        frame.y + y * frame.scale,
        hx,
        hy,
        halfWidth * frame.scale,
        range * frame.scale,
        BODY_KIND.human,
        undefined,
        excludedAreas?.map((area) => this.polygonToRef(area)),
      );
    return (
      Math.min(query(this.occupied), this.queryOnly ? query(this.queryOnly) : Infinity) /
      frame.scale
    );
  }
  walkersInArea(polygon: Polygon, predicate?: (body: Readonly<Body>) => boolean) {
    const { frame } = this;
    const converted = this.polygonToRef(polygon);
    const query = (occupied: Occupancy) =>
      occupied.someInArea(
        converted,
        BODY_KIND.human,
        predicate &&
          ((b) => {
            // Predicates run synchronously; this numeric scratch contains no live body references.
            Object.assign(this.predicateBody, {
              x: (b.x - frame.x) / frame.scale,
              y: (b.y - frame.y) / frame.scale,
              hx: b.hx,
              hy: b.hy,
              kind: b.kind,
              length: b.length / frame.scale,
              width: b.width / frame.scale,
            });
            return predicate(this.predicateBody);
          }),
      );
    return query(this.occupied) || (this.queryOnly ? query(this.queryOnly) : false);
  }
  /** One live footprint query covers every chord, including footprints centered outside the envelope. */
  walkersAlong(path: Iterable<PedestrianSegment>, halfWidth: number, range: number): number {
    const iterator = path[Symbol.iterator]();
    let count = 0;
    try {
      let item = iterator.next();
      if (item.done) return Infinity;
      const { frame } = this;
      const x = frame.x + item.value.x * frame.scale,
        y = frame.y + item.value.y * frame.scale,
        reach = (range + halfWidth) * frame.scale;
      const corner = { x: x - reach, y: y - reach };
      const region = [
        [
          corner,
          { x: x + reach, y: y - reach },
          { x: x + reach, y: y + reach },
          { x: x - reach, y: y + reach },
          corner,
        ],
      ];
      const collect = (b: Readonly<Body>) => {
        const copy =
          this.candidateBodies[count] ??
          (this.candidateBodies[count] = { x: 0, y: 0, hx: 0, hy: 0, length: 0, width: 0 });
        Object.assign(copy, {
          x: b.x,
          y: b.y,
          hx: b.hx,
          hy: b.hy,
          length: b.length,
          width: b.width,
          kind: b.kind,
        });
        count++;
        return false;
      };
      this.occupied.someInArea(region, BODY_KIND.human, collect);
      this.queryOnly?.someInArea(region, BODY_KIND.human, collect);
      if (!count) return Infinity;
      let nearest = Infinity;
      for (; !item.done; item = iterator.next()) {
        const p = item.value;
        if (p.ahead >= range - 1e-7 || p.ahead >= nearest) break;
        for (let i = 0; i < count; i++) {
          const d = corridorDistance(
            this.candidateBodies[i]!,
            frame.x + p.x * frame.scale,
            frame.y + p.y * frame.scale,
            p.hx,
            p.hy,
            halfWidth * frame.scale,
            Math.min(p.length, range - p.ahead) * frame.scale,
          );
          nearest = Math.min(nearest, p.ahead + d / frame.scale);
        }
      }
      return nearest;
    } finally {
      // Only numeric copies remain in the pool; no live body or owner references are retained.
      iterator.return?.();
    }
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
    stoppingReach(velocity, k.brake, length / 2 + FOLLOW.minGap, PEDESTRIAN.lookaheadPad),
  );
function stopTarget(distance: number, length: number, k: Kinematics, pm: number, dt: number) {
  return stopBefore(
    distance * pm,
    0,
    k.brake * pm,
    (FOLLOW.minGap + length / 2) * pm,
    k.brake * dt * dt * pm,
  );
}
export function pedestrianLimit(
  view: PedestrianView,
  path: Iterable<PedestrianSegment>,
  halfWidth: number,
  length: number,
  target: number,
  k: Kinematics,
  pm: number,
  dt: number,
  range: number,
): number {
  if (target <= 0 || view.empty) return target;
  const nearest = view.walkersAlong(path, halfWidth, range);
  if (!Number.isFinite(nearest)) return target;
  return Math.min(target, stopTarget(nearest, length, k, pm, dt));
}

/** Geographic values only: immutable records survive tile and zoom adoption. */
export type PedestrianHold = Readonly<{
  key: string;
  x: number;
  y: number;
  radius: number;
  elapsed: number;
  expired: boolean;
  /** A late curb arrival must not make a vehicle stop across the stripes. */
  committed?: boolean;
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
const DIRECT_CROSSINGS = 8;
const NO_HOLDS: readonly PedestrianHold[] = [];

/** Cached road associations and metric quads; neither walkers nor tiles are retained here. */
export class PedestrianCrossings {
  private readonly index = new Map<number, PedestrianCrossing[]>();
  private readonly lines = new Map<number, PedestrianCrossing[]>();
  private readonly foundCrossings = new Map<PedestrianCrossing, number>();
  private readonly limitCandidates = new Map<string, PedestrianCrossing>();
  private readonly usedHolds = new Set<PedestrianHold>();
  get empty() {
    return this.index.size === 0;
  }
  hasLine(line: number): boolean {
    return this.lines.has(line);
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
      for (const key of binKeys(polygon[0]!)) {
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
        for (const key of binKeys([
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
          for (const key of binKeys(polygon[0]!)) {
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
  along(
    path: readonly PedestrianSegment[],
    halfWidth: number,
    found = new Map<PedestrianCrossing, number>(),
  ): Map<PedestrianCrossing, number> {
    found.clear();
    for (const p of path) {
      const associated = this.lines.get(p.line);
      if (!associated) continue;
      // Small road-local sets cost less to scan than constructing spatial query geometry.
      let candidates: Iterable<PedestrianCrossing> = associated;
      if (associated.length > DIRECT_CROSSINGS) {
        const nearby = new Set<PedestrianCrossing>();
        for (const key of binKeys([
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
    velocity = target / this.pm,
  ) {
    const found = this.along(path, halfWidth, this.foundCrossings);
    const candidates = this.limitCandidates,
      used = this.usedHolds;
    candidates.clear();
    used.clear();
    try {
      if (!found.size && !holds.length) return { target, holds: undefined };
      for (const [crossing, ahead] of found) {
        const previous = candidates.get(crossing.identity.key);
        if (!previous || ahead < found.get(previous)!)
          candidates.set(crossing.identity.key, crossing);
      }
      const position = path[0];
      const global = position && this.geographic(position);
      const scale = this.geographicScale;
      const records: PedestrianHold[] = [];
      for (const c of candidates.values()) {
        const ahead = found.get(c)!;
        const previous = holds.find(
          (h) =>
            h.key === c.identity.key ||
            (Math.hypot(h.x - c.identity.x, h.y - c.identity.y) <= PEDESTRIAN.holdMatch * scale &&
              Math.abs(h.radius - c.identity.radius) <= PEDESTRIAN.holdMatch * scale),
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
        const front = ahead - length / 2;
        const committed =
          previous?.committed === true ||
          front <= 0 ||
          (!previous && front < (velocity * velocity) / (2 * k.maxBrake));
        const record =
          previous &&
          elapsed === previous.elapsed &&
          expired === previous.expired &&
          committed === (previous.committed === true)
            ? previous
            : { ...(previous ?? c.identity), elapsed, expired, committed };
        records.push(record);
        // Expiry ends the courtesy hold; people in the physical lane still limit speed.
        if (!expired && !committed && blocked) {
          target = Math.min(target, stopTarget(ahead, length, k, this.pm, dt));
        }
      }
      // Keep a crossing while the rear is still over it, even after its edge leaves forward lookahead.
      for (const h of holds) {
        if (used.has(h) || !global || !position) continue;
        const distance = Math.hypot(h.x - global.x, h.y - global.y);
        if (distance <= h.radius + (length / 2) * scale) records.push(h);
      }
      return { target, holds: records.length ? records : undefined };
    } finally {
      found.clear();
      candidates.clear();
      used.clear();
    }
  }
}
