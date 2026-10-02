import { localMetricProjection } from './flat-geometry';
import type { SeasonalAccessRecord, SeasonalPoint } from './seasonal-record';

/** Rounded paving envelope, shared by tile coverage, clearance and fixture packing. */
export function seasonalAccessRing(
  r: Pick<SeasonalAccessRecord, 'from' | 'to' | 'width_m'>,
): SeasonalPoint[] {
  const { to, from } = localMetricProjection(r.from);
  const end = to(r.to);
  const angle = Math.atan2(end[1], end[0]);
  const radius = r.width_m / 2;
  const ring: SeasonalPoint[] = [];
  for (const [center, start] of [
    [end, angle - Math.PI / 2],
    [[0, 0], angle + Math.PI / 2],
  ] as const)
    for (let i = 0; i <= 8; i++) {
      const a = start + (Math.PI * i) / 8;
      ring.push(from([center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]));
    }
  ring.push([...ring[0]!]);
  return ring;
}
