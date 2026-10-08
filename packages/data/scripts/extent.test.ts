import { expect, it } from 'vitest';
import type { Feature, FeatureCollection, Geometry, Polygon } from 'geojson';
import {
  CityProcessions,
  Procession,
  type SeasonalRecord,
  type SubdivisionArea,
} from '@atlas/shared';
import { normalize, type AtlasFeature } from './03-normalize';
import { tileRecords, yearRange } from './05-tiles';
import { buildSearchIndex, searchEntries } from './06-search-index';
import { quantizeGroundRoutes, validateRouteTerritory } from './07-processions';
import { routeProcessions } from './lib/procession';
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

it('drops curated farmland wholly in void only at the display stage', () => {
  const source: AtlasFeature = {
    type: 'Feature',
    geometry: bboxPolygon([0.2, 2.5, 0.5, 2.8]),
    properties: { id: 'cover:fields/area-1', class: 'farmland' },
    tippecanoe: { layer: 'landuse', minzoom: 12, maxzoom: 16 },
  };
  const before = structuredClone(source);
  expect(tileRecords([source], territory)).toEqual([]);
  expect(source).toEqual(before);
  expect(tileRecords([source], createTerritory(territory.regionBounds, city.geometry))).toEqual([
    source,
  ]);
});

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

it('keeps reachable anchors when retained components extend beyond the camera rectangle', () => {
  const road = (id: string, coordinates: number[][]): AtlasFeature => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: {
      id,
      class: 'road_minor',
      name: id,
      label_lng: 0.5,
      label_lat: 3,
      shop_lng: 0.5,
      shop_lat: 3,
      life_lng: 0.5,
      life_lat: 3,
    },
    tippecanoe: { layer: 'roads', minzoom: 13, maxzoom: 16 },
  });
  const sources: AtlasFeature[] = [
    road('split', [
      [-3, 3],
      [0.5, 3],
      [1.5, 3],
    ]),
    road('single', [
      [-4, 1],
      [-3, 1],
      [-2, 1],
      [-1, 1],
      [1, 1],
      [1.5, 3],
      [0.5, 3],
    ]),
    road('crossing', [
      [-3, 1.5],
      [6, 1.5],
    ]),
    {
      ...road('school', []),
      properties: {
        id: 'school',
        class: 'building_school',
        name: 'School',
        label_lng: 0.5,
        label_lat: 3,
      },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          bboxPolygon([-4, 2.5, -1, 3.5]).coordinates,
          bboxPolygon([1.2, 2.5, 1.4, 2.7]).coordinates,
        ],
      },
    },
  ];
  const before = structuredClone(sources);
  const displayed = displayFeatures(sources, territory);
  expect(displayed).toHaveLength(sources.length);
  for (const feature of displayed) {
    for (const prefix of ['label', 'shop', 'life'] as const) {
      const lng = feature.properties[`${prefix}_lng`],
        lat = feature.properties[`${prefix}_lat`];
      if (lng !== undefined && lat !== undefined)
        expect(inTerritory(lng, lat, territory)).toBe(true);
    }
  }
  expect(displayed[0]!.geometry).toEqual({
    type: 'MultiLineString',
    coordinates: [
      [
        [-3, 3],
        [-Number.MIN_VALUE, 3],
      ],
      [
        [1, 3],
        [1.5, 3],
      ],
    ],
  });
  const content = { landmarks: [] } as unknown as ContentBundle;
  expect(searchEntries(displayed, [], content, territory).map((e) => e.id)).toEqual(
    sources.map((f) => f.properties.id),
  );
  expect(sources).toEqual(before);
  expect(displayFeatures(sources, createTerritory(territory.regionBounds, city.geometry))).toEqual(
    sources,
  );
  const outside: AtlasFeature = {
    ...road('outside', [
      [4.0001, 3],
      [4.002, 3],
    ]),
    properties: { id: 'outside', class: 'road_minor', name: 'Grouped' },
  };
  const inside: AtlasFeature = {
    ...road('inside', [
      [3.9999, 3],
      [4, 3],
    ]),
    properties: { id: 'inside', class: 'road_minor', name: 'Grouped' },
  };
  const grouped = searchEntries(
    displayFeatures([outside, inside], territory),
    [],
    content,
    territory,
  );
  expect(grouped).toHaveLength(1);
  expect(grouped[0]!.id).toBe('inside');
  expect([...grouped[0]!.featureIds!].sort()).toEqual(['inside', 'outside']);
});

