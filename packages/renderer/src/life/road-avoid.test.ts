import { describe, expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, type Mover, type WorldGroundGuard } from './simulate';
import { worldTiles } from './testing/scenarios';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import { ROAD_AVOID, STALL } from './config';
import { VEHICLES } from './vehicles';
import { bodyHitsPolygon, bodiesOverlap } from './occupancy';
import { buildTileGeometry, createIdRegistry, type TileFeatureLike } from '../raster/geometry';
import type { Curve } from './curves';
import type { LaneTerrain } from './lane-clearance';

type LaneQueries = {
  straightOn(inLine: number, inDir: 1 | -1, outLine: number, outDir: 1 | -1): boolean;
  pedestrianPath(m: Mover, range: number): Iterable<{ x: number; y: number; length: number }>;
  corner(m: Mover, vertex: number): Curve | undefined;
  laneTerrain: LaneTerrain;
  laneBends: Map<number, Float32Array | null>;
};

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);
function bareRoad(builder: LifeBuilder) {
  const world = new LifeWorld(undefined, undefined, { enabled: false });
  world.sync([{ key: 'road', tile, life: builder.finish() }]);
  const life = worldTiles(world).get('road')!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.pending.length = 0;
  life.scenes.sites.length = 0;
  return { world, life };
}
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
  it('recognizes a straight handoff with repeated endpoint vertices', () => {
    const p = (x: number, y = 0) => ({ x: 1000 + x * pm, y: 2000 + y * pm });
    const b = new LifeBuilder();
    b.line([p(0), p(100), p(100)], LifeLine.roadMid, 8, 1, 1);
    b.line([p(100), p(100), p(200)], LifeLine.roadMid, 8, 2, 1);
    b.line([p(100), p(100, 100)], LifeLine.roadMid, 8, 3, 1);
    const { life } = bareRoad(b);
    const queries = life as unknown as LaneQueries;
    expect(queries.straightOn(0, 1, 1, 1)).toBe(true);
    expect(queries.straightOn(0, 1, 2, 1)).toBe(false);
  });

  it('keeps an offscreen queue beyond twenty seconds but retires guard-refused movement', () => {
    const p = (x: number, y = 0) => ({ x: 1000 + x * pm, y: 2000 + y * pm });
    const b = new LifeBuilder();
    b.line([p(0), p(400)], LifeLine.roadMid, 8, 1, 1);
    const { world, life } = bareRoad(b);
    const make = (x: number): Mover => ({
      kind: 'vehicle',
      vehicle: 'car',
      line: 0,
      from: 0,
      dir: 1,
      d: x * pm,
      ...p(x),
      hx: 1,
      hy: 0,
      speed: 4 * pm,
      v: 0,
      lane: 0,
      paint: 0,
      pause: 0,
      rank: 0,
    });
    const queued = make(90),
      leader = { ...make(100), speed: 0 },
      locked = make(300);
    life.movers.push(queued, leader, locked);
    const hooks = world as unknown as { groundGuard(...args: unknown[]): WorldGroundGuard };
    const original = hooks.groundGuard.bind(world);
    // Model an unresolved occupancy lock. The queue still uses the production following/guard.
    hooks.groundGuard = (...args) => {
      const guard = original(...args);
      return Object.assign((...trial: Parameters<WorldGroundGuard>) => {
        if (trial[1] === locked && trial[2]) {
          trial[6]?.('occupancy');
          return false;
        }
        return guard(...trial);
      }, guard);
    };
    const [w, n] = tileToLngLat(tile, p(0, -40));
    const [e, s] = tileToLngLat(tile, p(40, 40));
    world.updateView({ bounds: [w, s, e, n], spawnMarginM: 2 });
    for (let frame = 0; frame < (STALL.anySeconds + 2) * 10; frame++)
      world.step(0.1, undefined, 21);
    expect(life.movers).toContain(queued);
    expect(queued.v).toBeCloseTo(0);
    expect(queued.waiting).toBe(0);
    expect(locked.terrainWait).toBeUndefined();
    expect(locked.waiting).toBeGreaterThanOrEqual(STALL.anySeconds);
    expect(life.movers).not.toContain(locked);
  });

  it('uses straight chords in the middle but samples a handoff inside lookahead', () => {
    const p = (x: number) => ({ x: 1000 + x * pm, y: 2000 });
    const b = new LifeBuilder();
    b.line([p(0), p(100)], LifeLine.roadMid, 8, 1, 1);
    b.line([p(100), p(400)], LifeLine.roadMajor, 20, 2, 1);
    const { life } = bareRoad(b);
    const m: Mover = {
      kind: 'vehicle',
      vehicle: 'car',
      line: 1,
      from: 2,
      dir: 1,
      d: 100 * pm,
      ...p(200),
      hx: 1,
      hy: 0,
      speed: 4 * pm,
      paint: 0,
      lane: 0.8,
      pause: 0,
      rank: 0,
      came: 1,
    };
    const queries = life as unknown as LaneQueries;
    expect(life.offsetVaries(m, 10)).toBe(false);
    expect([...queries.pedestrianPath(m, 10)]).toHaveLength(1);
    const before = { ...m, line: 0, from: 0, came: undefined, next: 2, d: 80 * pm, ...p(80) };
    expect(life.offsetVaries(before)).toBe(false);
    expect(life.offsetVaries(before, 10)).toBe(true);
    const chords = [...queries.pedestrianPath(before, 10)];
    expect(chords.length).toBeGreaterThan(1);
    expect(chords.at(-1)!.y).toBeGreaterThan(chords[0]!.y);
  });

  it('retains lane results for distant arrivals and invalidates nearby obstacles', () => {
    const p = (x: number, y = 0) => ({ x: 1000 + x * pm, y: 2000 + y * pm });
    const b = new LifeBuilder();
    b.line([p(0), p(500)], LifeLine.roadMid, 8, 1, 1);
    b.area('blocked', [[p(25, 6), p(35, 6), p(35, 10), p(25, 10), p(25, 6)]]);
    const { world, life } = bareRoad(b);
    const queries = life as unknown as LaneQueries;
    const m: Mover = {
      kind: 'vehicle',
      vehicle: 'car',
      line: 0,
      from: 0,
      dir: 1,
      d: 100 * pm,
      ...p(100),
      hx: 1,
      hy: 0,
      speed: 4 * pm,
      v: 4 * pm,
      paint: 0,
      lane: 0.8,
      pause: 0,
      rank: 0,
    };
    life.pose(m);
    const reader = queries.laneTerrain,
      cached = [...queries.laneBends];
    expect(cached.length).toBeGreaterThan(0);
    const far = { key: 'far', tile: { ...tile, x: tile.x + 5 }, life: new LifeBuilder().finish() };
    const road = { key: 'road', tile, life: life.geo };
    world.sync([road, far]);
    world.step(0.01, undefined, 21);
    expect(queries.laneTerrain).toBe(reader);
    expect([...queries.laneBends]).toEqual(cached);
    const neighbor = new LifeBuilder();
    neighbor.area('blocked', [
      [
        { x: -6, y: 2000 },
        { x: 4, y: 2000 },
        { x: 4, y: 2030 },
        { x: -6, y: 2030 },
        { x: -6, y: 2000 },
      ],
    ]);
    world.sync([
      road,
      far,
      { key: 'near', tile: { ...tile, x: tile.x + 1 }, life: neighbor.finish() },
    ]);
    world.step(0.01, undefined, 21);
    expect(queries.laneTerrain).not.toBe(reader);
    expect(queries.laneBends.size).toBe(0);
  });

  it('reuses an unchanged shifted corner and rechecks a changed trial shift', () => {
    const p = (x: number, y = 0) => ({ x: 1000 + x * pm, y: 2000 + y * pm });
    const b = new LifeBuilder();
    b.line([p(0), p(100)], LifeLine.roadMid, 8, 1, 1);
    b.line([p(100), p(100, 100)], LifeLine.roadMid, 8, 2, 1);
    const { life } = bareRoad(b);
    const m: Mover = {
      kind: 'vehicle',
      vehicle: 'car',
      line: 0,
      from: 0,
      dir: 1,
      d: 95 * pm,
      ...p(95),
      hx: 1,
      hy: 0,
      speed: 4 * pm,
      paint: 0,
      lane: 0.8,
      pause: 0,
      rank: 0,
      next: 2,
      roadShift: -0.5,
    };
    let hits = 0;
    life.setLaneTerrain({
      near: () => true,
      hits: () => {
        hits++;
        return false;
      },
    });
    const queries = life as unknown as LaneQueries;
    const curve = queries.corner(m, 1);
    expect(curve).toBeDefined();
    const first = hits;
    expect(queries.corner(m, 1)).toEqual(curve);
    expect(hits).toBe(first);
    m.roadShift = -0.6;
    queries.corner(m, 1);
    expect(hits).toBeGreaterThan(first);
  });

  it('keeps fallback corner results separate for different future exits', () => {
    const p = (x: number, y = 0) => ({ x: 1000 + x * pm, y: 2000 + y * pm });
    const b = new LifeBuilder();
    b.line([p(0), p(100)], LifeLine.roadMid, 8, 1, 1);
    b.line([p(100), p(100, 30)], LifeLine.roadMid, 8, 2, 1);
    b.line([p(100, 30), p(100, 130)], LifeLine.roadMid, 8, 3, 1);
    b.line([p(100, 30), p(200, 30)], LifeLine.roadMajor, 20, 4, 1);
    const { life } = bareRoad(b);
    const polygon = [
      [p(91.875, 0.875), p(92.125, 0.875), p(92.125, 1.125), p(91.875, 1.125), p(91.875, 0.875)],
    ].map((r) => r.map((q) => ({ x: q.x / pm, y: q.y / pm })));
    const terrain = {
      near: () => true,
      hits: (body: Parameters<LaneTerrain['hits']>[0]) => bodyHitsPolygon(body, polygon),
    };
    life.setLaneTerrain(terrain);
    const a: Mover = {
      kind: 'vehicle',
      vehicle: 'bus',
      line: 1,
      from: 2,
      dir: 1,
      d: 0,
      ...p(100),
      hx: 0,
      hy: 1,
      speed: 4 * pm,
      paint: 0,
      lane: 0.8,
      pause: 0,
      rank: 0,
      came: 1,
      next: 4,
    };
    const second = { ...a, next: 6 };
    const queries = life as unknown as LaneQueries;
    const firstCurve = queries.corner(a, 2);
    const cached = queries.corner(second, 2);
    life.setLaneTerrain({ ...terrain });
    const fresh = queries.corner(second, 2);
    expect(firstCurve).not.toEqual(fresh);
    expect(cached).toEqual(fresh);
  });

  it('accepts a short-line entry with its final route before later traffic preparation', () => {
    const p = (x: number) => ({ x: 1000 + x * pm, y: 2000 });
    const builder = new LifeBuilder();
    builder.line([p(0), p(100)], LifeLine.roadMid, 8, 1, 1);
    builder.line([p(100), p(110)], LifeLine.roadMid, 8, 2, 1);
    builder.line([p(110), p(210)], LifeLine.roadMajor, 20, 3, 1);
    const { life } = bareRoad(builder);
    const mover: Mover = {
      kind: 'vehicle',
      vehicle: 'car',
      line: 0,
      from: 0,
      dir: 1,
      d: 99.95 * pm,
      ...p(99.95),
      hx: 1,
      hy: 0,
      speed: 4 * pm,
      v: 4 * pm,
      paint: 0,
      lane: 0.8,
      pause: 0,
      rank: 0,
    };
    life.movers.push(mover);
    let checked: ReturnType<typeof life.pose> | undefined;
    life.step(0.1, undefined, undefined, undefined, undefined, (next) => {
      if ('kind' in next && next === mover) checked = { ...life.pose(next) };
      return true;
    });
    expect(mover.line).toBe(1);
    expect(mover.routing?.plan?.exit).toBe(4);
    const accepted = { ...life.pose(mover) };
    expect(checked).toEqual(accepted);
    life.prepareTraffic(() => true);
    expect(life.pose(mover)).toEqual(accepted);
  });

  it('checks the returning bus nose against parked traffic before accepting its move', () => {
    const { world, life, make, point } = obstacleRoad();
    const bus: Mover = {
      ...make(100),
      vehicle: 'bus',
      speed: 8 * pm,
      v: 8 * pm,
      roadShift: -2,
      roadYaw: 0,
    };
    const parked = {
      ...point(105, 2.1),
      hx: 1,
      hy: 0,
      vehicle: 'motorcycle' as const,
      paint: 0,
      rank: 0,
    };
    life.movers.push(bus);
    life.parked.push(parked);
    const obstacle = {
      x: parked.x / pm,
      y: parked.y / pm,
      hx: 1,
      hy: 0,
      length: VEHICLES.motorcycle.length,
      width: VEHICLES.motorcycle.width,
    };
    for (let frame = 0; frame < 20; frame++) {
      world.step(0.1, undefined, 21);
      expect(bodiesOverlap(life.groundBodies(bus)[0]!, obstacle)).toBe(false);
    }
  });

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
