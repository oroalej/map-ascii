import { expect, it, vi } from 'vitest';
import { LifeBuilder } from './geometry';
import { LifeWorld, TileLife, type Mover } from './simulate';
import type { JunctionTable } from './junctions';
import { type Junction, type Movement } from './junctions';
import { worldTiles } from './testing/scenarios';
import { metersPerUnit } from '../raster/geometry';
import { EMPTY_PEDESTRIANS, type PedestrianCrossing, type PedestrianView } from './pedestrians';
import { signalState } from './signals';
import { kinematicsOf } from './config';
import { reach } from './occupancy';
import { VEHICLES } from './vehicles';
import { continuityMover, continuityTile, left, right } from './testing/continuity';

const tile = { z: 16, x: 55192, y: 30266 },
  pm = 1 / metersPerUnit(tile);
const humanView = (life: TileLife) =>
  (life as unknown as { standalonePedestrians(): PedestrianView }).standalonePedestrians();

it('keeps original and copied acute-fork arms tied to their own crossing', () => {
  const b = new LifeBuilder(),
    center = { x: 2000, y: 2000 },
    hx = Math.cos(Math.PI / 9),
    hy = Math.sin(Math.PI / 9);
  for (const [x, y] of [
    [1, 0],
    [hx, hy],
    [-1, 0],
  ])
    b.line([center, { x: center.x + x! * 100 * pm, y: center.y + y! * 100 * pm }], 0, 12);
  const x = center.x + 12 * hx * pm,
    y = center.y + 12 * hy * pm;
  b.area('crossing', [
    [
      [-1.5, -6.5],
      [1.5, -6.5],
      [1.5, 6.5],
      [-1.5, 6.5],
    ].map(([a, s]) => ({
      x: x + (hx * a! - hy * s!) * pm,
      y: y + (hy * a! + hx * s!) * pm,
    })),
  ]);
  b.line(
    [
      { x: x - 10 * hy * pm, y: y + 10 * hx * pm },
      { x: x + 10 * hy * pm, y: y - 10 * hx * pm },
    ],
    3,
    3,
  );
  const life = new TileLife(tile, b.finish(), 1);
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  const j = life.junctionIndex.junctions[0]!,
    arm = j.arms.find((a) => a.line === 1)!;
  expect(life.junctionCrossings.forArm(j, arm)).toHaveLength(1);
  expect(life.junctionCrossings.forArm(j, { ...arm })).toHaveLength(1);
  expect(
    life.junctionCrossings.forArm(
      j,
      j.arms.find((a) => a.line === 0),
    ),
  ).toHaveLength(0);
  const car: Mover = {
    kind: 'vehicle',
    vehicle: 'car',
    line: 2,
    from: 5,
    dir: -1,
    d: 70 * pm,
    x: center.x - 30 * pm,
    y: center.y,
    hx: 1,
    hy: 0,
    speed: 8 * pm,
    paint: 0,
    lane: 0,
    pause: 0,
    rank: 0,
    next: 2,
  };
  const human: Mover = {
    kind: 'person',
    line: 3,
    from: 6,
    dir: 1,
    d: 10 * pm,
    x,
    y,
    hx: -hy,
    hy: hx,
    speed: 0,
    paint: 0,
    lane: 0,
    pause: 100,
    rank: 0,
    group: [{ figure: 'adult', shirt: 3, umbrella: 0, canopy: 0, lateral: 0, back: 0, step: 0 }],
  };
  life.movers.push(car, human);
  const movement = life.junctionIndex.movement(car, 60 * pm)!;
  expect(movement.exit).toBe(arm);
  expect(life.junctionClear(movement, humanView(life))).toBe(false);
  const inbound = {
    ...movement,
    entry: arm,
    inHx: -hx,
    inHy: -hy,
    ahead: 30 * pm,
    boxAhead: 30 * pm,
  };
  life.junctionCrossings.holdAhead(inbound, false);
  expect(inbound.ahead).toBeLessThan(inbound.boxAhead);
});
function fixture(signal = false, remoteCrossing?: number) {
  const b = new LifeBuilder(),
    center = { x: 2000, y: 2000 },
    directions = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ];
  for (const [hx, hy] of directions) {
    b.line([center, { x: center.x + hx! * 200 * pm, y: center.y + hy! * 200 * pm }], 0, 12);
    const x = center.x + hx! * 12 * pm,
      y = center.y + hy! * 12 * pm;
    b.area('crossing', [
      [
        [-1.5, -6.5],
        [1.5, -6.5],
        [1.5, 6.5],
        [-1.5, 6.5],
      ].map(([a, s]) => ({
        x: x + (hx! * a! - hy! * s!) * pm,
        y: y + (hy! * a! + hx! * s!) * pm,
      })),
    ]);
  }
  if (remoteCrossing !== undefined) {
    const x = center.x - remoteCrossing * pm;
    b.area('crossing', [
      [
        { x: x - 1.5 * pm, y: center.y - 6.5 * pm },
        { x: x + 1.5 * pm, y: center.y - 6.5 * pm },
        { x: x + 1.5 * pm, y: center.y + 6.5 * pm },
        { x: x - 1.5 * pm, y: center.y + 6.5 * pm },
      ],
    ]);
  }
  b.line(
    [
      { x: 2000 - 12 * pm, y: 2000 - 14 * pm },
      { x: 2000 - 12 * pm, y: 2000 + 14 * pm },
    ],
    3,
    3,
  );
  if (signal) b.signal(center, 12, 90, 0, true);
  const world = new LifeWorld();
  world.sync([{ key: 'junction-crossings', tile, life: b.finish() }]);
  const life = worldTiles(world).get('junction-crossings')!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  Object.assign(life, { walkerRng: () => 1, runRng: () => 1 });
  const car: Mover = {
    kind: 'vehicle',
    vehicle: 'car',
    line: 2,
    from: 5,
    dir: -1,
    d: (200 - 10.8) * pm,
    x: 2000 - 10.8 * pm,
    y: 2000,
    hx: 1,
    hy: 0,
    speed: 8 * pm,
    v: 8 * pm,
    paint: 0,
    lane: 0,
    pause: 0,
    rank: 0,
    routing: { seed: 1, turns: 0, plan: { line: 2, dir: -1, vertex: 4, exit: 0, radius: 7 } },
  };
  const human: Mover = {
    kind: 'person',
    line: 4,
    from: 8,
    dir: 1,
    d: 14 * pm,
    x: 2000 - 12 * pm,
    y: 2000,
    hx: 0,
    hy: 1,
    speed: 0,
    paint: 0,
    lane: 0,
    pause: 100,
    rank: 0,
    group: [{ figure: 'adult', shirt: 3, umbrella: 0, canopy: 0, lateral: 0, back: 0, step: 0 }],
  };
  life.movers.push(car);
  const table = (world as unknown as { junctions: JunctionTable }).junctions;
  return { world, life, car, human, table };
}

