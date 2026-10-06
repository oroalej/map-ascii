import { CityMeta, CityProcessions, SearchIndexFile, SubdivisionAreas } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import { isCityMeta, isCityProcessions, isSearchIndexFile, isSubdivisionAreas } from './guards';

const meta = {
  slug: 'fixture',
  name: { en: 'Fixture City', fil: 'Lungsod' },
  subdivisionLabel: { en: 'district' },
  languages: ['fil'],
  bounds: [1, 2, 3, 4],
  regionBounds: [0, 1, 4, 5],
  defaultCamera: { lat: 3, lng: 2, zoom: 14 },
  yearRange: [1900, 2026],
  attribution: ['A credit'],
};

const areas = [
  { name: 'North', approximate: false, geometry: { type: 'Polygon', coordinates: [] } },
];

const index = {
  version: 1,
  entries: [
    {
      id: 'osm:way/1',
      name: 'Plaza',
      altNames: [],
      type: 'landmark',
      lat: 3,
      lng: 2,
      zoomHint: 17,
    },
  ],
  index: { documentCount: 1 },
};

/** Each guard must accept what its schema accepts, and reject these broken copies. */
describe('browser shape guards agree with the schemas', () => {
  it('accepts all event kinds and rejects cross-kind or misaligned geography', () => {
    const base = {
      id: 'procession/test',
      title: { en: 'Test' },
      status: 'draft',
      schedule: {
        month: 9,
        weekday: 6,
        nth: 3,
        offset_days: 0,
        start: '15:00',
        duration_min: 90,
        timezone: 'Asia/Manila',
      },
    };
    const route = [
      [1, 2],
      [1.001, 2],
    ];
    const fluvial = { ...base, kind: 'fluvial', route, length_m: 100 };
    const street = {
      ...base,
      kind: 'procession',
      route,
      length_m: 100,
      segments: [{ id: 'osm:way/1', width_m: 8, sidewalk_m: 1 }],
      blocked: [],
    };
    const mass = {
      ...base,
      kind: 'mass',
      site: {
        id: 'osm:way/2',
        location: route[0],
        anchor: route[1],
        radius_m: 100,
        grounds: [
          [
            [1, 2],
            [1.001, 2],
            [1.001, 2.001],
            [1, 2],
          ],
        ],
        blocked: [],
        approaches: [route],
        roads: [],
      },
    };
    for (const [sidewalks_m, accepted] of [
      [{ left: 0, right: 2 }, true],
      [{ left: 1.5, right: 3 }, true],
      [{ left: -1, right: 2 }, false],
      [{ left: 2 }, false],
      [{ left: 2, right: 2, other: 1 }, false],
    ] as const) {
      const bundle = {
        processions: [{ ...street, segments: [{ ...street.segments[0]!, sidewalks_m }] }],
      };
      expect(CityProcessions.safeParse(bundle).success).toBe(accepted);
      expect(isCityProcessions(bundle)).toBe(accepted);
    }
    for (const p of [fluvial, street, { ...street, kind: 'parade' }, mass]) {
      expect(CityProcessions.safeParse({ processions: [p] }).success).toBe(true);
      expect(isCityProcessions({ processions: [p] })).toBe(true);
    }
    for (const [offset_days, duration_min, accepted] of [
      [-31, 1, true],
      [31, 1440, true],
      [-32, 1, false],
      [32, 1, false],
      [0, 0, false],
      [0, 1441, false],
    ] as const) {
      const bundle = {
        processions: [{ ...street, schedule: { ...base.schedule, offset_days, duration_min } }],
      };
      expect(CityProcessions.safeParse(bundle).success).toBe(accepted);
      expect(isCityProcessions(bundle)).toBe(accepted);
    }
    for (const p of [
      { ...street, segments: [] },
      { ...street, formation: { columns: 2 } },
      { ...mass, route },
      { ...fluvial, banks: [[1, 2]] },
      { ...street, season: 'fiesta' },
      { ...mass, schedule: { ...base.schedule, start: '25:00' } },
    ]) {
      expect(CityProcessions.safeParse({ processions: [p] }).success).toBe(false);
      expect(isCityProcessions({ processions: [p] })).toBe(false);
    }
  });
  it('city meta', () => {
    expect(CityMeta.safeParse(meta).success).toBe(true);
    expect(isCityMeta(meta)).toBe(true);
    for (const broken of [
      { ...meta, slug: '' },
      { ...meta, name: { fil: 'no English' } },
      { ...meta, regionBounds: [0, 1, 4] },
      { ...meta, defaultCamera: { ...meta.defaultCamera, zoom: 30 } },
      { ...meta, yearRange: '1900-2026' },
      null,
    ]) {
      expect(CityMeta.safeParse(broken).success).toBe(false);
      expect(isCityMeta(broken)).toBe(false);
    }
  });

  it('subdivision areas', () => {
    expect(SubdivisionAreas.safeParse(areas).success).toBe(true);
    expect(isSubdivisionAreas(areas)).toBe(true);
    for (const broken of [{}, [{ ...areas[0], approximate: 'no' }], [{ name: 'x' }]]) {
      expect(SubdivisionAreas.safeParse(broken).success).toBe(false);
      expect(isSubdivisionAreas(broken)).toBe(false);
    }
  });

  it('search index', () => {
    expect(SearchIndexFile.safeParse(index).success).toBe(true);
    expect(isSearchIndexFile(index)).toBe(true);
    for (const broken of [
      { ...index, version: 2 },
      { ...index, entries: [{ ...index.entries[0], lat: '3' }] },
      { ...index, entries: 'none' },
    ]) {
      expect(SearchIndexFile.safeParse(broken).success).toBe(false);
      expect(isSearchIndexFile(broken)).toBe(false);
    }
  });
});
