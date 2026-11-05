import { describe, expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { TileLife, type GroundGuard, type Mover } from './simulate';
import { FOLLOW } from './config';
import { VEHICLES } from './vehicles';
import { expectSteered } from './testing/steering-checks';
import { metersPerUnit } from '../raster/geometry';

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);

function road(width = 9.6, oneway: 0 | 1 = 1, atM = 50) {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2000 },
      { x: 4095, y: 2000 },
    ],
    LifeLine.roadMinor,
    width,
    1,
    oneway,
  );
  const life = new TileLife(tile, b.finish(), 42);
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  (life as unknown as { parkingLines: Set<number> }).parkingLines.clear();
  life.scenes.sites.length = 0;
  const m: Mover = {
    kind: 'vehicle',
    vehicle: 'car',
    line: 0,
    from: 0,
    dir: 1,
    d: atM * pm,
    x: atM * pm,
    y: 2000,
    hx: 1,
    hy: 0,
    speed: 8 * pm,
    v: 8 * pm,
    paint: 0,
    lane: 0.9,
    pause: 0,
    rank: 0,
    routing: { seed: 123, turns: 0 },
  };
  life.movers.push(m);
  return { life, m };
}

const step = (life: TileLife, m: Mover, dt = 1 / 30, guard: GroundGuard = () => true) =>
  expectSteered(life, m, () => life.step(dt, undefined, undefined, undefined, undefined, guard));

