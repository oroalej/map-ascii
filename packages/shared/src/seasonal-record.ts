/** Pipeline-baked bunting. Geographic endpoints survive tile clipping unchanged. */
import { localMetricProjection, LEGACY_LOCAL_METERS_PER_DEGREE } from './flat-geometry';
import { utilitySeed } from './utilities';
export type SeasonalPoint = [number, number];
export type SeasonalBuntingRecord = {
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

/**
 * One corridor edge's evenly spaced hanging rows, as shipped in tiles: decoding expands it
 * into `bunting` rows (`expandBuntingRun`), so a dense corridor costs one record per edge.
 */
export type SeasonalBuntingRunRecord = {
  version: 1;
  kind: 'bunting-run';
  id: string;
  season: string;
  corridor: string;
  road: string;
  /** The trimmed source segment, oriented along the corridor's row order. */
  segment: [SeasonalPoint, SeasonalPoint];
  /** First row's distance from `segment[0]`, row spacing, and rows, m. */
  start_m: number;
  spacing_m: number;
  count: number;
  /** Each row hangs this far either side of the segment, m. */
  reach_m: number;
  seed: number;
};
/** Rows of a run, curb to curb across its segment, each with its own identity and seed. */
export function expandBuntingRun(run: SeasonalBuntingRunRecord): SeasonalBuntingRecord[] {
  const frame = localMetricProjection(run.segment[0], {
    east: LEGACY_LOCAL_METERS_PER_DEGREE,
    north: LEGACY_LOCAL_METERS_PER_DEGREE,
  });
  const [ex, ey] = frame.to(run.segment[1]),
    length = Math.hypot(ex, ey);
  if (!length) return [];
  const nx = -ey / length,
    ny = ex / length;
  const rows: SeasonalBuntingRecord[] = [];
  for (let k = 0; k < run.count; k++) {
    const u = (run.start_m + k * run.spacing_m) / length,
      x = ex * u,
      y = ey * u;
    const id = `${run.id}/${k}`;
    rows.push({
      version: 1,
      kind: 'bunting',
      id,
      season: run.season,
      corridor: run.corridor,
      road: run.road,
      from: frame.from([x - nx * run.reach_m, y - ny * run.reach_m]),
      to: frame.from([x + nx * run.reach_m, y + ny * run.reach_m]),
      segment: run.segment,
      seed: utilitySeed(id),
    });
  }
  return rows;
}
const runFields = new Set([
  'version',
  'kind',
  'id',
  'season',
  'corridor',
  'road',
  'segment',
  'start_m',
  'spacing_m',
  'count',
  'reach_m',
  'seed',
]);
export function isSeasonalBuntingRun(value: unknown): value is SeasonalBuntingRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const finite = (n: unknown, lo: number, hi: number) =>
    typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
  const segment: unknown = v.segment;
  const position = (p: unknown): p is SeasonalPoint =>
    Array.isArray(p) && p.length === 2 && finite(p[0], -180, 180) && finite(p[1], -90, 90);
  return (
    Object.keys(v).length === runFields.size &&
    Object.keys(v).every((k) => runFields.has(k)) &&
    v.version === 1 &&
    v.kind === 'bunting-run' &&
    typeof v.id === 'string' &&
    !!v.id &&
    typeof v.season === 'string' &&
    !!v.season &&
    typeof v.corridor === 'string' &&
    !!v.corridor &&
    typeof v.road === 'string' &&
    /^osm:way\/\d+$/.test(v.road) &&
    Array.isArray(segment) &&
    segment.length === 2 &&
    position(segment[0]) &&
    position(segment[1]) &&
    (segment[0][0] !== segment[1][0] || segment[0][1] !== segment[1][1]) &&
    finite(v.start_m, 0, 80) &&
    finite(v.spacing_m, 3, 80) &&
    Number.isInteger(v.count) &&
    finite(v.count, 1, 10000) &&
    finite(v.reach_m, 0.5, 40) &&
    Number.isInteger(v.seed) &&
    finite(v.seed, 0, 0xffffffff)
  );
}
/** A tile's seasonal record: ordinary records as they are, bunting runs as their rows. */
export function parseSeasonalTileRecord(value: unknown): readonly SeasonalRecord[] {
  if (typeof value !== 'string') return [];
  try {
    const record: unknown = JSON.parse(value);
    if (isSeasonalBuntingRun(record)) return expandBuntingRun(record);
    return isSeasonalRecord(record) ? [record] : [];
  } catch {
    return [];
  }
}

