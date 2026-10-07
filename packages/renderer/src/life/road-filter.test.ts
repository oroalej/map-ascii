import { describe, expect, it, vi } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { FILTER, FOLLOW, SIGNAL, JUNCTION } from './config';
import { VEHICLES } from './vehicles';
import { TileLife, type Mover, type GroundGuard } from './simulate';
import { signalState } from './signals';
import { bodiesOverlap, BODY_KIND, Occupancy } from './occupancy';
import { pedestrianView, type PedestrianView } from './pedestrians';
import { JunctionTable } from './junctions';
import { metersPerUnit } from '../raster/geometry';

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);
const red = Array.from({ length: 120 }, (_, n) => n).find(
  (t) => signalState(0, t, true).a === 'red',
)!;
function queue(
  vehicle: 'motorcycle' | 'bicycle' = 'motorcycle',
  width = 9.6,
  signal = true,
  dir: 1 | -1 = 1,
) {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2000 },
      { x: 4095, y: 2000 },
    ],
    LifeLine.roadMajor,
    width,
    1,
    dir,
  );
  if (signal) b.signal({ x: 150 * pm, y: 2000 }, 6, -1, 90, true, undefined, { seed: 0 });
  else
    b.line(
      [
        { x: 0, y: 2000 + 50 * pm },
        { x: 4095, y: 2000 + 50 * pm },
      ],
      LifeLine.roadMajor,
      width,
      2,
      dir,
    );
  const life = new TileLife(tile, b.finish(), 42);
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  const stop = 150 - 6 - SIGNAL.gap;
  const make = (type: Mover['vehicle'], d: number): Mover => ({
    kind: 'vehicle',
    vehicle: type,
    line: 0,
    from: dir === 1 ? 0 : 1,
    dir,
    d: d * pm,
    x: dir === 1 ? d * pm : 4095 - d * pm,
    y: 2000,
    hx: dir,
    hy: 0,
    speed: 8 * pm,
    v: 0,
    lane: 0.9,
    paint: 0,
    pause: 0,
    rank: 0,
    routing: { seed: 123, turns: 0 },
  });
  const cars = Array.from({ length: 4 }, (_, n) =>
    make('car', stop - 2.2 - n * (4.4 + FOLLOW.minGap)),
  );
  const last = cars.at(-1)!;
  const m = make(vehicle, last.d / pm - (4.4 + VEHICLES[vehicle].length) / 2 - 2);
  life.movers.push(...cars, m);
  const guard: GroundGuard = (owner, before) => {
    if (!('kind' in owner)) return true;
    const body = life.groundBodies(owner)[0]!;
    for (const peer of life.movers) {
      if (peer === owner) continue;
      const other = life.groundBodies(peer)[0]!;
      if (bodiesOverlap(body, other)) return false;
      if (before && 'kind' in before) {
        const start = life.groundBodies(before)[0]!;
        for (const t of [0.25, 0.5, 0.75])
          if (
            bodiesOverlap(
              { ...body, x: start.x + (body.x - start.x) * t, y: start.y + (body.y - start.y) * t },
              other,
            )
          )
            return false;
      }
    }
    return true;
  };
  const physicalStop =
    (cars[0]!.d + life.signals.protectedRoom(cars[0]!)) / pm + VEHICLES.car.length / 2;
  return { life, m, cars, stop: physicalStop, guard };
}

