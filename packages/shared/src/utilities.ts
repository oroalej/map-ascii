/** Versioned illustrative utility data. Runtime helpers deliberately have no Zod dependency. */
export type UtilityPoint = [number, number];
export type UtilityPole = {
  id: string;
  road: string;
  component: string;
  at: UtilityPoint;
  /** Unit vectors in local ground metres, east/north. */
  heading: UtilityPoint;
  normal: UtilityPoint;
  transformer: boolean;
  sharedLamp?: string;
  /** Only drop poles have a partner; they never join the corridor chain. */
  partner?: string;
};
export type UtilitySpan = {
  id: string;
  kind: 'corridor' | 'crossing' | 'junction';
  from: UtilityPole;
  to: UtilityPole;
  seed: number;
};
export type UtilityRecord =
  { version: 1; kind: 'pole'; pole: UtilityPole } | { version: 1; kind: 'span'; span: UtilitySpan };

export const UTILITY = {
  spacing: 30,
  jitter: 6,
  setback: 8,
  lateral: [0.2, 1.1],
  sharedChance: 0.67,
  transformer: 0.12,
  crossingEvery: 4,
  crossingOffset: 12,
  maxSpan: 65,
  junctionLink: 35,
  /** Maximum reach beyond the indexed support/span geometry, including ornaments. */
  buffer: 4,
} as const;

export const utilityRecordId = (r: UtilityRecord): string =>
  r.kind === 'pole' ? r.pole.id : r.span.id;
export const utilitySpanId = (a: string, b: string): string =>
  `utility:span:${JSON.stringify([a, b].sort())}`;
export function utilitySeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
/** Independent named draws avoid changing existing choices when a new ornament is added. */
export const utilityRandom = (id: string, purpose: string): number =>
  utilitySeed(`${id}:${purpose}`) / 0x100000000;

export const UTILITY_EXTENT = 4096;
export const UTILITY_MERCATOR_METERS = 40_075_016.686;
export type UtilityTile = { z: number; x: number; y: number };
/** These operations match the renderer's legacy lamp projection exactly. */
export function utilityTileMeters({ z, y }: UtilityTile): number {
  const n = Math.PI - (2 * Math.PI * (y + 0.5)) / 2 ** z;
  return (UTILITY_MERCATOR_METERS * Math.cos(Math.atan(Math.sinh(n)))) / 2 ** z / UTILITY_EXTENT;
}
export function utilityTilePoint(
  { z, x, y }: UtilityTile,
  p: { x: number; y: number },
): UtilityPoint {
  const n = 2 ** z;
  const wx = (x + p.x / UTILITY_EXTENT) / n;
  const wy = (y + p.y / UTILITY_EXTENT) / n;
  return [wx * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180) / Math.PI];
}
export const lampSupportKey = (t: UtilityTile, x: number, y: number): string =>
  `${t.z}/${t.x}/${t.y}:${Math.fround(x)},${Math.fround(y)}`;
export function offsetUtility(at: UtilityPoint, east: number, north: number): UtilityPoint {
  const unit = UTILITY_MERCATOR_METERS / 360;
  return [at[0] + east / (unit * Math.cos((at[1] * Math.PI) / 180)), at[1] + north / unit];
}
