import { expect, it } from 'vitest';
import { JunctionTable, type Movement } from './junctions';
import { JunctionTraffic } from './junction-traffic';
import { LifeBuilder } from './geometry';
import { TileLife, type Mover } from './simulate';
import { signalState } from './signals';
import { metersPerUnit } from '../raster/geometry';

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
  stop: 0,
  line: 0,
  dir: 1,
  exit: { line: 0, along: 0, out: 1, hx: 1, hy: 0 },
  ahead: 2,
});

it('does not reserve a downstream box or block its cross traffic behind a real red', () => {
  const tile = { z: 16, x: 55192, y: 30266 },
    pm = 1 / metersPerUnit(tile),
    b = new LifeBuilder(),
    ax = 2000,
    bx = ax + 12 * pm;
  b.line(
    [
      { x: 1000, y: 2000 },
      { x: ax, y: 2000 },
      { x: bx, y: 2000 },
      { x: 3000, y: 2000 },
    ],
    0,
    4,
  );
  for (const x of [ax, bx])
    b.line(
      [
        { x, y: 1000 },
        { x, y: 2000 },
        { x, y: 3000 },
      ],
      0,
      4,
    );
  b.signal({ x: ax, y: 2000 }, 1, 90, 0, true);
  const life = new TileLife(tile, b.finish(), 1),
    table = new JunctionTable(),
    m = car();
  life.movers.length = 0;
  Object.assign(m, {
    x: ax - 8.7 * pm,
    y: 2000,
    d: 1000 - 8.7 * pm,
    speed: 0,
    v: 0,
    lane: 0,
    pause: 0,
    rank: 0,
    paint: 0,
  });
  const other = {
    ...m,
    line: 2,
    from: life.geo.starts[2]!,
    x: bx,
    y: 2000 - 8.7 * pm,
    hx: 0,
    hy: 1,
  };
  life.movers.push(m, other);
  const clock = Array.from({ length: 140 }, (_, t) => t).find(
    (t) => signalState(life.signals.signals[0]!.seed, t).a === 'red',
  )!;
  life.prepareTraffic(() => true);
  life.requestJunctions(table, () => true, clock);
  table.resolve(clock);
  const next = table.snapshot().find((r) => r.index === 0 && r.movement.junction.x !== ax)!;
  expect(next.precedingKey).toBeDefined();
  expect(table.granted(m, next.key)).toBe(false);
  expect(table.granted(other, next.key)).toBe(true);
});
it('revokes downstream outside grants for current-step closure and live upstream revocation', () => {
  const life = empty(),
    table = new JunctionTable(),
    m = car();
  const step = (clock: number, ready: boolean) => {
    table.begin(new Set([life]));
    for (const [key, precedingKey] of [
      ['a', undefined],
      ['b', 'a'],
    ] as const)
      table.request({
        m,
        life,
        tileKey: '',
        index: 0,
        movement: movement(key),
        precedingKey,
        ready: key === 'b' || ready,
        inside: false,
        atLine: true,
      });
    table.resolve(clock);
  };
  step(0, true);
  step(1, true);
  expect(table.granted(m, 'b')).toBe(true);
  step(2, false);
  expect(table.granted(m, 'b')).toBe(false);
  step(3, true);
  step(4, true);
  expect(table.granted(m, 'b')).toBe(true);
  table.revokeGrant(m, 'a');
  expect(table.granted(m, 'b')).toBe(false);
});
it('reclaims a carried next junction after a committed turn without projecting it inside', () => {
  const tile = { z: 16, x: 55192, y: 30266 },
    pm = 1 / metersPerUnit(tile),
    ax = 4096 + 12 * pm,
    by = 2000 - 6 * pm;
  const geometry = (offset: number) => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 3000 - offset, y: 2000 },
        { x: ax - offset, y: 2000 },
      ],
      0,
      4,
    );
    b.line(
      [
        { x: ax - offset, y: 2000 },
        { x: ax - offset, y: by },
        { x: ax - offset, y: 1000 },
      ],
      0,
      4,
    );
    b.line(
      [
        { x: ax - offset, y: 2000 },
        { x: 5000 - offset, y: 2000 },
      ],
      0,
      4,
      3,
      -1,
    );
    b.line(
      [
        { x: 3000 - offset, y: by },
        { x: ax - offset, y: by },
        { x: 5000 - offset, y: by },
      ],
      0,
      4,
    );
    return b.finish();
  };
  const source = new TileLife(tile, geometry(0), 1),
    target = new TileLife({ ...tile, x: tile.x + 1 }, geometry(4096), 2),
    table = new JunctionTable(),
    m = car();
  source.movers.length = target.movers.length = 0;
  Object.assign(m, {
    x: 4096.001,
    y: 2000,
    d: 1096.001,
    next: 2,
    speed: 0,
    v: 0,
    paint: 0,
    lane: 0,
    pause: 0,
    rank: 0,
    routing: { seed: 1, turns: 0, plan: { line: 0, dir: 1, vertex: 1, exit: 2, radius: 3 } },
  });
  source.movers.push(m);
  source.prepareTraffic(() => true);
  source.requestJunctions(table, () => true, 0);
  table.resolve(0);
  const key = table.snapshot().find((r) => r.movement.line === 1)!.key;
  expect(target.adoptFrom(m, source)).toBe(true);
  table.rebind(m, target, 'target', source);
  expect(table.carried(m, key)).toBe(true);
  const candidate = target.junctionIndex
    .movements(m, 60 * target.perMeter, (line, dir) => target.seamExit(m, line, dir))
    .find((p) => p.key === key)!;
  expect(candidate.ahead / target.perMeter).toBeGreaterThan(3);
  table.begin(new Set([target]));
  target.prepareTraffic(() => true);
  target.requestJunctions(table, () => true, 1);
  table.resolve(1);
  const next = table.snapshot().find((r) => r.key === key)!;
  expect(next.inside).toBe(false);
  expect(next.movement.ahead).toBeCloseTo(candidate.ahead);
  expect(table.carried(m, key)).toBe(false);
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
it('does not let arrivals after surrender override the surrendered oldest waiter', () => {
  const life = empty(),
    table = new JunctionTable(),
    a = car();
  const step = (clock: number, newcomer?: Mover) => {
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
    if (newcomer)
      table.request({
        m: newcomer,
        life,
        tileKey: 'b',
        index: 1,
        movement: movement('a', true),
        ready: true,
        inside: false,
        atLine: true,
      });
    table.resolve(clock);
  };
  step(0);
  const first = car();
  step(21, first);
  expect(table.granted(first)).toBe(true);
  expect(table.snapshot().find((r) => r.index === 0)!.surrenderedAt).toBe(21);
  for (const clock of [22, 32]) {
    const newcomer = car();
    if (clock === 32) table.revokeGrant(a, 'a');
    step(clock, newcomer);
    expect(table.granted(a)).toBe(true);
    expect(table.granted(newcomer)).toBe(false);
  }
});
it('restores maxWait priority even when an old surrender recipient remains eligible', () => {
  const life = empty(),
    table = new JunctionTable(),
    a = car(),
    b = car();
  const step = (clock: number, includeB: boolean) => {
    table.begin(new Set([life]));
    for (const [index, m] of (includeB ? [a, b] : [a]).entries())
      table.request({
        m,
        life,
        tileKey: String(index),
        index,
        movement: movement('a', index === 1),
        ready: true,
        inside: false,
        atLine: true,
      });
    table.resolve(clock);
  };
  step(0, false);
  step(21, true);
  expect(table.granted(b)).toBe(true);
  table.revokeGrant(b, 'a');
  step(32, true);
  expect(table.granted(a)).toBe(true);
  expect(table.granted(b)).toBe(false);
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
it('deduplicates complete quantized identities at positive and negative bin edges', () => {
  const tile = { z: 16, x: 55192, y: 30266 },
    life = new TileLife(tile, new LifeBuilder().finish(), 1),
    pm = life.perMeter,
    traffic = new JunctionTraffic(),
    m = car();
  for (const boundary of [-32, 32]) {
    const blocker = { ...car(), x: (boundary - 0.0001) * pm, y: -32 * pm },
      copy = { ...blocker, x: (boundary + 0.0001) * pm },
      bus = { ...blocker, vehicle: 'bus' as const },
      reverse = { ...blocker, hx: -1 };
    const p = {
      ...movement(),
      junction: { ...movement().junction, x: (boundary - 10) * pm, y: -32 * pm, radius: 7 * pm },
    };
    traffic.begin(life);
    traffic.add(life, blocker);
    traffic.add(life, copy);
    expect(traffic.room(m, p, life)).toBeCloseTo(0.7999, 4);
    expect(traffic.occupiesExit(copy, p, life)).toBe(false);
    traffic.add(life, bus);
    expect(traffic.occupiesExit(bus, p, life)).toBe(true);
    traffic.add(life, reverse);
    const backwards = {
      ...p,
      outHx: -1,
      exit: { ...p.exit, hx: -1 },
      junction: { ...p.junction, x: (boundary + 10) * pm },
    };
    expect(traffic.occupiesExit(reverse, backwards, life)).toBe(true);
  }
});
it('refreshes moving cached copies and frames across reference and zoom changes', () => {
  const tile = { z: 16, x: 55192, y: 30266 },
    life = new TileLife(tile, new LifeBuilder().finish(), 1),
    pm = life.perMeter,
    neighbor = new TileLife({ ...tile, x: tile.x + 1 }, new LifeBuilder().finish(), 2),
    finer = new TileLife(
      { z: tile.z + 1, x: tile.x * 2, y: tile.y * 2 },
      new LifeBuilder().finish(),
      3,
    ),
    traffic = new JunctionTraffic(),
    blocker = car(),
    m = car(),
    p = {
      ...movement(),
      junction: { ...movement().junction, x: 32 * pm, y: -32 * pm, radius: 7 * pm },
    };
  Object.assign(blocker, { x: 42 * pm, y: -32 * pm });
  traffic.begin(life);
  traffic.add(life, blocker);
  expect(traffic.room(m, p, life)).toBeCloseTo(0.8);
  blocker.x = 64 * pm;
  for (const reference of [life, neighbor, life]) {
    traffic.begin(reference);
    traffic.add(life, blocker);
    const copy = { ...blocker, x: blocker.x * 2, y: blocker.y * 2 };
    traffic.add(finer, copy);
    expect(traffic.room(m, p, life)).toBeCloseTo(22.8);
    expect(traffic.occupiesExit(copy, p, life)).toBe(false);
  }
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
it('keeps rotated footprint exclusion across spawn broad-phase bin boundaries', () => {
  const tile = { z: 16, x: 55192, y: 30266 },
    pm = 1 / metersPerUnit(tile);
  for (const center of [11.9999, 36.0001]) {
    const b = new LifeBuilder(),
      x = center * pm,
      y = 36 * pm;
    b.line(
      [
        { x: x - 20 * pm, y },
        { x, y },
        { x: x + 20 * pm, y },
      ],
      0,
      4,
    );
    b.line(
      [
        { x, y: y - 20 * pm },
        { x, y },
        { x, y: y + 20 * pm },
      ],
      0,
      4,
    );
    const life = new TileLife(tile, b.finish(), 1),
      m = car();
    Object.assign(m, { x: x - 3 * pm, y: y - 3 * pm, hx: Math.SQRT1_2, hy: Math.SQRT1_2 });
    expect(life.junctionIndex.canSpawnVehicle(m)).toBe(false);
    Object.assign(m, { x: x - 6 * pm, y: y - 6 * pm });
    expect(life.junctionIndex.canSpawnVehicle(m)).toBe(true);
  }
});
