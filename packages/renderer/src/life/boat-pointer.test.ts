import { expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld } from './simulate';
import { continuityMover, left } from './testing/continuity';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import { bodyInside } from './occupancy';

function fixture(width = 30, hole = false, water = true) {
  const b = new LifeBuilder();
  b.line(
    [
      { x: -100, y: 2000 },
      { x: 4196, y: 2000 },
    ],
    LifeLine.river,
    20,
  );
  const world = new LifeWorld(),
    pm = 1 / metersPerUnit(left);
  const ring = (y: number, half: number, x0 = -100, x1 = 4196) => [
    { x: x0, y: y - half * pm },
    { x: x1, y: y - half * pm },
    { x: x1, y: y + half * pm },
    { x: x0, y: y + half * pm },
    { x: x0, y: y - half * pm },
  ];
  if (water)
    b.area(
      'blocked',
      [ring(2000, width / 2), ...(hole ? [ring(2000 + 3 * pm, 1, 1980, 2020)] : [])],
      true,
    );
  world.sync([{ key: 'boat', tile: left, life: b.finish() }]);
  const life = world.resident('boat')!;
  life.movers.length =
    life.parked.length =
    life.gatherers.length =
    life.stalls.length =
    life.flocks.length =
      0;
  life.scenes.sites.length = 0;
  const boat = continuityMover(life, 2000, 'boat');
  boat.speed = 3 * life.perMeter;
  boat.v = boat.speed;
  life.movers.push(boat);
  const at = tileToLngLat(left, { x: boat.x + 1 * life.perMeter, y: 2000 - life.perMeter });
  const step = (pointer: readonly [number, number] | null = at) =>
    world.step(
      0.1,
      undefined,
      19,
      undefined,
      undefined,
      { rain: 0 },
      1,
      1.8,
      1,
      pointer ?? undefined,
    );
  return { world, life, boat, step, at };
}

it('accepts an eased away offset in broad water and caps speed through kinematics', () => {
  const f = fixture();
  for (let i = 0; i < 15; i++) f.step();
  expect(f.boat.boatShift).toBeGreaterThan(0);
  expect(f.boat.v).toBeLessThanOrEqual(f.life.perMeter);
  const polygon = f.life.geo.areas!.find((a) => a.kind === 'blocked' && a.water)!;
  expect(
    f.life.groundBodies(f.boat).every((body) =>
      bodyInside(
        {
          ...body,
          x: body.x * f.life.perMeter,
          y: body.y * f.life.perMeter,
          length: body.length * f.life.perMeter,
          width: body.width * f.life.perMeter,
        },
        polygon.rings,
      ),
    ),
  ).toBe(true);
});
it.each([
  [2, false, true],
  [30, true, true],
  [30, false, false],
] as const)(
  'refuses unproven detours at narrow banks/holes/missing water (%s,%s,%s)',
  (width, hole, water) => {
    const f = fixture(width, hole, water);
    for (let i = 0; i < 20; i++) f.step();
    expect(Math.abs(f.boat.boatShift ?? 0)).toBeLessThan(2);
    if (!water) expect(f.boat).not.toHaveProperty('boatShift');
  },
);
it('preserves pointer-free boat properties and refuses a neighboring craft', () => {
  const a = fixture(),
    b = fixture();
  for (let i = 0; i < 20; i++) {
    a.step(null);
    b.step(null);
  }
  expect(a.boat).toEqual(b.boat);
  a.life.movers.push({ ...a.boat, rank: 0.5, boatShift: 1, speed: 0, v: 0 });
  const before = a.boat.boatShift;
  a.step();
  expect(a.boat.boatShift).toBe(before);
});
