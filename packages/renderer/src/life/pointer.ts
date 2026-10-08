import { lngLatToTile } from '@atlas/shared';
import type { TileId } from '../tiles';
/** Geographic cursor gust; direction is east/south and radius is in physical metres. */
export type CursorGust = {
  lngLat: readonly [number, number];
  dir: readonly [number, number];
  strength: number;
  radiusM: number;
};
export type MetricGust = {
  x: number;
  y: number;
  radius: number;
  dir: CursorGust['dir'];
  strength: number;
};
export function metricGust(
  gust: CursorGust | undefined,
  tile: TileId,
  perMeter: number,
): MetricGust | undefined {
  if (!gust) return;
  return {
    ...lngLatToTile(tile, ...gust.lngLat),
    radius: gust.radiusM * perMeter,
    dir: gust.dir,
    strength: gust.strength,
  };
}
export function gustStrength(gust: MetricGust | undefined, x: number, y: number) {
  return gust && gust.radius > 0
    ? gust.strength * Math.max(0, 1 - Math.hypot(x - gust.x, y - gust.y) / gust.radius)
    : 0;
}
