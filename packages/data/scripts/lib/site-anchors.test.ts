import { DetailSelectionSchema, SiteDetail } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeSiteDetails } from './site-detail';

const p = (x: number, y: number): [number, number] => [x / 111320, y / 111320];
const ring = (x = 0, y = 0, size = 50) => [
  p(x, y),
  p(x + size, y),
  p(x + size, y + size),
  p(x, y + size),
  p(x, y),
];
const area = (id: string, shape = ring()): AtlasFeature => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [shape] },
  properties: { id, class: 'building_school', landmark_id: 'landmark/test', name: 'Test campus' },
  tippecanoe: { layer: 'buildings', minzoom: 12, maxzoom: 16 },
});
const parent = area('osm:way/1');
const pack = (extra: Record<string, unknown> = {}) =>
  SiteDetail.parse({
    id: 'detail/test',
    osm_id: parent.properties.id,
    title: 'Test campus',
    surface: 'keep',
    status: 'draft',
    credit: 'Test survey',
    sources: [{ title: 'Test survey' }],
    ...extra,
  });
const building = {
  ...area('osm:way/2', ring(20, 20, 10)),
  properties: {
    id: 'osm:way/2',
    class: 'building' as const,
    height: 6,
    landmark_id: 'landmark/building',
    name: 'Test building',
  },
};

