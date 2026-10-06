/** Vehicle-only readers of the live ground index; all inputs and distances are local metres. */
import {
  BODY_KIND,
  binKeys,
  bodyCorners,
  bodyHitsPolygon,
  corridorDistance,
  pointInside,
  type Body,
  type Occupancy,
  type Point,
  type Polygon,
} from './occupancy';
import { frontClearance, PEDESTRIAN, type Kinematics } from './config';
import { stopBefore, stoppingReach } from './motion';
import { LifeLine, type LifeGeometry } from './geometry';
import { EXTENT, MERCATOR_METERS } from '../raster/geometry';
import type { TileId } from '../tiles';
import type { SignalControl } from './signals';

export type PedestrianView = {
  readonly empty: boolean;
  readonly minimum: number;
  walkersInArea(polygon: Polygon, predicate?: (body: Readonly<Body>) => boolean): boolean;
  walkersAlong(path: Iterable<PedestrianSegment>, halfWidth: number, range: number): number;
};
export const EMPTY_PEDESTRIANS: PedestrianView = {
  empty: true,
  minimum: 0,
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
  private candidateCount = 0;
  private readonly queryCorners: Point[] = Array.from({ length: 4 }, () => ({ x: 0, y: 0 }));
  private readonly queryRegion: Polygon = [[...this.queryCorners, this.queryCorners[0]!]];
  private areaPredicate: ((body: Readonly<Body>) => boolean) | undefined;
  private readonly collect = (b: Readonly<Body>) => {
    const i = this.candidateCount++;
    const copy =
      this.candidateBodies[i] ??
      (this.candidateBodies[i] = {
        x: 0,
        y: 0,
        hx: 0,
        hy: 0,
        length: 0,
        width: 0,
      });
    copy.x = b.x;
    copy.y = b.y;
    copy.hx = b.hx;
    copy.hy = b.hy;
    copy.length = b.length;
    copy.width = b.width;
    copy.kind = b.kind;
    return false;
  };
  private readonly matches = (b: Readonly<Body>) => {
    const out = this.predicateBody,
      frame = this.frame;
    out.x = (b.x - frame.x) / frame.scale;
    out.y = (b.y - frame.y) / frame.scale;
    out.hx = b.hx;
    out.hy = b.hy;
    out.kind = b.kind;
    out.length = b.length / frame.scale;
    out.width = b.width / frame.scale;
    return this.areaPredicate?.(out) ?? false;
  };
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
  walkersInArea(polygon: Polygon, predicate?: (body: Readonly<Body>) => boolean) {
    const converted = this.polygonToRef(polygon);
    this.areaPredicate = predicate;
    try {
      const matches = predicate ? this.matches : undefined;
      return (
        this.occupied.someInArea(converted, BODY_KIND.human, matches) ||
        (this.queryOnly?.someInArea(converted, BODY_KIND.human, matches) ?? false)
      );
    } finally {
      this.areaPredicate = undefined;
    }
  }
  /** One live footprint query covers every chord, including footprints centered outside the envelope. */
  walkersAlong(path: Iterable<PedestrianSegment>, halfWidth: number, range: number): number {
    if (!Number.isFinite(range) || !Number.isFinite(halfWidth) || range < 0 || halfWidth < 0)
      return Infinity;
    const iterator = path[Symbol.iterator]();
    this.candidateCount = 0;
    try {
      let item = iterator.next();
      if (item.done) return Infinity;
      const { frame } = this;
      const first = item.value;
      const x = frame.x + first.x * frame.scale,
        y = frame.y + item.value.y * frame.scale,
        reach = (range + halfWidth) * frame.scale;
      if (
        first.ahead === 0 &&
        first.length >= range &&
        Math.abs(first.hx * first.hx + first.hy * first.hy - 1) < 1e-9
      ) {
        if (range > 0 && range <= 1e-7) return Infinity;
        // A complete straight chord needs one exact corridor test, without polygon/copy work.
        let nearest = this.occupied.nearestInCorridor(
          x,
          y,
          first.hx,
          first.hy,
          halfWidth * frame.scale,
          range * frame.scale,
          BODY_KIND.human,
        );
        if (nearest !== 0 && this.queryOnly)
          nearest = Math.min(
            nearest,
            this.queryOnly.nearestInCorridor(
              x,
              y,
              first.hx,
              first.hy,
              halfWidth * frame.scale,
              range * frame.scale,
              BODY_KIND.human,
            ),
          );
        return nearest / frame.scale;
      }
      const [a, b, c, d] = this.queryCorners;
      if (first.length >= range) {
        const nx = -first.hy * halfWidth * frame.scale,
          ny = first.hx * halfWidth * frame.scale,
          dx = first.hx * range * frame.scale,
          dy = first.hy * range * frame.scale;
        a!.x = x + nx;
        a!.y = y + ny;
        b!.x = x + dx + nx;
        b!.y = y + dy + ny;
        c!.x = x + dx - nx;
        c!.y = y + dy - ny;
        d!.x = x - nx;
        d!.y = y - ny;
      } else {
        a!.x = x - reach;
        a!.y = y - reach;
        b!.x = x + reach;
        b!.y = y - reach;
        c!.x = x + reach;
        c!.y = y + reach;
        d!.x = x - reach;
        d!.y = y + reach;
      }
      this.occupied.someInArea(this.queryRegion, BODY_KIND.human, this.collect);
      this.queryOnly?.someInArea(this.queryRegion, BODY_KIND.human, this.collect);
      const count = this.candidateCount;
      if (!count) return Infinity;
      let nearest = Infinity;
      for (; !item.done; item = iterator.next()) {
        const p = item.value;
        if ((range > 0 && p.ahead >= range - 1e-7) || p.ahead > range || p.ahead >= nearest) break;
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
      this.candidateCount = 0;
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
    stoppingReach(velocity, k.brake, frontClearance(length), PEDESTRIAN.lookaheadPad),
  );
function stopTarget(distance: number, length: number, k: Kinematics, pm: number, dt: number) {
  return stopBefore(
    distance * pm,
    0,
    k.brake * pm,
    frontClearance(length) * pm,
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
  /**
   * The uncontrolled crossings a step from `from` to `to` (tile metres) walks onto from outside,
   * one record per road line they cross.
   */
  entered(from: Point, to: Point): PedestrianCrossing[] {
    const out: PedestrianCrossing[] = [];
    for (const key of binKeys([to]))
      for (const c of this.index.get(key) ?? [])
        if (
          !c.controlled &&
          !out.includes(c) &&
          pointInside(to, c.polygon) &&
          !pointInside(from, c.polygon)
        )
          out.push(c);
    return out;
  }
  constructor(
    private readonly tile: TileId,
    private readonly pm: number,
  ) {}
  *prepare(geo: LifeGeometry, signals: SignalControl): Generator<void, void, void> {
    const quads = new Map<number, Polygon[]>();
    const geometry = new Map<
      Polygon,
      {
        centre: Point;
        distance: number;
        hx: number;
        hy: number;
        lines: Set<number>;
      }
    >();
    for (const area of geo.areas ?? []) {
      yield;
      if (area.kind !== 'crossing') continue;
      const ring = (area.crossingStripes ?? area.rings)[0];
      if (!ring || ring.length < 4) continue;
      const polygon = preparedArea([
        ring.slice(0, 4).map((p) => ({ x: p.x / this.pm, y: p.y / this.pm })),
      ]);
      const centre = { x: 0, y: 0 };
      for (const p of polygon[0]!) {
        centre.x += p.x / 4;
        centre.y += p.y / 4;
      }
      geometry.set(polygon, { centre, distance: Infinity, hx: 1, hy: 0, lines: new Set() });
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
        const road: Body = { x: x + dx / 2, y: y + dy / 2, hx, hy, length, width: halfWidth * 2 };
        const corners = bodyCorners(road);
        const candidates = new Set<Polygon>();
        for (const key of binKeys([
          { x: x - hy * halfWidth, y: y + hx * halfWidth },
          { x: x + hy * halfWidth, y: y - hx * halfWidth },
          { x: x + dx - hy * halfWidth, y: y + dy + hx * halfWidth },
          { x: x + dx + hy * halfWidth, y: y + dy - hx * halfWidth },
        ]))
          for (const polygon of quads.get(key) ?? []) candidates.add(polygon);
        for (const polygon of candidates) {
          if (!bodyHitsPolygon(road, polygon, corners)) continue;
          const prepared = geometry.get(polygon)!;
          prepared.lines.add(line);
          const along = Math.max(
            0,
            Math.min(length, (prepared.centre.x - x) * hx + (prepared.centre.y - y) * hy),
          );
          const distance = Math.hypot(
            prepared.centre.x - x - hx * along,
            prepared.centre.y - y - hy * along,
          );
          // Equal distances retain the first segment in deterministic line/vertex order.
          if (distance < prepared.distance) {
            prepared.distance = distance;
            prepared.hx = hx;
            prepared.hy = hy;
          }
        }
      }
    }
    for (const [polygon, prepared] of geometry) {
      yield;
      if (!prepared.lines.size) continue;
      const shared = this.derive(polygon, prepared.hx, prepared.hy);
      for (const line of prepared.lines) {
        const controlled = signals.controlsCrossing({
          x: prepared.centre.x * this.pm,
          y: prepared.centre.y * this.pm,
        });
        if (controlled) continue;
        const crossing = { ...shared, line, controlled };
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
  private derive(
    polygon: Polygon,
    hx: number,
    hy: number,
  ): Omit<PedestrianCrossing, 'line' | 'controlled'> {
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
  /** Only a full straight route can use geographic projection as an along-route bound. */
  heldRange(
    holds: readonly PedestrianHold[],
    straight: PedestrianSegment,
    physicalRange: number,
  ): number {
    const start = this.geographic(straight),
      scale = this.geographicScale;
    let range = physicalRange;
    for (const h of holds) {
      const projected = (h.x - start.x) * straight.hx + (h.y - start.y) * straight.hy;
      // Both centre and radius may differ by the geographic matching tolerance after adoption.
      const reach = (projected + h.radius) / scale + 2 * PEDESTRIAN.holdMatch;
      if (!Number.isFinite(reach)) return PEDESTRIAN.maxRange;
      range = Math.max(range, reach);
    }
    return Math.min(PEDESTRIAN.maxRange, range);
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
          (!previous && front < stoppingReach(velocity, k.maxBrake, 0));
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
