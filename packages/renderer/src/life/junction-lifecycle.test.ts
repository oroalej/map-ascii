import { expect, it, vi } from 'vitest';
import { JunctionTable, type Movement } from './junctions';
import { JunctionTraffic } from './junction-traffic';
import { LifeBuilder } from './geometry';
import { LifeWorld, TileLife, type Mover } from './simulate';
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

for (const reversed of [false, true])
  it(`admits and releases both opposing split-way close chains (reversed=${reversed})`, () => {
    const tile = { z: 16, x: 55192, y: 30266 },
      pm = 1 / metersPerUnit(tile),
      a = { x: 2000, y: 2000 },
      z = { x: 2000 + 10 * pm, y: 2000 },
      b = new LifeBuilder();
    b.line([{ x: a.x - 100 * pm, y: a.y }, a], 0, 4);
    b.line([a, z], 0, 4);
    b.line([z, { x: z.x + 100 * pm, y: z.y }], 0, 4);
    b.line([a, { x: a.x, y: a.y - 100 * pm }], 0, 4);
    b.line([z, { x: z.x, y: z.y + 100 * pm }], 0, 4);
    const world = new LifeWorld();
    world.sync([{ key: 'close-chains', tile, life: b.finish() }]);
    const life = world.active('close-chains')!;
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    const make = (line: number, x: number, dir: 1 | -1, exit: number): Mover => ({
      kind: 'vehicle',
      vehicle: 'car',
      line,
      x,
      y: a.y,
      hx: dir,
      hy: 0,
      from: dir === 1 ? life.geo.starts[line]! : life.geo.starts[line + 1]! - 1,
      dir,
      d: (100 - 6.8) * pm,
      speed: 8 * pm,
      v: 0,
      lane: 0,
      paint: 0,
      pause: 0,
      rank: 0,
      next: exit,
      routing: {
        seed: 1,
        turns: 0,
        plan: {
          line,
          dir,
          vertex: dir === 1 ? life.geo.starts[line + 1]! - 1 : life.geo.starts[line]!,
          exit,
          radius: 3,
        },
      },
    });
    const movers = [make(0, a.x - 6.8 * pm, 1, 2), make(2, z.x + 6.8 * pm, -1, 3)];
    life.movers.push(...(reversed ? [...movers].reverse() : movers));
    const table = (world as unknown as { junctions: JunctionTable }).junctions,
      admitted = [false, false],
      released = [false, false],
      held = [false, false];
    for (let frame = 0; frame < 120 * 30; frame++) {
      world.step(1 / 30, undefined, 18, undefined, undefined, { rain: 0, minutes: 720 }, 0.9);
      for (let i = 0; i < movers.length; i++) {
        const m = movers[i]!,
          rows = [...table.holds(m)];
        held[i] ||= rows.length > 0;
        admitted[i] ||= rows.some((r) => table.canEnter(m, r.movement.key));
        released[i] ||= held[i]! && rows.length === 0;
      }
    }
    expect(admitted).toEqual([true, true]);
    expect(released).toEqual([true, true]);
  });

