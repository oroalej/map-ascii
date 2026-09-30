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
  const flagpole: AtlasFeature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: p(-5, 5) },
    properties: {
      id: 'osm:node/4',
      class: 'furniture',
      variant: 'flagpole',
      operator: 'City government',
      subdivision: 'Old district',
      subdivision_approx: true,
      label_lng: -5 / m,
      label_lat: 5 / m,
    },
    tippecanoe: { layer: 'poi', minzoom: 16, maxzoom: 16 },
  };
  const correction = { ...detail, flagpoles: [{ osm_id: flagpole.properties.id, at: p(35, 35) }] };

  it('relocates one mapped flagpole and refreshes its location metadata without mutating inputs', () => {
    const input = [parent, flagpole];
    const before = structuredClone(input);
    const flagged = {
      ...correction,
      flagpoles: correction.flagpoles.map((pole) => ({ ...pole, flag: 'PH' as const })),
    };
    const packs = structuredClone([flagged]);
    const geometry = {
      type: 'Polygon' as const,
      coordinates: [[p(0, 0), p(50, 0), p(50, 50), p(0, 50), p(0, 0)]],
    };
    const result = mergeSiteDetails(input, packs, [
      { name: 'Approximate district', approximate: true, geometry },
      { name: 'Mapped district', approximate: false, geometry },
    ]);
    const poles = result.features.filter((f) => f.properties.variant === 'flagpole');
    expect(poles).toHaveLength(1);
    expect(poles[0]).toEqual({
      ...flagpole,
      geometry: { type: 'Point', coordinates: p(35, 35) },
      properties: {
        ...flagpole.properties,
        flag: 'PH',
        label_lng: 35 / m,
        label_lat: 35 / m,
        subdivision: 'Mapped district',
        subdivision_approx: undefined,
      },
    });
    expect(input).toEqual(before);
    expect(packs).toEqual([flagged]);
    // Neither the original geometry nor the content pack owns the output coordinates.
    expect(poles[0]!.geometry).not.toBe(flagpole.geometry);
    if (poles[0]!.geometry.type !== 'Point') throw new Error('expected point');
    expect(poles[0]!.geometry.coordinates).not.toBe(packs[0]!.flagpoles[0]!.at);

    const unmapped = mergeSiteDetails(input, packs).features.find(
      (f) => f.properties.id === flagpole.properties.id,
    )!;
    expect(unmapped.properties).not.toHaveProperty('subdivision');
    expect(unmapped.properties).not.toHaveProperty('subdivision_approx');
    const approximate = mergeSiteDetails(input, packs, [
      { name: 'Approximate district', approximate: true, geometry },
    ]).features.find((f) => f.properties.id === flagpole.properties.id)!;
    expect(approximate.properties).toMatchObject({
      subdivision: 'Approximate district',
      subdivision_approx: true,
    });
  });

  it('rejects absent or wrong flagpole targets, duplicate overrides, and blocked destinations', () => {
    expect(() => mergeSiteDetails([parent], [correction])).toThrow('existing mapped flagpole');
    for (const invalid of [
      { ...flagpole, properties: { ...flagpole.properties, variant: 'bench' } },
      { ...flagpole, geometry: parent.geometry },
    ]) {
      expect(() => mergeSiteDetails([parent, invalid], [correction])).toThrow(
        'existing mapped flagpole',
      );
    }
    const input = [parent, flagpole];
    expect(() =>
      mergeSiteDetails(input, [
        { ...correction, flagpoles: [...correction.flagpoles, ...correction.flagpoles] },
      ]),
    ).toThrow('duplicate flagpole');
    const otherParent = { ...parent, properties: { ...parent.properties, id: 'osm:way/2' } };
    expect(() =>
      mergeSiteDetails(
        [...input, otherParent],
        [correction, { ...correction, id: 'detail/other', osm_id: 'osm:way/2' }],
      ),
    ).toThrow('duplicate flagpole');
    expect(() =>
      mergeSiteDetails(input, [
        { ...correction, flagpoles: [{ osm_id: flagpole.properties.id, at: p(60, 30) }] },
      ]),
    ).toThrow('outside parent footprint');
    expect(() =>
      mergeSiteDetails(input, [
        { ...correction, flagpoles: [{ osm_id: flagpole.properties.id, at: p(15, 23) }] },
      ]),
    ).toThrow('crosses detail:test/seating-curve');
  });

  it('defaults legacy details to no flagpole overrides and validates targets and coordinates', () => {
    expect(SiteDetail.parse({ ...detail, flagpoles: undefined }).flagpoles).toEqual([]);
    expect(SiteDetail.safeParse(correction).success).toBe(true);
    for (const flagpoles of [
      [...correction.flagpoles, ...correction.flagpoles],
      [{ osm_id: 'not-an-osm-id', at: p(35, 35) }],
      [{ osm_id: flagpole.properties.id, at: p(35, 35), flag: 'unknown' }],
      [{ osm_id: flagpole.properties.id, at: [181, 0] }],
    ]) {
      expect(SiteDetail.safeParse({ ...detail, flagpoles }).success).toBe(false);
    }
  });

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

  it('unions wider bench spans into a hollow rim and seats only along those spans', () => {
    const line = [p(15, 15), p(30, 15), p(30, 30), p(15, 30), p(15, 15)];
    const span = { id: 'front', start: 0, end: 1, width_m: 0.8 };
    const seat = { ...detail.seating[0]!, line, width_m: 0.3, bench_spans: [span] };
    const shape = seatingFootprint(line, seat.width_m, seat.bench_spans);
    expect(shape.coordinates).toHaveLength(1);
    expect(shape.coordinates[0]).toHaveLength(2);
    expect(inside(p(22, 22), shape)).toBe(false);
    expect(inside(p(22, 14.65), shape)).toBe(true); // wide bench
    expect(inside(p(30.35, 22), shape)).toBe(false); // narrow rim
    expect(inside(p(30.1, 22), shape)).toBe(true);
    const pack = { ...detail, seating: [seat] };
    const result = mergeSiteDetails([parent], [pack]);
    expect(result.features.filter((f) => f.properties.class === 'seating')).toHaveLength(1);
    const anchors = result.features.filter((f) => f.properties.seat_bearing !== undefined);
    expect(anchors).toHaveLength(4);
    for (const anchor of anchors) {
      expect(anchor.properties.id).toContain('/bench-curve-front-');
      expect(anchor.properties.seat_bearing).toBeCloseTo(180);
      if (anchor.geometry.type !== 'Point') throw new Error('expected point');
      expect(anchor.geometry.coordinates[1]! * m).toBeCloseTo(13.85);
      expect(inside(anchor.geometry.coordinates, { type: 'Polygon', coordinates: [line] })).toBe(
        false,
      );
    }
    const rim = mergeSiteDetails([parent], [{ ...pack, seating: [{ ...seat, bench_spans: [] }] }]);
    expect(rim.features.some((f) => f.properties.seat_bearing !== undefined)).toBe(false);
    expect(rim.features.filter((f) => f.properties.class === 'seating')).toHaveLength(1);
    expect(() =>
      mergeSiteDetails(
        [parent],
        [{ ...pack, walks: [{ id: 'blocked', line: [p(20, 14.7), p(25, 14.7)], width_m: 1 }] }],
      ),
    ).toThrow('crosses detail:test/seating-curve');
  });

  it('validates bench span names, widths and non-overlapping inclusive vertex ranges', () => {
    const seat = { ...detail.seating[0]!, width_m: 0.3 };
    const span = { id: 'front', start: 0, end: 1, width_m: 0.8 };
    const parse = (bench_spans: unknown) =>
      SiteDetail.safeParse({ ...detail, seating: [{ ...seat, bench_spans }] }).success;
    expect(parse(undefined)).toBe(true);
    expect(parse([])).toBe(true);
    expect(parse([span, { ...span, id: 'side', start: 1, end: 2 }])).toBe(true);
    for (const spans of [
      [span, span],
      [span, { ...span, id: 'overlap', end: 2 }],
      [{ ...span, start: -1 }],
      [{ ...span, start: 0.5 }],
      [{ ...span, end: 3 }],
      [{ ...span, start: 1 }],
      [{ ...span, start: 2 }],
      [{ ...span, width_m: 0.2 }],
      [{ ...span, width_m: 0 }],
      [{ ...span, width_m: 4 }],
      [{ ...span, id: 'Bad span' }],
    ])
      expect(parse(spans)).toBe(false);
  });

  it('unions densely sampled curved rims and benches without losing the planted hole', () => {
    const line = Array.from({ length: 361 }, (_, i) => {
      const angle = ((i % 360) / 180) * Math.PI;
      return p(25 + 10 * Math.cos(angle), 25 + 5 * Math.sin(angle));
    });
    const spans = [{ id: 'front', start: 20, end: 140, width_m: 0.8 }];
    const shape = seatingFootprint(line, 0.3, spans);
    expect(shape.coordinates).toHaveLength(1);
    expect(shape.coordinates[0]).toHaveLength(2);
    expect(inside(p(25, 25), shape)).toBe(false);
    expect(inside(p(25, 30.35), shape)).toBe(true);
    expect(inside(p(25, 19.65), shape)).toBe(false);
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
