import { describe, expect, it } from 'vitest';
import { City, CityLife, Season } from './schemas';
import { FIREWORK_VARIANTS } from './seasons';

const season = {
  id: 'winter',
  title: { en: 'Winter' },
  status: 'draft',
  window: { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } },
  note: 'TODO(verify): annual dates and placement',
  lanterns: { label: 'Lanterns', shape: 'star' },
  sources: [{ title: 'Calendar', url: 'https://example.org/' }],
};
describe('season content validation', () => {
  it('requires sourced, bounded access routes in matching grounds', () => {
    const grounds = {
      id: 'lot',
      anchor: 'osm:way/1',
      sources: season.sources,
      ring: [
        [0, 0],
        [0.001, 0],
        [0.001, 0.001],
        [0, 0.001],
        [0, 0],
      ],
    };
    const access = {
      id: 'walk',
      kind: 'access-path',
      anchor: grounds.anchor,
      grounds: grounds.id,
      label: 'Access',
      sources: season.sources,
      style: 'walkway',
      width_m: 1.8,
      points: [
        [0.0001, 0.0001],
        [0.0009, 0.0009],
      ],
    };
    const config = { ...season, grounds: [grounds], installations: [access] };
    expect(Season.safeParse(config).success).toBe(true);
    expect(
      Season.safeParse({ ...config, installations: [{ ...access, style: 'parking', width_m: 6 }] })
        .success,
    ).toBe(true);
    expect(
      Season.safeParse({
        ...config,
        installations: [{ ...access, style: 'parking', width_m: 5.49 }],
      }).success,
    ).toBe(false);
    for (const change of [
      { grounds: 'missing' },
      { sources: [] },
      { width_m: 0.99 },
      { width_m: 12.01 },
      { points: [access.points[0]] },
      { points: [access.points[0], access.points[0]] },
      { style: 'road' },
      {
        points: [
          [0, 90],
          [0.001, 90],
        ],
      },
      { mount: 'canopy' },
    ])
      expect(
        Season.safeParse({ ...config, installations: [{ ...access, ...change }] }).success,
      ).toBe(false);
  });
  it('accepts fireworks-only calendars and rejects unknown, empty or duplicate variants', () => {
    const only = {
      ...season,
      lanterns: undefined,
      fireworks: { label: 'Fireworks and smoke', variants: [...FIREWORK_VARIANTS] },
    };
    expect(Season.safeParse(only).success).toBe(true);
    for (const fireworks of [
      { ...only.fireworks, variants: [] },
      { ...only.fireworks, variants: ['peony', 'peony'] },
      { ...only.fireworks, variants: ['unknown'] },
      { ...only.fireworks, label: ' ' },
      { ...only.fireworks, density: 100000 },
    ])
      expect(Season.safeParse({ ...only, fireworks }).success).toBe(false);
    expect(
      Season.safeParse({ ...only, fireworks: { label: 'Ring', variants: ['ring'] } }).success,
    ).toBe(true);
  });
  it('requires simple sourced property grounds and matching installation references', () => {
    const grounds = {
      id: 'forecourt',
      anchor: 'osm:way/1',
      sources: season.sources,
      ring: [
        [0, 0],
        [0.001, 0],
        [0.001, 0.001],
        [0, 0.001],
        [0, 0],
      ],
    };
    const tree = {
      id: 'tree',
      anchor: grounds.anchor,
      grounds: grounds.id,
      label: 'Tree',
      sources: season.sources,
      kind: 'christmas-tree',
      radius_m: 3,
    };
    const only = { ...season, lanterns: undefined, grounds: [grounds], installations: [tree] };
    expect(Season.safeParse(only).success).toBe(true);
    const roofLights = {
      ...tree,
      kind: 'light-string',
      radius_m: undefined,
      layout: 'building-perimeter',
      spacing_m: 3,
    };
    // Strict definitions: tree-only fields and property grounds must not leak into roof lights.
    const { radius_m: _radius, grounds: _grounds, ...mounted } = roofLights;
    expect(Season.safeParse({ ...only, installations: [mounted] }).success).toBe(true);
    expect(
      Season.safeParse({ ...only, installations: [{ ...mounted, mount: 'canopy' }] }).success,
    ).toBe(false);
    expect(
      Season.safeParse({ ...only, installations: [{ ...mounted, grounds: grounds.id }] }).success,
    ).toBe(false);
    for (const change of [
      { sources: [] },
      { anchor: 'osm:node/1' },
      { ring: grounds.ring.slice(0, -1) },
      {
        ring: [
          [0, 0],
          [0.001, 0.001],
          [0.001, 0],
          [0, 0.001],
          [0, 0],
        ],
      },
      {
        ring: [
          [0, 0],
          [0, 0],
          [0.001, 0],
          [0, 0],
        ],
      },
      {
        ring: [
          [0, 0],
          [0.001, 0],
          [0.002, 0],
          [0, 0],
        ],
      },
      {
        ring: [
          [181, 0],
          [0.001, 0],
          [0.001, 0.001],
          [0, 0.001],
          [181, 0],
        ],
      },
    ])
      expect(Season.safeParse({ ...only, grounds: [{ ...grounds, ...change }] }).success).toBe(
        false,
      );
    expect(Season.safeParse({ ...only, grounds: [grounds, grounds] }).success).toBe(false);
    expect(Season.safeParse({ ...only, grounds: undefined }).success).toBe(false);
    expect(
      Season.safeParse({ ...only, installations: [{ ...tree, anchor: 'osm:way/2' }] }).success,
    ).toBe(false);
    expect(
      Season.safeParse({ ...only, installations: [{ ...tree, grounds: 'unknown' }] }).success,
    ).toBe(false);
  });
  it('requires sourced, bounded and unique installation definitions and admits installation-only seasons', () => {
    const tree = {
      id: 'tree',
      anchor: 'osm:way/1',
      label: 'Tree',
      kind: 'christmas-tree',
      radius_m: 4,
      sources: season.sources,
    };
    const only = { ...season, lanterns: undefined, installations: [tree] };
    expect(Season.safeParse(only).success).toBe(true);
    for (const installations of [
      [{ ...tree, sources: [] }],
      [{ ...tree, radius_m: 0 }],
      [{ ...tree, anchor: 'unmapped' }],
      [tree, tree],
      [{ ...tree, layout: 'paths' }],
      [],
    ])
      expect(Season.safeParse({ ...only, installations }).success).toBe(false);
  });
  it('accepts sourced drafts and fully verified records', () => {
    expect(Season.safeParse(season).success).toBe(true);
    expect(
      Season.safeParse({ ...season, status: 'verified', note: 'Confirmed calendar' }).success,
    ).toBe(true);
  });
  it('requires sources, decorations, and a draft verification note', () => {
    for (const change of [
      { sources: [] },
      { lanterns: undefined },
      { note: undefined },
      { note: 'Unconfirmed' },
      { id: 'auto' },
    ])
      expect(Season.safeParse({ ...season, ...change }).success).toBe(false);
  });
  it('rejects verified TODOs in any title language or note', () => {
    expect(Season.safeParse({ ...season, status: 'verified' }).success).toBe(false);
    expect(
      Season.safeParse({
        ...season,
        status: 'verified',
        note: undefined,
        title: { en: 'Winter', fil: 'TODO(verify)' },
      }).success,
    ).toBe(false);
  });
  it('rejects unknown keys, impossible dates, duplicate IDs, and incomplete placement filters', () => {
    expect(Season.safeParse({ ...season, extra: true }).success).toBe(false);
    expect(
      Season.safeParse({ ...season, lanterns: { ...season.lanterns, extra: true } }).success,
    ).toBe(false);
    expect(
      Season.safeParse({
        ...season,
        window: { from: { month: 2, day: 30 }, to: { month: 3, day: 1 } },
      }).success,
    ).toBe(false);
    expect(CityLife.safeParse({ source: 'Calendar', seasons: [season, season] }).success).toBe(
      false,
    );
    expect(
      Season.safeParse({ ...season, lanterns: { ...season.lanterns, near: ['worship'] } }).success,
    ).toBe(false);
    expect(
      Season.safeParse({ ...season, lanterns: { ...season.lanterns, near: [], radius_m: 300 } })
        .success,
    ).toBe(false);
  });
  it('checks season title languages against the city', () => {
    const city = {
      slug: 'test',
      name: { en: 'Test' },
      country: 'PH',
      boundary: { name: 'Test', admin_level: 6 },
      detail_buffer_km: 0,
      region: { bbox: [1, 1, 2, 2] },
      subdivision: { admin_level: 10, label: { en: 'District' } },
      languages: ['fil'],
      smoke_landmark: 'Test',
      life: { source: 'Calendar', seasons: [season] },
    };
    expect(City.safeParse(city).success).toBe(true);
    expect(
      City.safeParse({
        ...city,
        life: { ...city.life, seasons: [{ ...season, title: { en: 'Winter', ja: 'Winter' } }] },
      }).success,
    ).toBe(false);
  });
});