it('allows complete storage along a committed 30 degree bend before a denied box', () => {
  const tile = { z: 16, x: 55192, y: 30266 },
    pm = 1 / metersPerUnit(tile),
    a = { x: 2000, y: 2000 },
    bend = { x: a.x + 20 * pm, y: a.y },
    hx = Math.cos(Math.PI / 6),
    hy = Math.sin(Math.PI / 6),
    z = { x: bend.x + 25 * pm * hx, y: bend.y + 25 * pm * hy },
    b = new LifeBuilder();
  b.line(
    [{ x: a.x - 100 * pm, y: a.y }, a, bend, z, { x: z.x + 100 * pm * hx, y: z.y + 100 * pm * hy }],
    0,
    4,
  );
  for (const point of [a, z])
    b.line(
      [{ x: point.x, y: point.y - 100 * pm }, point, { x: point.x, y: point.y + 100 * pm }],
      0,
      4,
    );
  const life = new TileLife(tile, b.finish(), 1),
    table = new JunctionTable(),
    m = car();
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  Object.assign(m, {
    x: a.x - 6.8 * pm,
    y: a.y,
    d: (100 - 6.8) * pm,
    speed: 8 * pm,
    v: 0,
    lane: 0,
    paint: 0,
    pause: 0,
    rank: 0,
  });
  life.movers.push(m);
  const motions = life.junctionIndex.movements(m, 60 * pm, (line, dir) =>
      life.seamExit(m, line, dir),
    ),
    first = motions[0]!.key,
    next = motions[1]!.key,
    radius = motions[0]!.junction.radius;
  const gate = vi.spyOn(life, 'junctionClear').mockImplementation((p) => p.key !== next);
  for (let frame = 0; frame < 20 * 30; frame++) {
    life.prepareTraffic(() => true);
    table.begin(new Set([life]));
    life.requestJunctions(table, () => true, frame / 30);
    table.resolve(frame / 30);
    if (frame === 2) {
      expect(table.canEnter(m, first)).toBe(true);
      expect(table.granted(m, next)).toBe(false);
    }
    life.step(1 / 30, undefined, undefined, undefined, { clock: frame / 30, rain: 0 }, undefined, {
      junctions: table,
    });
  }
  expect(m.x - 2.2 * pm).toBeGreaterThan(a.x + radius);
  expect(table.movement(m, first)).toBeUndefined();
  expect(table.granted(m, next)).toBe(false);
  gate.mockRestore();
});

for (const linked of [false, true])
  it(`uses final-exit projections conservatively for ${linked ? 'linked' : 'carried'} storage`, () => {
    const life = empty(),
      table = new JunctionTable(),
      m = car(),
      pm = life.perMeter;
    const first = movement('a'),
      next = movement('b');
    Object.assign(first.junction, { radius: 3 * pm, linked });
    first.exit = { ...first.exit, x: 20 * pm, y: 0 };
    first.ahead = first.boxAhead = 0;
    Object.assign(next.junction, { x: 30 * pm, radius: 3 * pm });
    next.entry = { ...next.exit, x: 30 * pm, y: 0 };
    next.ahead = next.boxAhead = 30 * pm;
    life.movers.push(m);
    table.begin(new Set([life]));
    table.request({ m, life, tileKey: 'a', index: 0, movement: first, ready: true, inside: false });
    table.request({
      m,
      life,
      tileKey: 'a',
      index: 0,
      movement: next,
      ready: false,
      inside: false,
      precedingKey: 'a',
    });
    table.resolve(0);
    if (!linked) {
      const target = empty();
      target.movers.push(m);
      table.rebind(m, target, 'target', life);
    }
    expect(table.canEnter(m, 'a')).toBe(false);
    const currentNext = table.movement(m, 'b')!;
    currentNext.junction.x = currentNext.entry!.x = 40 * pm;
    expect(table.canEnter(m, 'a')).toBe(true);
    currentNext.inHx = Math.cos(Math.PI / 6);
    currentNext.inHy = Math.sin(Math.PI / 6);
    expect(table.canEnter(m, 'a')).toBe(false);
  });

