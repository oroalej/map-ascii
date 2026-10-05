import { describe, expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, type Mover } from './simulate';
import { worldTiles } from './testing/scenarios';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import { ROAD_AVOID, STALL } from './config';
import { VEHICLES } from './vehicles';
import { bodyHitsPolygon, bodiesOverlap } from './occupancy';
import { buildTileGeometry, createIdRegistry, type TileFeatureLike } from '../raster/geometry';

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);
function obstacleRoad(angle = 0, oneway: 0 | 1 = 1) {
  const hx = Math.cos(angle),
    hy = Math.sin(angle);
  const point = (x: number, y = 0) => ({
    x: 2000 + (hx * x - hy * y) * pm,
    y: 2000 + (hy * x + hx * y) * pm,
  });
  const b = new LifeBuilder();
  b.line([point(-100), point(150)], LifeLine.roadMinor, 8, 1, oneway);
  // A mapped curb intrudes into the ordinary lane, while the carriageway has room beside it.
  const obstacle = [[point(10, 1.5), point(35, 1.5), point(35, 4), point(10, 4), point(10, 1.5)]];
  b.area('blocked', obstacle);
  const world = new LifeWorld();
  world.sync([{ key: 'road', tile, life: b.finish() }]);
  const life = worldTiles(world).get('road')!;
  (life as unknown as { walkerRng: () => number }).walkerRng = () => 1;
  (life as unknown as { runRng: () => number }).runRng = () => 1;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  const make = (x: number, vehicle: 'car' | 'motorcycle' = 'car'): Mover => ({
    kind: 'vehicle',
    vehicle,
    line: 0,
    from: 0,
    dir: 1,
    d: (x + 100) * pm,
    ...point(x),
    hx,
    hy,
    speed: 4 * pm,
    v: 4 * pm,
    lane: 0,
    paint: 0,
    pause: 0,
    rank: 0,
  });
  return { world, life, point, obstacle, make };
}

