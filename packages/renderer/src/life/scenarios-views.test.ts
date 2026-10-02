import { expect, it } from 'vitest';
import { makeScenario, scenarioState, worldTiles, retiredTiles } from './testing/scenarios';
import { bounded, valid } from './testing/scenario-checks';

// Split from scenarios.test.ts so these run in parallel with the soaks.
for (const seed of [1, 42]) {
  // eslint-disable-next-line no-restricted-syntax -- 100 view cycles; tracked by the CI file budget
  it(`seed ${seed}: view changes revive tiles and respawn deterministically after expiry`, () => {
    const s = makeScenario('transit', 4, false, seed);
    bounded(s.world);
    const original = worldTiles(s.world).get(s.tiles[0]!.key)!;
    for (let cycle = 0; cycle < 100; cycle++) {
      s.world.sync(s.tiles.slice(0, 1));
      expect(worldTiles(s.world).get(s.tiles[0]!.key)).toBe(original);
      const before = original.movers.map((m) => [m.x, m.y, m.pause]);
      for (let frame = 0; frame < 30; frame++)
        s.world.step(1 / 30, undefined, 18, [0, 0, 0.001, 0.001]);
      expect(original.movers.map((m) => [m.x, m.y, m.pause])).toEqual(before);
      s.world.sync(s.tiles);
      bounded(s.world);
      for (let frame = 0; frame < 24; frame++) s.step(frame);
      valid(s.world);
    }
    s.world.sync([]);
    expect(worldTiles(s.world).size).toBe(0);
    expect((s.world as unknown as { groundTerrain?: unknown }).groundTerrain).toBeUndefined();
    for (let i = 0; i < 90; i++) s.world.step(0.1);
    expect(retiredTiles(s.world).size).toBe(0);
    s.world.sync(s.tiles);
    bounded(s.world);
    const fresh = makeScenario('transit', 4, false, seed);
    bounded(fresh.world);
    expect(scenarioState(s.world)).toEqual(scenarioState(fresh.world));
    expect(worldTiles(s.world).get(s.tiles[0]!.key)).not.toBe(original);
    s.world.setTraffic();
    expect(worldTiles(s.world).size).toBe(0);
  }, 30_000);
}