describe('vehicles steer instead of sliding', () => {
  it.each([1, 4, 8, 11])('changes lane along a curve at %s m/s', (speed) => {
    const { life, m } = road();
    m.speed = m.v = speed * pm;
    m.maneuver = { kind: 'lane', target: 0.5 };
    m.laneSignal = 'left';
    const start = life.offsetOf(m);
    let peak = 0;
    for (let frame = 0; frame < 60 * 30 && m.maneuver; frame++) {
      step(life, m);
      peak = Math.max(peak, Math.abs(Math.atan(m.latYaw ?? 0)));
    }
    expect(m.maneuver).toBeUndefined();
    expect(m.latYaw).toBeUndefined();
    expect(life.offsetOf(m)).toBeCloseTo(start - 3.2);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(Math.PI / 12 + 1e-9);
  });

  it('eases the nose in and out rather than switching its angle on and off', () => {
    const { life, m } = road();
    m.speed = m.v = 11 * pm;
    m.maneuver = { kind: 'lane', target: 0.5 };
    let previous = 0,
      largest = 0;
    for (let frame = 0; frame < 30 * 30 && m.maneuver; frame++) {
      life.step(1 / 30, undefined, undefined, undefined, undefined, () => true);
      const yaw = m.latYaw ?? 0;
      largest = Math.max(largest, Math.abs(yaw - previous));
      previous = yaw;
    }
    expect(m.maneuver).toBeUndefined();
    // One frame at 11 m/s is about 0.37 m of road; the nose turns only a little over it.
    expect(largest).toBeLessThan(0.01);
  });

  it('never moves a return sideways faster than it creeps forward', () => {
    const { life, m } = road();
    m.speed = m.v = 1 * pm;
    m.lat = -3.2;
    m.maneuver = { kind: 'return', target: m.lane, returning: true };
    for (let frame = 0; frame < 60 * 30 && m.maneuver; frame++) step(life, m);
    expect(m.maneuver).toBeUndefined();
    expect(m.lat).toBeUndefined();
  });

  it('finishes a late return by driving, not by stopping short of the junction', () => {
    const { life, m } = road(9.6, 1, 4095 / pm - 60);
    m.v = 4 * pm;
    m.lat = -3.2;
    m.maneuver = { kind: 'return', target: m.lane, returning: true };
    let stopped = 0;
    for (let frame = 0; frame < 30 * 30 && m.maneuver; frame++) {
      const { forward } = step(life, m);
      if (forward === 0) stopped++;
    }
    expect(m.maneuver).toBeUndefined();
    expect(stopped).toBe(0);
  });

  it('holds its angled pose while stopped and resumes when it can roll again', () => {
    const { life, m } = road();
    m.lat = -1.6;
    m.latYaw = 0.1;
    m.v = 0;
    m.maneuver = { kind: 'return', target: m.lane, returning: true };
    const leader: Mover = {
      ...m,
      lat: undefined,
      latYaw: undefined,
      maneuver: undefined,
      speed: 0,
      v: 0,
      d: m.d + (VEHICLES.car.length + FOLLOW.minGap) * pm,
      x: m.x + (VEHICLES.car.length + FOLLOW.minGap) * pm,
    };
    life.movers.push(leader);
    const pose = { ...life.pose(m) };
    for (let frame = 0; frame < 3 * 30; frame++) step(life, m);
    expect(life.pose(m)).toEqual(pose);
    expect(m.lat).toBe(-1.6);
    expect(m.latYaw).toBe(0.1);
    life.movers.pop();
    for (let frame = 0; frame < 20 * 30 && m.maneuver; frame++) step(life, m);
    expect(m.maneuver).toBeUndefined();
    expect(m.lat).toBeUndefined();
  });

  it('keeps a boxed-in rider in line instead of sliding it out of a stopped queue', () => {
    const { life, m } = road(9.6, 1, 100);
    m.vehicle = 'motorcycle';
    m.v = 0;
    const car: Mover = {
      ...m,
      vehicle: 'car',
      speed: 0,
      v: 0,
      d: m.d + ((VEHICLES.car.length + VEHICLES.motorcycle.length) / 2 + 1.6) * pm,
      x: m.x + ((VEHICLES.car.length + VEHICLES.motorcycle.length) / 2 + 1.6) * pm,
    };
    life.movers.push(car);
    for (let frame = 0; frame < 5 * 30; frame++) step(life, m);
    expect(m.lat).toBeUndefined();
    expect(m.maneuver).toBeUndefined();
  });

  it('filters past a stopped queue when it has room to steer out', () => {
    const { life, m } = road(9.6, 1, 100);
    m.vehicle = 'motorcycle';
    m.v = 3 * pm;
    const car: Mover = {
      ...m,
      vehicle: 'car',
      speed: 0,
      v: 0,
      d: m.d + 25 * pm,
      x: m.x + 25 * pm,
    };
    life.movers.push(car);
    let filtered = false;
    for (let frame = 0; frame < 15 * 30; frame++) {
      step(life, m);
      filtered ||= m.maneuver?.kind === 'filter' && !!m.lat;
      if (m.d > car.d + 5 * pm) break;
    }
    expect(filtered).toBe(true);
    expect(m.d).toBeGreaterThan(car.d);
  });

  it('carries a late maneuver through a turn without a jump, then finishes it', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 2000 },
        { x: 2000, y: 2000 },
        { x: 2000, y: 4000 },
      ],
      LifeLine.roadMinor,
      9.6,
      1,
      1,
    );
    const life = new TileLife(tile, b.finish(), 42);
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    (life as unknown as { parkingLines: Set<number> }).parkingLines.clear();
    life.scenes.sites.length = 0;
    const startM = 2000 / pm - 22;
    const m: Mover = {
      kind: 'vehicle',
      vehicle: 'car',
      line: 0,
      from: 0,
      dir: 1,
      d: startM * pm,
      x: startM * pm,
      y: 2000,
      hx: 1,
      hy: 0,
      speed: 6 * pm,
      v: 6 * pm,
      lane: 0.5,
      lat: -2.5,
      maneuver: { kind: 'return', target: 0.5, returning: true },
      paint: 0,
      pause: 0,
      rank: 0,
      routing: { seed: 7, turns: 0 },
    };
    life.movers.push(m);
    for (let frame = 0; frame < 30 * 30 && m.maneuver; frame++) {
      const before = life.pose(m);
      const fastest = Math.max(m.speed, m.v ?? 0) / pm;
      // Not `step`: the steering check is for straight road, and this one turns.
      life.step(1 / 30, undefined, undefined, undefined, undefined, () => true);
      const after = life.pose(m);
      expect(Math.hypot(after.x - before.x, after.y - before.y) / pm).toBeLessThanOrEqual(
        (fastest * 1.02) / 30 + 1e-6,
      );
      // The heading turns with the arc rather than snapping.
      expect(before.hx * after.hx + before.hy * after.hy).toBeGreaterThan(Math.cos(0.2));
    }
    expect(m.hy).toBeCloseTo(1);
    expect(m.maneuver).toBeUndefined();
    expect(m.lat).toBeUndefined();
    expect(m.latYaw).toBeUndefined();
  });

  it('never steps sideways on the spot when forward travel is refused', () => {
    const { life, m } = road();
    const refuseForward: GroundGuard = (owner, before) =>
      !('kind' in owner) || !before || !('kind' in before) || owner.d <= before.d;
    for (let frame = 0; frame < 3 * 30; frame++) step(life, m, 1 / 30, refuseForward);
  });

  describe('curb stops', () => {
    function stop(atM: number, width = 14) {
      const { life, m } = road(width, 0, 100);
      m.vehicle = 'jeepney';
      m.lane = 0.1;
      m.speed = 6 * pm;
      m.v = 3 * pm;
      m.d = m.x = atM * pm;
      life.scenes.sites.push({
        kind: 'stop',
        x: 150 * pm,
        y: 2000 + 8 * pm,
        modes: 7,
        covered: true,
        queue: [],
        capacity: 6,
        hx: 1,
        hy: 0,
        road: 0,
        roadWidth: width,
        direction: 1,
      });
      return { life, m };
    }

    it('pulls in and out nose first with no sideways jump', () => {
      const { life, m } = stop(90);
      const lane = life.offsetOf(m);
      let served = false,
        steered = false;
      for (let frame = 0; frame < 60 * 30; frame++) {
        step(life, m);
        served ||= life.scenes.held(m);
        steered ||= Math.abs(life.pose(m).hy) > 0.03;
        if (served && m.x > 200 * pm) break;
      }
      expect(served).toBe(true);
      expect(steered).toBe(true);
      expect(life.offsetOf(m)).toBeCloseTo(lane, 1);
    });

    it('drives past a stop it is already too close to reach', () => {
      const { life, m } = stop(146);
      const lane = life.offsetOf(m);
      m.v = 0.5 * pm;
      for (let frame = 0; frame < 2 * 30; frame++) step(life, m);
      expect(life.offsetOf(m)).toBeCloseTo(lane, 6);
    });
  });
});