for (const [separation, turning] of [
  [10, false],
  [12, false],
  [10, true],
] as const)
  it(`holds before a denied downstream box with ${separation}m storage geometry (turning=${turning}) and resumes`, () => {
    const tile = { z: 16, x: 55192, y: 30266 },
      pm = 1 / metersPerUnit(tile),
      b = new LifeBuilder(),
      a = { x: 2000, y: 2000 },
      next = { x: a.x + (turning ? 0 : separation * pm), y: a.y - (turning ? separation * pm : 0) };
    if (turning) {
      b.line([{ x: 1000, y: a.y }, a], 0, 4);
      b.line([a, next, { x: next.x, y: next.y - 100 * pm }], 0, 4);
      b.line([a, { x: a.x + 100 * pm, y: a.y }], 0, 4);
      b.line(
        [{ x: next.x - 100 * pm, y: next.y }, next, { x: next.x + 100 * pm, y: next.y }],
        0,
        4,
      );
    } else {
      b.line([{ x: 1000, y: a.y }, a, next, { x: 3000, y: a.y }], 0, 4);
      for (const point of [a, next])
        b.line([{ x: point.x, y: 1000 }, point, { x: point.x, y: 3000 }], 0, 4);
    }
    const life = new TileLife(tile, b.finish(), 1),
      table = new JunctionTable(),
      m = car();
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    Object.assign(m, {
      x: a.x - 20 * pm,
      y: a.y,
      d: 1000 - 20 * pm,
      speed: 8 * pm,
      v: 0,
      lane: 0,
      pause: 0,
      rank: 0,
      paint: 0,
      ...(turning
        ? {
            next: 2,
            routing: {
              seed: 1,
              turns: 0,
              plan: { line: 0, dir: 1, vertex: 1, exit: 2, radius: 4 },
            },
          }
        : {}),
    });
    life.movers.push(m);
    const junctions = life.junctionIndex.movements(m, 60 * pm, (line, dir) =>
      life.seamExit(m, line, dir),
    );
    expect(junctions).toHaveLength(2);
    const firstKey = junctions[0]!.key,
      nextKey = junctions[1]!.key,
      radius = junctions[0]!.junction.radius;
    let open = false,
      independentlyReleased = false;
    const gate = vi
      .spyOn(life, 'junctionClear')
      .mockImplementation((p) => p.key !== nextKey || open);
    const step = (frame: number, closeBeforeMovement = false) => {
      const clock = frame / 30;
      life.prepareTraffic(() => true);
      table.begin(new Set([life]));
      life.requestJunctions(table, () => true, clock);
      table.resolve(clock);
      if (closeBeforeMovement) open = false;
      life.step(1 / 30, undefined, undefined, undefined, { clock, rain: 0 }, undefined, {
        junctions: table,
      });
      independentlyReleased ||= !table.movement(m, firstKey) && !!table.movement(m, nextKey);
    };
    for (let frame = 0; frame < 600; frame++) step(frame);
    expect(table.granted(m, nextKey)).toBe(false);
    if (separation === 10) {
      expect(m.x + 2.2 * pm).toBeLessThanOrEqual(a.x - radius + 1e-7);
      expect(table.canEnter(m, firstKey)).toBe(false);
    } else expect(m.x - 2.2 * pm).toBeGreaterThanOrEqual(a.x + radius);
    open = true;
    step(600, true);
    expect(table.granted(m, nextKey)).toBe(false);
    if (separation === 10) expect(m.x + 2.2 * pm).toBeLessThanOrEqual(a.x - radius + 1e-7);
    open = true;
    for (let frame = 601; frame < 1200; frame++) step(frame);
    const past = turning ? next.y - m.y : m.x - next.x;
    expect(past / pm).toBeGreaterThan(20);
    expect(independentlyReleased).toBe(true);
    expect(table.movement(m, firstKey)).toBeUndefined();
    expect(table.movement(m, nextKey)).toBeUndefined();
    gate.mockRestore();
  });

for (const authorized of [false, true])
  it(`preserves ${authorized ? 'earned' : 'absent'} signal-clearance provenance through occupied adoption`, () => {
    const life = empty(),
      target = empty(),
      table = new JunctionTable(),
      m = car(),
      p = movement();
    life.movers.push(m);
    if (authorized) {
      table.begin(new Set([life]));
      table.request({
        m,
        life,
        tileKey: 'source',
        index: 0,
        movement: p,
        ready: true,
        inside: false,
        atLine: true,
      });
      table.resolve(0);
    }
    table.begin(new Set([life]));
    table.request({
      m,
      life,
      tileKey: 'source',
      index: 0,
      movement: p,
      ready: false,
      inside: true,
    });
    table.resolve(1);
    expect(table.granted(m)).toBe(true); // Physical occupancy remains protected in either case.
    expect(table.snapshot()[0]!.authorizedOutside).toBe(authorized ? true : undefined);
    target.movers.push(m);
    table.rebind(m, target, 'target', life);
    expect(table.snapshot()[0]!.authorizedOutside).toBe(authorized ? true : undefined);
  });

