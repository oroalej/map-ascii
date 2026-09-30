import { describe, expect, it } from 'vitest';
import { LifeBuilder, LifeLine, type LifeGeometry } from './geometry';
import { LifeWorld, TileLife, type Mover } from './simulate';
import { activityLevels } from './config';
import { bodiesOverlap, bodyInside, type Body } from './occupancy';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import { resolveTraffic, VEHICLES } from './vehicles';

const tile = { z: 16, x: 55192, y: 30266 },
  key = '16/55192/30266';
const pm = 1 / metersPerUnit(tile);
const center = tileToLngLat(tile, { x: 2048, y: 2048 });
const road = (kind: LifeLine = LifeLine.roadMinor, width = 10) => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2000 },
      { x: 4095, y: 2000 },
    ],
    kind,
    width,
  );
  return b;
};
const worldWith = (geo: LifeGeometry) => {
  const world = new LifeWorld();
  world.sync([{ key, tile, life: geo }]);
  const life = (world as unknown as { tiles: Map<string, TileLife> }).tiles.get(key)!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  // Disable random walking pauses/turns so the test isolates obstacle avoidance.
  (life as unknown as { rng: () => number }).rng = () => 1;
  world.visible(18, { ...activityLevels(1), vehicle: 1, person: 1, train: 1 }, center);
  return { world, life };
};
const mover = (at: number, person = false): Mover => ({
  kind: person ? 'person' : 'vehicle',
  line: 0,
  from: 0,
  dir: 1,
  d: at,
  x: at,
  y: 2000,
  hx: 1,
  hy: 0,
  speed: (person ? 1.2 : 20) * pm,
  vehicle: person ? undefined : 'car',
  paint: 0,
  lane: 0,
  pause: 0,
  rank: 0,
  group: person
    ? [{ figure: 'adult', shirt: 3, umbrella: 1, canopy: 0, lateral: 0, back: 0, step: 0 }]
    : undefined,
});

describe('traffic clearance', () => {
  it('keeps walkers off water while road vehicles can cross a mapped bridge', () => {
    const b = road(LifeLine.roadMinor, 6);
    b.area(
      'blocked',
      [
        [
          { x: 1100, y: 1700 },
          { x: 1500, y: 1700 },
          { x: 1500, y: 2300 },
          { x: 1100, y: 2300 },
          { x: 1100, y: 1700 },
        ],
      ],
      true,
    );
    const { world, life } = worldWith(b.finish());
    const car = mover(1000),
      person = mover(1000, true);
    life.movers.push(car, person);
    for (let i = 0; i < 300; i++) world.step(0.1, undefined, 18);
    expect(car.x).toBeGreaterThan(1500);
    expect(person.x).toBeLessThan(1100);
  });
  it('stops a fast car before a parked car instead of tunneling through it', () => {
    const { world, life } = worldWith(road(LifeLine.roadMinor, 6).finish());
    const m = mover(1000);
    life.movers.push(m);
    const p = { x: 1200, y: 2000 + 1.5 * pm, hx: 1, hy: 0, vehicle: 'car' as const, paint: 0 };
    life.parked.push(p);
    const parked: Body = { ...p, x: p.x / pm, y: p.y / pm, length: 4.4, width: 1.8 };
    for (let i = 0; i < 150; i++) {
      world.step(0.1, undefined, 18);
      expect(bodiesOverlap(life.groundBodies(m)[0]!, parked, 0)).toBe(false);
    }
    expect(m.x).toBeLessThan(p.x - 4.4 * pm);
    expect(m.waiting).toBeGreaterThan(0);
  });
  it('walks around parked cars and returns toward the path after passing', () => {
    const { world, life } = worldWith(road().finish());
    const m = mover(1000, true);
    life.movers.push(m);
    const p = { x: 1080, y: 2000, hx: 1, hy: 0, vehicle: 'car' as const, paint: 0 };
    life.parked.push(p);
    const parked: Body = { ...p, x: p.x / pm, y: p.y / pm, length: 4.4, width: 1.8 };
    let detour = 0;
    for (let i = 0; i < 600; i++) {
      world.step(0.1, undefined, 18);
      detour = Math.max(detour, Math.abs(m.avoid ?? 0));
      expect(bodiesOverlap(life.groundBodies(m)[0]!, parked, 0)).toBe(false);
    }
    expect(detour).toBeGreaterThan(1);
    expect(m.x).toBeGreaterThan(p.x + 20 * pm);
    expect(Math.abs(m.avoid ?? 0)).toBeLessThan(0.2);
  });
  it('cars yield to people in their lane', () => {
    const { world, life } = worldWith(road(LifeLine.roadMinor, 6).finish());
    const car = mover(1000),
      person = mover(1100, true);
    person.speed = 0;
    person.avoid = 1.5;
    person.pause = 100;
    life.movers.push(car, person);
    for (let i = 0; i < 80; i++) {
      world.step(0.1, undefined, 18);
      expect(bodiesOverlap(life.groundBodies(car)[0]!, life.groundBodies(person)[0]!, 0)).toBe(
        false,
      );
    }
    expect(car.x).toBeLessThan(person.x);
  });
  it('checks parked vehicles in the neighboring tile', () => {
    const { world, life } = worldWith(road(LifeLine.roadMinor, 6).finish());
    const nextTile = { ...tile, x: tile.x + 1 },
      nextKey = `16/${nextTile.x}/${nextTile.y}`;
    world.sync([
      { key, tile, life: life.geo },
      { key: nextKey, tile: nextTile, life: road(LifeLine.roadMinor, 6).finish() },
    ]);
    const next = (world as unknown as { tiles: Map<string, TileLife> }).tiles.get(nextKey)!;
    next.movers.length = next.parked.length = next.stalls.length = next.gatherers.length = 0;
    const m = mover(4000);
    life.movers.push(m);
    next.parked.push({ x: 2, y: 2000 + 1.5 * pm, hx: 1, hy: 0, vehicle: 'car', paint: 0 });
    for (let i = 0; i < 20; i++) world.step(0.1, undefined, 18);
    expect(m.x).toBeLessThan(4096 - 4.4 * pm);
  });
});

