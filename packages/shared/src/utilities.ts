/** Versioned illustrative utility data. Runtime helpers deliberately have no Zod dependency. */
import { MERCATOR_METERS, type TileAddress } from './tile-space';
export {
  TILE_EXTENT as UTILITY_EXTENT,
  MERCATOR_METERS as UTILITY_MERCATOR_METERS,
  metersPerUnit as utilityTileMeters,
  tileToLngLat as utilityTilePoint,
} from './tile-space';
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

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const point = (value: unknown): value is UtilityPoint =>
  Array.isArray(value) && value.length === 2 && value.every(finite);
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const direction = (value: unknown): value is UtilityPoint =>
  point(value) && Math.abs(Math.hypot(...value) - 1) < 0.001;
function isUtilityPole(value: unknown): value is UtilityPole {
  return (
    object(value) &&
    keys(
      value,
      ['id', 'road', 'component', 'at', 'heading', 'normal', 'transformer'],
      ['sharedLamp', 'partner'],
    ) &&
    text(value.id) &&
    text(value.road) &&
    text(value.component) &&
    point(value.at) &&
    Math.abs(value.at[0]) <= 180 &&
    Math.abs(value.at[1]) <= 85.051129 &&
    direction(value.heading) &&
    direction(value.normal) &&
    typeof value.transformer === 'boolean' &&
    (value.sharedLamp === undefined || text(value.sharedLamp)) &&
    (value.partner === undefined || text(value.partner))
  );
}

/** Runtime counterpart of UtilityRecordSchema; no schema evaluation in the tile worker. */
export function isUtilityRecord(value: unknown): value is UtilityRecord {
  if (!object(value) || value.version !== 1) return false;
  if (value.kind === 'pole')
    return keys(value, ['version', 'kind', 'pole']) && isUtilityPole(value.pole);
  if (value.kind !== 'span' || !keys(value, ['version', 'kind', 'span'])) return false;
  const span = value.span;
  return (
    object(span) &&
    keys(span, ['id', 'kind', 'from', 'to', 'seed']) &&
    text(span.id) &&
    (span.kind === 'corridor' || span.kind === 'crossing' || span.kind === 'junction') &&
    isUtilityPole(span.from) &&
    isUtilityPole(span.to) &&
    span.from.id !== span.to.id &&
    finite(span.seed) &&
    Number.isInteger(span.seed) &&
    span.seed >= 0 &&
    span.seed <= 0xffffffff
  );
}

/** Bad or newer optional records must not prevent the ordinary tile from drawing. */
export function parseUtilityRecord(value: unknown): UtilityRecord | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const record: unknown = JSON.parse(value);
    return isUtilityRecord(record) ? record : undefined;
  } catch {
    return undefined;
  }
}

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

export type UtilityTile = TileAddress;
export const lampSupportKey = (t: UtilityTile, x: number, y: number): string =>
  `${t.z}/${t.x}/${t.y}:${Math.fround(x)},${Math.fround(y)}`;
export function offsetUtility(at: UtilityPoint, east: number, north: number): UtilityPoint {
  const unit = MERCATOR_METERS / 360;
  return [at[0] + east / (unit * Math.cos((at[1] * Math.PI) / 180)), at[1] + north / unit];
}
