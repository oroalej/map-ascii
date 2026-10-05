import { expect, it } from 'vitest';
import { JunctionTable, type Movement } from './junctions';
import { JunctionTraffic } from './junction-traffic';
import { LifeBuilder } from './geometry';
import { TileLife, type Mover } from './simulate';

const empty = () => new TileLife({ z: 16, x: 1, y: 1 }, new LifeBuilder().finish(), 1);
const car = () =>
  ({
    kind: 'vehicle',
    vehicle: 'car',
    x: 0,
    y: 0,
    hx: 1,
    hy: 0,
    line: 0,
    dir: 1,
    from: 0,
    d: 0,
  }) as Mover;
const movement = (key = 'a', vertical = false): Movement => ({
  key,
  junction: { key, x: 0, y: 0, radius: 7, arms: [] },
  inHx: vertical ? 0 : 1,
  inHy: vertical ? 1 : 0,
  outHx: vertical ? 0 : 1,
  outHy: vertical ? 1 : 0,
  rank: 0,
  stop: 0,
  line: 0,
  dir: 1,
  exit: { line: 0, along: 0, out: 1, hx: 1, hy: 0 },
  ahead: 2,
});

for (const sameClock of [false, true])
  it(`surrenders an expired grant to an eligible conflicting waiter (sameClock=${sameClock})`, () => {
    const life = empty(),
      table = new JunctionTable(),
      a = car(),
      b = car();
    const step = (clock: number, waiter: boolean, eligible = true) => {
      table.begin(new Set([life]));
      table.request({
        m: a,
        life,
        tileKey: 'a',
        index: 0,
        movement: movement(),
        ready: true,
        inside: false,
        atLine: true,
      });
      if (waiter)
        table.request({
          m: b,
          life,
          tileKey: 'b',
          index: 1,
          movement: movement('a', true),
          ready: eligible,
          inside: false,
          atLine: true,
        });
      table.resolve(clock);
    };
    step(0, false);
    if (!sameClock) step(1, true);
    step(21, true);
    expect(table.granted(a)).toBe(false);
    expect(table.granted(b)).toBe(true);
    expect(table.waited(a)).toBe(0);
  });
