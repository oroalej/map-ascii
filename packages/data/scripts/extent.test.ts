import { expect, it } from 'vitest';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import type { SeasonalRecord, SubdivisionArea } from '@atlas/shared';
import { normalize, type AtlasFeature } from './03-normalize';
import { tileRecords } from './05-tiles';
import { buildSearchIndex, searchEntries } from './06-search-index';
import { validateRouteTerritory } from './07-processions';
import {
  bboxPolygon,
  createTerritory,
  geometryOutsideVoid,
  inTerritory,
  inVoid,
} from './lib/territory';
import { displayFeatures } from './lib/display';
import { seasonalRecordsInTerritory } from './lib/seasonal-tiles';
import { generateUtilities } from './lib/utilities';
import type { ContentBundle } from '@atlas/content';

const city: Feature<Polygon> = {
  type: 'Feature',
  id: 'relation/city',
  properties: { name: 'City' },
  geometry: bboxPolygon([1, 1, 4, 4]),
};
const territory = createTerritory([0, 0, 4, 4], city.geometry, [0, 0, 2, 2]);
const collection = (features: Feature[]): FeatureCollection => ({
  type: 'FeatureCollection',
  features,
});
const emptyRegion = { osm: collection([]), derived: [] };

it('keeps boundary point and subdivision search anchors admitted after serialization', () => {
  const boundary: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [2, 0],
        [0, 2.0000008],
        [0, 0],
      ],
    ],
  };
  const t = createTerritory([0, 0, 2, 3], boundary, [0, 0, 0.1, 0.1]);
  const point: [number, number] = [0.5, 1.5000006];
  expect(inTerritory(...point, t)).toBe(true);
  expect(inTerritory(0.5, 1.500001, t)).toBe(false);
  const feature = (id: string, name: string, subdivision = false): AtlasFeature => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: point },
    properties: {
      id,
      name,
      class: 'place_label',
      place: 'quarter',
      ...(subdivision && { subdivision_label: true }),
    },
    tippecanoe: { layer: 'labels', minzoom: 10, maxzoom: 16 },
  });
  const features = [feature('boundary', 'Boundary'), feature('ward', 'Ward', true)];
  const areas: SubdivisionArea[] = [
    {
      name: 'Ward',
      approximate: false,
      geometry: { type: 'Polygon', coordinates: bboxPolygon([0.4, 1.2, 0.6, 1.4]).coordinates },
    },
  ];
  const content = { landmarks: [] } as unknown as ContentBundle;
  const entries = searchEntries(features, areas, content, t);
  expect(entries.map((e) => e.id)).toEqual(['boundary', 'ward']);
  expect(entries.every((e) => inTerritory(e.lng, e.lat, t))).toBe(true);
  expect(entries.map((e) => [e.lng, e.lat])).toEqual([point, point]);
  expect(
    searchEntries(features, areas, content, createTerritory(t.regionBounds, boundary)),
  ).toEqual(searchEntries(features, areas, content));
});

