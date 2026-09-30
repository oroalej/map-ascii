import { SiteDetail } from '@atlas/shared';
import inside from '@turf/boolean-point-in-polygon';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeSiteDetails, seatingFootprint } from './site-detail';

const m = 111_320;
const p = (x: number, y: number): [number, number] => [x / m, y / m];
const parent: AtlasFeature = {
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [[p(0, 0), p(50, 0), p(50, 50), p(0, 50), p(0, 0)]] },
  properties: {
    id: 'osm:way/1',
    class: 'park',
    landmark: true,
    name: 'Test plaza',
    label_lng: 25 / m,
    label_lat: 25 / m,
  },
  tippecanoe: { layer: 'landuse', minzoom: 12, maxzoom: 16 },
};
const detail = SiteDetail.parse({
  id: 'detail/test',
  osm_id: 'osm:way/1',
  title: 'Test plaza',
  surface: 'paving',
  walks: [{ id: 'spine', line: [p(5, 5), p(45, 5)], width_m: 2 }],
  seating: [
    {
      id: 'curve',
      line: [p(10, 20), p(15, 23), p(20, 24)],
      width_m: 0.6,
      height_m: 0.45,
      facing: 'right',
    },
  ],
  lamps: [{ id: 'one', at: p(30, 30), bearing: 0, reach_m: 0.7, heads: 3 }],
  status: 'draft',
  credit: 'Test survey',
  sources: [{ title: 'Test survey' }],
});

