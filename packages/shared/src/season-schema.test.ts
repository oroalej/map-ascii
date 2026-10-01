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
