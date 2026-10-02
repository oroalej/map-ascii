import { describe, expect, it } from 'vitest';
import { City, CityLife, Season } from './schemas';

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
  it('bounds street light targets and keeps road-only fields out of public-area layouts', () => {
    const street = {
      id: 'road-lights',
      anchor: 'osm:way/1',
      label: 'Lights',
      sources: season.sources,
      kind: 'light-string',
      layout: 'street',
      spacing_m: 3,
      ways: ['osm:way/1', 'osm:way/2'],
      from: 'osm:way/3',
      to: 'osm:node/4',
    };
    const accepts = (installation: object) =>
      Season.safeParse({ ...season, lanterns: undefined, installations: [installation] }).success;
    expect(accepts(street)).toBe(true);
    expect(accepts({ ...street, from: undefined, to: undefined })).toBe(true);
    for (const change of [
      { ways: undefined },
      { ways: [] },
      { ways: ['osm:way/2'] },
      { ways: ['osm:way/1', 'osm:way/1'] },
      { ways: ['osm:way/1', 'osm:node/2'] },
      { ways: Array.from({ length: 101 }, (_, i) => `osm:way/${i + 1}`) },
      { from: 'unmapped' },
      { to: street.from },
      { spacing_m: 2.99 },
      { spacing_m: 12.01 },
      { sources: [] },
      { layout: 'paths' },
      { layout: 'perimeter' },
    ])
      expect(accepts({ ...street, ...change })).toBe(false);
    const { ways: _ways, from: _from, to: _to, ...area } = street;
    for (const layout of ['paths', 'perimeter']) {
      expect(accepts({ ...area, layout })).toBe(true);
      expect(accepts({ ...area, layout, from: street.from })).toBe(false);
      expect(accepts({ ...area, layout, to: street.to })).toBe(false);
    }
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