it('reuses route lookup scratch, queries each hop once and keeps retained movements and movers intact', () => {
  const tile = { z: 16, x: 55192, y: 30266 },
    pm = 1 / metersPerUnit(tile),
    builder = new LifeBuilder();
  for (let line = 0; line < 3; line++)
    builder.line(
      [
        { x: 1000 + line * 20 * pm, y: 2000 },
        { x: 1000 + (line + 1) * 20 * pm, y: 2000 },
      ],
      0,
      4,
    );
  for (const x of [1000 + 20 * pm, 1000 + 40 * pm])
    builder.line(
      [
        { x, y: 1900 },
        { x, y: 2000 },
        { x, y: 2100 },
      ],
      0,
      4,
    );
  const life = new TileLife(tile, builder.finish(), 1),
    m = { ...car(), x: 1000, y: 2000, next: 2 };
  const original = structuredClone(m),
    calls: number[] = [];
  const next = (line: number) => {
    calls.push(line);
    return line < 2 ? (line + 1) * 2 : 0;
  };
  const found = life.junctionIndex.movements(m, 65 * pm, next),
    retained = [...found];
  const values = structuredClone(retained);
  expect(found).toHaveLength(2);
  expect(calls).toEqual([0, 1, 2]);
  calls.length = 0;
  expect(life.junctionIndex.movements(m, 65 * pm, next)).toBe(found);
  expect(calls).toEqual([0, 1, 2]);
  expect(found.every((p, i) => p !== retained[i])).toBe(true);
  expect(retained).toEqual(values);
  expect(m).toEqual(original);
  calls.length = 0;
  expect(life.junctionIndex.movements(m, 5 * pm, next)).toHaveLength(0);
  expect(calls).toEqual([]);
  expect(life.junctionIndex.movements(m, 45 * pm, next)).toHaveLength(2);
  expect(calls).toEqual([0, 1]);
  expect(retained).toEqual(values);
});

