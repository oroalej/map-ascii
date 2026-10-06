import { expect, it, vi } from 'vitest';
import { LifeWorld, TileLife } from './simulate';
import { signalizedCrossingEntry, seedSignalizedCrossing } from './testing/signalized-crossing';
import { completeScenarioState, worldTiles } from './testing/scenarios';
import { pedestrianState } from './signals';
import { bodyCorners, bodyInside, bodiesOverlap, type Point } from './occupancy';
import { frameBetween } from './frames';
import { walkingBefore } from './continuity';
import type { TileId } from '../tiles';
import { signalizedCrossroads } from './testing/signalized-crossroads';
import { controlledTile } from './testing/signalized-crossing';

function projectedCrossing(tile: TileId, routeSnapM = 0) {
  const entry = signalizedCrossingEntry(),
    geo = structuredClone(entry.life),
    frame = frameBetween(entry.tile, tile);
  const point = (p: Point) => ({
    ...p,
    x: frame.x + p.x * frame.scale,
    y: frame.y + p.y * frame.scale,
  });
  for (let i = 0; i < geo.coords.length; i++)
    geo.coords[i] = (i % 2 ? frame.y : frame.x) + geo.coords[i]! * frame.scale;
  for (const area of geo.areas ?? []) area.rings = area.rings.map((ring) => ring.map(point));
  for (const crossing of geo.controlledCrossings ?? []) {
    crossing.anchor = point(crossing.anchor);
    crossing.quad = crossing.quad?.map(point);
    for (const side of crossing.sides ?? []) {
      side.centre = point(side.centre);
      side.gate = side.gate.map(point) as [Point, Point];
      side.pads = side.pads.map((ring) => ring.map(point));
      side.slots = side.slots.map(point);
    }
  }
  const destination = new TileLife(tile, geo, 2);
  // Snap the destination walking route while leaving the physical crossing unchanged.
  for (let i = geo.starts[1]!; i < geo.starts[2]!; i++)
    geo.coords[i * 2] = geo.coords[i * 2]! + routeSnapM * destination.perMeter;
  return destination;
}

function waitingPair() {
  const world = new LifeWorld();
  world.sync([signalizedCrossingEntry()]);
  const { life, m } = seedSignalizedCrossing(world);
  (life as unknown as { walkerRng: () => number }).walkerRng = () => 1;
  m.group!.push({ ...m.group![0]!, lateral: 1.2 });
  for (let i = 0; i < 120; i++)
    world.step(0.1, undefined, 19, undefined, undefined, { rain: 0 }, 0.9);
  expect(m.crossingWait?.waiting?.slots).toHaveLength(2);
  return { world, life, m };
}

for (const records of ['empty', 'unrelated'] as const)
  it(`rejects waiting adoption into an ${records} crossing registry without changing source ownership`, () => {
    const { world, life, m } = waitingPair();
    const geo = structuredClone(life.geo);
    if (records === 'empty') geo.controlledCrossings = [];
    else geo.controlledCrossings![0]!.id = 'another-crossing';
    const destination = new TileLife(life.tile, geo, 2);
    destination.crossingWaits.registry = world.crossingReservations;
    const payload = structuredClone(m);
    const claims = structuredClone(world.crossingReservations.snapshot());
    expect(destination.adoptFrom(m, life)).toBe(false);
    expect(m).toEqual(payload);
    expect(life.movers).toContain(m);
    expect(destination.movers).not.toContain(m);
    expect(world.crossingReservations.snapshot()).toEqual(claims);
  });

