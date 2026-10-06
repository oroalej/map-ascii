import { expect, it } from 'vitest';
import { LifeWorld, TileLife } from './simulate';
import { signalizedCrossingEntry, seedSignalizedCrossing } from './testing/signalized-crossing';
import { completeScenarioState, worldTiles } from './testing/scenarios';
import { pedestrianState } from './signals';
import { bodyCorners } from './occupancy';

it('clamps an oversized ordinary step after its bend and restores a rejected full trial', () => {
  const entry = signalizedCrossingEntry(),
    world = new LifeWorld();
  world.sync([entry]);
  const { life, m } = seedSignalizedCrossing(world),
    pm = life.perMeter;
  const red = Array.from({ length: 100 }, (_, i) => i).find(
    (t) => pedestrianState(7, t, false, 'a') === 'dont',
  )!;
  (life as unknown as { walkerRng: () => number }).walkerRng = () => 1;
  const before = structuredClone(m);
  life.step(0.1, undefined, undefined, undefined, { clock: red }, () => false);
  expect(m.x).toBe(before.x);
  expect(m.y).toBe(before.y);
  expect(m.crossingWait).toBeUndefined();
  life.step(20, undefined, undefined, undefined, { clock: red });
  expect(m.from).toBe(3);
  expect((m.y - 2000) / pm).toBeCloseTo(-5.46);
  expect(m.crossingWait?.waiting).toBeDefined();
});
for (const hz of [30, 60, 120])
  it(`replays accepted waiting and release exactly in two complete worlds at ${hz} Hz`, () => {
    const worlds = [new LifeWorld(), new LifeWorld()];
    const agents = worlds.map((world) => {
      world.sync([signalizedCrossingEntry()]);
      return seedSignalizedCrossing(world);
    });
    let waiting = false,
      released = false;
    for (let frame = 0; frame < 35 * hz; frame++) {
      for (const world of worlds)
        world.step(1 / hz, undefined, 19, undefined, undefined, { rain: 0 }, 0.9);
      waiting ||= !!agents[0]!.m.crossingWait?.waiting;
      released ||= waiting && !!agents[0]!.m.crossingWait?.commitments.length;
    }
    expect(waiting).toBe(true);
    expect(released).toBe(true);
    expect(completeScenarioState(worlds[0]!)).toEqual(completeScenarioState(worlds[1]!));
  });
it('releases retired claims, retains the immutable payload, and restores compatible revival', () => {
  const entry = signalizedCrossingEntry(),
    world = new LifeWorld();
  world.sync([entry]);
  const { life, m } = seedSignalizedCrossing(world);
  for (let i = 0; i < 120; i++)
    world.step(0.1, undefined, 19, undefined, undefined, { rain: 0 }, 0.9);
  expect(m.crossingWait?.waiting).toBeDefined();
  const payload = m.crossingWait;
  world.sync([]);
  expect(world.crossingReservations.snapshot().claims).toHaveLength(0);
  expect(m.crossingWait).toBe(payload);
  world.sync([entry]);
  expect(worldTiles(world).get(entry.key)).toBe(life);
  world.step(0.1, undefined, 19, undefined, undefined, { rain: 0 }, 0.9);
  expect(m.crossingWait?.waiting).toBeDefined();
  expect(life.roadTerrain.access.allows(life.groundBodies(m), false)).toBe(true);
});
it('keeps waiting members fixed under reversal and preserves rejected adoption', () => {
  const entry = signalizedCrossingEntry(),
    world = new LifeWorld();
  world.sync([entry]);
  const { life, m } = seedSignalizedCrossing(world);
  for (let i = 0; i < 100; i++)
    world.step(0.1, undefined, 19, undefined, undefined, { rain: 0 }, 0.9);
  expect(m.crossingWait?.waiting).toBeDefined();
  const before = life.groundBodies(m);
  m.hx = -m.hx;
  m.hy = -m.hy;
  expect(life.groundBodies(m)).toEqual(before);
  const destination = new TileLife(entry.tile, structuredClone(entry.life), 2),
    payload = structuredClone(m),
    claims = world.crossingReservations.snapshot();
  expect(destination.adoptFrom(m, life, {}, () => false)).toBe(false);
  expect(m).toEqual(payload);
  expect(world.crossingReservations.snapshot()).toEqual(claims);
  expect(
    life.groundBodies(m).every((b) => bodyCorners(b).every((p) => p.y <= 2000 / life.perMeter - 5)),
  ).toBe(true);
});