it('does not let an ineligible waiter prevent safe regrant after expiry', () => {
  const life = empty(),
    table = new JunctionTable(),
    a = car(),
    b = car();
  for (const clock of [0, 21]) {
    table.begin(new Set([life]));
    table.request({
      m: a,
      life,
      tileKey: 'a',
      index: 0,
      movement: movement(),
      ready: true,
      inside: false,
      atLine: true,
    });
    table.request({
      m: b,
      life,
      tileKey: 'b',
      index: 1,
      movement: movement('a', true),
      ready: false,
      inside: false,
      atLine: true,
    });
    table.resolve(clock);
    expect(table.granted(a)).toBe(true);
  }
});
it('revokes a provisional grant on red or unavailable room while retaining arrival', () => {
  const life = empty(),
    table = new JunctionTable(),
    a = car();
  for (const clock of [0, 1]) {
    table.begin(new Set([life]));
    table.request({
      m: a,
      life,
      tileKey: 'a',
      index: 0,
      movement: movement(),
      ready: clock === 0,
      inside: false,
      atLine: true,
    });
    table.resolve(clock);
  }
  expect(table.granted(a)).toBe(false);
  expect(table.waited(a)).toBe(1);
});
it('keeps primary observation and keyed permissions consistent across three records and rebind', () => {
  const life = empty(),
    target = empty(),
    table = new JunctionTable(),
    a = car();
  target.movers.length = 0;
  target.movers.push(a);
  for (const [key, inside, ready, ahead] of [
    ['a', true, false, -2],
    ['b', false, false, 1],
    ['c', false, true, 8],
  ] as const)
    table.request({
      m: a,
      life,
      tileKey: 'source',
      index: 0,
      movement: { ...movement(key), ahead },
      inside,
      ready,
      atLine: true,
    });
  table.resolve(1);
  expect(table.movement(a)!.key).toBe('a');
  expect(table.granted(a)).toBe(true);
  expect(table.granted(a, 'b')).toBe(false);
  expect(table.granted(a, 'c')).toBe(true);
  table.rebind(a, target, 'target', life);
  expect(table.snapshot()).toHaveLength(3);
  expect(table.snapshot().every((r) => r.tileKey === 'target')).toBe(true);
  table.release(a, 'a');
  expect(table.movement(a)!.key).toBe('b');
  expect(table.granted(a)).toBe(false);
  table.revokeGrant(a, 'c');
  expect(table.waited(a, 'c')).toBe(0);
  table.release(a);
  expect(table.empty).toBe(true);
});
it('promotes a first observed physical occupant even with red and insufficient room', () => {
  const life = empty(),
    table = new JunctionTable(),
    a = car();
  table.request({
    m: a,
    life,
    tileKey: 'a',
    index: 0,
    movement: movement(),
    ready: false,
    inside: true,
    room: 0,
  });
  table.resolve(2);
  expect(table.granted(a)).toBe(true);
});
it('charges an inside holder still on its approach until rear clearance', () => {
  const life = empty(),
    table = new JunctionTable(),
    a = car(),
    b = car();
  table.request({
    m: a,
    life,
    tileKey: 'a',
    index: 0,
    movement: movement(),
    ready: false,
    inside: true,
  });
  table.request({
    m: b,
    life,
    tileKey: 'b',
    index: 1,
    movement: movement(),
    ready: true,
    inside: false,
    atLine: true,
    room: 10,
  });
  table.resolve(0);
  expect(table.granted(a)).toBe(true);
  expect(table.granted(b)).toBe(false);
});
it('queries a neighboring exit queue and preserves its room after rebind without counting buffered copies twice', () => {
  const a = empty(),
    b = new TileLife({ z: 16, x: 2, y: 1 }, new LifeBuilder().finish(), 2),
    table = new JunctionTable(),
    traffic = new JunctionTraffic(),
    m = car(),
    blocker = car();
  const p = {
    ...movement(),
    junction: { ...movement().junction, x: 4096, y: 0, radius: 7 * a.perMeter },
  };
  blocker.x = 10 * b.perMeter;
  traffic.begin(a);
  traffic.add(b, blocker);
  traffic.add(b, { ...blocker });
  expect(traffic.room(m, p, a)).toBeCloseTo(0.8);
  table.request({
    m,
    life: a,
    tileKey: 'a',
    index: 0,
    movement: p,
    ready: false,
    inside: false,
    atLine: true,
  });
  table.resolve(0);
  table.rebind(m, b, 'b', a);
  expect(traffic.room(m, table.movement(m, 'a')!, b)).toBeCloseTo(0.8);
});
it('reserves two close junctions and keeps the denied next hold with an A grant', () => {
  const b = new LifeBuilder();
  const nextX = 2048 + 12 * empty().perMeter;
  b.line(
    [
      { x: 100, y: 2048 },
      { x: 2048, y: 2048 },
      { x: nextX, y: 2048 },
      { x: 3996, y: 2048 },
    ],
    0,
    4,
  );
  for (const x of [2048, nextX])
    b.line(
      [
        { x, y: 100 },
        { x, y: 2048 },
        { x, y: 3996 },
      ],
      0,
      4,
    );
  const life = new TileLife({ z: 16, x: 1, y: 1 }, b.finish(), 1),
    table = new JunctionTable(),
    m = car();
  life.movers.length = 0;
  Object.assign(m, {
    x: 2048 - 5 * life.perMeter,
    y: 2048,
    d: 1948 - 5 * life.perMeter,
    speed: life.perMeter,
    v: 0,
    lane: 0,
    pause: 0,
    rank: 0,
    paint: 0,
  });
  life.movers.push(m);
  life.prepareTraffic(() => true);
  life.requestJunctions(table, () => true, 0);
  table.resolve(0);
  const holds = table.snapshot();
  expect(holds).toHaveLength(2);
  const next = holds[1]!.key;
  table.revokeGrant(m, next);
  const caps = life as unknown as {
    followLimits(dt: number, table: JunctionTable): Float64Array;
    caps: Float64Array;
  };
  caps.followLimits(0.1, table);
  expect(table.granted(m, holds[0]!.key)).toBe(true);
  expect(table.granted(m, next)).toBe(false);
  expect(caps.caps[0]).toBeCloseTo(table.movement(m, next)!.ahead / 0.1);
});

it('enumerates a committed turn into a close next junction without changing the route or RNG', () => {
  const tile = { z: 16, x: 55192, y: 30266 },
    pm = new TileLife(tile, new LifeBuilder().finish(), 1).perMeter;
  const b = new LifeBuilder(),
    a = { x: 2000, y: 2000 },
    next = { x: 2000, y: 2000 - 12 * pm };
  b.line([{ x: 1000, y: 2000 }, a], 0, 4);
  b.line([a, next], 0, 4);
  b.line([a, { x: 3000, y: 2000 }], 0, 4);
  b.line([{ x: 1000, y: next.y }, next, { x: 3000, y: next.y }], 0, 4);
  const life = new TileLife(tile, b.finish(), 1),
    m = car();
  Object.assign(m, { from: 0, x: 2000 - 5 * pm, y: 2000, d: 1000 - 5 * pm, next: 2 });
  const before = structuredClone(m),
    paths = life.junctionIndex.movements(m, 60 * pm, (line, dir) => life.seamExit(m, line, dir));
  expect(paths).toHaveLength(2);
  expect(paths[0]!.outHy).toBe(-1);
  expect(paths[1]!.line).toBe(1);
  expect(paths[1]!.ahead).toBeGreaterThan(0);
  expect(m).toEqual(before);
});

it('rejects unlinked spawn-box overlap and accepts a footprint outside it', () => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 100, y: 2000 },
      { x: 2000, y: 2000 },
      { x: 4000, y: 2000 },
    ],
    0,
    4,
  );
  b.line(
    [
      { x: 2000, y: 100 },
      { x: 2000, y: 2000 },
      { x: 2000, y: 4000 },
    ],
    0,
    4,
  );
  const life = new TileLife({ z: 16, x: 55192, y: 30266 }, b.finish(), 1),
    m = car();
  Object.assign(m, { x: 2000 - 4 * life.perMeter, y: 2000 });
  expect(life.junctionIndex.canSpawnVehicle(m)).toBe(false);
  m.x = 2000 - 8 * life.perMeter;
  expect(life.junctionIndex.canSpawnVehicle(m)).toBe(true);
});
