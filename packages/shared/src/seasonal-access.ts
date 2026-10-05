import { localMetricProjection } from './flat-geometry';
import type { SeasonalAccessRecord, SeasonalPoint } from './seasonal-record';

/** Full paving envelope: square parking apron, rounded walking/drive segments. */
export function seasonalAccessRing(
  r: Pick<SeasonalAccessRecord, 'from' | 'to' | 'width_m'> &
    Partial<Pick<SeasonalAccessRecord, 'style'>>,
): SeasonalPoint[] {
  const { to, from } = localMetricProjection(r.from);
  const end = to(r.to);
  const angle = Math.atan2(end[1], end[0]);
  const radius = r.width_m / 2;
  if (r.style === 'parking') {
    const x = -Math.sin(angle) * radius,
      y = Math.cos(angle) * radius;
    const ring: SeasonalPoint[] = [
      [x, y],
      [end[0] + x, end[1] + y],
      [end[0] - x, end[1] - y],
      [-x, -y],
      [x, y],
    ];
    return ring.map(from);
  }
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
