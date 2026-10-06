import { expect } from 'vitest';
import { makeScenario, scenarioState, worldTiles, retiredTiles } from './scenarios';
import { bounded, valid } from './scenario-checks';

export function checkViewRevival(seed: number) {
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
}