it('retains occupied adult and child slots when a fresh destination inherits guarded adoption context', () => {
  const world = new LifeWorld();
  world.sync([signalizedCrossingEntry()]);
  const { life, m } = seedSignalizedCrossing(world);
  (life as unknown as { walkerRng: () => number }).walkerRng = () => 1;
  m.group!.push({ ...m.group![0]!, figure: 'child', lateral: 1.2 });
  let transferred = false;
  for (let i = 0; i < 2400; i++) {
    world.step(0.02, undefined, 19, undefined, undefined, { rain: 0 }, 0.9);
    const wait = m.crossingWait?.waiting;
    if (!wait?.releasing || !world.crossingReservations.claim(wait.owner)?.slots.length) continue;
    const destination = new TileLife(life.tile, structuredClone(life.geo), 2);
    destination.crossingWaits.registry = world.crossingReservations;
    const preview = destination.projectFrom(m, life);
    if (!preview) continue;
    const side = destination.crossingWaits.records[0]!.sides[wait.side]!;
    const vacated = (minimum: number) => {
      const bodies = destination.groundBodies(preview, minimum);
      return world.crossingReservations.claim(wait.owner)!.slots.filter((id) => {
        const slot = side.slots[side.slotIds.indexOf(id)]!;
        return bodies.every(
          (body) =>
            !bodiesOverlap(body, { ...body, ...slot, hx: side.inward.x, hy: side.inward.y }, 0),
        );
      });
    };
    if (vacated(0).length === vacated(0.9).length) continue;
    const claims = structuredClone(world.crossingReservations.snapshot());
    expect(destination.adoptFrom(m, life)).toBe(true);
    expect(world.crossingReservations.snapshot()).toEqual(claims);
    transferred = true;
    break;
  }
  expect(transferred).toBe(true);
});

for (const tile of [
  { z: 17, x: controlledTile.x * 2, y: controlledTile.y * 2 },
  { ...controlledTile, x: controlledTile.x + 1 },
])
  it(`preserves waiting member poses through a snapped transfer to z${tile.z}/${tile.x}`, () => {
    const { world, life, m } = waitingPair(),
      destination = projectedCrossing(tile, 0.025),
      payload = structuredClone(m.crossingWait),
      frame = frameBetween(life.tile, tile),
      before = life.groundBodies(m),
      claims = world.crossingReservations.snapshot();
    destination.crossingWaits.registry = world.crossingReservations;
    const preview = destination.projectFrom(m, life)!;
    expect(preview).toBeDefined();
    expect(Math.abs(preview.x - (frame.x + m.x * frame.scale))).toBeGreaterThan(
      0.01 * destination.perMeter,
    );
    const ratio = (frame.scale * life.perMeter) / destination.perMeter;
    for (const owner of [preview, walkingBefore(destination, life, m, preview)]) {
      const bodies = destination.groundBodies(owner);
      for (let i = 0; i < bodies.length; i++) {
        expect(bodies[i]!.x).toBeCloseTo(frame.x / destination.perMeter + before[i]!.x * ratio);
        expect(bodies[i]!.y).toBeCloseTo(frame.y / destination.perMeter + before[i]!.y * ratio);
        expect(bodies[i]!.hx).toBe(before[i]!.hx);
        expect(bodies[i]!.hy).toBe(before[i]!.hy);
      }
    }
    expect(m.crossingWait).toEqual(payload);
    expect(destination.adoptFrom(m, life)).toBe(true);
    expect(destination.movers).toContain(m);
    expect(life.movers).not.toContain(m);
    expect(m.crossingWait?.waiting?.owner).toBe(payload!.waiting!.owner);
    expect(world.crossingReservations.snapshot()).toEqual(claims);
  });