it('preserves complete normalization inputs, cuts only tile records and repairs void anchors without mutation', () => {
  const source: Feature = {
    type: 'Feature',
    id: 'way/1',
    properties: { building: 'yes', name: 'School', amenity: 'school' },
    geometry: bboxPolygon([1.5, 2.5, 2.5, 3.5]),
  };
  // A crossing footprint, plus one wholly in the void and a road which exits/reenters it.
  const wholly: Feature = { ...source, id: 'way/2', geometry: bboxPolygon([0.2, 2.5, 0.4, 3]) };
  const road: Feature = {
    type: 'Feature',
    id: 'way/3',
    properties: { highway: 'residential', name: 'Street' },
    geometry: {
      type: 'LineString',
      coordinates: [
        [0.5, 1.5],
        [0.5, 3],
        [2, 3],
      ],
    },
  };
  const full = normalize(collection([source, wholly, road]), city, 10, emptyRegion, true).features;
  const building = full.find((f) => f.properties.id === 'osm:way/1')!;
  building.properties.roof_plan = 'complete-source-plan';
  building.properties.label_lng = 0.5;
  building.properties.label_lat = 3;
  building.properties.shop_lng = 0.5;
  building.properties.shop_lat = 3;
  building.properties.life_lng = 0.5;
  building.properties.life_lat = 3;
  const before = structuredClone(full);
  const records = tileRecords(full, territory);
  expect(building.geometry).toEqual(source.geometry);
  expect(full.find((f) => f.properties.id === 'osm:way/3')!.geometry).toEqual(road.geometry);
  expect(records.some((f) => f.properties.id === 'osm:way/2')).toBe(false);
  expect(records.every((f) => geometryOutsideVoid(f.geometry, territory))).toBe(true);
  expect(
    records.filter(
      (f) => f.properties.id === building.properties.id && f.tippecanoe.minzoom >= 15,
    )[0]!.properties.roof_plan,
  ).toBe('complete-source-plan');
  const displayed = displayFeatures(full, territory).find(
    (f) => f.properties.id === building.properties.id,
  )!;
  for (const key of ['label', 'shop', 'life'] as const)
    expect(
      inVoid([displayed.properties[`${key}_lng`]!, displayed.properties[`${key}_lat`]!], territory),
    ).toBe(false);
  expect(full).toEqual(before);
  const flagless = createTerritory([0, 0, 4, 4], city.geometry);
  expect(displayFeatures(full, flagless)).toEqual(full);
  const content = { landmarks: [] } as unknown as ContentBundle;
  const entries = searchEntries(displayFeatures(full, territory), [], content).filter((e) =>
    inTerritory(e.lng, e.lat, territory),
  );
  expect(buildSearchIndex(entries).entries.some((e) => e.name === 'Street')).toBe(true);
  expect(entries.some((e) => e.id === 'osm:way/2')).toBe(false);
  const splitSchool: AtlasFeature = {
    ...building,
    properties: { id: 'split-school', class: 'building_school', name: 'Split School' },
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        bboxPolygon([0.1, 1.5, 0.3, 1.8]).coordinates,
        bboxPolygon([1.1, 3.5, 1.3, 3.8]).coordinates,
      ],
    },
  };
  const schoolEntry = searchEntries(
    displayFeatures([splitSchool], territory),
    [],
    content,
    territory,
  )[0]!;
  expect(inTerritory(schoolEntry.lng, schoolEntry.lat, territory)).toBe(true);
  expect(searchEntries([splitSchool], [], content)[0]!.lng).toBe(0.7);
});

it('uses original subdivision centroids for eligibility, clips HUD areas and keeps source outlines', () => {
  const subdivision = (
    id: string,
    name: string,
    bounds: [number, number, number, number],
  ): Feature => ({
    type: 'Feature',
    id,
    properties: { boundary: 'administrative', admin_level: '10', name },
    geometry: bboxPolygon(bounds),
  });
  const inside = subdivision('relation/inside', 'Inside', [0.5, 1, 2, 3]);
  const outside = subdivision('relation/outside', 'Outside', [-2, 1, 1.5, 3]);
  const result = normalize(collection([inside, outside]), city, 10, emptyRegion, true);
  expect(result.areas.map((a) => a.name)).toEqual(['Inside']);
  expect(result.areas[0]!.bbox[0]).toBe(1);
  expect(result.features.find((f) => f.properties.id === 'osm:relation/inside')!.geometry).toEqual({
    type: 'MultiLineString',
    coordinates: (inside.geometry as Polygon).coordinates,
  });
  expect(result.features.some((f) => f.properties.id === 'osm:relation/outside')).toBe(false);
  expect(normalize(collection([inside, outside]), city, 10).areas).toHaveLength(2);
});

it('restricts same-named subdivision place labels to city membership only when opted in', () => {
  const mapped: Feature = {
    type: 'Feature',
    id: 'relation/ward',
    properties: { boundary: 'administrative', admin_level: '10', name: 'Ward' },
    geometry: bboxPolygon([1, 1, 2, 2]),
  };
  const place = (id: string, coordinates: [number, number]): Feature => ({
    type: 'Feature',
    id,
    properties: { place: 'quarter', name: 'Ward' },
    geometry: { type: 'Point', coordinates },
  });
  // The outside-city node remains in the retained rectangle and cannot be hidden by void clipping.
  const detail = collection([
    mapped,
    place('node/inside', [1.5, 1.5]),
    place('node/outside', [0.5, 1.5]),
  ]);
  expect(inTerritory(0.5, 1.5, territory)).toBe(true);
  for (const enabled of [false, true]) {
    const result = normalize(detail, city, 10, emptyRegion, enabled);
    const labels = ['osm:node/inside', 'osm:node/outside'].map(
      (id) =>
        result.features.find((f) => f.properties.id === id)!.properties.subdivision_label === true,
    );
    expect(labels).toEqual(enabled ? [true, false] : [true, true]);
  }
});