describe('physically clear queue filtering', () => {
  it('holds a blocked two-way filtering return beyond give-up, freezes inspection and resumes safely', () => {
    const { life, m, cars } = queue('motorcycle', 12, false);
    life.geo.oneway![0] = 0;
    const fit = life.filterCorridor(m, {
      kind: 'filter',
      target: m.lane,
      corridor: 1,
      queueSpeed: 0,
      returning: true,
    })!;
    m.lat = fit.offset - life.offsetOf(m);
    m.maneuver = fit.maneuver;
    m.v = 0;
    const blocker = cars[0]!;
    blocker.d = blocker.x = m.d;
    blocker.v = blocker.speed = 0;
    life.movers.splice(0, life.movers.length, m, blocker);
    const recovery = life as unknown as { recoverVehicle(m: Mover): boolean };
    const recovered = vi.spyOn(recovery, 'recoverVehicle').mockImplementation((owner) => {
      expect(owner.maneuver).toBeUndefined();
      return false;
    });
    const pose = life.pose(m);
    for (let frame = 0; frame < (JUNCTION.giveUp + 1) * 30; frame++)
      life.step(1 / 30, undefined, undefined, undefined, undefined, () => false);
    expect(m.waiting).toBeGreaterThan(JUNCTION.giveUp);
    expect(m.maneuver?.kind).toBe('filter');
    expect(m.maneuver?.returning).toBe(true);
    expect(life.pose(m)).toEqual(pose);
    expect(recovered).not.toHaveBeenCalled();
    const held = structuredClone(m);
    life.step(0.1, undefined, undefined, undefined, { rain: 0, inspecting: m }, () => true);
    expect(m).toEqual(held);
    life.movers.pop();
    for (let frame = 0; frame < 12 * 30 && m.maneuver; frame++)
      life.step(1 / 30, undefined, undefined, undefined, undefined, () => true);
    expect(m.maneuver).toBeUndefined();
    expect(m.lat).toBeUndefined();
    expect(m.latYaw).toBeUndefined();
    for (let frame = 0; frame < 5; frame++)
      life.step(0.1, undefined, undefined, undefined, undefined, () => true);
    expect(m.d).toBeGreaterThan(held.d);
    // Ordinary give-up becomes eligible again after the accepted return is complete.
    recovered.mockRestore();
  });

  it('holds a filtering return for a strictly mid-sweep rider when both endpoints are clear', () => {
    const { life, m, cars } = queue('motorcycle', 9.6, false);
    life.movers.splice(0, life.movers.length, m);
    m.lat = -6.4;
    m.maneuver = {
      kind: 'filter',
      target: m.lane,
      corridor: 2 / 3,
      returning: true,
      queueSpeed: 0,
    };
    const peer = { ...cars[0]!, vehicle: 'motorcycle' as const, lane: 0.5, d: m.d, x: m.x };
    life.movers.push(peer);
    life.prepareTraffic(() => true);
    const clearance = VEHICLES.motorcycle.width + FOLLOW.roadGap;
    expect(Math.abs(life.offsetOf(m) - life.offsetOf(peer))).toBeGreaterThan(clearance);
    expect(Math.abs(3.2 - life.offsetOf(peer))).toBeGreaterThan(clearance);
    const update = life as unknown as { updateFilter(index: number, table: JunctionTable): void };
    update.updateFilter(0, new JunctionTable());
    expect(m.maneuver.kind).toBe('filter');
    expect(m.lat).toBe(-6.4);
    life.movers.pop();
    life.prepareTraffic(() => true);
    update.updateFilter(0, new JunctionTable());
    expect(m.maneuver.kind).toBe('return');
  });

  it.each([
    { dir: 1, width: 9.6, side: 'left' },
    { dir: -1, width: 9.6, side: 'left' },
    { dir: 1, width: 6, side: 'right' },
    { dir: -1, width: 6, side: 'right' },
  ] as const)(
    'indicates automatic $side filtering and the opposite return in direction $dir',
    ({ dir, width, side }) => {
      const { life, m, cars, guard } = queue('motorcycle', width, false, dir);
      for (const car of cars) car.speed = car.v = 0;
      for (let frame = 0; frame < 90 && !m.lat; frame++)
        life.step(1 / 30, undefined, undefined, undefined, undefined, guard);
      expect(m.maneuver?.kind).toBe('filter');
      expect(m.laneSignal).toBe(side);
      expect(Math.abs(m.lat ?? 0)).toBeGreaterThan(0);
      m.maneuver = { ...m.maneuver!, returning: true };
      for (let n = 0; n < cars.length; n++) {
        cars[n]!.d = m.d + (70 + n * 10) * pm;
        cars[n]!.x = dir === 1 ? cars[n]!.d : 4095 - cars[n]!.d;
      }
      life.prepareTraffic(() => true);
      const update = life as unknown as { updateFilter(index: number, table: JunctionTable): void };
      update.updateFilter(life.movers.indexOf(m), new JunctionTable());
      expect(m.maneuver.kind).toBe('return');
      expect(m.laneSignal).toBe(side === 'left' ? 'right' : 'left');
    },
  );

  it.each([1, -1] as const)(
    'keeps the left edge-return signal through fallback and re-return while yaw settles in direction %s',
    (dir) => {
      const { life, m, cars } = queue('motorcycle', 6, false, dir);
      life.movers.splice(0, life.movers.length, m);
      const fit = life.filterCorridor(m, {
        kind: 'filter',
        target: m.lane,
        corridor: 1,
        queueSpeed: 0,
        returning: true,
      })!;
      m.lat = fit.offset - life.offsetOf(m);
      m.maneuver = fit.maneuver;
      m.laneSignal = 'right';
      m.v = 3 * pm;
      let settling = false;
      for (let frame = 0; frame < 300; frame++) {
        life.step(1 / 30, undefined, undefined, undefined, undefined, () => true);
        if (
          m.maneuver?.kind === 'return' &&
          Math.abs(m.lat ?? 0) < 1e-6 &&
          m.latYaw !== undefined
        ) {
          settling = true;
          break;
        }
      }
      expect(settling).toBe(true);
      expect(m.laneSignal).toBe('left');
      const car = cars[0]!;
      car.speed = car.v = 0;
      car.d = m.d + 5.5 * pm;
      car.x = dir === 1 ? car.d : 4095 - car.d;
      life.movers.push(car);
      const update = life as unknown as { updateFilter(index: number, table: JunctionTable): void };
      life.prepareTraffic(() => true);
      update.updateFilter(0, new JunctionTable());
      expect(m.maneuver?.kind).toBe('filter');
      expect(m.latYaw).toBeLessThan(0);
      car.d = m.d + 70 * pm;
      car.x = dir === 1 ? car.d : 4095 - car.d;
      life.prepareTraffic(() => true);
      update.updateFilter(0, new JunctionTable());
      expect(m.maneuver?.kind).toBe('return');
      expect(m.laneSignal).toBe('left');
      expect(m.latYaw).toBeLessThan(0);
    },
  );

  it.each(['changed line', 'more than sixty metres behind'] as const)(
    'completes a requested safe return after the queue is %s',
    (reason) => {
      const { life, m, cars, guard } = queue('motorcycle', 9.6, false);
      const oldQueue = cars[0]!;
      if (reason === 'changed line') {
        oldQueue.line = 1;
        oldQueue.from = 2;
        oldQueue.y = life.geo.coords[5]!;
      } else oldQueue.d = oldQueue.x = m.d - 70 * pm;
      oldQueue.speed = oldQueue.v = 0;
      life.movers.splice(0, life.movers.length, m, oldQueue);
      m.lat = -1.6;
      m.latYaw = 0.1;
      m.v = 3 * pm;
      m.maneuver = {
        kind: 'filter',
        target: m.lane,
        corridor: 2 / 3,
        queueSpeed: 0,
        returning: true,
      };
      m.laneSignal = 'left';
      m.roadScan = 0;
      for (let frame = 0; frame < 10 * 30 && m.maneuver; frame++)
        life.step(1 / 30, undefined, undefined, undefined, undefined, guard);
      expect(m.maneuver).toBeUndefined();
      expect(m.lat).toBeUndefined();
      expect(m.latYaw).toBeUndefined();
      expect(m.laneSignal).toBeUndefined();
      expect(life.offsetOf(m)).toBeCloseTo(3.2);
      for (let frame = 0; frame < 4 * 30; frame++)
        life.step(1 / 30, undefined, undefined, undefined, undefined, guard);
      expect(m.v / pm).toBeCloseTo(8);
    },
  );

  it('retains its queue reference between refreshes and waits for the full return sweep', () => {
    const { life, m, cars } = queue('motorcycle', 9.6, false);
    const oldQueue = cars[0]!;
    oldQueue.d = oldQueue.x = m.d - 70 * pm;
    oldQueue.speed = oldQueue.v = 0;
    life.movers.splice(0, life.movers.length, m, oldQueue);
    m.lat = -1.6;
    m.v = 3 * pm;
    m.maneuver = { kind: 'filter', target: m.lane, corridor: 2 / 3, queueSpeed: 0 };
    m.roadScan = 0.25;
    const update = life as unknown as { updateFilter(index: number, table: unknown): void };
    const table = { holds: () => [] };
    life.prepareTraffic(() => true);
    update.updateFilter(0, table);
    expect(m.maneuver.kind).toBe('filter');
    const blocker: Mover = {
      ...cars[1]!,
      vehicle: 'motorcycle',
      d: m.d,
      x: m.x,
      speed: 0,
      v: 0,
    };
    life.movers.push(blocker);
    m.roadScan = 0;
    life.prepareTraffic(() => true);
    // Another rider does not establish a queue reference.
    blocker.line = 1;
    blocker.from = 2;
    blocker.y = life.geo.coords[5]!;
    life.prepareTraffic(() => true);
    m.maneuver = { ...m.maneuver, returning: true };
    update.updateFilter(0, table);
    expect(m.maneuver.kind).toBe('return');
    // Once a body occupies the original lane, the complete source-to-target sweep closes.
    blocker.line = 0;
    blocker.from = 0;
    blocker.y = m.y;
    m.maneuver = {
      kind: 'filter',
      target: m.lane,
      corridor: 2 / 3,
      queueSpeed: 0,
      returning: true,
    };
    m.roadScan = 0;
    life.prepareTraffic(() => true);
    const at = life.offsetOf(m);
    update.updateFilter(0, table);
    expect(m.maneuver.kind).toBe('filter');
    expect(m.maneuver.returning).toBe(true);
    expect(life.offsetOf(m)).toBe(at);
    life.movers.pop();
    m.roadScan = 0;
    life.prepareTraffic(() => true);
    update.updateFilter(0, table);
    expect(m.maneuver.kind).toBe('return');
  });

  it('keeps pedestrian braking on the accepted filtering path', () => {
    const { life, m } = queue();
    m.maneuver = { kind: 'filter', target: m.lane, corridor: 2 / 3, queueSpeed: 0 };
    m.lat = -1.6;
    m.v = 3 * pm;
    const body = life.groundBodies(m)[0]!;
    const occupied = new Occupancy();
    occupied.set({}, [
      {
        x: body.x + VEHICLES.motorcycle.length / 2 + 0.6,
        y: body.y,
        hx: 1,
        hy: 0,
        length: 0.9,
        width: 1,
        kind: BODY_KIND.human,
      },
    ]);
    const query = life as unknown as {
      pedestrianTarget(m: Mover, target: number, view: PedestrianView, dt: number): number;
    };
    expect(query.pedestrianTarget(m, 3 * pm, pedestrianView(occupied, 0.9), 1 / 30)).toBeLessThan(
      pm,
    );
  });
  it.each(['motorcycle', 'bicycle'] as const)(
    '%s reaches a red stop within twenty seconds',
    (vehicle) => {
      const { life, m, stop, guard } = queue(vehicle);
      let entered = false;
      for (let frame = 0; frame < 20 * 30; frame++) {
        life.step(1 / 30, undefined, undefined, undefined, { rain: 0, clock: red }, guard);
        entered ||= m.maneuver?.kind === 'filter' && Math.abs(m.lat ?? 0) > 0;
        expect(m.v! / pm).toBeLessThanOrEqual(FILTER.max + 1e-8);
        expect(m.x / pm + VEHICLES[vehicle].length / 2).toBeLessThanOrEqual(stop + 1e-6);
        for (const peer of life.movers)
          if (peer !== m)
            expect(bodiesOverlap(life.groundBodies(m)[0]!, life.groundBodies(peer)[0]!)).toBe(
              false,
            );
      }
      expect(entered).toBe(true);
      expect(stop - m.x / pm - VEHICLES[vehicle].length / 2).toBeLessThan(0.1);
      expect(m.maneuver?.kind).toBe('filter');
    },
  );

  it.each(['narrow', 'occupied'] as const)(
    'retains following when the corridor is %s',
    (reason) => {
      const { life, m, cars } = queue('motorcycle', reason === 'narrow' ? 3.2 : 9.6);
      if (reason === 'occupied') life.movers.push({ ...cars[1]!, vehicle: 'truck', lane: 0.5 });
      for (let frame = 0; frame < 3 * 30; frame++)
        life.step(1 / 30, undefined, undefined, undefined, { rain: 0, clock: red });
      expect(m.maneuver).toBeUndefined();
    },
  );

  it('backs off once per rejected simulation step and freezes its active-time retry', () => {
    const { life, m } = queue();
    for (let i = 0; i < 2; i++)
      life.step(1 / 30, undefined, undefined, undefined, { rain: 0, clock: red }, () => false);
    expect(m.maneuver?.returning).toBe(true);
    expect(m.filterRetry).toBe(FILTER.retry);
    const before = structuredClone(m);
    life.step(0.1, undefined, undefined, undefined, { rain: 0, clock: red, inspecting: m });
    expect(m).toEqual(before);
  });

  it('retains an unsafe return offset, then merges after the queue accelerates and opens a gap', () => {
    const { life, m, cars, guard } = queue();
    for (let frame = 0; frame < 8 * 30; frame++)
      life.step(1 / 30, undefined, undefined, undefined, { rain: 0, clock: red }, guard);
    expect(m.maneuver?.kind).toBe('filter');
    // A car beside the rider makes the full return sweep unsafe even though the corridor is clear.
    cars[0]!.d = cars[0]!.x = m.d;
    for (const car of cars) car.v = car.speed = 8 * pm;
    m.roadScan = 0;
    life.prepareTraffic(() => true);
    const update = life as unknown as { updateFilter(index: number, table: unknown): void };
    const table = { holds: () => [] };
    const at = life.offsetOf(m);
    update.updateFilter(life.movers.indexOf(m), table);
    expect(m.maneuver?.kind).toBe('filter');
    expect(m.maneuver?.returning).toBe(true);
    expect(life.offsetOf(m)).toBe(at);
    // Move every queue body ahead of the complete return envelope; no reset of rider state.
    for (let n = 0; n < cars.length; n++) cars[n]!.d = cars[n]!.x = m.d + (30 + n * 10) * pm;
    m.roadScan = 0;
    life.prepareTraffic(() => true);
    update.updateFilter(life.movers.indexOf(m), table);
    expect(m.maneuver?.kind).toBe('return');
    for (let frame = 0; frame < 12 * 30; frame++)
      life.step(1 / 30, undefined, undefined, undefined, { rain: 0, clock: 0 }, guard);
    expect(m.maneuver).toBeUndefined();
    expect(life.offsetOf(m)).toBeCloseTo(3.2);
  });

  it.each([30, 60, 120])('replays complete state and accepted poses at %s Hz', (hz) => {
    const a = queue(),
      b = queue();
    let entered = false;
    for (let frame = 0; frame < 8 * hz; frame++) {
      for (const s of [a, b])
        s.life.step(1 / hz, undefined, undefined, undefined, { rain: 0, clock: red }, s.guard);
      entered ||= !!a.m.lat;
      expect(a.life.movers).toEqual(b.life.movers);
      expect(a.life.movers.map((m) => a.life.pose(m))).toEqual(
        b.life.movers.map((m) => b.life.pose(m)),
      );
    }
    expect(entered).toBe(true);
  });
});
