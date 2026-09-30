import { describe, expect, it } from 'vitest';
import { LifeBuilder, LifeLine, type LifeGeometry } from './geometry';
import { LifeWorld, TileLife, type Mover, type Stall, type VisibleAgent } from './simulate';
import { activityLevels } from './config';
import { bodiesOverlap, bodyInside, type Body } from './occupancy';
import { lngLatToTile, metersPerUnit, tileToLngLat } from '../raster/geometry';
import { resolveTraffic, VEHICLES } from './vehicles';
import { stripRing } from './terrain';
import { packLife, type LifeGrid } from './draw';
import { themes } from '../theme';

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
  it('packs moving traffic under a crown envelope but rejects a complete parked stamp', () => {
    const b = new LifeBuilder();
    b.area('parking-exclusion', [
      stripRing(
        { x: 2000 - 2 * pm, y: 2000 - 10 * pm },
        { x: 2000 - 2 * pm, y: 2000 + 10 * pm },
        pm,
      ),
    ]);
    const { world } = worldWith(b.finish());
    const grid: LifeGrid = {
      cols: 40,
      rows: 30,
      cellWidth: 10,
      cellHeight: 18,
      toCell: (lng, lat) => {
        const p = lngLatToTile(tile, lng, lat);
        return [(p.x - 2000) / pm + 20, (p.y - 2000) / pm + 15];
      },
    };
    grid.allowsGroundCell = world.groundCellGuard(grid.toCell);
    const [lng, lat] = tileToLngLat(tile, { x: 2000, y: 2000 });
    const car: VisibleAgent = {
      kind: 'vehicle',
      vehicle: 'car',
      paint: 1,
      lng,
      lat,
      flap: 0,
      ahead: tileToLngLat(tile, { x: 2000 + pm, y: 2000 }),
      side: tileToLngLat(tile, { x: 2000, y: 2000 + pm }),
    };
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    expect(packLife(out, grid, [car], themes.dark, () => 1)).toBe(1);
    expect(out.some((byte) => byte !== 0)).toBe(true);
    expect(packLife(out, grid, [{ ...car, parked: true }], themes.dark, () => 1)).toBe(0);
    expect(out.every((byte) => byte === 0)).toBe(true);
  });

  it('removes a vendor and releases its approaching customer when a neighboring road loads', () => {
    const { world, life } = worldWith(road(LifeLine.path).finish());
    life.scenes.sites.length = 0;
    const stall: Stall = { x: 4090, y: 2000, hx: 1, hy: 0, paint: 0, shirt: 0, side: 1, rank: 0 };
    life.stalls.push(stall);
    life.scenes.addStall(stall);
    const customer = mover(3900, true);
    life.movers.push(customer);
    expect(life.scenes.reserve(customer, 0)).toBe(true);
    life.scenes.step(0.5, [customer], {});
    const visit = life.scenes.visits.get(customer)!;
    const position = [customer.x, customer.y];
    const b = new LifeBuilder();
    b.area('carriageway', [stripRing({ x: -20, y: 1900 }, { x: -20, y: 2100 }, 40)]);
    world.sync([
      { key, tile, life: life.geo },
      { key: 'neighbor', tile: { ...tile, x: tile.x + 1 }, life: b.finish() },
    ]);
    expect(life.stalls).toHaveLength(0);
    expect(life.scenes.sites).toHaveLength(0);
    expect(visit.site.queue).toHaveLength(0);
    expect(visit.state).toBe('return');
    expect([customer.x, customer.y]).toEqual(position);
    for (let i = 0; i < 100 && life.scenes.visits.has(customer); i++)
      world.step(0.1, undefined, 18);
    expect(life.scenes.visits.has(customer)).toBe(false);
    // Normal walking resumes in the same frame after returning to the original route.
    expect(customer.x).toBeGreaterThanOrEqual(3900);
    expect(customer.x).toBeLessThanOrEqual(3900 + customer.speed * 0.1 + 1e-8);
    expect(customer.y).toBe(2000);
  });

  it('projects whole ASCII cells onto road, crossing, and tree masks', () => {
    const b = road(LifeLine.roadMinor, 6);
    b.area('crossing', [stripRing({ x: 39.5 * pm, y: 2000 }, { x: 42.5 * pm, y: 2000 }, 3 * pm)]);
    b.area('parking-exclusion', [
      stripRing({ x: 60 * pm, y: 2000 + 11 * pm }, { x: 62 * pm, y: 2000 + 11 * pm }, pm),
    ]);
    const { world } = worldWith(b.finish());
    // Two-meter square cells with the road center at row 10.
    const allows = world.groundCellGuard((lng, lat) => {
      const p = lngLatToTile(tile, lng, lat);
      return [p.x / pm / 2, (p.y - 2000) / pm / 2 + 10];
    })!;
    const person: VisibleAgent = { kind: 'person', lng: center[0], lat: center[1], flap: 0 };
    expect(allows(person, 10, 10)).toBe(false);
    // Its center is at the curb, but part of the cell still reaches into the road.
    expect(allows(person, 10, 11)).toBe(false);
    expect(allows(person, 10, 12)).toBe(true);
    expect(allows(person, 20, 10)).toBe(true);
    expect(allows({ ...person, vehicle: 'cart' }, 20, 10)).toBe(false);
    expect(allows({ ...person, aboard: true }, 10, 10)).toBe(true);
    const vehicle: VisibleAgent = { ...person, kind: 'vehicle', vehicle: 'car' };
    expect(allows(vehicle, 10, 10)).toBe(true);
    expect(allows(vehicle, 30, 15)).toBe(true);
    expect(allows({ ...vehicle, parked: true }, 30, 15)).toBe(false);
    expect(allows(vehicle, 30, 17)).toBe(true);
  });

  it('only lets a whole walking group cross a carriageway inside an explicit crossing', () => {
    for (const marked of [false, true]) {
      const b = road(LifeLine.roadMinor, 6);
      b.line(
        [
          { x: 1200, y: 1800 },
          { x: 1200, y: 2300 },
        ],
        LifeLine.path,
      );
      if (marked)
        b.area('crossing', [
          stripRing({ x: 1200 - 1.5 * pm, y: 2000 }, { x: 1200 + 1.5 * pm, y: 2000 }, 3 * pm),
        ]);
      const { world, life } = worldWith(b.finish());
      const m = mover(0, true);
      Object.assign(m, { line: 1, from: 2, x: 1200, y: 1800, hx: 0, hy: 1 });
      life.movers.push(m);
      for (let i = 0; i < 500; i++) world.step(0.1, undefined, 18);
      if (marked) expect(m.y).toBeGreaterThan(2000 + 3 * pm);
      else expect(m.y).toBeLessThan(2000 - 3 * pm);
      expect(life.roadTerrain.access.allows(life.groundBodies(m))).toBe(true);
    }
  });
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
    b.line(
      [
        { x: 0, y: 2000 - 5 * pm },
        { x: 4095, y: 2000 - 5 * pm },
      ],
      LifeLine.path,
    );
    const { world, life } = worldWith(b.finish());
    const car = mover(1000),
      person = mover(1000, true);
    Object.assign(person, { line: 1, from: 2, y: 2000 - 5 * pm });
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
    const { world, life } = worldWith(road(LifeLine.path).finish());
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
  it('omits complete cars overlapping trees, including rotated corners, keeping clear stalls', () => {
    const b = new LifeBuilder();
    b.area('parking-exclusion', [
      [
        { x: 500, y: 500 },
        { x: 540, y: 500 },
        { x: 540, y: 540 },
        { x: 500, y: 540 },
        { x: 500, y: 500 },
      ],
    ]);
    for (const [x, y, hx, hy] of [
      [510, 510, 1, 0],
      [547, 543, Math.SQRT1_2, Math.SQRT1_2],
      [700, 700, 1, 0],
    ])
      b.spot({ x: x!, y: y! }, hx!, hy!);
    const seen = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      const life = new TileLife(tile, b.finish(), seed, resolveTraffic({ parked: { car: 1 } }));
      for (const p of life.parked) seen.add(p.x);
    }
    expect([...seen]).toEqual([700]);
  });
  it('removes parking overlapping a neighboring tile crown while retaining nearby clear cars', () => {
    const { world, life } = worldWith(road().finish());
    const overlapping = { x: 4090, y: 2000, hx: 1, hy: 0, vehicle: 'car' as const, paint: 0 };
    const clear = { ...overlapping, x: 3900 };
    life.parked.push(overlapping, clear);
    const nextTile = { ...tile, x: tile.x + 1 };
    const b = new LifeBuilder();
    b.area('parking-exclusion', [
      [
        { x: -20, y: 1960 },
        { x: 50, y: 1960 },
        { x: 50, y: 2040 },
        { x: -20, y: 2040 },
        { x: -20, y: 1960 },
      ],
    ]);
    world.sync([
      { key, tile, life: life.geo },
      { key: 'neighbor', tile: nextTile, life: b.finish() },
    ]);
    expect(life.parked).toEqual([clear]);
  });
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
