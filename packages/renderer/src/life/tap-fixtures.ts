import type { StreetFixture } from './fixtures';
import type { LifeTap } from './tap';
import { carnivalKey } from './carnival-boost';
import { carnivalRing } from '@atlas/shared';
import { pointInside } from './occupancy';

export function tapCarnivalFixture(
  fixtures: readonly StreetFixture[],
  point: readonly [number, number],
  toCell: (lng: number, lat: number) => [number, number],
): LifeTap['carnival'] {
  for (const f of fixtures) {
    if (
      f.kind !== 'season-installation' ||
      f.record.kind !== 'carnival' ||
      f.record.style === 'midway'
    )
      continue;
    const at = toCell(...point),
      ring = carnivalRing(f.record).map((p) => {
        const c = toCell(...p);
        return { x: c[0], y: c[1] };
      });
    if (pointInside({ x: at[0], y: at[1] }, [ring]))
      return { key: carnivalKey(f.record), at: f.record.at, record: f.record };
  }
}

/** Snapshot actual posed signal hardware rather than using the centre of an intersection. */
export function tapSignalFixture(
  fixtures: readonly StreetFixture[],
  point: readonly [number, number],
  toCell: (lng: number, lat: number) => [number, number],
): LifeTap['signal'] {
  let closest = 1.5,
    chosen: LifeTap['signal'];
  const p = toCell(...point);
  for (const f of fixtures) {
    if (f.kind !== 'signal' && f.kind !== 'pedestrian-signal') continue;
    for (const at of [f.base, f.tip]) {
      const c = toCell(...at),
        distance = Math.hypot(c[0] - p[0], c[1] - p[1]);
      if (distance > closest) continue;
      closest = distance;
      chosen = { seed: f.seed, midBlock: f.midBlock };
    }
  }
  return chosen;
}