describe('terrain-blocked road vehicles', () => {
  for (const [angle, oneway] of [
    [0, 1],
    [0.8, 1],
    [0, 0],
    [0.8, 0],
  ] as const)
    it(`passes an intruding curb with guarded, bounded lateral movement at ${angle} radians, oneway ${oneway}`, () => {
      const { world, life, obstacle, make } = obstacleRoad(angle, oneway);
      const car = make(-15),
        follower = make(-30, 'motorcycle');
      life.movers.push(car, follower);
      let adjusted = false;
      const lane = life.offsetOf(car);
      for (let frame = 0; frame < 600; frame++) {
        const before = life.offsetOf(car),
          start = car.d,
          from = { ...life.pose(car) };
        world.step(0.1, undefined, 21);
        const offset = life.offsetOf(car);
        // Nose first: the body points the way it moves, within 3°.
        const to = life.pose(car);
        const dx = to.x - from.x,
          dy = to.y - from.y;
        if (Math.hypot(dx, dy) > 0.05 * pm) {
          const hx = from.hx + to.hx,
            hy = from.hy + to.hy;
          const cos = (dx * hx + dy * hy) / (Math.hypot(dx, dy) * Math.hypot(hx, hy));
          expect(cos).toBeGreaterThan(Math.cos((3 * Math.PI) / 180));
        }
        // It steers: sideways only while moving forward, and no steeper than a lane bend.
        const forward = Math.abs(car.d - start) / pm;
        expect(Math.abs(offset - before)).toBeLessThanOrEqual(
          ROAD_AVOID.slope * forward * 1.05 + 1e-6,
        );
        expect(Math.abs(offset) + VEHICLES.car.width / 2).toBeLessThanOrEqual(4);
        for (const m of [car, follower]) {
          const bodies = life.groundBodies(m);
          // Unit geometry is in tile units; ground bodies are in metres.
          expect(
            bodies.some((b) =>
              bodyHitsPolygon(
                { ...b, x: b.x * pm, y: b.y * pm, length: b.length * pm, width: b.width * pm },
                obstacle,
              ),
            ),
          ).toBe(false);
        }
        expect(bodiesOverlap(life.groundBodies(car)[0]!, life.groundBodies(follower)[0]!)).toBe(
          false,
        );
        adjusted ||= Math.abs(offset - lane) > 0.5;
        if (follower.d > 150 * pm && car.roadShift === undefined) break;
      }
      expect(adjusted).toBe(true);
      expect(car.d).toBeGreaterThan(150 * pm);
      expect(follower.d).toBeGreaterThan(150 * pm);
      expect(car.roadShift).toBeUndefined();
    });

  it('keeps the crossing stop when a human blocks the lane', () => {
    const { world, life, make, point } = obstacleRoad();
    const car = make(-15);
    const human: Mover = {
      ...make(0),
      kind: 'person',
      vehicle: undefined,
      ...point(0, 2),
      speed: 0,
      v: undefined,
      group: [{ figure: 'adult', shirt: 0, umbrella: 0, canopy: 0, lateral: 0, back: 0, step: 0 }],
    };
    life.movers.push(car, human);
    for (let frame = 0; frame < 200; frame++) world.step(0.1, undefined, 21);
    expect(car.v).toBe(0);
    expect(car.roadShift).toBeUndefined();
    expect(car.d).toBeLessThan(100 * pm);
  });

  it('does not steer through traffic occupying the available road space', () => {
    const { world, life, make } = obstacleRoad(0, 0);
    const car = make(7.7);
    car.v = 0;
    const parked = make(7.7);
    parked.speed = parked.v = 0;
    parked.roadShift = -2;
    life.movers.push(car, parked);
    const start = car.d;
    for (let frame = 0; frame < 100; frame++) world.step(0.1, undefined, 21);
    expect(car.d).toBeLessThan(110 * pm);
    expect(car.d).toBeGreaterThanOrEqual(start);
    expect(bodiesOverlap(life.groundBodies(car)[0]!, life.groundBodies(parked)[0]!)).toBe(false);
  });

  for (const [vehicle, turn, oneway] of [
    ['jeepney', 'left', 1],
    ['car', 'right', 0],
  ] as const)
    it(`clears a ${vehicle} and followers around a curb into a ${turn} turn, oneway ${oneway}`, () => {
      const b = new LifeBuilder();
      b.line(
        [
          { x: 466, y: 378 },
          { x: 500, y: 263 },
          { x: 518, y: 208 },
        ],
        LifeLine.roadMid,
        8,
        1,
        1,
      );
      b.line(
        [{ x: 518, y: 208 }, turn === 'left' ? { x: 181, y: 40 } : { x: 3833, y: 1313 }],
        LifeLine.roadMid,
        8,
        2,
        oneway,
      );
      const curb = [
        [
          { x: 536, y: 216 },
          { x: 563, y: 230 },
          { x: 563, y: 268 },
          { x: 531, y: 278 },
          { x: 527, y: 278 },
          { x: 494, y: 268 },
          { x: 494, y: 230 },
          { x: 522, y: 216 },
          { x: 536, y: 216 },
        ],
        [
          { x: 496, y: 231 },
          { x: 496, y: 267 },
          { x: 529, y: 277 },
          { x: 562, y: 267 },
          { x: 562, y: 231 },
          { x: 535, y: 218 },
          { x: 522, y: 218 },
          { x: 496, y: 231 },
        ],
      ];
      // Tile geometry blocks a curb's whole island for vehicles (raster/geometry.ts).
      const island = [curb[0]!];
      b.area('vehicle-blocked', island);
      const world = new LifeWorld();
      world.sync([{ key: 'turn', tile, life: b.finish() }]);
      const life = worldTiles(world).get('turn')!;
      life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
      life.pending.length = 0;
      life.scenes.sites.length = 0;
      const make = (vehicle: 'jeepney' | 'motorcycle' | 'car'): Mover => ({
        kind: 'vehicle',
        vehicle,
        line: 0,
        from: 0,
        dir: 1,
        d: 0,
        x: 466,
        y: 378,
        hx: 34 / Math.hypot(34, 115),
        hy: -115 / Math.hypot(34, 115),
        speed: 4 * pm,
        v: 4 * pm,
        lane: 0.24,
        paint: 0,
        pause: 0,
        rank: 0,
      });
      const jeep = make(vehicle),
        motorcycle = make('motorcycle'),
        car = make('car');
      const completed = new Set<Mover>();
      life.movers.push(jeep);
      for (let frame = 0; frame < 9000; frame++) {
        if (frame === 300) life.movers.push(motorcycle);
        if (frame === 600) life.movers.push(car);
        world.step(1 / 30, undefined, 21);
        for (const m of life.movers)
          for (const body of life.groundBodies(m))
            expect(
              bodyHitsPolygon(
                {
                  ...body,
                  x: body.x * pm,
                  y: body.y * pm,
                  length: body.length * pm,
                  width: body.width * pm,
                },
                island,
              ),
            ).toBe(false);
        const bodies = life.movers.map((m) => life.groundBodies(m)[0]!);
        for (let i = 0; i < bodies.length; i++)
          for (let j = i + 1; j < bodies.length; j++)
            expect(bodiesOverlap(bodies[i]!, bodies[j]!)).toBe(false);
        // The fixture ends beyond the curb. Remove departing traffic so its artificial
        // dead end cannot send vehicles back into the junction under test.
        for (const m of [jeep, motorcycle, car])
          if (!completed.has(m) && m.line === 1 && m.d > 20 * pm && m.roadShift === undefined) {
            completed.add(m);
            life.movers.splice(life.movers.indexOf(m), 1);
          }
        if (completed.size === 3) break;
      }
      for (const m of [jeep, motorcycle, car]) {
        expect(m.line, JSON.stringify(m)).toBe(1);
        expect(m.d).toBeGreaterThan(20 * pm);
        expect(m.roadShift).toBeUndefined();
      }
    });
});

