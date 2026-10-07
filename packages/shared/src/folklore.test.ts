import { describe, expect, it } from 'vitest';
import { CityLife, RuntimeCityLifeSchema } from './schemas';

const source = { title: 'Folklore reference', url: 'https://example.org/' };
const season = {
  id: 'undas',
  title: { en: 'Undas' },
  sources: [source],
  candles: { label: 'Candles', share: 0.5 },
  window: { from: { month: 10, day: 31 }, to: { month: 11, day: 2 } },
};
const folklore = {
  hours: { from: 1320, to: 240 },
  ghosts: {
    sites: ['cemetery', 'worship', 'hospital'],
    per_cemetery: [1, 2],
    undas_per_cemetery: [3, 6],
    undas_season: 'undas',
    site_share: 0.5,
    range_m: [30, 50],
  },
  manananggal: { window: season.window, night_chance: 0.35 },
  sources: [source],
};
describe('city folklore configuration', () => {
  it('keeps absent folklore optional and preserves configured runtime values', () => {
    expect(CityLife.parse({ source: 'example' }).folklore).toBeUndefined();
    expect(
      RuntimeCityLifeSchema.parse({ source: 'example', seasons: [season], folklore }).folklore,
    ).toEqual(folklore);
  });
  it('rejects an unknown Undas season and unbounded or malformed configuration', () => {
    const life = { source: 'example', seasons: [season], folklore };
    expect(CityLife.safeParse(life).success).toBe(true);
    expect(
      CityLife.safeParse({
        ...life,
        folklore: { ...folklore, ghosts: { ...folklore.ghosts, undas_season: 'missing' } },
      }).success,
    ).toBe(false);
    for (const change of [
      { sources: [] },
      { hours: { from: 240, to: 240 } },
      { extra: true },
      { manananggal: { ...folklore.manananggal, night_chance: 1.1 } },
      { ghosts: { ...folklore.ghosts, range_m: [50, 30] } },
    ])
      expect(CityLife.safeParse({ ...life, folklore: { ...folklore, ...change } }).success).toBe(
        false,
      );
  });
});
