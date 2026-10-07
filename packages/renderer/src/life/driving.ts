import { DRIVE } from './config';
import type { Mover } from './simulate';

export const RAIN_PACE_SALT = 7919.123;
export const RUSH_PACE_SALT = 3571.719;

/** Stable individual pace, independent of admission and route random streams. */
export function share(m: Mover, range: readonly [number, number], salt: number): number {
  const value = m.rank * salt;
  return range[0] + (range[1] - range[0]) * (value - Math.floor(value));
}

/** Cruise target in the mover's existing tile units per second. */
export function cruise(m: Mover, wet: boolean): number {
  if (m.kind !== 'vehicle' || !m.vehicle) return m.speed;
  return (
    m.speed *
    (wet
      ? share(m, DRIVE.rain.pace, RAIN_PACE_SALT)
      : (m.rush ?? 0) > 0
        ? share(m, DRIVE.rush.pace, RUSH_PACE_SALT)
        : 1)
  );
}
