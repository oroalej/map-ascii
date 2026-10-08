import type { StreetFixture } from './fixtures';
import type { LifeTap } from './tap';

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
