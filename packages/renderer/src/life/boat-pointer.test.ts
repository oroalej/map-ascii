import { expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, TileLife } from './simulate';
import { continuityMover, left, parent, right } from './testing/continuity';
import type { TileId } from '../tiles';
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

function transferTile(tile: TileId, hazard?: 'bank' | 'hole' | 'obstacle', seam = false) {
  const b = new LifeBuilder(),
    pm = 1 / metersPerUnit(tile),
    y = 1000 * 2 ** (tile.z - parent.z);
  b.line(
    [
      { x: -100, y },
      { x: 4196, y },
    ],
    LifeLine.river,
    20,
    77,
  );
  const ring = (x0: number, x1: number, center: number, half: number) => [
    { x: x0, y: center - half * pm },
    { x: x1, y: center - half * pm },
    { x: x1, y: center + half * pm },
    { x: x0, y: center + half * pm },
    { x: x0, y: center - half * pm },
  ];
  const x = seam ? 0 : 2000;
  b.area(
    'blocked',
    [
      ring(-100, seam && !hazard ? 4096 : 4196, y, hazard === 'bank' ? 1.8 : 15),
      ...(hazard === 'hole' ? [ring(x - 4 * pm, x + 4 * pm, y + 3 * pm, 1)] : []),
    ],
    true,
  );
  if (hazard === 'obstacle') b.area('blocked', [ring(x - 4 * pm, x + 4 * pm, y + 3 * pm, 1)]);
  return { key: `${tile.z}/${tile.x}/${tile.y}`, tile, life: b.finish() };
}
function empty(life: TileLife) {
  life.movers.length = life.parked.length = life.gatherers.length = life.stalls.length = 0;
  life.flocks.length = life.scenes.sites.length = 0;
}
it.each(['bank', 'hole', 'obstacle'] as const)(
  'rejects a shifted zoom adoption into a %s while the unshifted transfer remains legal',
  (hazard) => {
    for (const shifted of [false, true]) {
      const world = new LifeWorld(),
        sourceEntry = transferTile(parent),
        targetEntry = transferTile(left, hazard);
      world.sync([sourceEntry]);
      const source = world.resident(sourceEntry.key)!,
        target = new TileLife(left, targetEntry.life, 1),
        boat = continuityMover(source, 1000, 'boat');
      empty(source);
      empty(target);
      target.movers.push(continuityMover(target, 2500, 'boat'));
      if (shifted) boat.boatShift = 3;
      source.movers.push(boat);
      world.sync([targetEntry], undefined, undefined, new Map([[targetEntry.key, target]]));
      expect(target.movers.includes(boat)).toBe(!shifted);
      if (shifted) expect(source.movers).toContain(boat);
    }
  },
);
it.each(['bank', 'hole', 'obstacle'] as const)(
  'does not hand an active detour across a seam into a %s',
  (hazard) => {
    const world = new LifeWorld(),
      sourceEntry = transferTile(left, undefined, true),
      targetEntry = transferTile(right, hazard, true);
    world.sync([sourceEntry, targetEntry]);
    const source = world.resident(sourceEntry.key)!,
      target = world.resident(targetEntry.key)!,
      boat = continuityMover(source, 4080, 'boat');
    empty(source);
    empty(target);
    Object.assign(boat, { boatShift: 3, speed: 3 * source.perMeter, v: source.perMeter });
    source.movers.push(boat);
    const pointer = tileToLngLat(left, {
      x: boat.x + source.perMeter,
      y: boat.y - source.perMeter,
    });
    for (let i = 0; i < 60; i++)
      world.step(0.1, undefined, 19, undefined, undefined, { rain: 0 }, 1, 1.8, 1, pointer);
    expect(target.movers).not.toContain(boat);
    expect(source.movers).toContain(boat);
    expect(boat.boatShift).toBeGreaterThan(0);
  },
);
