import { expect, it } from 'vitest';
import { LifeBuilder } from './geometry';
import { JunctionTable, type Movement } from './junctions';
import { JunctionTraffic } from './junction-traffic';
import { TileLife, type Mover } from './simulate';
import { VEHICLES } from './vehicles';
import { JUNCTION } from './config';
import { RUSH_PACE_SALT } from './driving';

function fixture() {
  const tile = { z: 16, x: 55192, y: 30266 },
    life = new TileLife(tile, new LifeBuilder().finish(), 1),
    pm = life.perMeter,
    traffic = new JunctionTraffic(),
    table = new JunctionTable();
  const vehicle = (x: number, v: number): Mover => ({
    kind: 'vehicle',
    vehicle: 'car',
    x: x * pm,
    y: 0,
    hx: 1,
    hy: 0,
    line: 0,
    dir: 1,
    from: 0,
    d: 0,
    v: v * pm,
    speed: 8 * pm,
    paint: 0,
    lane: 0,
    pause: 0,
    rank: 0,
  });
  const m = vehicle(-30, 8),
    leader = vehicle(1, 8),
    p: Movement = {
      key: 'junction',
      junction: { key: 'junction', x: 0, y: 0, radius: 7 * pm, arms: [] },
      inHx: 1,
      inHy: 0,
      outHx: 1,
      outHy: 0,
      stop: 0,
      line: 0,
      dir: 1,
      exit: { line: 0, along: 0, out: 1, hx: 1, hy: 0 },
      ahead: 19.3 * pm,
    };
  const refresh = (clock: number, bodies: Mover[] = [leader]) => {
    traffic.begin(life);
    for (const b of bodies) traffic.add(life, b);
    const room = traffic.room(m, p, life);
    table.begin(new Set([life]));
    table.request({
      m,
      life,
      tileKey: 'tile',
      index: 0,
      movement: p,
      ready: room >= VEHICLES.car.length + JUNCTION.gap,
      room,
      traffic,
      inside: false,
      atLine: true,
    });
    table.resolve(clock);
    return room;
  };
  return { life, pm, traffic, table, vehicle, m, leader, p, refresh };
}

it('keeps a following grant across a moving leader entering the exit, then revokes if it stops', () => {
  const f = fixture();
  expect(f.refresh(1)).toBeGreaterThan(VEHICLES.car.length + JUNCTION.gap);
  expect(f.table.canEnter(f.m, f.p.key)).toBe(true);
  const arrival = f.table.snapshot()[0]!.arrival;
  f.leader.x = 10 * f.pm;
  f.m.x = -20 * f.pm;
  f.refresh(2);
  expect(f.table.canEnter(f.m, f.p.key)).toBe(true);
  f.leader.v = 0;
  expect(f.refresh(3)).toBeCloseTo(0.8);
  expect(f.table.canEnter(f.m, f.p.key)).toBe(false);
  expect(f.table.snapshot()[0]!.arrival).toBe(arrival);
  expect(f.table.waited(f.m, f.p.key)).toBe(2);
});

it('still charges a stationary downstream queue behind a moving leader', () => {
  const f = fixture(),
    queue = f.vehicle(14, 0);
  expect(f.refresh(1, [f.leader, queue])).toBeCloseTo(4.8);
  expect(f.table.granted(f.m, f.p.key)).toBe(false);
});

it('denies a rushing approach whose earlier box clearance leaves insufficient exit room', () => {
  const f = fixture();
  f.m.x = -20 * f.pm;
  f.leader.x = 8 * f.pm;
  f.leader.v = 2 * f.pm;
  expect(f.refresh(1)).toBeCloseTo(6.1, 2);
  expect(f.table.canEnter(f.m, f.p.key)).toBe(true);
  // Choose a stable driver share giving exactly 1.3x normal cruise.
  f.m.rank = 1 / 3 / RUSH_PACE_SALT;
  f.m.rush = 5;
  const rushed = f.refresh(2);
  expect(rushed).toBeCloseTo(4.69, 2);
  expect(rushed).toBeLessThan(VEHICLES.car.length + JUNCTION.gap);
  expect(f.table.canEnter(f.m, f.p.key)).toBe(false);
  f.m.rush = 0;
  f.m.v = 10.4 * f.pm;
  expect(f.refresh(3)).toBeLessThan(VEHICLES.car.length + JUNCTION.gap);
});

it('uses observed velocity from the traffic frame and treats unknown velocity as stationary', () => {
  const f = fixture();
  f.refresh(1);
  f.leader.v = 0;
  expect(f.traffic.room(f.m, f.p, f.life)).toBeGreaterThan(VEHICLES.car.length + JUNCTION.gap);
  f.refresh(2);
  expect(f.table.granted(f.m, f.p.key)).toBe(false);
  f.leader.v = undefined;
  expect(f.refresh(3)).toBeLessThan(0);
});

it('keeps turning and linked routes on physical exit capacity', () => {
  const f = fixture();
  f.refresh(1);
  expect(f.traffic.room(f.m, { ...f.p, inHx: 0, inHy: 1 }, f.life)).toBeCloseTo(-8.2);
  expect(
    f.traffic.room(f.m, { ...f.p, junction: { ...f.p.junction, linked: true } }, f.life),
  ).toBeCloseTo(-8.2);
  f.m.x = 20 * f.pm;
  expect(f.traffic.room(f.m, f.p, f.life)).toBeCloseTo(-8.2);
});

it('preserves moving exit capacity across adjacent and finer ownership frames and rebind', () => {
  const f = fixture(),
    neighbor = new TileLife(
      { ...f.life.tile, x: f.life.tile.x + 1 },
      new LifeBuilder().finish(),
      2,
    ),
    finer = new TileLife(
      { z: f.life.tile.z + 1, x: (f.life.tile.x + 1) * 2, y: f.life.tile.y * 2 },
      new LifeBuilder().finish(),
      3,
    );
  f.p.junction.x = 4096;
  f.m.x = 4096 - 30 * f.pm;
  const leader = { ...f.leader, x: neighbor.perMeter, v: 8 * neighbor.perMeter },
    copy = { ...leader, x: leader.x * 2, v: leader.v * 2 };
  f.traffic.begin(f.life);
  f.traffic.add(neighbor, leader);
  const room = f.traffic.room(f.m, f.p, f.life);
  f.traffic.add(finer, copy);
  expect(f.traffic.room(f.m, f.p, f.life)).toBe(room);
  f.table.request({
    m: f.m,
    life: f.life,
    tileKey: 'source',
    index: 0,
    movement: f.p,
    inside: false,
    ready: true,
  });
  f.table.resolve(1);
  f.m.x = -30 * neighbor.perMeter;
  f.table.rebind(f.m, neighbor, 'neighbor', f.life);
  expect(f.traffic.room(f.m, f.table.movement(f.m)!, neighbor)).toBeCloseTo(room);
  f.traffic.begin(finer);
  f.traffic.add(neighbor, leader);
  expect(f.traffic.room(f.m, f.table.movement(f.m)!, neighbor)).toBeCloseTo(room);
});