for (const controlled of [false, true])
  it(`caches ${controlled ? 'controlled' : 'uncontrolled'} entry membership through requests and copied arms`, () => {
    const { life, car, table } = fixture(controlled),
      membership = vi.spyOn(life.signals, 'controlsCrossing');
    life.prepareTraffic(() => true);
    life.requestJunctions(table, () => true, 0);
    table.resolve(0);
    const p = table.movement(car)!;
    expect(life.junctionCrossings.controlled(p)).toBe(controlled);
    expect(membership).toHaveBeenCalledTimes(1);
    life.junctionClear({ ...p, entry: { ...p.entry! } }, humanView(life));
    expect(membership).toHaveBeenCalledTimes(1);
    expect(life.junctionCrossings.controlled({ ...p, entry: p.exit })).toBe(controlled);
    expect(membership).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) life.junctionCrossings.controlled({ ...p, entry: undefined });
    expect(membership).toHaveBeenCalledTimes(4);
    membership.mockRestore();
  });

it('classifies replacement controller geometry without inheriting a cached negative answer', () => {
  const f = fixture(),
    before = f.life.junctionIndex.movement(f.car, 60 * pm)!;
  expect(f.life.junctionCrossings.controlled(before)).toBe(false);
  const replacement = fixture(true);
  f.world.sync([{ key: 'replacement-controller', tile, life: replacement.life.geo }]);
  f.world.step(0.01);
  const life = f.world.active('replacement-controller')!,
    p = life.junctionIndex.movement(f.car, 60 * pm)!;
  expect(life).not.toBe(f.life);
  expect(life.junctionCrossings.controlled(p)).toBe(true);
});

