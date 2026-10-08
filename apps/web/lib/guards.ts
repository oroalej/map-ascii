/**
 * Shape checks for the generated files the browser loads. The pipeline validates each with its
 * zod schema when it writes it (steps 05 and 06), so these only catch a missing, stale, or
 * hand-edited file, and keep zod out of the browser bundle (ARCHITECTURE.md §8 initial JS).
 */
import {
  isEmergencyData,
  CAMERA_RANGES,
  PROCESSION_LIMITS,
  processionActorCount,
  PROCESSION_VEHICLES,
  CLOCK_TIME_PATTERN,
  TIME_ZONE_PATTERN,
  OSM_ID_PATTERN,
  TODO_VERIFY,
  artChars,
  ART_CHARACTERS,
  type Landmark,
  type Tour,
  type CityArt,
  type CameraState,
  type CityMeta,
  type CityProcessions,
  type SearchIndexFile,
  type SubdivisionArea,
} from '@atlas/shared';
export const isCityEmergency = isEmergencyData;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNumbers = (v: unknown, length: number): v is number[] =>
  Array.isArray(v) && v.length === length && v.every(isNumber);
const isLocalized = (v: unknown): v is Record<string, string> & { en: string } =>
  isRecord(v) && isText(v.en) && Object.values(v).every(isText);

const sources = (v: unknown) =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every(
    (s) =>
      isRecord(s) &&
      isText(s.title) &&
      (s.url === undefined || isText(s.url)) &&
      (s.note === undefined || typeof s.note === 'string'),
  );
const optional = (v: unknown, check: (value: unknown) => boolean) => v === undefined || check(v);
const osmId = (v: unknown) => isText(v) && OSM_ID_PATTERN.test(v);
const year = (v: unknown) => isNumber(v) && Number.isInteger(v);

/** Step 04 emits the validated landmark array, retaining sources and fact indices. */
export function isCityLandmarks(v: unknown): v is Landmark[] {
  return (
    Array.isArray(v) &&
    v.every(
      (l) =>
        isRecord(l) &&
        isText(l.id) &&
        l.id.startsWith('landmark/') &&
        isLocalized(l.name) &&
        isText(l.type) &&
        ['exact', 'circa', 'unknown'].includes(String(l.certainty)) &&
        sources(l.sources) &&
        optional(l.osm_id, osmId) &&
        (l.osm_id !== undefined ||
          (isRecord(l.geometry) &&
            isText(l.geometry.type) &&
            Array.isArray(l.geometry.coordinates))) &&
        optional(l.start_year, year) &&
        optional(l.end_year, year) &&
        optional(l.story, isLocalized) &&
        optional(
          l.photos,
          (p) =>
            Array.isArray(p) &&
            p.every(
              (x) =>
                isRecord(x) &&
                isText(x.src) &&
                isText(x.credit) &&
                isText(x.license) &&
                optional(x.year, year) &&
                optional(x.caption, (c) => typeof c === 'string'),
            ),
        ) &&
        optional(
          l.facts,
          (f) =>
            Array.isArray(f) &&
            f.length >= 3 &&
            f.length <= 5 &&
            f.every(
              (x) =>
                isRecord(x) &&
                isLocalized(x.text) &&
                integer(x.source, 0, (l.sources as unknown[]).length - 1) &&
                optional(x.year, year) &&
                optional(x.certainty, (c) => ['exact', 'circa'].includes(String(c))),
            ),
        ),
    )
  );
}

export function isCityTours(v: unknown): v is Tour[] {
  return (
    Array.isArray(v) &&
    v.every(
      (t) =>
        isRecord(t) &&
        isText(t.id) &&
        t.id.startsWith('tour/') &&
        isLocalized(t.title) &&
        optional(t.description, isLocalized) &&
        ['draft', 'verified'].includes(String(t.status)) &&
        Array.isArray(t.steps) &&
        t.steps.length > 0 &&
        t.steps.every(
          (s) =>
            isRecord(s) &&
            isCamera(s.camera) &&
            integer(s.duration_ms, 1, Number.MAX_SAFE_INTEGER) &&
            optional(s.fly_ms, (n) => integer(n, 1, 15000)) &&
            isLocalized(s.narration) &&
            optional(s.year, year) &&
            optional(s.select, osmId) &&
            optional(s.highlight, (h) => Array.isArray(h) && h.length <= 64 && h.every(osmId)) &&
            optional(s.audio, isText) &&
            optional(s.sources, sources) &&
            (t.status !== 'verified' ||
              (sources(s.sources) &&
                Object.values(s.narration).every((text) => !text.includes(TODO_VERIFY)))),
        ),
    )
  );
}

