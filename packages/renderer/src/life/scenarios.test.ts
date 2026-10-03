import { describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import { makeScenario, scenarioState, worldTiles, SCENARIO_DIALOGUE } from './testing/scenarios';
import { bounded } from './testing/scenario-checks';
import { LifeWorld, type TileLife } from './simulate';
import { MAX_STEP_S } from './config';
import { bodiesOverlap, type Body, bodyCorners, Occupancy, PolygonIndex } from './occupancy';

it('exercises scene speech and visible cues when a performance scenario opts into dialogue', () => {
  const scenario = makeScenario('moments', 1, false, 1, LifeWorld, undefined, {
    dialogue: SCENARIO_DIALOGUE,
  });
  bounded(scenario.world);
  let cues = 0;
  for (let frame = 0; frame < 300; frame++)
    cues += scenario.step(frame).filter((agent) => agent.speech?.id.includes(':scene:')).length;
  const admissions = [...worldTiles(scenario.world).values()].reduce(
    (sum, tile) =>
      sum +
      Object.values(tile.momentHost.scenes.selector.selected).reduce((n, count) => n + count, 0),
    0,
  );
  expect(admissions).toBeGreaterThan(0);
  expect(cues).toBeGreaterThan(0);
});

describe('combined living-city scenarios', () => {
  for (const hz of [30, 60, 120])
    it(`replays ${hz} Hz inputs exactly and clamps oversized steps`, () => {
      const a = makeScenario('rain', 1),
        b = makeScenario('rain', 1);
      bounded(a.world);
      bounded(b.world);
      for (let frame = 0; frame < hz * 3; frame++) {
        assert.deepEqual(a.step(frame, 1 / hz), b.step(frame, 1 / hz));
      }
      expect(scenarioState(a.world)).toEqual(scenarioState(b.world));
      a.world.step(100, undefined, 18, a.bounds);
      b.world.step(MAX_STEP_S, undefined, 18, b.bounds);
      expect(scenarioState(a.world)).toEqual(scenarioState(b.world));
    });
});

describe('collision storage isolation', () => {
  it('reuses caller storage without changing allocating callers or retaining query neighbors', () => {
    const s = makeScenario('junction', 1),
      tile: TileLife = [...worldTiles(s.world).values()][0]!;
    const m = tile.movers.find((m) => m.kind === 'person')!;
    const out: Body[] = [];
    const fresh = tile.groundBodies(m, 0.9);
    expect(tile.groundBodies(m, 0.9, out)).toEqual(fresh);
    const first = out[0];
    m.x += 2;
    tile.groundBodies(m, 0.9, out);
    expect(out[0]).toBe(first);
    expect(out).not.toEqual(fresh);
    const corners = bodyCorners(out[0]!);
    const saved = corners[0];
    bodyCorners(out[0]!, corners);
    expect(corners[0]).toBe(saved);
    const occupied = new Occupancy(),
      owner = {};
    occupied.set(owner, out);
    expect(occupied.conflicts({}, out)).toBeGreaterThan(0);
    expect((occupied as unknown as { neighbors: Set<object> }).neighbors.size).toBe(0);
    occupied.delete(owner);
    expect((occupied as unknown as { bins: Map<number, unknown> }).bins.size).toBe(0);
    const p = new PolygonIndex();
    p.add([corners]);
    expect(p.hits(out)).toBe(true);
    expect((p as unknown as { tested: Set<unknown> }).tested.size).toBe(0);
    const second = new Occupancy();
    expect(second.conflicts({}, out)).toBe(0);
    expect(bodiesOverlap(out[0]!, out[0]!)).toBe(true);
  });
});