describe('parking footprints', () => {
  it('leaves a crossing clear even when it is in the middle of a road polyline', () => {
    const b = road(LifeLine.roadMajor, 14);
    b.line(
      [
        { x: 2048, y: 0 },
        { x: 2048, y: 4095 },
      ],
      LifeLine.roadMajor,
      14,
    );
    for (let seed = 1; seed <= 12; seed++) {
      const life = new TileLife(tile, b.finish(), seed);
      for (const p of life.parked) {
        const s = VEHICLES[p.vehicle];
        expect(Math.hypot(p.x - 2048, p.y - 2000) / pm).toBeGreaterThan(7 + 5 + s.length / 2);
      }
    }
  });
  it('rejects oversize and edge-crossing cars in lots with holes', () => {
    const b = new LifeBuilder();
    const ring = (x: number, y: number, w: number, h: number) => [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
      { x, y },
    ];
    const rings = [ring(500, 500, 200, 100), ring(585, 530, 20, 20)];
    b.area('parking', rings);
    for (const x of [505, 550, 595, 650, 695]) b.spot({ x, y: 540 }, 1, 0);
    for (let seed = 1; seed <= 10; seed++) {
      const life = new TileLife(tile, b.finish(), seed, resolveTraffic({ parked: { car: 1 } }));
      for (const p of life.parked)
        expect(bodyInside({ ...p, length: 4.4 * pm, width: 1.8 * pm }, rings)).toBe(true);
    }
  });
});

describe('occasional train arrivals', () => {
  it('admits a complete train after an empty interval and replaces a departed train', () => {
    const { world, life } = worldWith(road(LifeLine.rail, 0).finish());
    expect(world.visible(18, 1, center).some((a) => a.kind === 'train')).toBe(false);
    const arrival = () => {
      for (let i = 0; i < 1210 && !life.movers.some((m) => m.train); i++)
        world.step(0.1, undefined, 18);
      expect(life.movers.some((m) => m.train)).toBe(true);
      expect(world.visible(18, 1, center).filter((a) => a.kind === 'train')).toHaveLength(
        life.movers.find((m) => m.train)!.train!.cars.length,
      );
    };
    arrival();
    life.movers.length = 0;
    world.step(0.1, undefined, 18);
    expect(life.movers).toHaveLength(0);
    arrival();
  });
  it('never admits a running train to a siding or a track too short for its coaches', () => {
    for (const b of [
      road(LifeLine.siding, 0),
      (() => {
        const b = new LifeBuilder();
        b.line(
          [
            { x: 1000, y: 2000 },
            { x: 1010, y: 2000 },
          ],
          LifeLine.rail,
        );
        return b;
      })(),
    ]) {
      const { world, life } = worldWith(b.finish());
      for (let i = 0; i < 1500; i++) world.step(0.1, undefined, 18);
      expect(life.movers.some((m) => m.train)).toBe(false);
    }
  });
});