it('does not repeat live crossing queries for a denied and already capped hold', () => {
  const { life, car, human, table } = fixture();
  life.movers.push(human);
  life.prepareTraffic(() => true);
  life.requestJunctions(table, () => true, 0, '', undefined, humanView(life));
  table.resolve(0);
  expect(table.granted(car)).toBe(false);
  const clear = vi.spyOn(life, 'junctionClear'),
    distance = car.d,
    movement = table.movement(car)!;
  life.step(0.1, undefined, undefined, undefined, { clock: 0, rain: 0 }, undefined, {
    junctions: table,
  });
  expect(clear).not.toHaveBeenCalled();
  expect(car.d - distance).toBeLessThanOrEqual(
    Math.max(0, movement.boxAhead ?? movement.ahead) + 1e-7,
  );
  expect(table.granted(car)).toBe(false);
  clear.mockRestore();
});

it('excludes a remote road crossing while retaining the nearby entrance stripe', () => {
  const { life, car, human } = fixture(false, 30),
    p = life.junctionIndex.movement(car, 60 * pm)!;
  expect(life.junctionCrossings.forArm(p.junction, p.entry)).toHaveLength(1);
  human.x = 2000 - 30 * pm;
  life.movers.push(human);
  expect(life.junctionClear(p, humanView(life))).toBe(true);
  life.junctionCrossings.holdAhead(p, false);
  expect((p.boxAhead! - p.ahead) / pm).toBeCloseTo(6.5);
});

it('denies occupied entry after the front passed the stripe while the rear still overlaps it', () => {
  const { life, car, human, table } = fixture(),
    p = life.junctionIndex.movement(car, 60 * pm)!,
    crossing = life.junctionCrossings.forArm(p.junction, p.entry)[0]!,
    outward = (p.junction.x / pm - crossing.body.x) * p.inHx,
    half = reach(crossing.body, p.inHx, p.inHy),
    distance = (p.junction.x - car.x) / pm,
    front = distance - VEHICLES.car.length / 2,
    rear = distance + VEHICLES.car.length / 2;
  expect(front).toBeLessThan(outward - half);
  expect(rear).toBeGreaterThan(outward - half);
  expect(rear).toBeLessThan(outward + half);
  life.movers.push(human);
  expect(life.junctionClear(p, humanView(life))).toBe(false);
  life.prepareTraffic(() => true);
  life.requestJunctions(table, () => true, 0, '', undefined, humanView(life));
  table.resolve(0);
  expect(table.granted(car, p.key)).toBe(false);
  expect(table.snapshot().find((r) => r.key === p.key)!.inside).toBe(false);
});

for (const inside of [false, true])
  it(`retains ${inside ? 'physical braking while an occupant clears' : 'courtesy for an outside provisional grant'}`, () => {
    const { life, car, table } = fixture();
    const distance = inside ? 5 : 25;
    Object.assign(car, { x: 2000 - distance * pm, d: (200 - distance) * pm });
    life.prepareTraffic(() => true);
    life.requestJunctions(table, () => true, 0);
    table.resolve(0);
    expect(table.granted(car)).toBe(true);
    expect(table.snapshot()[0]!.inside).toBe(inside);
    if (inside) {
      // Move onto the committed exit, close enough for courtesy to slow the
      // vehicle but still outside the late-arrival commitment distance.
      Object.assign(car, {
        line: 0,
        from: 0,
        dir: 1,
        x: 2000 + pm,
        d: pm,
        routing: undefined,
        next: undefined,
      });
      life.prepareTraffic(() => true);
      table.begin(new Set([life]));
      life.requestJunctions(table, () => true, 0.1);
      table.resolve(0.1);
    }
    const target = (
      life as unknown as {
        pedestrianTarget(m: Mover, target: number, view: PedestrianView, dt: number): number;
      }
    ).pedestrianTarget.bind(life);
    const view: PedestrianView = {
      ...EMPTY_PEDESTRIANS,
      empty: false,
      walkersInArea: () => true,
    };
    const limited = target(car, 8 * pm, view, 0.1);
    if (inside) {
      expect(limited).toBe(8 * pm);
      const associations = vi.spyOn(life.junctionCrossings, 'forArm').mockReturnValue([]);
      expect(target(car, 8 * pm, view, 0.1)).toBeLessThan(8 * pm);
      associations.mockRestore();
    } else expect(limited).toBeLessThan(8 * pm);
    expect(car.pedestrianHolds?.length).toBeGreaterThan(0);
    expect(target(car, 8 * pm, { ...view, walkersAlong: () => 5 }, 0.1)).toBeLessThan(8 * pm);
    expect(table.snapshot()[0]!.inside).toBe(inside);
  });

