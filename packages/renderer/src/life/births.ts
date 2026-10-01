import { lngLatToTile } from '../raster/geometry';
import { bodyCorners, type Body } from './occupancy';
import type { LngLatBounds } from './procession';
import type { Mover, TileLife } from './simulate';

export type LifeViewContext = { bounds: LngLatBounds; spawnMarginM: number };
export type PendingSeed = { mover: Mover; at: number; entrance?: number };
export const BIRTHS = { attempts: 32, grace: 1, tileRate: 4, worldRate: 16, margin: 12 } as const;

export function viewRect(life: TileLife, view: LifeViewContext, margin: number) {
  const [w, s, e, n] = view.bounds;
  const a = lngLatToTile(life.tile, w, n),
    b = lngLatToTile(life.tile, e, s);
  return {
    x0: a.x / life.perMeter - margin,
    y0: a.y / life.perMeter - margin,
    x1: b.x / life.perMeter + margin,
    y1: b.y / life.perMeter + margin,
  };
}
/** Full groups/consists, not just their leading cursor, must be outside the protected view. */
export function outsideView(
  life: TileLife,
  bodies: readonly Body[],
  view: LifeViewContext,
  margin: number,
) {
  if (!bodies.length) return false;
  const r = viewRect(life, view, margin);
  return bodies.every((body) => {
    const p = bodyCorners(body);
    return (
      p.every((v) => v.x < r.x0) ||
      p.every((v) => v.x > r.x1) ||
      p.every((v) => v.y < r.y0) ||
      p.every((v) => v.y > r.y1)
    );
  });
}

/** Deterministic possible entrances along the original route. No seed stream is consumed. */
export function entryDistances(
  life: TileLife,
  m: Mover,
  view: LifeViewContext,
  radius: number,
): number[] {
  const r = viewRect(life, view, radius + 0.01),
    pm = life.perMeter;
  const c = life.geo.coords,
    start = life.geo.starts[m.line]!,
    last = life.geo.starts[m.line + 1]! - 1;
  const values: number[] = [];
  let along = 0;
  for (let v = start; v < last; v++) {
    const ax = c[v * 2]! / pm,
      ay = c[v * 2 + 1]! / pm;
    const dx = c[v * 2 + 2]! / pm - ax,
      dy = c[v * 2 + 3]! / pm - ay;
    const length = Math.hypot(dx, dy);
    const put = (t: number) => {
      if (t < 0 || t > 1) return;
      const x = ax + dx * t,
        y = ay + dy * t;
      if (x < r.x0 - 0.001 || x > r.x1 + 0.001 || y < r.y0 - 0.001 || y > r.y1 + 0.001) return;
      if (((r.x0 + r.x1) / 2 - x) * dx * m.dir + ((r.y0 + r.y1) / 2 - y) * dy * m.dir <= 0) return;
      values.push((along + t * length) * pm);
    };
    if (dx) {
      put((r.x0 - ax) / dx);
      put((r.x1 - ax) / dx);
    }
    if (dy) {
      put((r.y0 - ay) / dy);
      put((r.y1 - ay) / dy);
    }
    along += length;
  }
  // Mapped route endpoints are valid entrances even when the viewport contains the whole tile.
  values.push(
    m.dir === 1
      ? Math.min(along / 2, radius + 0.01) * pm
      : Math.max(along / 2, along - radius - 0.01) * pm,
  );
  return values;
}
