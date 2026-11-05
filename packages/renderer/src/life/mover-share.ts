import { DISTRICT, type Activity, type AgentKind } from './config';

/**
 * Whose hours someone keeps, fixed when they start, so nobody vanishes for walking into a quieter
 * area: a commercial `centre`'s, or the whole `city`'s. Absent, they live on residential streets.
 */
export type Belonging = 'centre' | 'city';

/** The share of people out where `owner` belongs; the city's own share without districts. */
export const peopleShare = (owner: { district?: Belonging | undefined }, levels: Activity) =>
  !levels.districts || owner.district === 'city'
    ? levels.person
    : owner.district === 'centre'
      ? levels.districts.centre
      : levels.districts.home;

/** The share of `m`'s kind out; people follow where they belong. */
export const moverShare = (
  m: { kind: AgentKind; district?: Belonging | undefined },
  levels: Activity,
) => (m.kind === 'person' ? peopleShare(m, levels) : levels[m.kind]);

/**
 * Whether someone starting at `x`, `y` belongs to a commercial centre, from the mapped shops
 * around them (a tile's `commerce`: x, y pairs in tile units, buffered, so a tile's edge doesn't
 * undercount).
 */
export function inCentre(
  x: number,
  y: number,
  commerce: Float32Array | undefined,
  perMeter: number,
): boolean {
  if (!commerce) return false;
  const reach = (DISTRICT.radiusM * perMeter) ** 2;
  let found = 0;
  for (let i = 0; i < commerce.length; i += 2) {
    const dx = commerce[i]! - x,
      dy = commerce[i + 1]! - y;
    if (dx * dx + dy * dy < reach && ++found >= DISTRICT.minShops) return true;
  }
  return false;
}
