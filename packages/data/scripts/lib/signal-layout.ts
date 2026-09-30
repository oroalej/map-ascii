import { SignalLayout, type SignalArm } from '@atlas/shared';
import type { Position } from 'geojson';
import type { AtlasFeature } from '../03-normalize';
import { signalStop, type RoadArm, type RoadVertex } from './streets';

const key = (p: Position) => p.join(',');
const position = (p: Position): [number, number] => [p[0]!, p[1]!];
const angle = (a: number, b: number) => {
  const d = Math.abs((a % 180) - (b % 180));
  return Math.min(d, 180 - d);
};

/** Explicitly linked vertices must be connected without crossing an unlisted junction. */
export function resolveSignalLayout(
  signal: AtlasFeature,
  vertices: ReadonlyMap<string, RoadVertex>,
  linked: readonly Position[] = [],
): SignalLayout | undefined {
  if (signal.geometry.type !== 'Point') return;
  const center = signal.geometry.coordinates;
  const points = [center, ...linked];
  const members = new Set(points.map(key));
  if (members.size !== points.length) throw new Error('Duplicate signal junction membership');
  for (const p of points) {
    if ((vertices.get(key(p))?.arms.length ?? 0) < 3) {
      if (!linked.length) return; // Existing mid-block signals retain their legacy behavior.
      throw new Error(`Signal junction is not a shared road vertex: ${key(p)}`);
    }
  }
  const edges = new Map<string, Set<string>>();
  function internal(p: Position, arm: RoadArm) {
    const lines =
      arm.road.geometry.type === 'LineString'
        ? [arm.road.geometry.coordinates]
        : arm.road.geometry.type === 'MultiLineString'
          ? arm.road.geometry.coordinates
          : [];
    const step = arm.forward ? 1 : -1;
    for (const line of lines) {
      const start = line.findIndex(
        (q, i) => key(q) === key(p) && line[i + step] && key(line[i + step]!) === key(arm.toward),
      );
      if (start < 0) continue;
      for (let i = start + step; i >= 0 && i < line.length; i += step) {
        const k = key(line[i]!);
        if (members.has(k)) {
          const neighbors = edges.get(key(p)) ?? new Set<string>();
          neighbors.add(k);
          edges.set(key(p), neighbors);
          return true;
        }
        if ((vertices.get(k)?.arms.length ?? 0) >= 3) break;
      }
    }
    return false;
  }
  const arms: SignalArm[] = [];
  for (const p of points)
    for (const arm of vertices.get(key(p))!.arms) {
      if (internal(p, arm)) continue;
      const direction = arm.forward ? -1 : 1;
      const flow = arm.road.properties.oneway ?? 0;
      const dx = (p[0]! - arm.toward[0]!) * Math.cos((p[1]! * Math.PI) / 180);
      const dy = p[1]! - arm.toward[1]!;
      const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
      const stop = signalStop(p, arm, signal.properties.signal_radius! + 1.5);
      arms.push({
        road_id: arm.road.properties.id,
        junction: position(p),
        toward: position(arm.toward),
        direction,
        inbound: !flow || flow === direction,
        outbound: !flow || flow === -direction,
        bearing,
        width:
          arm.road.properties.width ??
          { road_major: 14, road_mid: 10, road_minor: 6 }[
            arm.road.properties.class as 'road_major'
          ] ??
          6,
        group:
          angle(bearing, signal.properties.signal_a!) <= angle(bearing, signal.properties.signal_b!)
            ? 'a'
            : 'b',
        ...(stop ? { stop: stop.position, stop_width: stop.width } : {}),
      });
    }
  const visited = new Set<string>();
  const pending = [key(center)];
  while (pending.length) {
    const k = pending.pop()!;
    if (visited.has(k)) continue;
    visited.add(k);
    pending.push(...(edges.get(k) ?? []));
  }
  if (visited.size !== members.size) throw new Error('Disconnected linked signal junctions');
  return SignalLayout.parse({ members: points.map(position), arms });
}