it('discovers a reachable junction on a longer line without previewing its distant endpoint', () => {
  const tile = { z: 16, x: 55192, y: 30266 },
    pm = 1 / metersPerUnit(tile),
    builder = new LifeBuilder(),
    x = 1000 + 30 * pm;
  builder.line(
    [
      { x: 1000, y: 2000 },
      { x, y: 2000 },
      { x: 1000 + 100 * pm, y: 2000 },
    ],
    0,
    4,
  );
  builder.line(
    [
      { x, y: 1900 },
      { x, y: 2000 },
      { x, y: 2100 },
    ],
    0,
    4,
  );
  const life = new TileLife(tile, builder.finish(), 1),
    m = { ...car(), x: 1000, y: 2000 },
    next = vi.fn(() => 2);
  const before = structuredClone(m);
  expect(life.junctionIndex.movements(m, 60 * pm, next)).toHaveLength(1);
  expect(next).not.toHaveBeenCalled();
  expect(m).toEqual(before);
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
for (const downstreamFirst of [false, true])
  it(`revokes downstream eligibility before left-turn arbitration (downstreamFirst=${downstreamFirst})`, () => {
    const life = empty(),
      table = new JunctionTable(),
      left = car(),
      straight = car(),
      cross = car();
    const a = { ...movement('a'), outHx: 0, outHy: -1 };
    const b = { ...movement('b', true), inHy: -1, outHx: 0, outHy: -1, ahead: 14 };
    const step = (clock: number, traffic: boolean) => {
      table.begin(new Set([life]));
      for (const key of downstreamFirst ? ['b', 'a'] : ['a', 'b'])
        table.request({
          m: left,
          life,
          tileKey: '0',
          index: 0,
          movement: key === 'a' ? a : b,
          precedingKey: key === 'b' ? 'a' : undefined,
          ready: true,
          inside: false,
          atLine: key === 'a',
        });
      if (traffic) {
        table.request({
          m: straight,
          life,
          tileKey: '1',
          index: 1,
          movement: { ...movement('a'), inHx: -1, outHx: -1 },
          ready: true,
          inside: false,
          atLine: true,
        });
        table.request({
          m: cross,
          life,
          tileKey: '2',
          index: 2,
          movement: movement('b'),
          ready: true,
          inside: false,
          atLine: true,
        });
      }
      table.resolve(clock);
    };
    step(0, false);
    step(1, false);
    expect(table.granted(left, 'a')).toBe(true);
    expect(table.granted(left, 'b')).toBe(true);
    step(2, true);
    expect(table.granted(left, 'a')).toBe(false);
    expect(table.granted(left, 'b')).toBe(false);
    expect(table.snapshot().find((r) => r.index === 0 && r.key === 'b')!.ready).toBe(false);
    expect(table.granted(straight, 'a')).toBe(true);
    expect(table.granted(cross, 'b')).toBe(true);
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
for (const blockedBy of ['red', 'room'])
  it(`revokes a provisional grant on ${blockedBy} while retaining arrival`, () => {
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
        ready: blockedBy === 'room' || clock === 0,
        room: blockedBy === 'room' && clock === 1 ? 1 : Infinity,
        inside: false,
        atLine: true,
      });
      table.resolve(clock);
    }
    expect(table.granted(a)).toBe(false);
    expect(table.waited(a)).toBe(1);
  });
it('refreshes compacted carried indices and keeps a four-way cycle stable across request permutations', () => {
  const permutations = (xs: number[]): number[][] =>
    xs.length
      ? xs.flatMap((x, i) => permutations(xs.filter((_, j) => i !== j)).map((rest) => [x, ...rest]))
      : [[]];
  for (const order of permutations([0, 1, 2, 3])) {
    const source = empty(),
      target = empty(),
      table = new JunctionTable(),
      directions = [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ],
      paths = directions.map(([hx, hy]) => ({
        ...movement('cycle'),
        inHx: hx!,
        inHy: hy!,
        outHx: hx!,
        outHy: hy!,
        exit: { line: 0, along: 0, out: 1 as const, hx: hx!, hy: hy! },
      })),
      cars = paths.map((p) => ({
        ...car(),
        x: -p.inHx * (p.junction.radius + 5.7 * source.perMeter),
        y: -p.inHy * (p.junction.radius + 5.7 * source.perMeter),
      }));
    target.movers.length = 0;
    target.movers.push(car(), ...cars);
    table.request({
      m: cars[0]!,
      life: source,
      tileKey: 'source',
      index: 0,
      movement: paths[0]!,
      ready: false,
      inside: false,
      atLine: true,
    });
    table.resolve(0);
    table.rebind(cars[0]!, target, 'target', source);
    expect(table.snapshot()[0]!.index).toBe(1);
    target.movers.splice(0, 1);
    table.begin(new Set([target]));
    const traffic = new JunctionTraffic(),
      atLine = vi.spyOn(traffic, 'atLine').mockReturnValue(true);
    for (const i of order) {
      if (i === 0) table.refreshCarried(cars[0]!, () => true, Infinity, 'cycle', traffic, 0);
      else
        table.request({
          m: cars[i]!,
          life: target,
          tileKey: 'target',
          index: i,
          movement: paths[i]!,
          ready: true,
          inside: false,
          atLine: true,
        });
    }
    table.resolve(0);
    const snapshot = table.snapshot();
    expect(snapshot.map((r) => r.index).sort()).toEqual([0, 1, 2, 3]);
    expect(snapshot.find((r) => r.index === 0)!.arrival).toBe(0);
    expect(cars.map((m, i) => (table.granted(m, 'cycle') ? i : -1)).filter((i) => i >= 0)).toEqual([
      0,
    ]);
    atLine.mockRestore();
  }
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
    ready: true,
    room: traffic.room(m, p, a),
    inside: false,
    atLine: true,
  });
  table.resolve(0);
  expect(table.granted(m, 'a')).toBe(false);
  const arrival = table.snapshot()[0]!.arrival;
  table.rebind(m, b, 'b', a);
  expect(traffic.room(m, table.movement(m, 'a')!, b)).toBeCloseTo(0.8);
  const rebound = table.movement(m, 'a')!;
  table.begin(new Set([b]));
  table.request({
    m,
    life: b,
    tileKey: 'b',
    index: 0,
    movement: rebound,
    ready: true,
    room: traffic.room(m, rebound, b),
    inside: false,
    atLine: true,
  });
  table.resolve(1);
  expect(table.granted(m, 'a')).toBe(false);
  expect(table.snapshot()[0]!.arrival).toBe(arrival);
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
