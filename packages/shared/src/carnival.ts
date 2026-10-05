import { offsetUtility } from './utilities';
import type { CarnivalComponent, SeasonalPoint } from './seasonal-record';

/** Complete world footprint, shared by tile coverage, clearance and Life obstacles. */
export function carnivalRing(c: Omit<CarnivalComponent, 'id'>): SeasonalPoint[] {
  const angle = (c.angle_deg * Math.PI) / 180;
  const local: SeasonalPoint[] =
    c.style === 'carousel'
      ? Array.from({ length: 32 }, (_, i) => [
          (Math.cos((i * Math.PI) / 16) * c.size_m[0]) / 2,
          (Math.sin((i * Math.PI) / 16) * c.size_m[1]) / 2,
        ])
      : [
          [-c.size_m[0] / 2, -c.size_m[1] / 2],
          [c.size_m[0] / 2, -c.size_m[1] / 2],
          [c.size_m[0] / 2, c.size_m[1] / 2],
          [-c.size_m[0] / 2, c.size_m[1] / 2],
        ];
  const ring = local.map(([x, y]) =>
    offsetUtility(
      c.at,
      x * Math.cos(angle) - y * Math.sin(angle),
      x * Math.sin(angle) + y * Math.cos(angle),
    ),
  );
  ring.push([...ring[0]!]);
  return ring;
}
