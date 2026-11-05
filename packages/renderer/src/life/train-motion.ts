import { EXTENT } from '../raster/geometry';
import { TRAIN, TRAIN_FOLLOW, kinematicsOf } from './config';
import { frameBetween, metricFrame } from './frames';
import { approach, type MotionLimit } from './motion';
import { cutTrail, trainLength, type Mover, type TileLife } from './simulate';
import type { Pose } from './curves';
import { RAIL_CROSSING } from './rail-crossings';

export type TrainLimit = MotionLimit & { station: number };
type Sample = Pose & { distance: number; life: TileLife };

/** One immutable path in the origin tile's frame, continuing with the handover matching rule. */
function lookahead(
  origin: TileLife,
  m: Mover,
  lives: readonly TileLife[],
  owns?: (life: TileLife, p: { x: number; y: number }) => boolean,
): { points: Sample[]; end?: number } {
  const points: Sample[] = [];
  let life = origin,
    cursor = { ...m },
    distance = 0;
  const reach = TRAIN_FOLLOW.lookahead * origin.perMeter;
  const visited = new Set<string>();
  for (let hops = 0; hops < 64 && distance < reach; hops++) {
    const f = frameBetween(life.tile, origin.tile);
    const result = life.trackAhead(
      cursor,
      (reach - distance) / f.scale,
      (p) =>
        points.push({
          x: f.x + p.x * f.scale,
          y: f.y + p.y * f.scale,
          hx: p.hx,
          hy: p.hy,
          distance: distance + p.distance * f.scale,
          life,
        }),
      owns && ((p) => owns(life, p)),
    );
    distance += result.distance * f.scale;
    if (result.end) return { points, end: distance };
    if (!result.edge || distance >= reach) break;
    let next: { life: TileLife; cursor: Mover } | undefined;
    for (const candidate of lives) {
      if (candidate === life || (!owns && candidate.tile.z !== life.tile.z)) continue;
      const map = frameBetween(life.tile, candidate.tile);
      const x = map.x + result.cursor.x * map.scale,
        y = map.y + result.cursor.y * map.scale;
      if (x < -0.01 || y < -0.01 || x > EXTENT + 0.01 || y > EXTENT + 0.01) continue;
      const projected =
        candidate.tile.z === life.tile.z
          ? candidate.projectRail({ ...result.cursor, x, y })
          : candidate.projectFrom(result.cursor, life, { snapM: TRAIN.handover });
      if (projected && (!owns || owns(candidate, projected))) {
        next = { life: candidate, cursor: projected };
        break;
      }
    }
    if (!next) break; // An unloaded edge is not a real terminus.
    const key = `${next.life.tile.z}/${next.life.tile.x}/${next.life.tile.y}/${next.cursor.line}/${next.cursor.dir}/${Math.round(next.cursor.d)}`;
    if (visited.has(key)) break;
    visited.add(key);
    life = next.life;
    cursor = next.cursor;
  }
  return { points };
}

/** Pure prepass: all leaders, including dwelling trains, are measured before anyone moves. */
export function trainLimits(
  lives: readonly TileLife[],
  dt: number,
  owns?: (life: TileLife, p: { x: number; y: number }) => boolean,
  inspecting?: object,
): Map<Mover, TrainLimit> {
  const trains = lives.flatMap((life) =>
    life.movers
      .filter((m) => m.train && !m.train.edge && (!owns || owns(life, m)))
      .map((m) => ({ life, m })),
  );
  const limits = new Map<Mover, TrainLimit>();
  for (const { life, m } of trains) {
    const pm = life.perMeter,
      brake = kinematicsOf('locomotive').brake * pm;
    const limit: TrainLimit = { target: m.speed, cap: Infinity, station: Infinity };
    limits.set(m, limit);
    if (inspecting === m || m.pause > 0 || m.train!.reverse) continue;
    const { points, end } = lookahead(
      life,
      m,
      owns ? [...lives].sort((a, b) => b.tile.z - a.tile.z) : lives,
      owns,
    );
    const constrain = (gap: number, lead = 0) => {
      limit.target = Math.min(limit.target, approach(gap, lead, brake));
      limit.cap = Math.min(limit.cap, Math.max(0, gap) / dt);
    };
    if (end !== undefined) constrain(end);
    const start = points[0];
    if (!start) continue;
    if (
      Math.hypot(start.x - m.train!.stopX, start.y - m.train!.stopY) >= TRAIN.stationGap * pm ||
      !Number.isFinite(m.train!.stopX)
    ) {
      const stationLives = new Set(points.map((p) => p.life));
      for (const stationLife of stationLives) {
        const f = frameBetween(stationLife.tile, life.tile);
        const stations = stationLife.geo.stations;
        for (let k = 0; k < stations.length; k += 2) {
          if (owns && !owns(stationLife, { x: stations[k]!, y: stations[k + 1]! })) continue;
          const x = f.x + stations[k]! * f.scale,
            y = f.y + stations[k + 1]! * f.scale;
          let closest = Infinity,
            at = Infinity;
          for (let i = 1; i < points.length; i++) {
            const a = points[i - 1]!,
              b = points[i]!;
            const dx = b.x - a.x,
              dy = b.y - a.y,
              length2 = dx * dx + dy * dy;
            if (!length2) continue;
            const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length2));
            const d = Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
            if (d < closest) {
              closest = d;
              at = a.distance + t * (b.distance - a.distance);
            }
          }
          if (closest <= TRAIN.stationReach * pm && at < limit.station) limit.station = at;
        }
      }
    }
    if (Number.isFinite(limit.station)) constrain(limit.station);
    for (const other of trains) {
      if (other.m === m) continue;
      const f = frameBetween(other.life.tile, life.tile);
      const body = cutTrail(
        [other.m.x, other.m.y, ...other.m.train!.trail],
        trainLength(other.m.train!.cars) * other.life.perMeter,
      );
      const coords = body.map((v, i) => (i % 2 ? f.y : f.x) + v * f.scale);
      const tolerance = TRAIN_FOLLOW.tolerance * pm;
      const xs = coords.filter((_, i) => i % 2 === 0),
        ys = coords.filter((_, i) => i % 2 === 1);
      const minX = Math.min(...xs) - tolerance,
        maxX = Math.max(...xs) + tolerance;
      const minY = Math.min(...ys) - tolerance,
        maxY = Math.max(...ys) + tolerance;
      for (const p of points) {
        if (
          p.hx * other.m.hx + p.hy * other.m.hy <= 0 ||
          p.x < minX ||
          p.x > maxX ||
          p.y < minY ||
          p.y > maxY
        )
          continue;
        let hit = false;
        for (let i = 0; i + 3 < coords.length; i += 2) {
          const x = coords[i]!,
            y = coords[i + 1]!,
            dx = coords[i + 2]! - x,
            dy = coords[i + 3]! - y;
          const t = Math.max(
            0,
            Math.min(1, ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy || 1)),
          );
          if (Math.hypot(p.x - x - t * dx, p.y - y - t * dy) <= tolerance) {
            hit = true;
            break;
          }
        }
        if (hit) {
          constrain(
            p.distance - (TRAIN_FOLLOW.minGap + TRAIN_FOLLOW.tolerance) * pm,
            (inspecting === other.m || other.m.pause > 0 || other.m.train!.reverse
              ? 0
              : (other.m.v ?? other.m.speed)) * f.scale,
          );
          break;
        }
      }
    }
  }
  return limits;
}