type SeasonalInstallationRecord = {
  version: 1;
  id: string;
  season: string;
  installation: string;
  anchor: string;
  seed: number;
};
export type SeasonalDisplayRecord = SeasonalInstallationRecord & {
  kind: 'christmas-tree' | 'decorated-canopy';
  at: SeasonalPoint;
  radius_m: number;
};
export type SeasonalLightStringRecord = SeasonalInstallationRecord & {
  kind: 'light-string';
  from: SeasonalPoint;
  to: SeasonalPoint;
  /** Explicit mounting; omitted records retain ordinary ground-string occlusion. */
  mount?: 'building' | 'canopy';
  /** Omitted fields preserve the original sparse ornament pattern. */
  bulb_spacing_m?: number;
  palette?: 'warm' | 'christmas';
};
/** Walkable seasonal paving; each complete segment keeps its real metric width. */
export type SeasonalAccessRecord = SeasonalInstallationRecord & {
  kind: 'access-path';
  style: 'walkway' | 'driveway' | 'parking';
  from: SeasonalPoint;
  to: SeasonalPoint;
  width_m: number;
};
export const CARNIVAL_STYLES = [
  'midway',
  'carousel',
  'ferris-wheel',
  'bumper-cars',
  'booth',
] as const;
export type CarnivalComponent = {
  id: string;
  style: (typeof CARNIVAL_STYLES)[number];
  at: SeasonalPoint;
  /** Width and length in meters; angle is counterclockwise from east. */
  size_m: [number, number];
  angle_deg: number;
};
export type SeasonalCarnivalRecord = SeasonalInstallationRecord &
  Omit<CarnivalComponent, 'id'> & {
    kind: 'carnival';
  };
export type SeasonalRecord =
  | SeasonalBuntingRecord
  | SeasonalDisplayRecord
  | SeasonalLightStringRecord
  | SeasonalAccessRecord
  | SeasonalCarnivalRecord;

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
  if (v.kind === 'carnival') {
    const keys = [
      'version',
      'kind',
      'id',
      'season',
      'installation',
      'anchor',
      'seed',
      'style',
      'at',
      'size_m',
      'angle_deg',
    ];
    const size = v.size_m;
    return (
      Object.keys(v).length === keys.length &&
      Object.keys(v).every((k) => keys.includes(k)) &&
      v.version === 1 &&
      text(v.id) &&
      text(v.season) &&
      text(v.installation) &&
      typeof v.anchor === 'string' &&
      /^osm:(node|way|relation)\/\d+$/.test(v.anchor) &&
      typeof v.seed === 'number' &&
      Number.isInteger(v.seed) &&
      v.seed >= 0 &&
      v.seed <= 0xffffffff &&
      typeof v.style === 'string' &&
      (CARNIVAL_STYLES as readonly string[]).includes(v.style) &&
      point(v.at) &&
      typeof v.angle_deg === 'number' &&
      Number.isFinite(v.angle_deg) &&
      Math.abs(v.angle_deg) <= 180 &&
      Array.isArray(size) &&
      size.length === 2 &&
      size.every(
        (n) =>
          typeof n === 'number' &&
          Number.isFinite(n) &&
          n >= 3 &&
          n <= (v.style === 'midway' ? 120 : 30),
      ) &&
      (v.style !== 'carousel' || size[0] === size[1])
    );
  }
  if (v.kind !== 'bunting') {
    const display = v.kind === 'christmas-tree' || v.kind === 'decorated-canopy';
    const access = v.kind === 'access-path';
    const keys = display
      ? ['version', 'kind', 'id', 'season', 'installation', 'anchor', 'seed', 'at', 'radius_m']
      : [
          'version',
          'kind',
          'id',
          'season',
          'installation',
          'anchor',
          'seed',
          'from',
          'to',
          ...(access ? ['style', 'width_m'] : []),
          ...(Object.hasOwn(v, 'mount') ? ['mount'] : []),
          ...(Object.hasOwn(v, 'bulb_spacing_m') ? ['bulb_spacing_m'] : []),
          ...(Object.hasOwn(v, 'palette') ? ['palette'] : []),
        ];
    return (
      (display || access || v.kind === 'light-string') &&
      (!access ||
        ((v.style === 'walkway' || v.style === 'driveway' || v.style === 'parking') &&
          typeof v.width_m === 'number' &&
          Number.isFinite(v.width_m) &&
          v.width_m >= (v.style === 'parking' ? 5.5 : 1) &&
          v.width_m <= 12 &&
          !Object.hasOwn(v, 'mount') &&
          !Object.hasOwn(v, 'bulb_spacing_m') &&
          !Object.hasOwn(v, 'palette'))) &&
      (display || !Object.hasOwn(v, 'mount') || v.mount === 'building' || v.mount === 'canopy') &&
      (display ||
        !Object.hasOwn(v, 'bulb_spacing_m') ||
        (typeof v.bulb_spacing_m === 'number' &&
          Number.isFinite(v.bulb_spacing_m) &&
          v.bulb_spacing_m >= 0.3 &&
          v.bulb_spacing_m <= 3)) &&
      (display ||
        !Object.hasOwn(v, 'palette') ||
        v.palette === 'warm' ||
        v.palette === 'christmas') &&
      Object.keys(v).length === keys.length &&
      Object.keys(v).every((k) => keys.includes(k)) &&
      v.version === 1 &&
      text(v.id) &&
      text(v.season) &&
      text(v.installation) &&
      typeof v.anchor === 'string' &&
      /^osm:(node|way|relation)\/\d+$/.test(v.anchor) &&
      typeof v.seed === 'number' &&
      Number.isInteger(v.seed) &&
      v.seed >= 0 &&
      v.seed <= 0xffffffff &&
      (display
        ? point(v.at) &&
          typeof v.radius_m === 'number' &&
          Number.isFinite(v.radius_m) &&
          v.radius_m >= 0.5 &&
          v.radius_m <= 20
        : point(v.from) && point(v.to) && (v.from[0] !== v.to[0] || v.from[1] !== v.to[1]))
    );
  }
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