it('adopts a releasing two-person cohort across zoom after it leaves the pad', () => {
  const { world, life, m } = waitingPair();
  let released = false;
  for (let i = 0; i < 400; i++) {
    world.step(0.1, undefined, 19, undefined, undefined, { rain: 0 }, 0.9);
    const wait = m.crossingWait?.waiting;
    if (!wait?.releasing || !wait.slots.length) continue;
    const side = life.crossingWaits.records[0]!.sides[wait.side]!;
    if (life.groundBodies(m, 0.9).every((body) => side.pads.some((pad) => bodyInside(body, [pad]))))
      continue;
    released = true;
    const destination = projectedCrossing({
        z: 17,
        x: controlledTile.x * 2,
        y: controlledTile.y * 2,
      }),
      payload = structuredClone(m),
      claims = world.crossingReservations.snapshot();
    destination.crossingWaits.registry = world.crossingReservations;
    expect(m.crossingWait!.commitments).toHaveLength(1);
    expect(destination.adoptFrom(m, life, {}, () => false)).toBe(false);
    expect(m).toEqual(payload);
    expect(world.crossingReservations.snapshot()).toEqual(claims);
    expect(destination.adoptFrom(m, life)).toBe(true);
    expect(m.crossingWait?.waiting?.releasing).toBe(true);
    expect(m.crossingWait?.commitments).toEqual(payload.crossingWait!.commitments);
    break;
  }
  expect(released).toBe(true);
});

it('runs dense signalized crossroads with exact stops and only off-road waiting bodies', () => {
  const geo = signalizedCrossroads(controlledTile),
    world = new LifeWorld();
  world.sync([{ key: 'dense-signals', tile: controlledTile, life: geo }]);
  const life = worldTiles(world).get('dense-signals')!;
  expect(life.crossingWaits.records).toHaveLength(4);
  expect(life.signals.signals[0]!.approaches).toHaveLength(4);
  expect(life.signals.signals[0]!.approaches!.every((a) => a.stopAlong !== undefined)).toBe(true);
  let waiting = 0;
  for (let frame = 0; frame < 300; frame++) {
    world.step(0.1, undefined, 19, undefined, undefined, { rain: 0 }, 0.9);
    for (const m of life.movers)
      if (m.crossingWait?.waiting && !m.crossingWait.waiting.releasing) {
        waiting++;
        expect(life.roadTerrain.access.allows(life.groundBodies(m, 0.9), false)).toBe(true);
      }
  }
  expect(waiting).toBeGreaterThan(0);
});

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
  life.step(0.1, undefined, undefined, undefined, { clock: red, rain: 0 }, () => false);
  expect(m.x).toBe(before.x);
  expect(m.y).toBe(before.y);
  expect(m.crossingWait).toBeUndefined();
  const physical = vi.fn(() => true);
  life.step(20, undefined, undefined, undefined, { clock: red, rain: 0 }, physical);
  expect(physical).toHaveBeenCalled();
  expect(m.from).toBe(3);
  expect((m.y - 2000) / pm).toBeCloseTo(-5.46);
  expect(m.crossingWait?.waiting).toBeDefined();
});

it('runs one crossing trial for an accepted world movement', () => {
  const world = new LifeWorld();
  world.sync([signalizedCrossingEntry()]);
  const { life } = seedSignalizedCrossing(world);
  const prepare = vi.spyOn(life.crossingWaits, 'prepare');
  const permits = vi.spyOn(life.crossingWaits, 'permits');
  const accept = vi.spyOn(life.crossingWaits, 'accept');
  world.step(1 / 60, undefined, 19, undefined, undefined, { rain: 0 }, 0.9);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(permits).toHaveBeenCalledTimes(1);
  expect(accept).toHaveBeenCalledTimes(1);
});

it('avoids queue scans and crossing cursor trials in a world without controlled crossings', () => {
  const entry = signalizedCrossingEntry();
  entry.life.controlledCrossings = [];
  const world = new LifeWorld();
  world.sync([entry]);
  const { life, m } = seedSignalizedCrossing(world);
  const index = vi.spyOn(life.movers, 'indexOf'),
    limit = vi.spyOn(life.crossingWaits, 'limit'),
    retain = vi.spyOn(world.crossingReservations, 'retain');
  world.step(1 / 60, undefined, 19, undefined, undefined, { rain: 0 }, 0.9);
  expect(m.crossingWait).toBeUndefined();
  expect(index).not.toHaveBeenCalled();
  expect(retain).not.toHaveBeenCalled();
  expect(limit.mock.calls.every((call) => call[5] === undefined)).toBe(true);
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