/** Art uses the placed CityArt object, rather than editorial LandmarkArt records. */
export function isCityArt(v: unknown): v is CityArt {
  const roles = new Set(['stone', 'wall', 'roof', 'wood', 'gold', 'glass', 'foliage', 'accent']);
  return (
    isRecord(v) &&
    Array.isArray(v.pieces) &&
    v.pieces.every((p) => {
      if (
        !isRecord(p) ||
        !isText(p.id) ||
        !osmId(p.osm_id) ||
        !isText(p.title) ||
        !['draft', 'verified'].includes(String(p.status)) ||
        !integer(p.priority, 0, 100) ||
        !isNumbers(p.bbox, 4) ||
        !point(p.anchor) ||
        !isRecord(p.palette) ||
        !Object.entries(p.palette).every(
          ([key, role]) => artChars(key).length === 1 && roles.has(String(role)),
        ) ||
        !Array.isArray(p.variants) ||
        !p.variants.length
      )
        return false;
      const palette = p.palette;
      return p.variants.every((variant) => {
        if (
          !isRecord(variant) ||
          !Array.isArray(variant.rows) ||
          !variant.rows.length ||
          !variant.rows.every((row) => typeof row === 'string') ||
          !Array.isArray(variant.colors) ||
          variant.colors.length !== variant.rows.length ||
          !variant.colors.every((row) => typeof row === 'string')
        )
          return false;
        const width = artChars(variant.rows[0] as string).length;
        return (
          width > 0 &&
          variant.rows.every(
            (row) =>
              artChars(row).length === width && artChars(row).every((c) => ART_CHARACTERS.has(c)),
          ) &&
          variant.colors.every(
            (row) =>
              artChars(row).length === width &&
              artChars(row).every((key) => key === ' ' || Object.hasOwn(palette, key)),
          )
        );
      });
    })
  );
}

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
  const limits: Readonly<Record<string, readonly [number, number]>> =
    p.kind === 'fluvial'
      ? PROCESSION_LIMITS.fluvial
      : p.kind === 'procession'
        ? PROCESSION_LIMITS.procession
        : PROCESSION_LIMITS.parade;
  const valid = Object.entries(p.formation).every(([k, v]) =>
    k === 'vehicles' && p.kind === 'parade'
      ? Array.isArray(v) &&
        v.length <= PROCESSION_LIMITS.vehicles &&
        v.every((x: unknown) => PROCESSION_VEHICLES.some((vehicle) => vehicle === x))
      : !!limits[k] && integer(v, ...limits[k]),
  );
  if (!valid || (p.kind !== 'fluvial' && p.kind !== 'procession' && p.kind !== 'parade'))
    return false;
  // Every present field was checked against its numeric or vehicle limits above.
  return processionActorCount(p.kind, p.formation) <= PROCESSION_LIMITS.actors;
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
    if (
      p.season !== undefined &&
      (!isText(p.season) || !isLocalized(p.label) || !p.label.en.trim())
    )
      return false;
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
        [
          ...Object.values(p.title as Record<string, string>),
          ...Object.values((p.label ?? {}) as Record<string, string>),
        ].some((t) => t.includes(TODO_VERIFY)))
    )
      return false;
    const s = p.schedule;
    if (
      !isRecord(s) ||
      !only(s, ['month', 'weekday', 'nth', 'offset_days', 'start', 'duration_min', 'timezone']) ||
      !integer(s.month, 1, 12) ||
      !integer(s.weekday, 0, 6) ||
      !integer(s.nth, 1, 5) ||
      !integer(s.offset_days, ...PROCESSION_LIMITS.schedule.offset_days) ||
      !integer(s.duration_min, ...PROCESSION_LIMITS.schedule.duration_min) ||
      !isText(s.start) ||
      !CLOCK_TIME_PATTERN.test(s.start) ||
      !isText(s.timezone) ||
      !TIME_ZONE_PATTERN.test(s.timezone)
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
          'closure_zone',
          'seated_grounds',
          'altar_ground',
          'altar',
        ]) &&
        ['closure_zone', 'seated_grounds', 'altar_ground'].every(
          (k) => site[k] === undefined || rings(site[k]),
        ) &&
        (site.altar === undefined ||
          (isRecord(site.altar) &&
            only(site.altar, ['at', 'radius_m', 'images']) &&
            point(site.altar.at) &&
            isNumber(site.altar.radius_m) &&
            site.altar.radius_m > 0 &&
            site.altar.radius_m <= PROCESSION_LIMITS.altar.radius &&
            integer(site.altar.images, ...PROCESSION_LIMITS.altar.images))) &&
        isText(site.id) &&
        OSM_ID_PATTERN.test(site.id) &&
        point(site.location) &&
        point(site.anchor) &&
        isNumber(site.radius_m) &&
        site.radius_m > 0 &&
        site.radius_m <= PROCESSION_LIMITS.radius &&
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
        only(p, [
          ...base,
          'route',
          'length_m',
          'departure_m',
          'landing_m',
          'banks',
          'formation',
          'crowd_ground',
        ]) &&
        (p.departure_m === undefined || (isNumber(p.departure_m) && p.departure_m > 0)) &&
        (p.landing_m === undefined || (isNumber(p.landing_m) && p.landing_m > 0)) &&
        (p.crowd_ground === undefined ||
          (isRecord(p.crowd_ground) &&
            only(p.crowd_ground, ['grounds', 'blocked', 'water', 'bridges', 'closure_zone']) &&
            rings(p.crowd_ground.grounds) &&
            rings(p.crowd_ground.blocked) &&
            rings(p.crowd_ground.water) &&
            rings(p.crowd_ground.bridges) &&
            (p.crowd_ground.closure_zone === undefined || rings(p.crowd_ground.closure_zone)))) &&
        (p.banks === undefined ||
          (Array.isArray(p.banks) &&
            p.banks.length === (p.route as unknown[]).length &&
            p.banks.every((b: unknown) => isNumbers(b, 2) && b.every((x) => x >= 0))))
      );
    return (
      only(p, [
        ...base,
        'route',
        'length_m',
        'segments',
        'blocked',
        'water',
        'bridges',
        'formation',
        'crowd_grounds',
      ]) &&
      (p.crowd_grounds === undefined || rings(p.crowd_grounds)) &&
      rings(p.blocked) &&
      (p.water === undefined || rings(p.water)) &&
      (p.bridges === undefined || rings(p.bridges)) &&
      Array.isArray(p.segments) &&
      p.segments.length === (p.route as unknown[]).length - 1 &&
      p.segments.every(
        (e) =>
          isRecord(e) &&
          only(e, ['id', 'width_m', 'sidewalk_m', 'sidewalks_m', 'clear_m', 'verge_m']) &&
          isText(e.id) &&
          OSM_ID_PATTERN.test(e.id) &&
          isNumber(e.width_m) &&
          e.width_m > 0 &&
          (e.clear_m === undefined ||
            (isNumber(e.clear_m) && e.clear_m > 0 && e.clear_m <= e.width_m)) &&
          (e.verge_m === undefined ||
            (isRecord(e.verge_m) &&
              only(e.verge_m, ['left', 'right']) &&
              isNumber(e.verge_m.left) &&
              e.verge_m.left >= 0 &&
              e.verge_m.left <= PROCESSION_LIMITS.verge &&
              isNumber(e.verge_m.right) &&
              e.verge_m.right >= 0 &&
              e.verge_m.right <= PROCESSION_LIMITS.verge)) &&
          isNumber(e.sidewalk_m) &&
          e.sidewalk_m >= 0 &&
          (e.sidewalks_m === undefined ||
            (isRecord(e.sidewalks_m) &&
              only(e.sidewalks_m, ['left', 'right']) &&
              isNumber(e.sidewalks_m.left) &&
              e.sidewalks_m.left >= 0 &&
              isNumber(e.sidewalks_m.right) &&
              e.sidewalks_m.right >= 0)),
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
