import type { LngLat, SiteDetail, SiteStructure } from '@atlas/shared';
import { localFrame } from './geo';

/** Neutral plan-view silhouettes: body, glazing, roof and four wheels. No activity anchor. */
export function parkedVehicleParts(
  vehicle: SiteDetail['parked_vehicles'][number],
): SiteStructure[] {
  const frame = localFrame(vehicle.at);
  const angle = (vehicle.bearing * Math.PI) / 180;
  const bus = vehicle.kind === 'bus';
  const length = bus ? 10 : 4.4;
  const width = bus ? 2.5 : 1.8;
  const height = bus ? 3 : 1.5;
  const point = (x: number, y: number): LngLat =>
    frame.toLngLat([
      x * Math.cos(angle) + y * Math.sin(angle),
      -x * Math.sin(angle) + y * Math.cos(angle),
    ]);
  const part = (
    name: string,
    x: number,
    y: number,
    w: number,
    l: number,
    material: 'stone' | 'wood',
    h: number,
  ): SiteStructure => ({
    id: `parked-${vehicle.id}-${name}`,
    ring: [
      point(x - w / 2, y - l / 2),
      point(x + w / 2, y - l / 2),
      point(x + w / 2, y + l / 2),
      point(x - w / 2, y + l / 2),
      point(x - w / 2, y - l / 2),
    ],
    height_m: h,
    material,
    overhead: false,
  });
  const out = [
    part('body', 0, 0, width, length, 'stone', height),
    part('glazing', 0, 0, width * 0.83, length * 0.65, 'wood', height + 0.02),
    part('roof', 0, 0, width * 0.7, length * (bus ? 0.5 : 0.32), 'stone', height + 0.04),
  ];
  for (const x of [-width / 2, width / 2])
    for (const y of [-length * 0.3, length * 0.3])
      out.push(
        part(
          `wheel-${x < 0 ? 'left' : 'right'}-${y < 0 ? 'rear' : 'front'}`,
          x,
          y,
          0.25,
          bus ? 0.8 : 0.55,
          'wood',
          0.6,
        ),
      );
  return out;
}
