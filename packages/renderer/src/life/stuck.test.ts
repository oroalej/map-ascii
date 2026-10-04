import { expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, type Mover, type Walker, type WorldGroundGuard } from './simulate';
import { worldTiles } from './testing/scenarios';
import { tileToLngLat, metersPerUnit } from '../raster/geometry';

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);
function fixture(
  kind: LifeLine,
  width: number,
  besideRoad = false,
  terrain?: (b: LifeBuilder) => void,
) {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 1000, y: 2048 },
      { x: 1000 + 220 * pm, y: 2048 },
    ],
    kind,
    width,
  );
  if (besideRoad)
    b.line(
      [
        { x: 1000, y: 2048 - 5.5 * pm },
        { x: 1000 + 220 * pm, y: 2048 - 5.5 * pm },
      ],
      LifeLine.roadMajor,
      8,
    );
  terrain?.(b);
  const world = new LifeWorld(undefined, undefined, { enabled: false });
  world.sync([{ key: 'stuck', tile, life: b.finish() }]);
  const life = worldTiles(world).get('stuck')!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  return { world, life };
}
const walker = (lateral = 0): Walker => ({
  figure: 'adult',
  shirt: 1,
  canopy: 0,
  umbrella: 1,
  lateral,
  back: 0,
  step: 0,
});
function mover(kind: 'person' | 'vehicle', metres: number, dir: 1 | -1): Mover {
  return {
    kind,
    line: 0,
    from: dir === 1 ? 0 : 1,
    dir,
    d: (dir === 1 ? metres : 220 - metres) * pm,
    x: 1000 + metres * pm,
    y: 2048,
    hx: dir,
    hy: 0,
    speed: (kind === 'person' ? 1.2 : 5) * pm,
    vehicle: kind === 'vehicle' ? 'car' : undefined,
    v: kind === 'vehicle' ? 5 * pm : undefined,
    group: kind === 'person' ? [walker()] : undefined,
    paint: 1,
    lane: 0,
    pause: 0,
    rank: 0,
  };
}

it.fails.each([2.9, 1.45])(
  'lets head-on walkers each travel 20 metres within 30 seconds at minimum %s',
  (minimum) => {
    const { world, life } = fixture(LifeLine.path, 3, true);
    const a = mover('person', 70, 1),
      b = mover('person', 80, -1);
    life.movers.push(a, b);
    for (let frame = 0; frame < 900; frame++)
      world.step(
        1 / 30,
        undefined,
        minimum === 2.9 ? 17 : 18,
        undefined,
        undefined,
        undefined,
        minimum,
      );
    expect(a.walked ?? 0).toBeGreaterThanOrEqual(20);
    expect(b.walked ?? 0).toBeGreaterThanOrEqual(20);
  },
);

it('lets a car clear a zoom-hidden crossing walker within 15 seconds at minimum 7', () => {
  const { world, life } = fixture(LifeLine.roadMajor, 8);
  const car = mover('vehicle', 50, 1),
    person = mover('person', 65, 1);
  const pose = life.pose(car);
  person.y = pose.y;
  life.movers.push(car, person);
  for (let frame = 0; frame < 450; frame++)
    world.step(1 / 30, undefined, 16, undefined, undefined, undefined, 7);
  expect(car.x / pm).toBeGreaterThan((1000 + 75 * pm) / pm);
});

it.fails('lets both head-on cars accept forward travel after recovery within 35 seconds', () => {
  const { world, life } = fixture(LifeLine.roadMajor, 3.2);
  const cars = [mover('vehicle', 70, 1), mover('vehicle', 82, -1)];
  life.movers.push(...cars);
  const resumed = new Set<Mover>();
  for (let frame = 0; frame < 35 * 30; frame++) {
    const before = cars.map((m) => ({ ...m }));
    world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
    if (frame > 30 * 30)
      for (const [i, m] of cars.entries())
        if (Math.hypot(m.x - before[i]!.x, m.y - before[i]!.y) > 0.001 * pm && (m.v ?? 0) > 0)
          resumed.add(m);
  }
  expect(resumed.size).toBe(2);
});

it('keeps a two-person group moving after switching from minimum 1.45 to 2.9', () => {
  const { world, life } = fixture(LifeLine.path, 3, true);
  const m = mover('person', 70, 1);
  m.group = [walker(-0.3), walker(0.3)];
  life.movers.push(m);
  for (let frame = 0; frame < 30; frame++)
    world.step(1 / 30, undefined, 18, undefined, undefined, undefined, 1.45);
  const before = tileToLngLat(tile, life.pose(m));
  for (let frame = 0; frame < 150; frame++)
    world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
  const after = tileToLngLat(tile, life.pose(m));
  expect(after).not.toEqual(before);
  expect(m.walked).toBeGreaterThan(1.2);
});

const guardFor = (world: LifeWorld, minimum: number) =>
  (
    world as unknown as {
      groundGuard: (minimum: number) => WorldGroundGuard;
    }
  ).groundGuard(minimum);
const rectangle = (x0: number, y0: number, x1: number, y1: number) => [
  [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
    { x: x0, y: y0 },
  ],
];

it.each([false, true])(
  'lets an inflated body escape nearby terrain without crossing physical terrain (water %s)',
  (water) => {
    const { world, life } = fixture(LifeLine.path, 3, false, (b) => {
      b.area('blocked', rectangle(1000, 2048 - 5 * pm, 1000 + 220 * pm, 2048 - 1.1 * pm), water);
      b.area(
        'blocked',
        rectangle(1000 + 72 * pm, 2048 - 10 * pm, 1000 + 73 * pm, 2048 + 10 * pm),
        water,
      );
    });
    const before = mover('person', 70, 1);
    const next = { ...before, x: before.x + pm, d: before.d + pm };
    life.movers.push(before);
    expect(guardFor(world, 2.9)(life, next, before)).toBe(true);
    expect(guardFor(world, 2.9)(life, { ...next, x: before.x + 5 * pm }, before)).toBe(false);
    // Initial admission still requires a legal inflated footprint.
    expect(guardFor(world, 2.9)(life, next)).toBe(false);
    const inside = { ...before, y: 2048 - 2 * pm };
    expect(guardFor(world, 2.9)(life, next, inside)).toBe(false);
  },
);

it('checks intermediate occupancy even during terrain inflation escape', () => {
  const { world, life } = fixture(LifeLine.path, 3, true);
  const before = mover('person', 70, 1);
  life.movers.push(before);
  life.parked.push({ x: before.x + 10 * pm, y: before.y, hx: 1, hy: 0, vehicle: 'car', paint: 0 });
  const guard = guardFor(world, 2.9);
  const previous = { ...before };
  before.x += 20 * pm;
  expect(guard(life, before, previous)).toBe(false);
});
