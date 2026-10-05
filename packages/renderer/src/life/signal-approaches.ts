import type { SignalArm, SignalLayout } from '@atlas/shared';
import { hashString, lngLatToTile } from '../raster/geometry';
import type { TileId } from '../tiles';
import { TILE_QUANTIZATION_TOLERANCE, type LifeGeometry } from './geometry';

export type SignalApproach = {
  arm: SignalArm;
  line: number;
  vertex: number;
  x: number;
  y: number;
  /** Outward unit vector and direction on the original road. */
  hx: number;
  hy: number;
  out: 1 | -1;
  along: number;
  stopAlong?: number;
};
export const signalJunctionKey = (layout: SignalLayout) => `signal:${layout.members[0]!.join(',')}`;

/** Match stable way IDs and shared vertices, tolerating only vector-tile quantization. */
export function signalApproaches(
  tile: TileId,
  geo: LifeGeometry,
  layout: SignalLayout,
  along: Float64Array,
): SignalApproach[] {
  const result: SignalApproach[] = [];
  for (const arm of layout.arms) {
    const id = hashString(arm.road_id),
      p = lngLatToTile(tile, ...arm.junction);
    const out = -arm.direction as 1 | -1;
    for (let line = 0; line < geo.kinds.length; line++) {
      if (geo.lineIds?.[line] !== id) continue;
      for (let v = geo.starts[line]!; v < geo.starts[line + 1]!; v++) {
        const next = v + out;
        if (next < geo.starts[line]! || next >= geo.starts[line + 1]!) continue;
        const x = geo.coords[2 * v]!,
          y = geo.coords[2 * v + 1]!;
        if (Math.hypot(x - p.x, y - p.y) > TILE_QUANTIZATION_TOLERANCE) continue;
        const dx = geo.coords[2 * next]! - x,
          dy = geo.coords[2 * next + 1]! - y;
        const length = Math.hypot(dx, dy);
        if (!length) continue;
        const hx = dx / length,
          hy = dy / length;
        const stop = arm.stop && lngLatToTile(tile, ...arm.stop);
        result.push({
          arm,
          line,
          vertex: v,
          x,
          y,
          hx,
          hy,
          out,
          along: along[v]!,
          stopAlong: stop ? along[v]! + out * ((stop.x - x) * hx + (stop.y - y) * hy) : undefined,
        });
      }
    }
  }
  return result;
}
