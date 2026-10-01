/** Captured from main b97ef42 before seasonal rendering/simulation changes. */
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { makeScenario, completeScenarioState, SCENARIOS } from './testing/scenarios';
import { mapGlyphs, themes } from '../theme';
import { packFixtures, updateFixtureFlags } from './fixtures';
import { LampState, packLights } from './lights';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const baseline = {
  sparse: 'c3e1b62f60429d70e90664bfd329e0b08dcf6fce8d5330d3e1761d0dea30925b',
  junction: '8a71b2058e8607dbafc33423a42ff14ee8e501d90166bb20ea45480ba7170128',
  crossroads: '4cdf614fcd177142b81d86dad60ab2f254e4c438245a179d28ccff56cbb43442',
  transit: '0c862daea63e4280b12df241c8c1b4acbd0d85c7d3344d199faba0dd862732e8',
  rain: '0de6d3a10df927f6d47e9f5c2514a055cc2d34e265e9955c52a6bb2a60475b79',
};
for (const kind of SCENARIOS)
  it(`preserves the unseasoned ${kind} simulation`, () => {
    const s = makeScenario(kind, 4);
    for (let frame = 0; frame < 60; frame++) s.step(frame);
    expect(hash(completeScenarioState(s.world))).toBe(baseline[kind]);
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
