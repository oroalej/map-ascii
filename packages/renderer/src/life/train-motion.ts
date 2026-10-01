import { EXTENT } from '../raster/geometry';
import { TRAIN, TRAIN_FOLLOW, kinematicsOf } from './config';
import { frameBetween } from './frames';
import { approach, type MotionLimit } from './motion';
import { cutTrail, trainLength, type Mover, type TileLife } from './simulate';
import type { Pose } from './curves';

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
    if (m.pause > 0 || m.train!.reverse) continue;
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
            (other.m.pause > 0 || other.m.train!.reverse ? 0 : (other.m.v ?? other.m.speed)) *
              f.scale,
          );
          break;
        }
      }
    }
  }
  return limits;
}