/** The nearest `points` (x, y pairs) comes to `x`, `y`. */
function polylineDistance(points: readonly number[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const ax = points[i]!,
      ay = points[i + 1]!,
      dx = points[i + 2]! - ax,
      dy = points[i + 3]! - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/** How far along a train's path (`lookahead`) it runs over `x`, `y`; Infinity if it doesn't. */
function pathDistance(points: readonly Sample[], x: number, y: number, reach: number): number {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const t = Math.max(
      0,
      Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)),
    );
    if (Math.hypot(x - a.x - t * dx, y - a.y - t * dy) <= reach)
      return a.distance + t * (b.distance - a.distance);
  }
  return Infinity;
}

/**
 * Pure prepass, like `trainLimits`: open or close every crossing for this frame, from where the
 * trains are now and nothing remembered, so a crossing with no train near it is always open. Trains
 * in neighbouring tiles count; a tile without crossings pays for nothing.
 */
export function crossingStates(
  lives: readonly TileLife[],
  owns?: (life: TileLife, p: { x: number; y: number }) => boolean,
  inspecting?: object,
): void {
  const guarded = lives.filter((life) => life.railCrossings.crossings.length);
  if (!guarded.length) return;
  for (const life of guarded)
    for (const crossing of life.railCrossings.crossings) crossing.closed = crossing.firm = false;
  const ordered = owns ? [...lives].sort((a, b) => b.tile.z - a.tile.z) : lives;
  for (const life of lives) {
    for (const m of life.movers) {
      // A train at its copy's edge waits there hidden; its other copy is the real one.
      if (!m.train || m.train.edge || (owns && !owns(life, m))) continue;
      const pm = life.perMeter;
      const standing = inspecting === m || m.pause > 0 || m.train.reverse;
      const speed = standing ? 0 : (m.v ?? m.speed) / pm;
      const length = trainLength(m.train.cars);
      const warn = RAIL_CROSSING.warnSeconds * speed;
      const reach = Math.max(warn, length) + RAIL_CROSSING.bodyReach;
      let body: number[] | undefined;
      let path: Sample[] | undefined;
      for (const guardedLife of guarded) {
        const f = metricFrame(life, guardedLife);
        const headX = f.x + (m.x / pm) * f.scale,
          headY = f.y + (m.y / pm) * f.scale;
        const back = metricFrame(guardedLife, life);
        for (const crossing of guardedLife.railCrossings.crossings) {
          if (crossing.firm) continue;
          const cx = crossing.x / guardedLife.perMeter,
            cy = crossing.y / guardedLife.perMeter;
          const dx = cx - headX,
            dy = cy - headY;
          if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
          // The crossing, in meters of the train's own frame.
          const x = back.x + cx * back.scale,
            y = back.y + cy * back.scale;
          body ??= cutTrail([m.x, m.y, ...m.train.trail], length * pm).map((v) => v / pm);
          if (polylineDistance(body, x, y) <= RAIL_CROSSING.bodyReach) {
            crossing.closed = crossing.firm = true;
            continue;
          }
          if (speed <= 0 || dx * dx + dy * dy > warn * warn) continue;
          if (dx * m.hx + dy * m.hy <= 0) continue;
          path ??= lookahead(life, m, ordered, owns).points;
          const seconds =
            pathDistance(path, x * pm, y * pm, RAIL_CROSSING.pathReach * pm) / pm / speed;
          if (seconds > RAIL_CROSSING.warnSeconds) continue;
          crossing.closed = true;
          if (seconds <= RAIL_CROSSING.firmSeconds) crossing.firm = true;
        }
      }
    }
  }
}
