import type { Position } from 'geojson';
import type { RoadArm, RoadVertex } from './streets';
import { delta, key, lines } from './road-geometry';

export const armKey = (p: Position, arm: RoadArm) =>
  JSON.stringify([arm.road.properties.id, p, arm.forward ? 1 : -1]);

/** The whole owned arm, stopping at the next shared junction, not the first bend. */
export function armPath(p: Position, arm: RoadArm, vertices: ReadonlyMap<string, RoadVertex>) {
  const points: Position[] = [p],
    segments: { road: RoadArm['road']; line: Position[]; forward: boolean }[] = [],
    visited = new Set<string>();
  let current = arm,
    at = p;
  const flow = (a: RoadArm) => (a.road.properties.oneway ?? 0) * (a.forward ? 1 : -1);
  while (!visited.has(armKey(at, current))) {
    visited.add(armKey(at, current));
    const step = current.forward ? 1 : -1;
    let line: Position[] | undefined,
      start = -1;
    for (const candidate of lines(current.road)) {
      start = candidate.findIndex(
        (q, i) =>
          key(q) === key(at) &&
          candidate[i + step] &&
          key(candidate[i + step]!) === key(current.toward),
      );
      if (start >= 0) {
        line = candidate;
        break;
      }
    }
    if (!line) break;
    for (let i = start + step; i >= 0 && i < line.length; i += step) {
      points.push(line[i]!);
      segments.push({ road: current.road, line, forward: current.forward });
      if ((vertices.get(key(line[i]!))?.arms.length ?? 0) >= 3) break;
    }
    const end = points.at(-1)!,
      previous = points.at(-2)!;
    const joint = vertices.get(key(end));
    if (joint?.arms.length !== 2) break;
    const next = joint.arms.find((a) => key(a.toward) !== key(previous));
    if (
      !next ||
      next.road.properties.class !== arm.road.properties.class ||
      flow(next) !== flow(arm)
    )
      break;
    at = end;
    current = next;
  }
  if (segments.length)
    return {
      points,
      segments,
      length: points.slice(1).reduce((d, q, i) => d + Math.hypot(...delta(points[i]!, q)), 0),
    };
}

export function pathPoint(points: readonly Position[], distance: number) {
  let remaining = distance;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    const [x, y] = delta(a, b),
      length = Math.hypot(x, y);
    if (!length) continue;
    if (remaining <= length) {
      const t = remaining / length;
      return {
        segment: i - 1,
        position: [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t] as [number, number],
        bearing: ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360,
      };
    }
    remaining -= length;
  }
}

export function pathDistance(points: readonly Position[], p: Position): number | undefined {
  let along = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    const [x, y] = delta(a, b),
      [px, py] = delta(a, p),
      length = Math.hypot(x, y);
    if (!length) continue;
    const t = (px * x + py * y) / (length * length);
    if (t >= -1e-8 && t <= 1 + 1e-8 && Math.hypot(px - t * x, py - t * y) < 0.01)
      return along + Math.max(0, Math.min(1, t)) * length;
    along += length;
  }
}
