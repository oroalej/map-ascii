import { describe, expect, it } from 'vitest';
import { LifeSite, CityLife } from './schemas';
import { transitMask } from './life-sites';
const site = {
  id: 'example',
  kind: 'stop',
  osm_id: 'osm:node/1',
  modes: ['bus'],
  source: 'OpenStreetMap',
};
describe('sourced life sites', () => {
  it('accepts OSM annotations and sourced missing coordinates', () => {
    expect(LifeSite.safeParse(site).success).toBe(true);
    expect(
      LifeSite.safeParse({ id: 'gazebo', kind: 'shelter', position: [120, 14], source: 'Survey' })
        .success,
    ).toBe(true);
    expect(transitMask(['bus', 'jeepney', 'tricycle'])).toBe(7);
  });
  it('rejects unsourced, ambiguous, invalid, and modeless transit records', () => {
    for (const bad of [
      { ...site, source: '' },
      { ...site, osm_id: undefined },
      { ...site, position: [120, 14] },
      { ...site, modes: [] },
      { ...site, osm_id: 'fake' },
      { ...site, osm_id: undefined, position: [200, 95] },
    ])
      expect(LifeSite.safeParse(bad).success).toBe(false);
  });
  it('accepts existing packs and rejects duplicate site ids', () => {
    expect(CityLife.safeParse({ source: 'Default' }).success).toBe(true);
    expect(CityLife.safeParse({ source: 'Survey', sites: [site, site] }).success).toBe(false);
  });
});
