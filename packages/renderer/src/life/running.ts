import { umbrellaShare, underUmbrella } from './config';
import type { Mover, Walker } from './simulate';

/**
 * Whether a group walks in the rain with no umbrella over any of them (a child walks under their
 * adult's). Rain only falls at full strength (wind.ts `rainFor`), where the rain's share of
 * umbrellas outweighs the sun's, so the sun's altitude doesn't change who is under one.
 */
export function exposed(group: readonly Walker[] | undefined, rain: number): boolean {
  if (!group?.length || rain <= 0) return false;
  const share = umbrellaShare(rain, 0);
  for (const w of group) if (underUmbrella(w, share)) return false;
  return true;
}

/**
 * A person's running speed, tile units per second: their own place in `range` (m/s), stable for
 * them and unrelated to whether they carry an umbrella, never slower than their walk.
 */
export function runPace(m: Mover, range: readonly [number, number], perMeter: number): number {
  const u = m.group?.[0]?.umbrella ?? 0;
  const t = (u * 7919.123) % 1;
  return Math.max(m.speed, (range[0] + (range[1] - range[0]) * t) * perMeter);
}