it('retains courtesy at an unrelated downstream crossing while an occupant clears its junction', () => {
  const { life, car, table } = fixture(false, -22);
  Object.assign(car, { x: 2000 - 5 * pm, d: 195 * pm });
  life.prepareTraffic(() => true);
  life.requestJunctions(table, () => true, 0);
  table.resolve(0);
  const key = table.movement(car)!.key;
  Object.assign(car, {
    line: 0,
    from: 0,
    dir: 1,
    x: 2000 + 7.5 * pm,
    d: 7.5 * pm,
    routing: undefined,
    next: undefined,
  });
  life.prepareTraffic(() => true);
  table.begin(new Set([life]));
  life.requestJunctions(table, () => true, 0.1);
  table.resolve(0.1);
  expect(table.snapshot().find((r) => r.key === key)!.inside).toBe(true);
  const movement = table.movement(car, key)!;
  expect(life.junctionCrossings.forArm(movement.junction, movement.exit)).toHaveLength(1);
  const target = (
    life as unknown as {
      pedestrianTarget(m: Mover, target: number, view: PedestrianView, dt: number): number;
    }
  ).pedestrianTarget(
    car,
    8 * pm,
    { ...EMPTY_PEDESTRIANS, empty: false, walkersInArea: () => true },
    0.1,
  );
  expect(target).toBeLessThan(8 * pm);
  expect(car.pedestrianHolds?.some((h) => !h.committed)).toBe(true);
  expect(table.granted(car, key)).toBe(true);
});

it('reuses one curb predicate across repeated entry and exit clearance queries', () => {
  const { life, car } = fixture(),
    movement = life.junctionIndex.movement(car, 60 * pm)!,
    predicates = new Set<NonNullable<Parameters<PedestrianView['walkersInArea']>[1]>>();
  let queries = 0;
  const view: PedestrianView = {
    ...EMPTY_PEDESTRIANS,
    empty: false,
    walkersInArea: (_polygon, predicate) => {
      if (predicate) {
        queries++;
        predicates.add(predicate);
      }
      return false;
    },
  };
  for (let i = 0; i < 10; i++) expect(life.junctionClear(movement, view)).toBe(true);
  expect(queries).toBeGreaterThan(1);
  expect(predicates.size).toBe(1);
});

for (const arm of ['entry', 'exit'] as const)
  it(`revokes a provisional grant when the ${arm} crossing fills and holds the line`, () => {
    const f = fixture(),
      { life, car, human, table } = f;
    life.prepareTraffic(() => true);
    life.requestJunctions(table, () => true, 0);
    table.resolve(0);
    expect(table.granted(car)).toBe(true);
    const key = table.movement(car)!.key,
      arrival = table.snapshot().find((r) => r.key === key)!.arrival;
    expect(arrival).toBeDefined();
    if (arm === 'exit') human.x = 2000 + 12 * pm;
    life.movers.push(human);
    f.world.step(0.1, undefined, 18, undefined, undefined, undefined, 0.9);
    expect(table.granted(car)).toBe(false);
    expect(car.x).toBeLessThanOrEqual(2000 - 10.7 * pm + 1e-6);
    expect(table.snapshot().find((r) => r.key === key)!.arrival).toBe(arrival);
  });