describe('site anchor surfaces', () => {
  it('keeps campus geometry, class, tile range and properties unchanged', () => {
    const before = structuredClone(parent);
    expect(mergeSiteDetails([parent], [pack()]).features).toEqual([before]);
    expect(parent).toEqual(before);
  });
  it('links a kept-campus canopy to canonical metadata without changing the grounds', () => {
    const detail = pack({
      structures: [
        { id: 'canopy', ring: ring(5, 5, 5), height_m: 3, material: 'roof', overhead: true },
      ],
    });
    const result = mergeSiteDetails([parent], [detail]).features;
    expect(result[0]).toEqual(parent);
    const canopy = result.find((f) => f.properties.id === 'detail:test/structure-canopy')!;
    expect(canopy.properties).toMatchObject({
      class: 'building_part',
      detail_parent: parent.properties.id,
      detail_overhead: true,
    });
    expect(DetailSelectionSchema.parse(JSON.parse(canopy.properties.detail_selection!))).toEqual({
      id: parent.properties.id,
      class: 'building_school',
      name: 'Test campus',
      landmarkId: 'landmark/test',
    });
  });
  it('adds unoutlined paving grounds and retains its standing building and original metadata', () => {
    const detail = pack({ osm_id: building.properties.id, surface: 'paving', grounds: ring() });
    const before = structuredClone([building, detail]);
    const result = mergeSiteDetails([building], [detail]).features;
    expect(result[0]).toEqual(building);
    const ground = result.find((f) => f.properties.id === 'detail:test/grounds')!;
    expect(ground.properties).toMatchObject({
      class: 'paving',
      detail_parent: building.properties.id,
    });
    expect(ground.properties.variant).toBeUndefined();
    expect(DetailSelectionSchema.parse(JSON.parse(ground.properties.detail_selection!))).toEqual({
      id: building.properties.id,
      class: 'building',
      height: 6,
      name: 'Test building',
      landmarkId: 'landmark/building',
    });
    expect([building, detail]).toEqual(before);
  });
  it('requires grounds for building and point parents and rejects unsupported line parents', () => {
    expect(() => mergeSiteDetails([building], [pack({ osm_id: building.properties.id })])).toThrow(
      'building parent needs curated grounds',
    );
    const point = { ...parent, geometry: { type: 'Point' as const, coordinates: p(25, 25) } };
    expect(() => mergeSiteDetails([point], [pack()])).toThrow('existing OSM area');
    expect(
      mergeSiteDetails([point], [pack({ grounds: ring(), surface: 'paving' })]).features,
    ).toHaveLength(2);
    const line = {
      ...parent,
      geometry: { type: 'LineString' as const, coordinates: [p(5, 5), p(10, 10)] },
    };
    expect(() => mergeSiteDetails([line], [pack({ grounds: ring() })])).toThrow(
      'existing OSM area',
    );
  });
  it('checks complete area and point containment, including multiple polygons', () => {
    const point = { ...parent, geometry: { type: 'Point' as const, coordinates: p(80, 80) } };
    for (const original of [
      parent,
      point,
      {
        ...parent,
        geometry: { type: 'MultiPolygon' as const, coordinates: [[ring()], [ring(70, 70, 5)]] },
      },
    ])
      expect(() => mergeSiteDetails([original], [pack({ grounds: ring(0, 0, 30) })])).toThrow(
        'grounds must contain parent',
      );
    const multi = {
      ...parent,
      geometry: {
        type: 'MultiPolygon' as const,
        coordinates: [[ring(5, 5, 5)], [ring(20, 20, 5)]],
      },
    };
    expect(() => mergeSiteDetails([multi], [pack({ grounds: ring() })])).not.toThrow();
  });
  it('rejects grounds overlaps in either pack order but permits touching boundaries', () => {
    const a = area('osm:way/1', ring(5, 5, 5)),
      b = area('osm:way/3', ring(25, 25, 5));
    const first = pack({ grounds: ring() }),
      second = pack({ id: 'detail/other', osm_id: b.properties.id });
    for (const packs of [
      [first, second],
      [second, first],
    ])
      expect(() => mergeSiteDetails([a, b], packs)).toThrow('grounds overlap');
    const outside = area('osm:way/3', ring(50, 0, 10));
    expect(() =>
      mergeSiteDetails(
        [a, outside],
        [first, pack({ id: 'detail/other', osm_id: outside.properties.id })],
      ),
    ).not.toThrow();
  });
  it('links kept grounds and terraces to a separate curated landmark', () => {
    const detail = pack({
      selection_osm_id: building.properties.id,
      structures: [
        { id: 'court', ring: ring(5, 5, 8), material: 'paving', height_m: 0.15, overhead: false },
      ],
    });
    const result = mergeSiteDetails([parent, building], [detail]).features;
    expect(result[0]?.properties).toMatchObject({
      class: 'building_school',
      detail_parent: building.properties.id,
    });
    expect(result[0]?.tippecanoe).toEqual(parent.tippecanoe);
    expect(result.at(-1)?.properties).toMatchObject({ detail_parent: building.properties.id });
    expect(result[1]).toEqual(building);
  });
  it('accepts a landmark facade adjacent to an approximate OSM grounds boundary', () => {
    const adjacent = {
      ...building,
      geometry: { type: 'Polygon' as const, coordinates: [ring(52, 10, 10)] },
    };
    expect(() =>
      mergeSiteDetails([parent, adjacent], [pack({ selection_osm_id: adjacent.properties.id })]),
    ).not.toThrow();
    const distant = {
      ...adjacent,
      geometry: { type: 'Polygon' as const, coordinates: [ring(56, 10, 10)] },
    };
    expect(() =>
      mergeSiteDetails([parent, distant], [pack({ selection_osm_id: distant.properties.id })]),
    ).toThrow('adjacent to the site');
  });
  it('rejects missing, uncurated, external and chained selection targets', () => {
    const detail = pack({ selection_osm_id: building.properties.id });
    for (const input of [
      [parent],
      [parent, { ...building, properties: { ...building.properties, landmark_id: undefined } }],
      [
        parent,
        { ...building, geometry: { type: 'Polygon' as const, coordinates: [ring(60, 60, 10)] } },
      ],
    ])
      expect(() => mergeSiteDetails(input, [detail])).toThrow('existing curated landmark inside');
    expect(() =>
      mergeSiteDetails(
        [parent, building],
        [
          detail,
          pack({
            id: 'detail/building',
            osm_id: building.properties.id,
            selection_osm_id: parent.properties.id,
            grounds: ring(),
          }),
        ],
      ),
    ).toThrow('alias chains');
  });
  it('blocks walks through standing buildings, while grounds and overhead roofs remain walkable', () => {
    const detail = pack({ walks: [{ id: 'spine', line: [p(5, 25), p(45, 25)], width_m: 2 }] });
    expect(() => mergeSiteDetails([parent, building], [detail])).toThrow('crosses osm:way/2');
    expect(() =>
      mergeSiteDetails(
        [parent, { ...building, properties: { ...building.properties, detail_overhead: true } }],
        [detail],
      ),
    ).not.toThrow();
    expect(() =>
      mergeSiteDetails(
        [parent, { ...building, properties: { ...building.properties, height: undefined } }],
        [detail],
      ),
    ).not.toThrow();
  });
  it('validates grounds using the same simple-ring rules as structures', () => {
    for (const grounds of [
      [p(0, 0), p(1, 1), p(1, 0), p(0, 1), p(0, 0)],
      [p(0, 0), p(1, 0), p(2, 0), p(0, 0)],
      ring().slice(0, -1),
    ])
      expect(SiteDetail.safeParse({ ...pack(), grounds }).success).toBe(false);
  });
});