it('derives metadata years only from emitted display records', () => {
  const building = (
    id: string,
    geometry: Polygon,
    start_year?: number,
    end_year?: number,
  ): AtlasFeature => ({
    type: 'Feature',
    geometry,
    properties: { id, class: 'building', start_year, end_year },
    tippecanoe: { layer: 'buildings', minzoom: 13, maxzoom: 16 },
  });
  const sources = [
    building('void', bboxPolygon([0.2, 2.5, 0.4, 3]), 1600),
    building('retained', bboxPolygon([2, 2, 3, 3]), 1900, 1880),
  ];
  expect(yearRange(tileRecords(sources, territory), 2026)).toEqual([1880, 2026]);
  expect(
    yearRange(tileRecords(sources, createTerritory(territory.regionBounds, city.geometry)), 2026),
  ).toEqual(yearRange(sources, 2026));
  expect(yearRange([], 2026)).toEqual([2026, 2026]);
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
  expect(admitted.stats.rejected.void).toBeGreaterThan(0);
  expect(admitted.stats.rejected.bounds).toBe(legacy.stats.rejected.bounds);
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

it('validates Mass approaches as open paths through a concave site', () => {
  const boundary: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [-0.0004, -0.0004],
        [0.0004, -0.0004],
        [0.0004, 0.0004],
        [0.0001, 0.0004],
        [0.0001, 0],
        [-0.0001, 0],
        [-0.0001, 0.0004],
        [-0.0004, 0.0004],
        [-0.0004, -0.0004],
      ],
    ],
  };
  const t = createTerritory(
    [-0.0004, -0.0004, 0.0004, 0.0004],
    boundary,
    [-0.0004, -0.0004, 0.0004, -0.0003],
  );
  const church: Feature<Geometry, Record<string, unknown>> = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-0.0002, 0.0002] },
    properties: { id: 'osm:node/1', class: 'building_religious' },
  };
  const grounds: Feature<Geometry, Record<string, unknown>> = {
    type: 'Feature',
    geometry: boundary,
    properties: { id: 'osm:way/2', class: 'park' },
  };
  const event = Procession.parse({
    id: 'procession/u-site',
    title: { en: 'Test Mass' },
    story: { en: 'Test' },
    status: 'draft',
    kind: 'mass',
    site: 'osm:node/1',
    grounds: ['osm:way/2'],
    radius_m: 80,
    gathering_anchor: [-0.0002, 0.0002],
    schedule: {
      month: 9,
      weekday: 6,
      nth: 3,
      offset_days: 0,
      start: '12:00',
      duration_min: 60,
      timezone: 'Etc/UTC',
    },
  });
  const routes = quantizeGroundRoutes(routeProcessions([church, grounds], [event]).routes);
  expect(CityProcessions.safeParse({ processions: routes }).success).toBe(true);
  const mass = routes[0]!;
  if (mass.kind !== 'mass') throw new Error('Expected Mass');
  expect(mass.site.approaches.length).toBeGreaterThan(0);
  expect(
    mass.site.approaches.every((coordinates) =>
      geometryOutsideVoid({ type: 'LineString', coordinates }, t),
    ),
  ).toBe(true);
  expect(() => validateRouteTerritory(routes, t)).not.toThrow();
  const crossing = {
    ...mass,
    site: {
      ...mass.site,
      approaches: [
        [
          [-0.0002, 0.0002],
          [0.0002, 0.0002],
        ] as [number, number][],
      ],
    },
  };
  expect(() => validateRouteTerritory([crossing], t)).toThrow('void');
});
