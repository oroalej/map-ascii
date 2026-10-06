import type { Position } from 'geojson';
import type { RoadArm, RoadVertex } from './streets';
import { delta, key, lines } from './road-geometry';

export const armKey = (p: Position, arm: RoadArm) =>
  JSON.stringify([arm.road.properties.id, p, arm.forward ? 1 : -1]);

/** The whole owned arm, stopping at the next shared junction, not the first bend. */
export function armPath(p: Position, arm: RoadArm, vertices?: ReadonlyMap<string, RoadVertex>) {
  const step = arm.forward ? 1 : -1;
  for (const line of lines(arm.road)) {
    const start = line.findIndex(
      (q, i) => key(q) === key(p) && line[i + step] && key(line[i + step]!) === key(arm.toward),
    );
    if (start < 0) continue;
    const points = [line[start]!];
    for (let i = start + step; i >= 0 && i < line.length; i += step) {
      points.push(line[i]!);
      if ((vertices?.get(key(line[i]!))?.arms.length ?? 0) >= 3) break;
    }
    return {
      line,
      points,
      length: points.slice(1).reduce((d, q, i) => d + Math.hypot(...delta(points[i]!, q)), 0),
    };
  }
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
