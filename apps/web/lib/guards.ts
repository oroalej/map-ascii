/**
 * Shape checks for the generated files the browser loads. The pipeline validates each with its
 * zod schema when it writes it (steps 05 and 06), so these only catch a missing, stale, or
 * hand-edited file, and keep zod out of the browser bundle (ARCHITECTURE.md §8 initial JS).
 */
import {
  CAMERA_RANGES,
  type CameraState,
  type CityMeta,
  type CityProcessions,
  type SearchIndexFile,
  type SubdivisionArea,
} from '@atlas/shared';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNumbers = (v: unknown, length: number): v is number[] =>
  Array.isArray(v) && v.length === length && v.every(isNumber);
const isLocalized = (v: unknown) => isRecord(v) && isText(v.en) && Object.values(v).every(isText);

function isCamera(v: unknown): v is CameraState {
  if (!isRecord(v)) return false;
  return (Object.keys(CAMERA_RANGES) as (keyof CameraState)[]).every((field) => {
    const value = v[field];
    const [min, max] = CAMERA_RANGES[field];
    return isNumber(value) && value >= min && value <= max;
  });
}

export function isCityMeta(v: unknown): v is CityMeta {
  return (
    isRecord(v) &&
    isText(v.slug) &&
    isLocalized(v.name) &&
    isLocalized(v.subdivisionLabel) &&
    Array.isArray(v.languages) &&
    v.languages.every(isText) &&
    isNumbers(v.bounds, 4) &&
    isNumbers(v.regionBounds, 4) &&
    isCamera(v.defaultCamera) &&
    isNumbers(v.yearRange, 2) &&
    Array.isArray(v.attribution) &&
    v.attribution.every(isText)
  );
}

/** A city's `<slug>.processions.json` (step 07). */
const integer = (v: unknown, lo: number, hi: number) =>
  isNumber(v) && Number.isInteger(v) && v >= lo && v <= hi;
const point = (v: unknown): v is [number, number] =>
  isNumbers(v, 2) && Math.abs(v[0]!) <= 180 && Math.abs(v[1]!) <= 90;
const line = (v: unknown) => Array.isArray(v) && v.length >= 2 && v.every(point);
const ring = (v: unknown): v is [number, number][] =>
  Array.isArray(v) &&
  v.length >= 4 &&
  v.every(point) &&
  v[0]![0] === v.at(-1)![0] &&
  v[0]![1] === v.at(-1)![1];
