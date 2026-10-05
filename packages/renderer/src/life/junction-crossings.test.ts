import { expect, it, vi } from 'vitest';
import { LifeBuilder } from './geometry';
import { LifeWorld, TileLife, type Mover } from './simulate';
import type { JunctionTable } from './junctions';
import { type Junction, type Movement } from './junctions';
import { worldTiles } from './testing/scenarios';
import { metersPerUnit } from '../raster/geometry';
import { EMPTY_PEDESTRIANS, type PedestrianView } from './pedestrians';
import { signalState } from './signals';
import { kinematicsOf } from './config';

const tile = { z: 16, x: 55192, y: 30266 },
  pm = 1 / metersPerUnit(tile);
const humanView = (life: TileLife) =>
  (life as unknown as { standalonePedestrians(): PedestrianView }).standalonePedestrians();
function fixture(signal = false) {
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
    near = { key: 'near', tile: neighborTile, life: geometry(20) },
    far = { key: 'far', tile: { ...tile, x: tile.x + 100 }, life: geometry(20) },
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
  f.world.sync([base, { ...near, key: 'replacement', life: geometry(25) }, far]);
  f.world.step(0.01);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(
    owner.junctionCrossings
      .forArm(j, east)
      .some((c) => Math.abs(c.body.x - (2000 + 25 * pm) / pm) < 0.01),
  ).toBe(true);
  expect(
    owner.junctionCrossings
      .forArm(j, east)
      .some((c) => Math.abs(c.body.x - (2000 + 20 * pm) / pm) < 0.01),
  ).toBe(false);
  f.world.sync([base]);
  f.world.step(0.01);
  expect(prepare).toHaveBeenCalledTimes(3);
  expect(owner.junctionCrossings.forArm(j, east)).toHaveLength(1);
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
    [20, 6],
    [30, 0],
  ]) {
    const x = center.x + outward! * pm,
      y = center.y + side! * pm;
    b.area('crossing', [
      [
        { x: x - 1.5 * pm, y: y - 6.5 * pm },
        { x: x + 1.5 * pm, y: y - 6.5 * pm },
        { x: x + 1.5 * pm, y: y + 6.5 * pm },
        { x: x - 1.5 * pm, y: y + 6.5 * pm },
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
