import { SiteDetail } from '@atlas/shared';
import inside from '@turf/boolean-point-in-polygon';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import type { Polygon } from 'geojson';
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
  it('anchors riverside detail to a complete mapped bridge line without changing its road', () => {
    const bridge: AtlasFeature = {
      ...parent,
      geometry: { type: 'LineString', coordinates: [p(5, 25), p(45, 25)] },
      properties: { ...parent.properties, class: 'road_mid', width: 10 },
      tippecanoe: { layer: 'roads', minzoom: 10, maxzoom: 16 },
    };
    const pack = SiteDetail.parse({
      ...detail,
      surface: 'keep',
      grounds: (parent.geometry as Polygon).coordinates[0],
      seating: [],
      lamps: [],
      structures: [
        {
          id: 'bank-wall',
          ring: [p(5, 10), p(45, 10), p(45, 11), p(5, 11), p(5, 10)],
          height_m: 3,
          material: 'stone',
          overhead: false,
        },
      ],
    });
    const original = structuredClone(bridge);
    const result = mergeSiteDetails([bridge], [pack]);
    expect(result.features.find((f) => f.properties.id === bridge.properties.id)).toEqual(original);
    expect(bridge).toEqual(original);
    const wall = result.features.find(
      (f) => f.properties.id === 'detail:test/structure-bank-wall',
    )!;
    expect(wall.properties.detail_parent).toBe(bridge.properties.id);
    expect(JSON.parse(wall.properties.detail_selection!)).toMatchObject({
      id: bridge.properties.id,
      class: 'road_mid',
      name: 'Test plaza',
    });
    expect(() => mergeSiteDetails([bridge], [{ ...pack, grounds: undefined }])).toThrow(
      'explicit grounds',
    );
    const concave = [
      p(0, 0),
      p(50, 0),
      p(50, 50),
      p(30, 50),
      p(30, 20),
      p(20, 20),
      p(20, 50),
      p(0, 50),
      p(0, 0),
    ];
    expect(() => mergeSiteDetails([bridge], [{ ...pack, grounds: concave }])).toThrow(
      'contain parent',
    );
    const bent: AtlasFeature = {
      ...bridge,
      geometry: {
        type: 'LineString',
        coordinates: [p(5, 25), p(25, 60), p(45, 25)],
      },
    };
    expect(() => mergeSiteDetails([bent], [pack])).toThrow('contain parent');
    // A centreline on the outline is contained, rather than needing a buffered road envelope.
    const edge: AtlasFeature = {
      ...bridge,
      geometry: {
        type: 'LineString',
        coordinates: [p(0, 0), p(50, 0)],
      },
    };
    expect(() => mergeSiteDetails([edge], [pack])).not.toThrow();
  });

  it('links a sourced pool to its site, blocks pedestrian routes and rejects mapped water duplicates', () => {
    const pool = {
      id: 'pool',
      ring: [p(10, 10), p(20, 10), p(20, 20), p(10, 20), p(10, 10)],
      material: 'water' as const,
      height_m: 0.05,
      overhead: false,
    };
    const pack = SiteDetail.parse({
      ...detail,
      surface: 'keep',
      structures: [pool],
      walks: [],
      seating: [],
      lamps: [],
    });
    const result = mergeSiteDetails([parent], [pack]).features;
    const water = result.find((f) => f.properties.class === 'water_area')!;
    expect(water.properties).toMatchObject({
      kind: 'leisure=swimming_pool',
      detail_parent: parent.properties.id,
      detail_blocked: true,
    });
    const mappedWater: AtlasFeature = {
      ...water,
      properties: { id: 'osm:way/3', class: 'water_area' },
    };
    expect(() => mergeSiteDetails([parent, mappedWater], [pack])).toThrow('duplicates');
    expect(() =>
      mergeSiteDetails(
        [parent],
        [{ ...pack, walks: [{ id: 'crossing', line: [p(5, 15), p(25, 15)], width_m: 2 }] }],
      ),
    ).toThrow('crosses');
    const roof: AtlasFeature = {
      ...water,
      properties: { id: 'osm:way/2', class: 'building', height: 6 },
    };
    expect(() => mergeSiteDetails([parent, roof], [pack])).toThrow('crosses');
  });
  it('applies sourced building height without mutating input and rejects missing or exterior targets', () => {
    const building: AtlasFeature = {
      ...parent,
      geometry: {
        type: 'Polygon',
        coordinates: [[p(10, 10), p(20, 10), p(20, 20), p(10, 20), p(10, 10)]],
      },
      properties: { id: 'osm:way/2', class: 'building_school', height: 6, variant: 'gabled' },
    };
    const pack = {
      ...detail,
      walks: [],
      seating: [],
      lamps: [],
      building_overrides: [{ osm_id: building.properties.id, height_m: 9 }],
    };
    const original = structuredClone(building);
    const changed = mergeSiteDetails([parent, building], [pack]).features.find(
      (f) => f.properties.id === building.properties.id,
    )!;
    expect(changed).toEqual({ ...building, properties: { ...building.properties, height: 9 } });
    expect(building).toEqual(original);
    for (const input of [
      [parent],
      [parent, { ...building, properties: { ...building.properties, height: 0 } }],
      [parent, { ...building, properties: { ...building.properties, class: 'grass' as const } }],
      [
        parent,
        {
          ...building,
          geometry: {
            type: 'Polygon' as const,
            coordinates: [[p(60, 60), p(70, 60), p(70, 70), p(60, 70), p(60, 60)]],
          },
        },
      ],
    ])
      expect(() => mergeSiteDetails(input, [pack])).toThrow('standing building inside the site');
  });
  it('preserves a track infield and rejects exterior or intersecting holes', () => {
    const ring = [p(10, 10), p(40, 10), p(40, 40), p(10, 40), p(10, 10)];
    const hole = [p(20, 20), p(30, 20), p(30, 30), p(20, 30), p(20, 20)];
    const pack = {
      ...detail,
      walks: [],
      seating: [],
      lamps: [],
      structures: [
        {
          id: 'track',
          ring,
          holes: [hole],
          height_m: 0.15,
          material: 'paving' as const,
          overhead: false,
          ground_override: true,
        },
      ],
    };
    const track = mergeSiteDetails([parent], [pack]).features.at(-1)!;
    expect(track.geometry.type).toBe('Polygon');
    expect(inside(p(25, 25), track.geometry as Polygon)).toBe(false);
    expect(inside(p(15, 15), track.geometry as Polygon)).toBe(true);
    for (const holes of [[hole, hole], [ring], [[p(0, 0), p(5, 0), p(5, 5), p(0, 5), p(0, 0)]]])
      expect(() =>
        mergeSiteDetails([parent], [{ ...pack, structures: [{ ...pack.structures[0]!, holes }] }]),
      ).toThrow('interior');
  });
  it('renders mapped roof wings above an unchanged source footprint with canonical selection', () => {
    const building: AtlasFeature = {
      ...parent,
      geometry: {
        type: 'Polygon',
        coordinates: [[p(10, 10), p(40, 10), p(40, 40), p(10, 40), p(10, 10)]],
      },
      properties: { id: 'osm:way/2', class: 'building_market', height: 8 },
    };
    const wing = {
      id: 'roof',
      ring: [p(12, 12), p(38, 12), p(38, 20), p(12, 20), p(12, 12)],
      height_m: 10,
      material: 'roof' as const,
      overhead: true,
      roof_shape: 'gabled' as const,
      roof_osm_id: 'osm:way/2',
    };
    const pack = {
      ...detail,
      surface: 'keep' as const,
      walks: [],
      seating: [],
      lamps: [],
      structures: [wing],
      roof_overrides: [{ osm_id: 'osm:way/2', shape: 'flat' as const }],
    };
    const result = mergeSiteDetails([parent, building], [pack]).features;
    expect(result.find((f) => f.properties.id === building.properties.id)).toEqual({
      ...building,
      properties: { ...building.properties, variant: 'flat' },
    });
    expect(building.properties.variant).toBeUndefined();
    expect(
      result.find((f) => f.properties.id === 'detail:test/structure-roof')!.properties,
    ).toMatchObject({
      class: 'building',
      variant: 'gabled',
      height: 10,
      detail_overhead: true,
      detail_parent: parent.properties.id,
    });
    for (const extra of [
      { height_m: 8 },
      { roof_osm_id: 'osm:way/3' },
      { ring: [p(5, 5), p(15, 5), p(15, 15), p(5, 15), p(5, 5)] },
    ])
      expect(() =>
        mergeSiteDetails([parent, building], [{ ...pack, structures: [{ ...wing, ...extra }] }]),
      ).toThrow('roof wing');
    expect(() =>
      mergeSiteDetails(
        [parent, building],
        [{ ...pack, roof_overrides: [{ osm_id: parent.properties.id, shape: 'flat' }] }],
      ),
    ).toThrow('standing building');
  });
  it('keeps ordinary terraces and emits opt-in overriding paving with canonical selection', () => {
    const pack = {
      ...detail,
      structures: [false, true].map((ground_override, i) => ({
        id: `court-${i}`,
        ring: [p(5, 35), p(15, 35), p(15, 40), p(5, 40), p(5, 35)],
        height_m: 0.15,
        material: 'paving' as const,
        overhead: false,
        ground_override,
      })),
    };
    const parts = mergeSiteDetails([parent], [pack]).features.filter((f) =>
      f.properties.id.startsWith('detail:test/structure-'),
    );
    expect(parts.map((f) => f.properties.variant)).toEqual(['terrace', 'terrace_override']);
    expect(parts.map((f) => f.properties.detail_parent)).toEqual(['osm:way/1', 'osm:way/1']);
  });
  it('rejects a ground override enclosing a standing building, but permits an overhead canopy', () => {
    const building: AtlasFeature = {
      ...parent,
      geometry: {
        type: 'Polygon',
        coordinates: [[p(8, 37), p(10, 37), p(10, 39), p(8, 39), p(8, 37)]],
      },
      properties: { id: 'osm:way/roof', class: 'building', height: 6 },
    };
    const court = {
      id: 'court',
      ring: [p(5, 35), p(15, 35), p(15, 40), p(5, 40), p(5, 35)],
      height_m: 0.15,
      material: 'paving' as const,
      overhead: false,
      ground_override: true,
    };
    expect(() =>
      mergeSiteDetails([parent, building], [{ ...detail, structures: [court] }]),
    ).toThrow('structure court: crosses osm:way/roof');
    const { ground_override: _override, ...canopy } = court;
    expect(() =>
      mergeSiteDetails(
        [parent, building],
        [{ ...detail, structures: [{ ...canopy, material: 'roof', overhead: true }] }],
      ),
    ).not.toThrow();
    // Legacy terraces retain their previous semantics.
    expect(() =>
      mergeSiteDetails([parent, building], [{ ...detail, structures: [canopy] }]),
    ).not.toThrow();
  });
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