it('holds a newly denied approach upstream of its entrance stripe without moving physical box admission', () => {
  const f = fixture(),
    { life, car, human, table } = f;
  Object.assign(car, { d: (200 - 20) * pm, x: 2000 - 20 * pm, v: 0 });
  life.movers.push(human);
  life.prepareTraffic(() => true);
  life.requestJunctions(table, () => true, 0, '', undefined, humanView(life));
  table.resolve(0);
  const p = table.movement(car)!;
  expect(table.granted(car)).toBe(false);
  expect(p.ahead / pm).toBeCloseTo(2.8);
  expect(p.boxAhead! / pm).toBeCloseTo(9.3);
  f.world.step(0.1, undefined, 18, undefined, undefined, undefined, 0.9);
  expect(car.x).toBeLessThanOrEqual(2000 - 17.2 * pm);
});
it('checks accepted pedestrian positions after a walker enters the inward-curb area in the same step', () => {
  const f = fixture(),
    { life, car, human, table } = f;
  Object.assign(human, { y: 2000 - 10.2 * pm, d: 3.8 * pm, pause: 0, speed: 10 * pm });
  life.movers.push(human);
  const p = life.junctionIndex.movement(car, 60 * pm)!;
  expect(life.junctionClear(p, humanView(life))).toBe(true);
  f.world.step(0.1, undefined, 18, undefined, undefined, undefined, 0.9);
  expect(human.y).toBeGreaterThan(2000 - 9.6 * pm);
  expect(table.granted(car, p.key)).toBe(false);
  expect(car.x).toBeLessThanOrEqual(2000 - 10.7 * pm + 1e-6);
});
it('assigns a stripe inside the box to the east arm only, leaving southbound traffic eligible', () => {
  const f = fixture(),
    j = f.life.junctionIndex.junctions[0]!;
  // Move the prepared east stripe nearer the centre to reproduce the retained occupied-box regression.
  const east = j.arms.find((a) => a.hx === 1)!,
    south = j.arms.find((a) => a.hy === 1)!;
  expect(f.life.junctionCrossings.forArm(j, east)).toHaveLength(1);
  expect(f.life.junctionCrossings.forArm(j, south)).toHaveLength(1);
  const crossing = f.life.junctionCrossings.forArm(j, east)[0]!;
  const view: PedestrianView = {
    ...EMPTY_PEDESTRIANS,
    empty: false,
    walkersInArea: (polygon) => polygon === crossing.polygon,
  };
  const movement = f.life.junctionIndex.movement(f.car, 60 * pm)!;
  const path = {
    ...movement,
    inHx: 0,
    inHy: 1,
    outHx: 0,
    outHy: 1,
    entry: j.arms.find((a) => a.hy === -1),
    exit: south,
  };
  expect(f.life.junctionClear(path, view)).toBe(true);
});
it('retains controlled geometry separately without enabling entrance courtesy', () => {
  const f = fixture(true),
    crossings = f.life.pedestrianCrossings;
  expect(crossings.empty).toBe(true);
  expect(crossings.hasLine(2)).toBe(false);
  expect(crossings.controlledAssociations.size).toBeGreaterThan(0);
  const path = [{ x: 2000 / pm - 40, y: 2000 / pm, hx: 1, hy: 0, length: 80, line: 2, ahead: 0 }];
  expect(crossings.along(path, 1).size).toBe(0);
  expect(
    crossings.limit(humanView(f.life), path, 1, 4.4, 30, 8 * pm, kinematicsOf('car'), 0.1),
  ).toEqual({ target: 8 * pm, holds: undefined });
  const j = f.life.junctionIndex.junctions[0]!;
  expect(
    f.life.junctionCrossings.forArm(
      j,
      j.arms.find((a) => a.hy === -1),
    ),
  ).toHaveLength(1);
});
it('gates only the exit crossing for a signal-controlled turn and retains its green permission', () => {
  const f = fixture(true),
    { life, car, human, table } = f;
  car.routing = {
    seed: 1,
    turns: 0,
    plan: { line: 2, dir: -1, vertex: 4, exit: 6, radius: 7, side: 'left' },
  };
  human.x = 2000;
  human.y = 2000 - 12 * pm;
  life.movers.push(human);
  const clock = Array.from({ length: 140 }, (_, t) => t).find(
    (t) => signalState(life.signals.signals[0]!.seed, t).a === 'green',
  )!;
  life.prepareTraffic(() => true);
  life.requestJunctions(table, () => true, clock, '', undefined, humanView(life));
  table.resolve(clock);
  expect(table.granted(car)).toBe(false);
  expect(table.snapshot()[0]!.ready).toBe(false);
  human.x = 2000 - 12 * pm;
  human.y = 2000;
  table.begin(new Set([life]));
  life.requestJunctions(table, () => true, clock, '', undefined, humanView(life));
  table.resolve(clock);
  expect(table.granted(car)).toBe(true);
});
it('uses a linked arm member anchor rather than the primary junction centre', () => {
  const f = fixture(),
    original = f.life.junctionIndex.junctions[0]!,
    east = original.arms.find((a) => a.hx === 1)!;
  const j: Junction = {
    ...original,
    x: original.x - 100 * pm,
    arms: [{ ...east, x: original.x, y: original.y }],
    linked: true,
  };
  expect(f.life.junctionCrossings.forArm(j, j.arms[0])).toHaveLength(1);
});
it('reads a crossing available only in an adjacent tile in the owner metric frame', () => {
  const owner = fixture().life,
    b = new LifeBuilder();
  const x = 2000 + 12 * pm - 4096;
  b.line(
    [
      { x: -4096, y: 2000 },
      { x: 0, y: 2000 },
    ],
    0,
    12,
  );
  b.area('crossing', [
    [
      { x: x - 1.5 * pm, y: 2000 - 6.5 * pm },
      { x: x + 1.5 * pm, y: 2000 - 6.5 * pm },
      { x: x + 1.5 * pm, y: 2000 + 6.5 * pm },
      { x: x - 1.5 * pm, y: 2000 + 6.5 * pm },
    ],
  ]);
  const neighbor = new TileLife({ ...tile, x: tile.x + 1 }, b.finish(), 2);
  owner.junctionCrossings.prepare([neighbor]);
  const j = owner.junctionIndex.junctions[0]!,
    east = j.arms.find((a) => a.hx === 1)!;
  expect(owner.junctionCrossings.forArm(j, east)).toHaveLength(1);
  const c = owner.junctionCrossings.forArm(j, east)[0]!;
  expect(c.body.x).toBeCloseTo((2000 + 12 * pm) / pm, 4);
  const view: PedestrianView = {
    ...EMPTY_PEDESTRIANS,
    empty: false,
    walkersInArea: (polygon) => polygon === c.polygon,
  };
  const m: Movement = {
    key: j.key,
    junction: j,
    inHx: 1,
    inHy: 0,
    outHx: 1,
    outHy: 0,
    stop: 0,
    line: 2,
    dir: -1,
    entry: j.arms.find((a) => a.hx === -1),
    exit: east,
    ahead: 1,
  };
  expect(owner.junctionClear(m, view)).toBe(false);
});
it('culls an irrelevant adjacent stripe and refreshes unchanged sources when consumer bounds expand', () => {
  const { life, table } = fixture(),
    builder = new LifeBuilder();
  builder.line(
    [
      { x: 0, y: 2000 },
      { x: 4096, y: 2000 },
    ],
    0,
    12,
  );
  builder.area('crossing', [
    [
      { x: 2000 - 1.5 * pm, y: 2000 - 6.5 * pm },
      { x: 2000 + 1.5 * pm, y: 2000 - 6.5 * pm },
      { x: 2000 + 1.5 * pm, y: 2000 + 6.5 * pm },
      { x: 2000 - 1.5 * pm, y: 2000 + 6.5 * pm },
    ],
  ]);
  const source = new TileLife({ ...tile, x: tile.x + 1 }, builder.finish(), 1),
    bounds = life.junctionCrossings.bounds(table),
    prepared = life.junctionCrossings as unknown as { crossings: PedestrianCrossing[] };
  expect(life.junctionCrossings.relevant(source, bounds)).toBe(true);
  life.junctionCrossings.prepare([source], 7, bounds);
  expect(prepared.crossings).toHaveLength(0);
  life.junctionCrossings.prepare([source], 7, { ...bounds, x1: (4096 + 2020) / pm });
  expect(prepared.crossings).toHaveLength(1);
  life.junctionCrossings.prepare([source], 7, bounds);
  expect(prepared.crossings).toHaveLength(0);
});

