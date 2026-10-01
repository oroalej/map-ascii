/** Pipeline-baked bunting. Geographic endpoints survive tile clipping unchanged. */
export type SeasonalPoint = [number, number];
export type SeasonalRecord = {
  version: 1;
  kind: 'bunting';
  id: string;
  season: string;
  corridor: string;
  road: string;
  from: SeasonalPoint;
  to: SeasonalPoint;
  /** The trimmed source segment: only its sparse rows are replaced. */
  segment: [SeasonalPoint, SeasonalPoint];
  seed: number;
};

const fields = new Set([
  'version',
  'kind',
  'id',
  'season',
  'corridor',
  'road',
  'from',
  'to',
  'segment',
  'seed',
]);
const point = (value: unknown): value is SeasonalPoint =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === 'number' &&
  Number.isFinite(value[0]) &&
  Math.abs(value[0]) <= 180 &&
  typeof value[1] === 'number' &&
  Number.isFinite(value[1]) &&
  Math.abs(value[1]) <= 85.051129;
const text = (value: unknown) => typeof value === 'string' && value.length > 0;

/** A corrupt/newer optional decoration must not stop the ordinary map from drawing. */
export function isSeasonalRecord(value: unknown): value is SeasonalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === fields.size &&
    Object.keys(v).every((k) => fields.has(k)) &&
    v.version === 1 &&
    v.kind === 'bunting' &&
    text(v.id) &&
    text(v.season) &&
    text(v.corridor) &&
    typeof v.road === 'string' &&
    /^osm:way\/\d+$/.test(v.road) &&
    point(v.from) &&
    point(v.to) &&
    (v.from[0] !== v.to[0] || v.from[1] !== v.to[1]) &&
    Array.isArray(v.segment) &&
    v.segment.length === 2 &&
    point(v.segment[0]) &&
    point(v.segment[1]) &&
    (v.segment[0][0] !== v.segment[1][0] || v.segment[0][1] !== v.segment[1][1]) &&
    typeof v.seed === 'number' &&
    Number.isInteger(v.seed) &&
    v.seed >= 0 &&
    v.seed <= 0xffffffff
  );
}

export function parseSeasonalRecord(value: unknown): SeasonalRecord | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const record: unknown = JSON.parse(value);
    return isSeasonalRecord(record) ? record : undefined;
  } catch {
    return undefined;
  }
}
