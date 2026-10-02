/** Inactive calendars must leave seeded worlds unchanged; legacy fixture bytes remain pinned. */
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { makeScenario, completeScenarioState, SCENARIOS } from './testing/scenarios';
import { mapGlyphs, themes } from '../theme';
import { packFixtures, updateFixtureFlags } from './fixtures';
import { LampState, packLights } from './lights';
import { simulationSeasons } from './seasonal-simulation';
import type { SeasonConfig } from '@atlas/shared';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inactive: SeasonConfig = {
  id: 'winter',
  title: { en: 'Winter' },
  status: 'draft',
  sources: [{ title: 'Synthetic', url: 'https://example.com/' }],
  window: { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } },
  stalls: { label: 'Carts', near: ['worship'], radius_m: 300, per_tile: 12 },
  installations: [
    {
      id: 'tree',
      kind: 'christmas-tree',
      anchor: 'osm:way/1',
      label: 'Tree',
      radius_m: 5,
      sources: [{ title: 'Synthetic', url: 'https://example.com/' }],
    },
  ],
};
for (const kind of SCENARIOS)
  it(`preserves the unseasoned ${kind} simulation with an inactive calendar`, () => {
    const a = makeScenario(kind, 2),
      b = makeScenario(kind, 2);
    b.world.setSeasons(simulationSeasons([inactive]));
    for (let frame = 0; frame < 60; frame++) {
      if (frame === 20 || frame === 30) {
        const tiles = frame === 20 ? a.tiles.slice(0, 1) : a.tiles;
        a.world.sync(tiles);
        b.world.sync(structuredClone(tiles));
      }
      const weather = a.environment(frame * 6);
      const dt = frame % 7 ? 1 / 30 : 0;
      a.world.step(dt, undefined, 18, a.bounds, undefined, weather, 0.9);
      b.world.step(dt, undefined, 18, b.bounds, undefined, { ...weather, season: null }, 0.9);
      expect(b.world.visible(18, b.levels, b.center, { ...weather, sunAltitude: 45 })).toEqual(
        a.world.visible(18, a.levels, a.center, { ...weather, sunAltitude: 45 }),
      );
    }
    expect(completeScenarioState(b.world)).toEqual(completeScenarioState(a.world));
  });
it('preserves legacy glyph indices, fixtures, animated flags and light bytes', () => {
  const grid = {
    cols: 100,
    rows: 100,
    cellWidth: 5,
    cellHeight: 9,
    toCell: (x: number, y: number): [number, number] => [x, y],
  };
  const lamp = {
    kind: 'streetlight' as const,
    base: [40.5, 40.5] as [number, number],
    tip: [43.5, 40.5] as [number, number],
    forward: [41.5, 40.5] as [number, number],
    right: [40.5, 41.5] as [number, number],
    roadCenter: [45.5, 40.5] as [number, number],
    state: LampState.flicker,
    seed: 17,
  };
  const signal = {
    kind: 'signal' as const,
    base: [60.5, 60.5] as [number, number],
    tip: [61.5, 60.5] as [number, number],
    forward: [61.5, 60.5] as [number, number],
    right: [60.5, 61.5] as [number, number],
    seed: 7,
    group: 'a' as const,
    midBlock: false,
  };
  for (const theme of Object.values(themes)) {
    const glyphs = mapGlyphs(theme);
    expect(hash(glyphs.slice(0, 303))).toBe(
      'ba5964e923cd6355deff42effe5ecdac79e81b148241d4ab53ee82466dd34eb0',
    );
    const packed = packFixtures(
      new Uint8Array(40000),
      grid,
      [lamp, signal, { ...lamp, base: [20.5, 40.5], kind: 'flagpole', flag: 'PH' }],
      20.5,
      (g) => glyphs.indexOf(g),
      0,
    );
    expect(hash([...packed.texels])).toBe(
      'bd463ef3daa52a831482ebc06133fad6ef1652a3538e9db9392f24a1f238a978',
    );
    updateFixtureFlags(packed, { time: 0.7, strength: 0.7 });
    expect(hash([...packed.texels])).toBe(
      '0f788cad730bcc00329f9870719accb62962bdc5c5ccee1879d4ce8054e06cc0',
    );
  }
  const lights = new Uint8Array(40000);
  packLights(lights, grid, [
    {
      lng: 20,
      lat: 20,
      center: [20, 20],
      pool: [20, 20],
      east: [24, 20],
      north: [20, 16],
      state: LampState.working,
      seed: 17,
    },
  ]);
  expect(hash([...lights])).toBe(
    '335ea64c203da4615665d5d5d086b53514ac0cb685199d066af64c573fd05aa2',
  );
});