it('caches relevant crossing sources and invalidates on addition, replacement and removal', () => {
  const f = fixture(),
    owner = f.life,
    neighborTile = { ...tile, x: tile.x + 1 };
  const geometry = (outward: number) => {
    const b = new LifeBuilder(),
      x = 2000 + outward * pm - 4096;
    b.line(
      [
        { x: -4096, y: 2000 },
        { x: 0, y: 2000 },
      ],
      0,
      12,
    );
    b.area('crossing', [
      [
        { x: x - 1.5 * pm, y: 2000 - 6.5 * pm },
        { x: x + 1.5 * pm, y: 2000 - 6.5 * pm },
        { x: x + 1.5 * pm, y: 2000 + 6.5 * pm },
        { x: x - 1.5 * pm, y: 2000 + 6.5 * pm },
      ],
    ]);
    return b.finish();
  };
  const base = { key: 'junction-crossings', tile, life: owner.geo },
    near = { key: 'near', tile: neighborTile, life: geometry(10) },
    far = { key: 'far', tile: { ...tile, x: tile.x + 100 }, life: geometry(10) },
    prepare = vi.spyOn(owner.junctionCrossings, 'prepare'),
    j = owner.junctionIndex.junctions[0]!,
    east = j.arms.find((a) => a.hx === 1)!;
  f.world.sync([base, near, far]);
  f.world.step(0.01);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(prepare.mock.calls[0]![0]).toContain(f.world.active('near'));
  expect(prepare.mock.calls[0]![0]).not.toContain(f.world.active('far'));
  expect(owner.junctionCrossings.forArm(j, east)).toHaveLength(2);
  f.world.step(0.01);
  expect(prepare).toHaveBeenCalledTimes(1);
  f.world.sync([base, { ...near, key: 'replacement', life: geometry(11) }, far]);
  f.world.step(0.01);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(
    owner.junctionCrossings
      .forArm(j, east)
      .some((c) => Math.abs(c.body.x - (2000 + 11 * pm) / pm) < 0.01),
  ).toBe(true);
  expect(
    owner.junctionCrossings
      .forArm(j, east)
      .some((c) => Math.abs(c.body.x - (2000 + 10 * pm) / pm) < 0.01),
  ).toBe(false);
  f.world.sync([base]);
  f.world.step(0.01);
  expect(prepare).toHaveBeenCalledTimes(3);
  expect(owner.junctionCrossings.forArm(j, east)).toHaveLength(1);
});
it('refreshes only the receiving crossing consumer after a retained-hold seam transfer', () => {
  const b = new LifeBuilder(),
    x = 4096 - pm;
  b.line(
    [
      { x: 3800, y: 2000 },
      { x, y: 2000 },
      { x: 4200, y: 2000 },
    ],
    0,
    6,
    77,
  );
  b.line(
    [
      { x, y: 1000 },
      { x, y: 2000 },
      { x, y: 3000 },
    ],
    1,
    6,
    88,
  );
  b.splitRoadJunctions(pm, 40);
  const world = new LifeWorld(),
    entry = { ...continuityTile(left), life: b.finish() },
    remote = continuityTile({ ...right, x: right.x + 100 });
  const remoteBuilder = new LifeBuilder(),
    stripeX = 2000 + 8 * pm;
  remoteBuilder.line(
    [
      { x: -100, y: 2000 },
      { x: 4196, y: 2000 },
    ],
    0,
    6,
    77,
  );
  remoteBuilder.area('crossing', [
    [
      { x: stripeX - 1.5 * pm, y: 2000 - 6.5 * pm },
      { x: stripeX + 1.5 * pm, y: 2000 - 6.5 * pm },
      { x: stripeX + 1.5 * pm, y: 2000 + 6.5 * pm },
      { x: stripeX - 1.5 * pm, y: 2000 + 6.5 * pm },
    ],
  ]);
  remote.life = remoteBuilder.finish();
  world.sync([entry, continuityTile(right), remote]);
  const source = world.active(entry.key)!,
    target = world.active(continuityTile(right).key)!,
    far = world.active(remote.key)!;
  for (const life of [source, target, far]) {
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
  }
  const m = continuityMover(source, 4096 - 11 * pm);
  Object.assign(m, { d: m.x - 3800, v: 10 * pm, next: 2 });
  source.movers.push(m);
  world.step(1 / 30);
  const sourceBounds = vi.spyOn(source.junctionCrossings, 'bounds'),
    sourceRelevant = vi.spyOn(source.junctionCrossings, 'relevant'),
    targetBounds = vi.spyOn(target.junctionCrossings, 'bounds'),
    targetPrepare = vi.spyOn(target.junctionCrossings, 'prepare');
  for (let i = 0; i < 120 && source.movers.includes(m); i++) world.step(1 / 30);
  expect(target.movers).toContain(m);
  const table = (world as unknown as { junctions: JunctionTable }).junctions;
  expect([...table.holds(m)].length).toBeGreaterThan(0);
  const previousSources = [...targetPrepare.mock.calls];
  world.step(1 / 30);
  expect(sourceBounds).not.toHaveBeenCalled();
  expect(sourceRelevant).not.toHaveBeenCalled();
  expect(targetBounds).toHaveBeenCalledTimes(1);
  expect(targetPrepare).toHaveBeenCalledTimes(previousSources.length + 1);
  expect(targetPrepare.mock.lastCall![0]).toEqual([source, target]);
  expect(targetPrepare.mock.lastCall![0]).not.toContain(far);

  // A carried box can extend beyond the receiver's usual footprint. Its bounds must
  // still admit newly relevant sources without invalidating any other consumer.
  const hold = [...table.holds(m)][0]!,
    carried = hold.movement.junction;
  hold.movement.junction = {
    ...carried,
    x: 100 * 4096 + 2000,
    arms: carried.arms.map((arm) => ({ ...arm, x: 100 * 4096 + 2000, y: carried.y })),
  };
  (world as unknown as { dirtyCrossingConsumers: Set<TileLife> }).dirtyCrossingConsumers.add(
    target,
  );
  world.step(1 / 30);
  expect(targetPrepare.mock.lastCall![0]).toContain(far);
  const extended = hold.movement.junction;
  expect(
    target.junctionCrossings.forArm(
      extended,
      extended.arms.find((arm) => arm.hx === 1),
    ),
  ).toHaveLength(1);
  expect(sourceBounds).not.toHaveBeenCalled();
  expect(sourceRelevant).not.toHaveBeenCalled();
});
it('includes prepared crossings from a finer neighboring footprint', () => {
  const f = fixture(),
    owner = f.life,
    b = new LifeBuilder(),
    finer = { z: tile.z + 1, x: tile.x * 2 + 1, y: tile.y * 2 },
    x = (2000 + 12 * pm) * 2 - 4096,
    y = 4000;
  b.line(
    [
      { x: 0, y },
      { x: 4096, y },
    ],
    0,
    12,
  );
  b.area('crossing', [
    [
      { x: x - 3 * pm, y: y - 13 * pm },
      { x: x + 3 * pm, y: y - 13 * pm },
      { x: x + 3 * pm, y: y + 13 * pm },
      { x: x - 3 * pm, y: y + 13 * pm },
    ],
  ]);
  const source = new TileLife(finer, b.finish(), 1),
    bounds = owner.junctionCrossings.bounds(f.table);
  expect(owner.junctionCrossings.relevant(source, bounds)).toBe(true);
  owner.junctionCrossings.prepare([source]);
  const j = owner.junctionIndex.junctions[0]!,
    east = j.arms.find((a) => a.hx === 1)!;
  expect(owner.junctionCrossings.forArm(j, east)).toHaveLength(1);
});
it('uses the shared default corridor for an unknown-width arm', () => {
  const b = new LifeBuilder(),
    center = { x: 2000, y: 2000 };
  b.line([{ x: 1000, y: 2000 }, center, { x: 3000, y: 2000 }], 0, 0);
  b.line([{ x: 2000, y: 1000 }, center, { x: 2000, y: 3000 }], 0, 6);
  for (const [outward, side] of [
    [10, 5.5],
    [10, 0],
  ]) {
    const x = center.x + outward! * pm,
      y = center.y + side! * pm;
    b.area('crossing', [
      [
        { x: x - 3 * pm, y: y - 6.5 * pm },
        { x: x + 3 * pm, y: y - 6.5 * pm },
        { x: x + 3 * pm, y: y + 6.5 * pm },
        { x: x - 3 * pm, y: y + 6.5 * pm },
      ],
    ]);
  }
  const life = new TileLife(tile, b.finish(), 1),
    j = life.junctionIndex.junctions[0]!,
    east = j.arms.find((a) => a.hx === 1)!;
  expect(life.geo.widths[east.line]).toBe(0);
  const associated = life.junctionCrossings.forArm(j, east);
  expect(associated).toHaveLength(1);
  expect(associated[0]!.body.y).toBeCloseTo(center.y / pm);
});