describe('site details', () => {
  it('preserves the parent identity and does not mutate inputs, with stable authored feature ids', () => {
    const result = mergeSiteDetails([parent], [detail]);
    expect(parent.properties.class).toBe('park');
    expect(result.features[0]!.properties).toEqual({ ...parent.properties, class: 'paving' });
    expect(result.features.find((f) => f.properties.detail_route)?.properties).toMatchObject({
      id: 'detail:test/walk-spine',
      width: 2,
    });
    const seat = result.features.find((f) => f.properties.id === 'detail:test/seating-curve')!;
    expect(seat).toMatchObject({
      geometry: { type: 'MultiPolygon' },
      properties: { class: 'seating', height: 0.45, detail_blocked: true },
    });
    const anchors = result.features.filter((f) => f.properties.seat_bearing !== undefined);
    expect(anchors.length).toBeGreaterThan(1);
    expect(
      anchors.every((f) => f.properties.seat_bearing! > 90 && f.properties.seat_bearing! < 180),
    ).toBe(true);
    expect(result.features.at(-1)!.properties).toMatchObject({
      variant: 'lamp',
      lamp_heads: 3,
      lamp_style: 'streetlight',
    });
    expect(result.features.map((f) => f.properties.id)).toEqual(
      mergeSiteDetails([parent], [detail]).features.map((f) => f.properties.id),
    );
  });

  it('rejects missing/duplicate parents, out-of-bounds geometry, and routes through raised beds', () => {
    expect(() => mergeSiteDetails([], [detail])).toThrow('existing OSM area');
    expect(() => mergeSiteDetails([parent], [detail, { ...detail, id: 'detail/second' }])).toThrow(
      'duplicate detail parent',
    );
    expect(() =>
      mergeSiteDetails([parent], [{ ...detail, lamps: [{ ...detail.lamps[0]!, at: p(60, 30) }] }]),
    ).toThrow('outside parent footprint');
    const bed: AtlasFeature = {
      ...parent,
      properties: { id: 'cover:test/bed', class: 'grass', detail_blocked: true },
      geometry: {
        type: 'Polygon',
        coordinates: [[p(20, 0), p(25, 0), p(25, 10), p(20, 10), p(20, 0)]],
      },
    };
    expect(() => mergeSiteDetails([parent, bed], [detail])).toThrow('crosses cover:test/bed');
    expect(() =>
      mergeSiteDetails(
        [parent],
        [
          {
            ...detail,
            walks: [{ id: 'blocked', line: [p(15, 18), p(15, 28)], width_m: 1 }],
          },
        ],
      ),
    ).toThrow('crosses detail:test/seating-curve');
  });

  it('omits curated fixtures when OSM maps the same bench or lamp', () => {
    const original = mergeSiteDetails([parent], [detail]).features;
    const anchor = original.find((f) => f.properties.seat_bearing !== undefined)!;
    const bench: AtlasFeature = {
      ...anchor,
      properties: { id: 'osm:node/2', class: 'furniture', variant: 'bench' },
    };
    const lamp: AtlasFeature = {
      ...original.at(-1)!,
      properties: { id: 'osm:node/3', class: 'furniture', variant: 'lamp' },
    };
    const result = mergeSiteDetails([parent, bench, lamp], [detail]);
    expect(result.features.some((f) => f.properties.id === original.at(-1)!.properties.id)).toBe(
      false,
    );
    expect(result.features.some((f) => f.properties.id === anchor.properties.id)).toBe(false);
    expect(result.warnings.join('\n')).toContain('mapped lamp');
    expect(result.warnings.join('\n')).toContain('mapped bench');
  });

  it('unions bends into one real-width footprint without interior seams', () => {
    const footprint = seatingFootprint([p(10, 10), p(15, 10), p(15, 15)], 1);
    expect(footprint.coordinates).toHaveLength(1);
    expect(footprint.coordinates[0]).toHaveLength(1);
    const xs = footprint.coordinates[0]![0]!.map((x) => x[0]! * m);
    expect(Math.min(...xs)).toBeCloseTo(9.5);
    expect(Math.max(...xs)).toBeCloseTo(15.5);
  });

  it('keeps closed seating footprints hollow and faces anchors outside raised beds', () => {
    const ring = [p(15, 15), p(30, 15), p(30, 30), p(15, 30), p(15, 15)];
    const footprint = seatingFootprint(ring, 0.65);
    expect(footprint.coordinates).toHaveLength(1);
    expect(footprint.coordinates[0]).toHaveLength(2);
    expect(inside(p(22, 22), footprint)).toBe(false);
    expect(inside(p(22, 15), footprint)).toBe(true);
    const garden = { type: 'Polygon' as const, coordinates: [ring] };
    const bed: AtlasFeature = {
      ...parent,
      properties: { id: 'cover:test/bed', class: 'grass', detail_blocked: true },
      geometry: garden,
    };
    const closed = {
      ...detail,
      seating: [{ ...detail.seating[0]!, line: ring, facing: 'right' as const }],
      lamps: [{ ...detail.lamps[0]!, style: 'lantern' as const }],
    };
    const result = mergeSiteDetails([parent, bed], [closed]);
    const anchors = result.features.filter((f) => f.properties.seat_bearing !== undefined);
    expect(anchors.length).toBeGreaterThan(8);
    expect(
      anchors.every((f) => f.geometry.type === 'Point' && !inside(f.geometry.coordinates, garden)),
    ).toBe(true);
    for (const anchor of anchors) {
      if (anchor.geometry.type !== 'Point') throw new Error('expected point anchor');
      const [x, y] = anchor.geometry.coordinates;
      const angle = (anchor.properties.seat_bearing! * Math.PI) / 180;
      expect((x! * m - 22.5) * Math.sin(angle) + (y! * m - 22.5) * Math.cos(angle)).toBeGreaterThan(
        7.5,
      );
    }
    expect(result.features.at(-1)!.properties.lamp_style).toBe('lantern');
    expect(() =>
      mergeSiteDetails(
        [parent, bed],
        [{ ...closed, walks: [{ id: 'inside', line: [p(10, 22), p(35, 22)], width_m: 2 }] }],
      ),
    ).toThrow('crosses');
  });

  it('defaults legacy lamps to streetlights and rejects unknown styles', () => {
    const legacy = { ...detail.lamps[0]!, style: undefined };
    expect(SiteDetail.parse({ ...detail, lamps: [legacy] }).lamps[0]!.style).toBe('streetlight');
    expect(
      SiteDetail.safeParse({ ...detail, lamps: [{ ...legacy, style: 'floodlight' }] }).success,
    ).toBe(false);
  });

  it('rejects duplicate item ids, empty credits, zero dimensions, and degenerate lines', () => {
    expect(
      SiteDetail.safeParse({ ...detail, lamps: [detail.lamps[0], detail.lamps[0]] }).success,
    ).toBe(false);
    expect(SiteDetail.safeParse({ ...detail, sources: [] }).success).toBe(false);
    expect(SiteDetail.safeParse({ ...detail, credit: '' }).success).toBe(false);
    expect(
      SiteDetail.safeParse({ ...detail, walks: [{ ...detail.walks[0], width_m: 0 }] }).success,
    ).toBe(false);
    expect(
      SiteDetail.safeParse({ ...detail, walks: [{ ...detail.walks[0], line: [p(5, 5), p(5, 5)] }] })
        .success,
    ).toBe(false);
  });
});