describe('vehicles that cannot go on', () => {
  it('never doubles back sharper than a corner can curve while another way on exists', () => {
    const b = new LifeBuilder();
    const at = (x: number, y: number) => ({ x: 1000 + x * pm, y: 2000 + y * pm });
    b.line([at(0, 0), at(100, 0)], LifeLine.roadMid, 8);
    b.line([at(100, 0), at(10, 8)], LifeLine.roadMid, 8);
    b.line([at(100, 0), at(200, 0)], LifeLine.roadMid, 8);
    const world = new LifeWorld();
    world.sync([{ key: 'hairpin', tile, life: b.finish() }]);
    const life = worldTiles(world).get('hairpin')! as unknown as {
      exitOptions(m: Pick<Mover, 'kind' | 'line' | 'dir'>, vertex: number): number[];
    };
    const options = life.exitOptions({ kind: 'vehicle', line: 0, dir: 1 }, 1);
    expect(options).toEqual([4]);
  });

  it('leaves once fixed obstacles have held it, only where nobody sees it go', () => {
    const b = new LifeBuilder();
    const at = (x: number, y: number) => ({ x: 200 + x * pm, y: 2000 + y * pm });
    b.line([at(0, 0), at(400, 0)], LifeLine.roadMid, 8, 1, 1);
    // Walls across the road ahead of each vehicle.
    for (const x of [30, 330])
      b.area('vehicle-blocked', [[at(x, -5), at(x + 2, -5), at(x + 2, 5), at(x, 5), at(x, -5)]]);
    const world = new LifeWorld();
    world.sync([{ key: 'walls', tile, life: b.finish() }]);
    const life = worldTiles(world).get('walls')!;
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.pending.length = 0;
    life.scenes.sites.length = 0;
    const make = (x: number): Mover => ({
      kind: 'vehicle',
      vehicle: 'car',
      line: 0,
      from: 0,
      dir: 1,
      d: x * pm,
      ...at(x, 0),
      hx: 1,
      hy: 0,
      speed: 4 * pm,
      v: 4 * pm,
      lane: 0,
      paint: 0,
      pause: 0,
      rank: 0,
    });
    const seen = make(25),
      unseen = make(325);
    life.movers.push(seen, unseen);
    const [w, n] = tileToLngLat(tile, at(0, -40));
    const [e, s] = tileToLngLat(tile, at(60, 40));
    world.updateView({ bounds: [w, s, e, n], spawnMarginM: 2 });
    for (let frame = 0; frame < (STALL.terrainSeconds + 2) * 10; frame++)
      world.step(0.1, undefined, 21);
    expect(life.movers).toContain(seen);
    expect(seen.terrainWait).toBeGreaterThan(STALL.terrainSeconds);
    expect(life.movers).not.toContain(unseen);
  });
});

