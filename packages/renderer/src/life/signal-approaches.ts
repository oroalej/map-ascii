import type { SignalArm, SignalLayout } from '@atlas/shared';
import { hashString, lngLatToTile, metersPerUnit } from '../raster/geometry';
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
  includeRemoteStops = false,
): SignalApproach[] {
  const result: SignalApproach[] = [];
  const perMeter = 1 / metersPerUnit(tile);
  for (const arm of layout.arms) {
    const id = hashString(arm.road_id),
      p = lngLatToTile(tile, ...arm.junction);
    const out = -arm.direction as 1 | -1;
    const painted = arm.stop && lngLatToTile(tile, ...arm.stop);
    const theta = ((arm.stop_bearing ?? arm.bearing) * Math.PI) / 180;
    const offset = ((arm.width - (arm.stop_width ?? arm.width)) / 2) * perMeter;
    const stop = painted && {
      x: painted.x - Math.cos(theta) * offset,
      y: painted.y - Math.sin(theta) * offset,
    };
    for (let line = 0; line < geo.kinds.length; line++) {
      if (geo.lineIds?.[line] !== id) continue;
      let matched = false;
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
        let stopAlong: number | undefined;
        for (
          let index = v;
          stop && index + out >= geo.starts[line]! && index + out < geo.starts[line + 1]!;
          index += out
        ) {
          const nextIndex = index + out;
          const ax = geo.coords[index * 2]!,
            ay = geo.coords[index * 2 + 1]!;
          const sx = geo.coords[nextIndex * 2]! - ax,
            sy = geo.coords[nextIndex * 2 + 1]! - ay;
          const len = Math.hypot(sx, sy);
          if (!len) continue;
          const t = Math.max(
            0,
            Math.min(1, ((stop.x - ax) * sx + (stop.y - ay) * sy) / (len * len)),
          );
          if (
            Math.hypot(stop.x - ax - t * sx, stop.y - ay - t * sy) <= TILE_QUANTIZATION_TOLERANCE
          ) {
            stopAlong = along[index]! + out * len * t;
            break;
          }
        }
        matched = true;
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
          stopAlong,
        });
      }
      // A crossing-carried controller can have its junction outside the buffered tile.
      // Match only its exact stop, never manufacture a radius stop or a local junction.
      if (!matched && includeRemoteStops && stop)
        for (let v = geo.starts[line]!; v + 1 < geo.starts[line + 1]!; v++) {
          const ax = geo.coords[v * 2]!,
            ay = geo.coords[v * 2 + 1]!;
          const dx = geo.coords[(v + 1) * 2]! - ax,
            dy = geo.coords[(v + 1) * 2 + 1]! - ay,
            length = Math.hypot(dx, dy);
          if (!length || (dx * out * -Math.sin(theta) + dy * out * Math.cos(theta)) / length < 0.7)
            continue;
          const t = Math.max(
            0,
            Math.min(1, ((stop.x - ax) * dx + (stop.y - ay) * dy) / (length * length)),
          );
          if (Math.hypot(stop.x - ax - t * dx, stop.y - ay - t * dy) > TILE_QUANTIZATION_TOLERANCE)
            continue;
          result.push({
            arm,
            line,
            vertex: v,
            x: p.x,
            y: p.y,
            hx: (dx * out) / length,
            hy: (dy * out) / length,
            out,
            along: along[v]!,
            stopAlong: along[v]! + length * t,
          });
          break;
        }
    }
  }
  return result;
}
