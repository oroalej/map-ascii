import {
  CityMeta,
  CityProcessions,
  SearchIndexFile,
  SubdivisionAreas,
} from '@atlas/shared/schemas';
import { PROCESSION_DEFAULTS } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import { isCityMeta, isCityProcessions, isSearchIndexFile, isSubdivisionAreas } from './guards';
import { isCityEmergency } from './guards';
import { emergencyFixture } from '../components/emergency-fixtures.test-utils';

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
  it('validates finite emergency geography and every decoded graph reference', () => {
    expect(isCityEmergency(emergencyFixture)).toBe(true);
    for (const broken of [
      { ...emergencyFixture, version: 2 },
      { ...emergencyFixture, origin: [NaN, 0] },
      { ...emergencyFixture, nodes: 'invalid!' },
      {
        ...emergencyFixture,
        targets: emergencyFixture.targets.map((t) => {
          const copy = [...t];
          copy[4] = 9999;
          return copy;
        }),
      },
    ])
      expect(isCityEmergency(broken)).toBe(false);
  });
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
    const agrees = (event: unknown, accepted: boolean) => {
      const bundle = { processions: [event] };
      expect(CityProcessions.safeParse(bundle).success).toBe(accepted);
      expect(isCityProcessions(bundle)).toBe(accepted);
    };
    const formation = { images: 2, bearers: 64, ranks: 16, columns: 10, marshals: 10 };
    agrees({ ...street, formation }, true);
    agrees({ ...street, formation: { ...formation, marshals: 11 } }, false);
    agrees(
      { ...street, formation: { images: 3, bearers: 64, ranks: 20, columns: 10, marshals: 32 } },
      false,
    );
    agrees({ ...street, formation: { images: 3, bearers: 64, marshals: 32 } }, true);
    agrees({ ...street, formation: { images: 3, bearers: 64, marshals: 32, ranks: 13 } }, false);
    agrees(
      {
        ...street,
        kind: 'parade',
        formation: {
          contingents: 72,
          bands: 6,
          band: 48,
          color_guard: 8,
          vehicles: ['car', 'car', 'car', 'car'],
        },
      },
      true,
    );
    agrees({ ...fluvial, formation: { columns: 6, ranks: 20, escorts: 40, followers: 139 } }, true);
    agrees(
      { ...fluvial, formation: { columns: 6, ranks: 20, escorts: 40, followers: 140 } },
      false,
    );
    for (const [event, defaults, key, min, max] of [
      [fluvial, PROCESSION_DEFAULTS.fluvial, 'followers', 0, 200],
      [street, PROCESSION_DEFAULTS.procession, 'columns', 2, 10],
      [street, PROCESSION_DEFAULTS.procession, 'images', 1, 3],
      [{ ...street, kind: 'parade' }, PROCESSION_DEFAULTS.parade, 'bands', 0, 6],
      [{ ...street, kind: 'parade' }, PROCESSION_DEFAULTS.parade, 'columns', 2, 10],
    ] as const)
      for (const value of [min, max, min - 1, max + 1])
        agrees(
          { ...event, formation: { ...defaults, [key]: value } },
          value >= min && value <= max,
        );
    agrees({ ...street, formation: { ...PROCESSION_DEFAULTS.procession, followers: 2 } }, false);
    agrees({ ...fluvial, formation: { ...PROCESSION_DEFAULTS.fluvial, images: 2 } }, false);
    for (const clear_m of [undefined, 5, 8, 0, 8.1, Infinity])
      agrees(
        { ...street, segments: [{ ...street.segments[0], clear_m }] },
        clear_m === undefined || (clear_m > 0 && clear_m <= 8),
      );
    for (const verge_m of [
      { left: 6, right: 0 },
      { left: 6.1, right: 0 },
      { left: 2, right: 2, other: 1 },
    ])
      agrees(
        { ...street, segments: [{ ...street.segments[0], verge_m }] },
        !('other' in verge_m) && verge_m.left <= 6,
      );
    const rings = mass.site.grounds;
    agrees({ ...street, crowd_grounds: rings }, true);
    agrees(
      { ...fluvial, crowd_ground: { grounds: rings, blocked: [], water: [], bridges: [] } },
      true,
    );
    // A river event's pagoda can stop at a landing short of the route's end.
    for (const [landing_m, valid] of [
      [400, true],
      [0, false],
      ['400', false],
    ] as const)
      agrees({ ...fluvial, landing_m }, valid);
    // ...and set off past a stretch of river kept behind it for its followers.
    for (const [departure_m, valid] of [
      [400, true],
      [-1, false],
    ] as const)
      agrees({ ...fluvial, departure_m }, valid);
    // A river event's owner-marked ground closes to traffic.
    for (const [closure_zone, valid] of [
      [rings, true],
      [[[route[0], route[0]]], false],
    ] as const)
      agrees(
        {
          ...fluvial,
          crowd_ground: { grounds: rings, blocked: [], water: [], bridges: [], closure_zone },
        },
        valid,
      );
    agrees(
      {
        ...mass,
        site: {
          ...mass.site,
          closure_zone: rings,
          seated_grounds: rings,
          altar_ground: rings,
          altar: { at: route[0], radius_m: 5, images: 2 },
        },
      },
      true,
    );
    agrees(
      { ...mass, site: { ...mass.site, altar: { at: route[0], radius_m: 5, images: 4 } } },
      false,
    );
    for (const [status, label, accepted] of [
      ['draft', { en: '   ' }, false],
      ['draft', { en: 'TODO(verify)' }, true],
      ['verified', { en: 'TODO(verify)' }, false],
      ['verified', { en: 'Procession', fil: 'TODO(verify)' }, false],
      ['verified', { en: 'Procession' }, true],
    ] as const) {
      const bundle = {
        processions: [
          { ...street, status, season: 'fiesta', label, sources: [{ title: 'Fixture' }] },
        ],
      };
      expect(CityProcessions.safeParse(bundle).success).toBe(accepted);
      expect(isCityProcessions(bundle)).toBe(accepted);
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
      { ...street, formation: { columns: 11 } },
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