describe('blocked walking routes', () => {
  it('gives a crossing group room to leave the carriageway and release waiting traffic', () => {
    const line: TileFeatureLike = {
      type: 2,
      properties: { id: 'road', class: 'road_minor', width: 8 },
      loadGeometry: () => [
        [
          { x: 100, y: 2000 },
          { x: 4000, y: 2000 },
        ],
      ],
    };
    const crossing: TileFeatureLike = {
      type: 1,
      properties: {
        id: 'crossing',
        class: 'furniture',
        variant: 'crossing',
        crossing_bearing: 90,
        crossing_width: 8,
      },
      loadGeometry: () => [[{ x: 2000, y: 2000 }]],
    };
    const layer = (features: TileFeatureLike[]) => ({
      extent: 4096,
      length: features.length,
      feature: (i: number) => features[i]!,
    });
    const geometry = buildTileGeometry(
      { roads: layer([line]), poi: layer([crossing]) },
      createIdRegistry(),
      tile,
    );
    const world = new LifeWorld(undefined, undefined, { enabled: false });
    world.sync([{ key: 'crossing', tile, life: geometry.life }]);
    const life = worldTiles(world).get('crossing')!;
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    (life as unknown as { walkerRng: () => number }).walkerRng = () => 1;
    const path = Array.from(life.geo.kinds).findIndex((kind) => kind === LifeLine.path);
    expect(path).toBeGreaterThanOrEqual(0);
    const from = life.geo.starts[path]!;
    const human: Mover = {
      kind: 'person',
      line: path,
      from,
      dir: 1,
      d: 0,
      x: life.geo.coords[from * 2]!,
      y: life.geo.coords[from * 2 + 1]!,
      hx: 0,
      hy: 1,
      speed: 1.2 * pm,
      paint: 0,
      lane: 0,
      pause: 0,
      rank: 0,
      group: [
        { figure: 'adult', shirt: 0, umbrella: 0, canopy: 0, lateral: 0, back: 0, step: 0 },
        { figure: 'child', shirt: 0, umbrella: 0, canopy: 0, lateral: 0, back: 1, step: 0 },
      ],
    };
    const car: Mover = {
      kind: 'vehicle',
      vehicle: 'car',
      line: 0,
      from: 0,
      dir: 1,
      d: 1900 - 20 * pm,
      x: 2000 - 20 * pm,
      y: 2000,
      hx: 1,
      hy: 0,
      speed: 4 * pm,
      v: 4 * pm,
      paint: 0,
      lane: 0,
      pause: 0,
      rank: 0,
    };
    life.movers.push(car, human);
    let cleared = false,
      entered = false;
    for (let frame = 0; frame < 500; frame++) {
      world.step(0.1, undefined, 21);
      const bodies = life.groundBodies(human);
      if (!life.roadTerrain.access.allows(bodies, false)) entered = true;
      else if (entered) cleared = true;
      expect(bodiesOverlap(life.groundBodies(car)[0]!, bodies[0]!)).toBe(false);
    }
    expect(cleared).toBe(true);
    expect(car.x).toBeGreaterThan(2000 + 10 * pm);
  });

  it('lets a pedestrian clear a low curb while preserving vehicle collision rejection', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 1000, y: 2000 },
        { x: 3000, y: 2000 },
      ],
      LifeLine.path,
      2,
    );
    const curb = [
      [
        { x: 1600, y: 1900 },
        { x: 1610, y: 1900 },
        { x: 1610, y: 2100 },
        { x: 1600, y: 2100 },
        { x: 1600, y: 1900 },
      ],
    ];
    b.area('vehicle-blocked', curb);
    const world = new LifeWorld();
    world.sync([{ key: 'curb', tile, life: b.finish() }]);
    const life = worldTiles(world).get('curb')!;
    (life as unknown as { walkerRng: () => number }).walkerRng = () => 1;
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    const human: Mover = {
      kind: 'person',
      line: 0,
      from: 0,
      dir: 1,
      d: 500,
      x: 1500,
      y: 2000,
      hx: 1,
      hy: 0,
      speed: pm,
      paint: 0,
      lane: 0,
      pause: 0,
      rank: 0,
      group: [{ figure: 'adult', shirt: 0, umbrella: 0, canopy: 0, lateral: 0, back: 0, step: 0 }],
    };
    life.movers.push(human);
    for (let frame = 0; frame < 300; frame++) world.step(0.1, undefined, 21);
    expect(human.x).toBeGreaterThan(1700);
    const car = { ...human, kind: 'vehicle' as const, vehicle: 'car' as const, x: 1605, d: 605 };
    const guard = (
      world as unknown as { groundGuard(): (tileLife: typeof life, owner: Mover) => boolean }
    ).groundGuard();
    expect(guard(life, car)).toBe(false);
  });

  it('turns a blocked group back without moving its members through the curb', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 1000, y: 2000 },
        { x: 3000, y: 2000 },
      ],
      LifeLine.path,
      2,
    );
    const obstacle = [
      [
        { x: 1600, y: 1900 },
        { x: 1700, y: 1900 },
        { x: 1700, y: 2100 },
        { x: 1600, y: 2100 },
        { x: 1600, y: 1900 },
      ],
    ];
    b.area('blocked', obstacle);
    const world = new LifeWorld();
    world.sync([{ key: 'walk', tile, life: b.finish() }]);
    const life = worldTiles(world).get('walk')!;
    (life as unknown as { walkerRng: () => number }).walkerRng = () => 1;
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    const human: Mover = {
      kind: 'person',
      line: 0,
      from: 0,
      dir: 1,
      d: 500,
      x: 1500,
      y: 2000,
      hx: 1,
      hy: 0,
      speed: pm,
      paint: 0,
      lane: 0,
      pause: 0,
      rank: 0,
      group: [
        { figure: 'adult', shirt: 0, umbrella: 0, canopy: 0, lateral: 0, back: 0, step: 0 },
        { figure: 'child', shirt: 0, umbrella: 0, canopy: 0, lateral: 0.5, back: 1, step: 0 },
      ],
    };
    life.movers.push(human);
    let turned = false;
    for (let frame = 0; frame < 600; frame++) {
      const before = life.groundBodies(human);
      world.step(0.1, undefined, 21);
      for (const body of life.groundBodies(human))
        expect(
          bodyHitsPolygon(
            {
              ...body,
              x: body.x * pm,
              y: body.y * pm,
              length: body.length * pm,
              width: body.width * pm,
            },
            obstacle,
          ),
        ).toBe(false);
      if (human.dir === -1) {
        const after = life.groundBodies(human);
        for (let i = 0; i < before.length; i++)
          expect(
            Math.hypot(after[i]!.x - before[i]!.x, after[i]!.y - before[i]!.y),
          ).toBeLessThanOrEqual(0.2);
        turned = true;
        break;
      }
    }
    expect(turned).toBe(true);
    expect(human.hx).toBe(-1);
    const x = human.x;
    for (let i = 0; i < 20; i++) world.step(0.1, undefined, 21);
    expect(human.x).toBeLessThan(x);
  });
});