it('drops whole seasonal records when embedded source segments cross the void', () => {
  const safe: SeasonalRecord = {
    version: 1,
    kind: 'bunting',
    id: 'safe',
    season: 'test',
    corridor: 'test',
    road: 'road',
    from: [2, 3],
    to: [3, 3],
    segment: [
      [2, 3],
      [3, 3],
    ],
    seed: 1,
  };
  const bad: SeasonalRecord = {
    ...safe,
    id: 'bad',
    segment: [
      [0.5, 1.5],
      [0.5, 3],
    ],
  };
  expect(seasonalRecordsInTerritory([safe, bad], territory)).toEqual([safe]);
  expect(seasonalRecordsInTerritory([safe, bad], territory)[0]).toBe(safe);
  expect(seasonalRecordsInTerritory([safe, bad])).toEqual([safe, bad]);
  const common = {
    version: 1 as const,
    id: 'edge',
    season: 'test',
    installation: 'test',
    anchor: 'osm:way/1',
    seed: 1,
  };
  const edgeRecords: SeasonalRecord[] = [
    { ...common, kind: 'light-string', from: [0.5, 1.5], to: [1.5, 3] },
    {
      ...common,
      kind: 'carnival',
      style: 'midway',
      at: [1.000001, 3],
      size_m: [30, 30],
      angle_deg: 0,
    },
    { ...common, kind: 'decorated-canopy', at: [1.000001, 3], radius_m: 10 },
  ];
  expect(seasonalRecordsInTerritory(edgeRecords, territory)).toEqual([]);
});

it('rejects straight utility spans across a concave gap with otherwise admissible endpoints', () => {
  const bounds: [number, number, number, number] = [123.18, 13.62, 123.184, 13.624];
  const boundary = {
    type: 'MultiPolygon' as const,
    coordinates: [
      bboxPolygon([123.18, 13.62, 123.1819, 13.624]).coordinates,
      bboxPolygon([123.1821, 13.62, 123.184, 13.624]).coordinates,
    ],
  };
  const t = createTerritory(bounds, boundary, [123.18, 13.62, 123.184, 13.621]);
  const road: AtlasFeature = {
    type: 'Feature',
    properties: { id: 'gap', class: 'road_major', highway: 'primary', width: 8 },
    tippecanoe: { layer: 'roads', minzoom: 6, maxzoom: 16 },
    geometry: {
      type: 'LineString',
      coordinates: [
        [123.1802, 13.622],
        [123.1838, 13.622],
      ],
    },
  };
  const crosses = (r: ReturnType<typeof generateUtilities>['records'][number]) =>
    r.kind === 'span' &&
    !geometryOutsideVoid({ type: 'LineString', coordinates: [r.span.from.at, r.span.to.at] }, t);
  expect(generateUtilities([road], bounds).records.some(crosses)).toBe(true);
  expect(generateUtilities([road], bounds, [], t).records.some(crosses)).toBe(false);
});

it('admits utility supports after offsets and retains only spans wholly outside the void', () => {
  const bounds: [number, number, number, number] = [123.18, 13.62, 123.184, 13.624];
  const t = createTerritory(
    bounds,
    bboxPolygon([123.181, 13.62, 123.184, 13.624]),
    [123.18, 13.62, 123.181, 13.621],
  );
  const road: AtlasFeature = {
    type: 'Feature',
    properties: { id: 'osm:way/1', class: 'road_major', highway: 'primary', width: 8 },
    tippecanoe: { layer: 'roads', minzoom: 6, maxzoom: 16 },
    geometry: {
      type: 'LineString',
      coordinates: [
        [123.18102, 13.6215],
        [123.18102, 13.6235],
      ],
    },
  };
  const legacy = generateUtilities([road], bounds);
  const admitted = generateUtilities([road], bounds, [], t);
  expect(legacy.records.length).toBeGreaterThan(admitted.records.length);
  expect(admitted.records.length).toBeGreaterThan(0);
  const ids = new Set(admitted.records.flatMap((r) => (r.kind === 'pole' ? [r.pole.id] : [])));
  for (const r of admitted.records) {
    if (r.kind === 'pole') expect(inVoid(r.pole.at, t)).toBe(false);
    else {
      expect(ids.has(r.span.from.id) && ids.has(r.span.to.id)).toBe(true);
      expect(
        geometryOutsideVoid({ type: 'LineString', coordinates: [r.span.from.at, r.span.to.at] }, t),
      ).toBe(true);
    }
  }
  expect(generateUtilities([road], bounds, [], createTerritory(bounds, t.territory!))).toEqual(
    legacy,
  );
});

it('rejects event geography crossing the void even with admitted endpoints', () => {
  // Use a fluvial route so this fixture exercises the complete line, independently of routing.
  const route = {
    id: 'river',
    kind: 'fluvial',
    route: [
      [0.5, 1.5],
      [0.5, 3],
      [2, 3],
    ],
  };
  expect(() =>
    validateRouteTerritory(
      [route as unknown as Parameters<typeof validateRouteTerritory>[0][number]],
      territory,
    ),
  ).toThrow('void');
});
