import { afterEach, expect, it, vi } from 'vitest';
import { activityLevels, DRIVE, kinematicsOf } from './config';
import { cruise } from './driving';
import { driveMover, driveRoad, driveStep, driveStreams } from './testing/driving';
import type { GroundGuard, Mover } from './simulate';

afterEach(() => vi.restoreAllMocks());

it.each([0, 1] as const)(
  'actually speeds on a clear road with oneway %s, with bounded acceleration',
  (oneway) => {
    const life = driveRoad(1, 0, undefined, oneway),
      m = driveMover(life);
    driveStreams(life).rushRng = () => 0;
    driveStep(life);
    expect(m.rush).toBe(DRIVE.rush.seconds[0]);
    expect(m.v).toBe(m.speed); // admission leaves all current-frame limits intact
    driveStreams(life).rushRng = () => 1;
    for (let frame = 0; frame < 20; frame++) {
      const v = m.v!;
      driveStep(life);
      expect(m.v! - v).toBeLessThanOrEqual(kinematicsOf('car').accel * life.perMeter * 0.1 + 1e-8);
    }
    expect(m.v).toBeCloseTo(cruise(m, false), 8);
    expect(m.v).toBeGreaterThan(m.speed * 1.25);
    expect(life.motionStats.hardCaps).toBe(0);
  },
);

it('admits a boosted guarded bend and bounded residual travel after expiry and rain', () => {
  const life = driveRoad(1, Math.PI / 12),
    m = driveMover(life, 3000 - 5 * life.perMeter);
  driveStreams(life).rushRng = () => 1;
  m.rush = 5;
  m.v = cruise(m, false);
  m.roadShift = 0.5;
  const checks = life as unknown as {
    motionFits(
      m: Mover,
      before: Mover,
      distance: number,
      dt: number,
      guarded: boolean,
      fits: GroundGuard,
      rejected: (reason: string) => void,
      trial: { origin?: { x: number; y: number } },
    ): boolean;
    blockedRestoration: Map<Mover, unknown>;
  };
  const fits = checks.motionFits.bind(checks);
  let boosted = false,
    checked = 0;
  vi.spyOn(checks, 'motionFits').mockImplementation((...args) => {
    const [owner, before, distance] = args;
    const result = fits(...args);
    if (
      result &&
      owner.line === before.line &&
      owner.from === before.from &&
      owner.dir === before.dir
    ) {
      const a = life.pose(before, undefined, owner),
        b = life.pose(owner);
      const travel = Math.hypot(b.x - a.x, b.y - a.y);
      expect(travel).toBeLessThanOrEqual(distance + 1e-8 * life.perMeter);
      boosted ||= travel > owner.speed * 0.1;
      checked++;
    }
    return result;
  });
  life.step(0.1, undefined, undefined, undefined, { rain: 0 }, () => true);
  m.rush = 0.01;
  life.step(0.1, undefined, undefined, undefined, { rain: 0 }, () => true);
  expect(m.rush).toBe(0);
  expect(m.v).toBeGreaterThan(m.speed);
  life.step(0.1, undefined, undefined, undefined, { rain: 1 }, () => true);
  expect(boosted).toBe(true);
  expect(checked).toBe(3);
  expect(checks.blockedRestoration.has(m)).toBe(false);
});

it('reserves a slot for frozen and suppressed residents and reconciles conflicting episodes', () => {
  const life = driveRoad(),
    first = driveMover(life, 500),
    second = driveMover(life, 1500);
  first.rush = second.rush = 5;
  driveStreams(life).rushRng = () => 0;
  life.step(0.1, undefined, undefined, (x) => x > 1000, { rain: 0 });
  expect(first.rush).toBe(5);
  expect(second.rush).toBe(0);
  life.step(0.1, undefined, undefined, undefined, { inspecting: first, rain: 0 });
  expect(first.rush).toBe(5);
  expect(second.rush).toBe(0);
  life.step(0.1, undefined, undefined, undefined, {
    rain: 0,
    levels: { ...activityLevels(1), vehicle: 0.1 },
  });
  expect(first.rush).toBe(5);
  life.reconcileSeasonalActors(
    (owner) => owner === first,
    () => false,
    true,
  );
  driveStep(life);
  expect(first.rush).toBe(5);
  expect(second.rush).toBe(0);
  expect([...life.residentMovers()].filter((m) => (m.rush ?? 0) > 0)).toHaveLength(1);
  driveStep(life, 1);
  expect(first.rush).toBe(0);
  expect(second.rush).toBe(0);
  life.reconcileSeasonalActors(
    () => false,
    () => false,
    false,
  );
  driveStep(life);
  expect([...life.residentMovers()].filter((m) => (m.rush ?? 0) > 0)).toHaveLength(1);
});

it('ends blocked bursts and does not admit another while collision-waiting', () => {
  const life = driveRoad(),
    m = driveMover(life);
  m.rush = 5;
  driveStreams(life).rushRng = () => 0;
  life.step(0.1, undefined, undefined, undefined, { rain: 0 }, () => false);
  expect(m.waiting).toBeGreaterThan(0);
  const rng = vi.fn(() => 0);
  driveStreams(life).rushRng = rng;
  life.step(0.1, undefined, undefined, undefined, { rain: 0 }, () => false);
  expect(m.rush).toBe(0);
  life.step(0.1, undefined, undefined, undefined, { rain: 0 }, () => false);
  expect(m.rush).toBe(0);
  expect(rng).not.toHaveBeenCalled();
});

it.each(['bus', 'truck', 'bicycle'] as const)(
  'does not admit a %s even when the burst RNG succeeds',
  (vehicle) => {
    const life = driveRoad(),
      m = driveMover(life);
    m.vehicle = vehicle;
    const rng = vi.fn(() => 0);
    driveStreams(life).rushRng = rng;
    driveStep(life);
    expect(m.rush ?? 0).toBe(0);
    expect(rng).not.toHaveBeenCalled();
  },
);

it('cancels a burst before choosing a wet target and freezes duration during inspection', () => {
  const life = driveRoad(),
    m = driveMover(life);
  driveStreams(life).rushRng = () => 0;
  m.rush = 5;
  driveStep(life, 0, { inspecting: m });
  expect(m.rush).toBe(5);
  driveStep(life, 1);
  expect(m.rush).toBe(0);
  expect(m.v).toBeLessThan(m.speed);
});

it('makes production-chance starts within a bounded seeded run and replays exact state', () => {
  const lives = [driveRoad(23), driveRoad(23)];
  for (const life of lives) for (let i = 0; i < 16; i++) driveMover(life, 100 + i * 160, 2, i / 16);
  let starts = 0;
  for (let frame = 0; frame < 600; frame++) {
    for (const life of lives) {
      const previous = life.movers.map((m) => m.rush ?? 0);
      driveStep(life);
      if (life === lives[0])
        starts += life.movers.filter((m, i) => (m.rush ?? 0) > 0 && previous[i]! <= 0).length;
      expect(life.movers.filter((m) => (m.rush ?? 0) > 0).length).toBeLessThanOrEqual(
        DRIVE.rush.maxPerTile,
      );
    }
  }
  expect(starts).toBeGreaterThan(0);
  expect(lives[1]!.movers).toEqual(lives[0]!.movers);
});