const rings = (v: unknown) => Array.isArray(v) && v.every(ring);
const only = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k));
function eventFormation(p: Record<string, unknown>): boolean {
  if (p.formation === undefined) return true;
  if (!isRecord(p.formation) || p.kind === 'mass') return false;
  const limits: Record<string, [number, number]> =
    p.kind === 'fluvial'
      ? { columns: [1, 6], ranks: [1, 20], escorts: [0, 40] }
      : p.kind === 'procession'
        ? { bearers: [4, 24], ranks: [1, 20], marshals: [0, 12] }
        : { contingents: [1, 6], ranks: [1, 10], band: [0, 24], color_guard: [0, 8] };
  return Object.entries(p.formation).every(([k, v]) =>
    k === 'vehicles' && p.kind === 'parade'
      ? Array.isArray(v) &&
        v.length <= 4 &&
        v.every((x: unknown) => typeof x === 'string' && ['car', 'truck', 'motorcycle'].includes(x))
      : !!limits[k] && integer(v, ...limits[k]),
  );
}
export function isCityProcessions(v: unknown): v is CityProcessions {
  if (!isRecord(v) || !Array.isArray(v.processions)) return false;
  return v.processions.every((p) => {
    if (
      !isRecord(p) ||
      !isText(p.id) ||
      !isLocalized(p.title) ||
      !['draft', 'verified'].includes(String(p.status)) ||
      !['fluvial', 'procession', 'parade', 'mass'].includes(String(p.kind)) ||
      !eventFormation(p)
    )
      return false;
    if (p.season !== undefined && (!isText(p.season) || !isLocalized(p.label))) return false;
    if (p.label !== undefined && !isLocalized(p.label)) return false;
    if (p.follows !== undefined && !isText(p.follows)) return false;
    if (
      p.sources !== undefined &&
      (!Array.isArray(p.sources) ||
        !p.sources.length ||
        !p.sources.every((x) => isRecord(x) && isText(x.title)))
    )
      return false;
    if (
      p.status === 'verified' &&
      (!p.sources ||
        Object.values(p.title as Record<string, string>).some((t) => t.includes('TODO(verify)')))
    )
      return false;
    const s = p.schedule;
    if (
      !isRecord(s) ||
      !only(s, ['month', 'weekday', 'nth', 'offset_days', 'start', 'duration_min', 'timezone']) ||
      !integer(s.month, 1, 12) ||
      !integer(s.weekday, 0, 6) ||
      !integer(s.nth, 1, 5) ||
      !integer(s.offset_days, -31, 31) ||
      !integer(s.duration_min, 1, 1440) ||
      !isText(s.start) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.start) ||
      !isText(s.timezone) ||
      !/^[A-Za-z_]+(\/[A-Za-z_+-]+)+$/.test(s.timezone)
    )
      return false;
    const base = [
      'id',
      'title',
      'status',
      'kind',
      'season',
      'label',
      'schedule',
      'sources',
      'follows',
    ];
    if (p.kind === 'mass') {
      const site = p.site;
      return (
        only(p, [...base, 'site']) &&
        isRecord(site) &&
        only(site, [
          'id',
          'location',
          'anchor',
          'radius_m',
          'grounds',
          'blocked',
          'approaches',
          'roads',
        ]) &&
        isText(site.id) &&
        /^osm:(node|way|relation)\/\d+$/.test(site.id) &&
        point(site.location) &&
        point(site.anchor) &&
        isNumber(site.radius_m) &&
        site.radius_m > 0 &&
        site.radius_m <= 500 &&
        rings(site.grounds) &&
        (site.grounds as unknown[]).length > 0 &&
        rings(site.blocked) &&
        Array.isArray(site.approaches) &&
        site.approaches.length > 0 &&
        site.approaches.every(line) &&
        Array.isArray(site.roads) &&
        site.roads.every(
          (r) =>
            isRecord(r) &&
            only(r, ['line', 'width_m']) &&
            line(r.line) &&
            isNumber(r.width_m) &&
            r.width_m > 0,
        )
      );
    }
    if (!line(p.route) || !isNumber(p.length_m) || p.length_m <= 0) return false;
    if (p.kind === 'fluvial')
      return (
        only(p, [...base, 'route', 'length_m', 'banks', 'formation']) &&
        (p.banks === undefined ||
          (Array.isArray(p.banks) &&
            p.banks.length === (p.route as unknown[]).length &&
            p.banks.every((b: unknown) => isNumbers(b, 2) && b.every((x) => x >= 0))))
      );
    return (
      only(p, [...base, 'route', 'length_m', 'segments', 'blocked', 'formation']) &&
      rings(p.blocked) &&
      Array.isArray(p.segments) &&
      p.segments.length === (p.route as unknown[]).length - 1 &&
      p.segments.every(
        (e) =>
          isRecord(e) &&
          only(e, ['id', 'width_m', 'sidewalk_m']) &&
          isText(e.id) &&
          /^osm:(node|way|relation)\/\d+$/.test(e.id) &&
          isNumber(e.width_m) &&
          e.width_m > 0 &&
          isNumber(e.sidewalk_m) &&
          e.sidewalk_m >= 0,
      )
    );
  });
}

export function isSubdivisionAreas(v: unknown): v is SubdivisionArea[] {
  return (
    Array.isArray(v) &&
    v.every(
      (area) =>
        isRecord(area) &&
        isText(area.name) &&
        typeof area.approximate === 'boolean' &&
        isRecord(area.geometry) &&
        isText(area.geometry.type) &&
        Array.isArray(area.geometry.coordinates),
    )
  );
}

export function isSearchIndexFile(v: unknown): v is SearchIndexFile {
  return (
    isRecord(v) &&
    v.version === 1 &&
    isRecord(v.index) &&
    Array.isArray(v.entries) &&
    v.entries.every(
      (e) =>
        isRecord(e) &&
        isText(e.id) &&
        isText(e.name) &&
        isText(e.type) &&
        Array.isArray(e.altNames) &&
        isNumber(e.lat) &&
        isNumber(e.lng) &&
        isNumber(e.zoomHint),
    )
  );
}
