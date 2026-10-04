import { describe, expect, it, vi } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import {
  LifeWorld,
  type TileLife,
  type Mover,
  type Stall,
  type Gatherer,
  type WorldGroundGuard,
} from './simulate';
import { completeScenarioState, worldTiles } from './testing/scenarios';
import { FrameProfiler } from '../profile';
import { frameBetween } from './frames';
import type { PedestrianView } from './pedestrians';
import { FOLLOW, PEDESTRIAN, kinematicsOf, laneOffset } from './config';
import { VEHICLES } from './vehicles';
import { BODY_KIND, Occupancy, bodiesOverlap, type Body } from './occupancy';
import {
  PedestrianCrossings,
  pedestrianLimit,
  pedestrianView,
  type PedestrianSegment,
  type PedestrianHold,
} from './pedestrians';
import { complete } from './cooperate';
import { TileLife as StandaloneLife } from './simulate';
import { metersPerUnit } from '../raster/geometry';
import { pedestrianWorld } from './testing/pedestrians';

const tile = { z: 16, x: 55192, y: 30266 };
function population(tiles = [tile], profiled = false) {
  const builder = new LifeBuilder();
  builder.line(
    [
      { x: 0, y: 2000 },
      { x: 4095, y: 2000 },
    ],
    LifeLine.plaza,
  );
  const geo = builder.finish();
  const world = new LifeWorld(undefined, profiled ? new FrameProfiler(() => 0) : undefined);
  world.sync(tiles.map((tile) => ({ key: `${tile.z}/${tile.x}/${tile.y}`, tile, life: geo })));
  const lives = [...worldTiles(world).values()];
  for (const life of lives)
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  return { world, lives };
}
function person(life: TileLife, x = 1000): Mover {
  return {
    kind: 'person',
    line: 0,
    from: 0,
    dir: 1,
    d: x,
    x,
    y: 2000,
    hx: 1,
    hy: 0,
    speed: 0,
    pause: 100,
    rank: 0,
    paint: 0,
    lane: 0,
    group: [{ figure: 'adult', shirt: 3, umbrella: 0, canopy: 0, lateral: 0, back: 0, step: 0 }],
  };
}
function guard(world: LifeWorld) {
  return (world as unknown as { groundGuard(minimum: number): WorldGroundGuard }).groundGuard(0.9);
}
describe('live pedestrian readers', () => {
  it('reuses prepared conversions across readers but converts mutable query geometry again', () => {
    const f = crossingFixture(),
      frame = { x: 10, y: 20, scale: 2 };
    const crossing = [...f.crossings.along(f.path, 1.2).keys()][0]!;
    const local = f.body(0, 3.5),
      owner = {},
      occupied = new Occupancy();
    const body = {
      ...local,
      x: frame.x + local.x * frame.scale,
      y: frame.y + local.y * frame.scale,
      length: local.length * frame.scale,
      width: local.width * frame.scale,
    };
    occupied.set(owner, [body]);
    const calls = vi.spyOn(occupied, 'someInArea');
    for (let i = 0; i < 2; i++) {
      const reader = pedestrianView(occupied, 0.9, frame);
      expect(
        reader.walkersInArea(crossing.polygon, (b) => b.x === local.x && b.width === local.width),
      ).toBe(true);
    }
    expect(calls.mock.calls[1]![0]).toBe(calls.mock.calls[0]![0]);
    const mutable = crossing.polygon.map((ring) => ring.map((p) => ({ ...p })));
    const reader = pedestrianView(occupied, 0.9, frame);
    expect(reader.walkersInArea(mutable)).toBe(true);
    for (const ring of mutable) for (const p of ring) p.x += 100;
    expect(reader.walkersInArea(mutable)).toBe(false);
    expect(calls.mock.calls[3]![0]).not.toBe(calls.mock.calls[2]![0]);
    body.x += 100 * frame.scale;
    occupied.set(owner, [body]);
    expect(reader.walkersInArea(crossing.polygon)).toBe(false);
  });
  it('queries distant humans once and retains footprint and bend intersections after live updates', () => {
    const occupied = new Occupancy(),
      view = pedestrianView(occupied, 0.9);
    const owner = {},
      body: Body = { x: 100, y: 100, hx: 1, hy: 0, length: 1, width: 1, kind: BODY_KIND.human };
    occupied.set(owner, [body]);
    const path: PedestrianSegment[] = [
      { x: 0, y: 0, hx: 1, hy: 0, length: 15, ahead: 0, line: 0 },
      { x: 15, y: 0, hx: 0, hy: 1, length: 15, ahead: 15, line: 0 },
    ];
    const regions = vi.spyOn(occupied, 'someInArea'),
      corridors = vi.spyOn(occupied, 'nearestInCorridor');
    expect(pedestrianLimit(view, path, 1.2, 4.4, 8, kinematicsOf('car'), 1, 0.1, 30)).toBe(8);
    expect(regions).toHaveBeenCalledTimes(1);
    expect(corridors).not.toHaveBeenCalled();
    body.x = 15;
    body.y = 5;
    occupied.set(owner, [body]);
    expect(view.walkersAlong!(path, 1.2, 30)).toBeCloseTo(19.5);
    body.x = 32;
    body.y = 0;
    body.length = 8;
    occupied.set(owner, [body]);
    expect(view.walkersAlong!([{ ...path[0]!, length: 30 }], 1.2, 30)).toBeCloseTo(28);
    occupied.delete(owner);
    expect(view.walkersAlong!(path, 1.2, 30)).toBe(Infinity);
    expect(view.empty).toBe(true);
  });
  it('rewrites body tags in reused buffers and filters animals through both readers', () => {
    const {
      world,
      lives: [life],
    } = population();
    const human = person(life!),
      out: Body[] = [];
    for (const kind of ['cat', 'dog'] as const) {
      const animal = { ...human, kind, group: undefined };
      life!.movers.push(animal);
      expect(life!.groundBodies(animal, 0.9, out)[0]?.kind).toBe(BODY_KIND.animal);
      const local = (
        life as unknown as { standalonePedestrians(): PedestrianView }
      ).standalonePedestrians();
      for (const view of [guard(world).pedestrians(life!), local])
        expect(
          view.walkersAhead(human.x / life!.perMeter - 10, human.y / life!.perMeter, 1, 0, 1, 30),
        ).toBe(Infinity);
      life!.movers.length = 0;
    }
    expect(life!.groundBodies(human, 0.9, out)[0]?.kind).toBe(BODY_KIND.human);
    const stall: Stall = {
      x: human.x,
      y: human.y,
      hx: 1,
      hy: 0,
      side: 1,
      rank: 0,
      paint: 0,
      shirt: 0,
    };
    expect(life!.groundBodies(stall, 0.9, out).map((b) => b.kind)).toEqual([
      BODY_KIND.fixed,
      BODY_KIND.human,
    ]);
    const gatherer: Gatherer = {
      x: human.x,
      y: human.y,
      hx: 1,
      hy: 0,
      speed: 0,
      pause: 100,
      rank: 0,
      place: 'bench',
      behavior: 'sit',
      cx: human.x,
      cy: human.y,
      inner: 0,
      outer: 0,
      tx: human.x,
      ty: human.y,
      walked: 0,
      walker: human.group![0]!,
      rx: 0,
      ry: 0,
      sign: 1,
    };
    expect(life!.groundBodies(gatherer, 0.9, out)[0]?.kind).toBe(BODY_KIND.human);
    life!.gatherers.push(gatherer);
    const local = (
      life as unknown as { standalonePedestrians(): PedestrianView }
    ).standalonePedestrians();
    for (const view of [guard(world).pedestrians(life!), local])
      expect(
        view.walkersAhead(human.x / life!.perMeter - 10, human.y / life!.perMeter, 1, 0, 1, 30),
      ).toBeCloseTo(9.55);
  });
  it('exposes an ordinary attendant to both readers without adding collision footprints', () => {
    const { world, life, car, human } = pedestrianWorld(-9.5);
    life.movers.splice(life.movers.indexOf(human), 1);
    const stall: Stall = {
      x: human.x + 1.3 * life.perMeter,
      y: human.y,
      hx: 0,
      hy: 1,
      side: 1,
      rank: 0,
      paint: 0,
      shirt: 0,
    };
    life.stalls.push(stall);
    expect(life.canIdle(stall)).toBe(true);
    const g = guard(world),
      view = g.pedestrians(life);
    const local = (
      life as unknown as { standalonePedestrians(): PedestrianView }
    ).standalonePedestrians();
    for (const reader of [view, local]) {
      expect(
        reader.walkersAhead(human.x / life.perMeter - 10, human.y / life.perMeter, 1, 0, 0.1, 30),
      ).toBeCloseTo(9.5);
      expect(
        reader.walkersAhead(
          stall.x / life.perMeter - 10,
          stall.y / life.perMeter - 1,
          1,
          0,
          0.05,
          30,
        ),
      ).toBe(Infinity);
    }
    // The original movement guard reserves the cart alone, so this legal attendant overlap stays legal.
    expect(g(life, human)).toBe(true);
    g.remove(human);
    const snapshot = structuredClone(stall);
    world.step(0.1, undefined, 18);
    expect(car.pedestrianHolds).toHaveLength(1);
    expect(car.v! / life.perMeter).toBeLessThan(8);
    expect(stall).toEqual(snapshot);
    g.remove(stall);
    expect(
      view.walkersAhead(human.x / life.perMeter - 10, human.y / life.perMeter, 1, 0, 1, 30),
    ).toBe(Infinity);
    stall.open = false;
    expect(guard(world).pedestrians(life).empty).toBe(true);
    expect(
      (life as unknown as { standalonePedestrians(): PedestrianView }).standalonePedestrians()
        .empty,
    ).toBe(true);
  });
  it('reads a returning person when the world view starts empty', () => {
    const { world, life, car, human } = pedestrianWorld(3.5);
    let hidden = true;
    const visibility = vi
      .spyOn(life.scenes, 'hidden')
      .mockImplementation((m) => m === human && hidden);
    const scene = vi
      .spyOn(life.scenes, 'step')
      .mockImplementation((_, __, ___, ____, _____, accept) => {
        hidden = false;
        expect(accept!(human, { ...human })).toBe(true);
      });
    try {
      world.step(0.1, undefined, 18);
      expect(car.v! / life.perMeter).toBeLessThan(8);
    } finally {
      visibility.mockRestore();
      scene.mockRestore();
    }
  });
  for (const profiled of [false, true])
    it(`reads accepted positions and removal (profiled=${profiled})`, () => {
      const {
        world,
        lives: [life],
      } = population([tile], profiled);
      const m = person(life!);
      life!.movers.push(m);
      const g = guard(world),
        view = g.pedestrians(life!);
      const start = (m.x - 10 * life!.perMeter) / life!.perMeter;
      expect(view.minimum).toBe(0.9);
      expect(view.walkersAhead(start, 2000 / life!.perMeter, 1, 0, 1, 30)).toBeCloseTo(9.55);
      const before = { ...m };
      m.x += 5 * life!.perMeter;
      m.d = m.x;
      expect(g(life!, m, before)).toBe(true);
      expect(view.walkersAhead(start, 2000 / life!.perMeter, 1, 0, 1, 30)).toBeCloseTo(14.55);
      g.remove(m);
      expect(view.walkersAhead(start, 2000 / life!.perMeter, 1, 0, 1, 30)).toBe(Infinity);
    });
  it('converts adjacent and mixed-zoom footprints to the querying tile metres', () => {
    for (const sourceTile of [tile, { z: 15, x: tile.x >> 1, y: tile.y >> 1 }]) {
      const targetTile = sourceTile.z === 16 ? { ...tile, x: tile.x + 1 } : tile;
      const {
        world,
        lives: [source, target],
      } = population([sourceTile, targetTile]);
      const m = person(target!, 5 * target!.perMeter);
      target!.movers.push(m);
      const f = frameBetween(targetTile, sourceTile);
      const cx = (f.x + m.x * f.scale) / source!.perMeter;
      const cy = (f.y + m.y * f.scale) / source!.perMeter;
      const sizeScale = (f.scale * target!.perMeter) / source!.perMeter;
      const view = guard(world).pedestrians(source!);
      expect(view.walkersAhead(cx - 10, cy, 1, 0, 1, 30)).toBeCloseTo(10 - 0.45 * sizeScale, 6);
      let at = 0;
      expect(
        view.walkersInArea(
          [
            [
              { x: cx - 1, y: cy - 1 },
              { x: cx + 1, y: cy - 1 },
              { x: cx + 1, y: cy + 1 },
              { x: cx - 1, y: cy + 1 },
            ],
          ],
          (b) => {
            at = b.x;
            return true;
          },
        ),
      ).toBe(true);
      expect(at).toBeCloseTo(cx, 6);
    }
  });
  it('omits hidden people and bodies outside tile ownership', () => {
    const {
      world,
      lives: [life],
    } = population();
    life!.movers.push(person(life!), person(life!, -10));
    life!.scenes.hidden = () => true;
    expect(
      guard(world)
        .pedestrians(life!)
        .walkersAhead(0, 2000 / life!.perMeter, 1, 0, 1, 100),
    ).toBe(Infinity);
  });
  it('provides a standalone human reader and an empty fast path', () => {
    const {
      lives: [life],
    } = population();
    const read = () =>
      (life as unknown as { standalonePedestrians(): PedestrianView }).standalonePedestrians();
    expect(read().walkersAhead(0, 2000 / life!.perMeter, 1, 0, 1, 200)).toBe(Infinity);
    const m = person(life!);
    life!.movers.push(m);
    expect(
      read().walkersAhead(m.x / life!.perMeter - 10, 2000 / life!.perMeter, 1, 0, 1, 30),
    ).toBeCloseTo(9.55);
    m.x += life!.perMeter;
    expect(
      read().walkersAhead(1000 / life!.perMeter - 10, 2000 / life!.perMeter, 1, 0, 1, 30),
    ).toBeCloseTo(10.55);
  });
});

function brakingFixture(craft: 'car' | 'bus' = 'car', distance = 15) {
  const builder = new LifeBuilder();
  builder.line(
    [
      { x: 0, y: 2000 },
      { x: 4095, y: 2000 },
    ],
    LifeLine.roadMajor,
    14,
  );
  const world = new LifeWorld();
  world.sync([{ key: 'braking', tile, life: builder.finish() }]);
  const life = worldTiles(world).get('braking')!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  const car: Mover = {
    ...person(life),
    kind: 'vehicle',
    vehicle: craft,
    paint: 0,
    lane: 0,
    group: undefined,
    pause: 0,
    speed: 8 * life.perMeter,
    v: 8 * life.perMeter,
  };
  const human = person(life, car.x + distance * life.perMeter);
  human.group![0]!.lateral = life.offsetOf(car);
  human.avoid = 0;
  life.movers.push(car, human);
  return { world, life, car, human };
}
describe('pedestrian braking targets', () => {
  for (const hz of [10, 30, 60, 120])
    it(`brakes gradually and preserves front clearance at ${hz} Hz`, () => {
      const { world, life, car, human } = brakingFixture();
      const speeds: number[] = [];
      let before = 8;
      for (let frame = 0; frame < hz * 6; frame++) {
        world.step(1 / hz, undefined, 18, undefined, undefined, undefined, 0.9);
        const v = car.v! / life.perMeter;
        expect(car.pedestrianHolds).toBeUndefined();
        expect(before - v).toBeLessThanOrEqual(kinematicsOf('car').maxBrake / hz + 1e-6);
        expect(bodiesOverlap(life.groundBodies(car)[0]!, life.groundBodies(human)[0]!, 0)).toBe(
          false,
        );
        speeds.push(v);
        before = v;
      }
      expect(car.v).toBe(0);
      expect(speeds.filter((v) => v > 0 && v < 7).length).toBeGreaterThan(3);
      const a = life.groundBodies(car)[0]!,
        b = life.groundBodies(human)[0]!;
      expect(b.x - b.length / 2 - a.x - a.length / 2).toBeGreaterThanOrEqual(FOLLOW.minGap - 1e-7);
      expect(life.motionStats.hardCaps).toBe(0);
    });
  it('keeps a stopped bus from accelerating into its front stopping gap', () => {
    const { world, car } = brakingFixture('bus', VEHICLES.bus.length / 2 + 0.45 + FOLLOW.minGap);
    car.v = 0;
    const start = car.x;
    for (let frame = 0; frame < 120; frame++) world.step(1 / 30, undefined, 18);
    expect(car.x).toBe(start);
    expect(car.v).toBe(0);
  });
  it('ignores a human beside the lane but sees a group member in it', () => {
    const miss = brakingFixture();
    miss.human.avoid! += 3;
    miss.world.step(0.1, undefined, 18);
    expect(miss.car.v! / miss.life.perMeter).toBeCloseTo(8);
    const hit = brakingFixture('car', 10);
    hit.human.avoid! += 3;
    hit.human.group!.push({ ...hit.human.group![0]!, lateral: hit.human.group![0]!.lateral - 3 });
    hit.world.step(0.1, undefined, 18);
    expect(hit.car.v! / hit.life.perMeter).toBeLessThan(8);
  });
  it('retains curb-service identity while predicting the actual lane path', () => {
    const { life, car } = brakingFixture();
    const original = structuredClone(car);
    const curbScene = vi.spyOn(life.scenes, 'curbSite').mockReturnValue(car);
    const offset = vi
      .spyOn(life.scenes, 'offsetAt')
      .mockImplementation((owner, at, normal, curb) =>
        owner === car
          ? normal +
            (curb - normal) * Math.max(0, 1 - Math.abs(at.x - car.x) / (20 * life.perMeter))
          : normal,
      );
    const currentOffset = vi
      .spyOn(life.scenes, 'offset')
      .mockImplementation((owner, normal, curb) =>
        life.scenes.offsetAt(owner, owner, normal, curb),
      );
    try {
      const path = [
        ...(
          life as unknown as {
            pedestrianPath(m: Mover, range: number): Iterable<PedestrianSegment>;
          }
        ).pedestrianPath(car, 10),
      ];
      const pose = life.pose(car);
      expect(path[0]!.y * life.perMeter).toBeCloseTo(pose.y);
      expect(path[0]!.hy).toBeLessThan(0);
      expect(car).toEqual(original);
    } finally {
      offset.mockRestore();
      currentOffset.mockRestore();
      curbScene.mockRestore();
    }
  });
  it('queries the known curved exit using actual lane poses without changing routing', () => {
    const builder = new LifeBuilder();
    builder.line(
      [
        { x: 0, y: 2000 },
        { x: 2000, y: 2000 },
      ],
      LifeLine.roadMinor,
      6,
    );
    builder.line(
      [
        { x: 2000, y: 2000 },
        { x: 2000, y: 4000 },
      ],
      LifeLine.roadMinor,
      6,
    );
    const world = new LifeWorld();
    world.sync([{ key: 'curve', tile, life: builder.finish() }]);
    const life = worldTiles(world).get('curve')!;
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    const car: Mover = {
      ...person(life, 2000 - 5 * life.perMeter),
      kind: 'vehicle',
      vehicle: 'car',
      lane: 0,
      paint: 0,
      pause: 0,
      group: undefined,
      speed: 8 * life.perMeter,
      v: 8 * life.perMeter,
      next: 2,
    };
    const original = structuredClone(car);
    const tracer = life as unknown as {
      pedestrianPath(m: Mover, range: number, physicalRange?: number): Iterable<PedestrianSegment>;
    };
    const path = [...tracer.pedestrianPath(car, 20)];
    const other = { ...car, d: car.d - life.perMeter, x: car.x - life.perMeter };
    const expectedOther = [...tracer.pedestrianPath(other, 20)];
    const a = tracer.pedestrianPath(car, 20)[Symbol.iterator]();
    const first = a.next();
    if (first.done) throw new Error('Expected a curved lookahead segment');
    expect([...tracer.pedestrianPath(other, 20)]).toEqual(expectedOther);
    const rest: PedestrianSegment[] = [];
    for (let step = a.next(); !step.done; step = a.next()) rest.push(step.value);
    expect([first.value, ...rest]).toEqual(path);
    const uncached = vi.spyOn(life.scenes, 'curbSite').mockReturnValue(car);
    const unchangedOffset = vi
      .spyOn(life.scenes, 'offsetAt')
      .mockImplementation((_, __, normal) => normal);
    try {
      expect(path).toEqual([...tracer.pedestrianPath(car, 20)]);
    } finally {
      uncached.mockRestore();
      unchangedOffset.mockRestore();
    }
    expect(path.some((p) => p.line === 1)).toBe(true);
    expect(path.some((p) => p.hx > 0.1 && p.hy > 0.1)).toBe(true);
    const queries = (path: Iterable<PedestrianSegment>, range = Infinity) => {
      const calls: number[][] = [];
      const view: PedestrianView = {
        empty: false,
        minimum: 0.9,
        walkersAhead(x, y, hx, hy, width, length) {
          calls.push([x, y, hx, hy, width, length]);
          return Infinity;
        },
        walkersInArea: () => false,
      };
      pedestrianLimit(
        view,
        path,
        1.2,
        4.4,
        car.speed,
        kinematicsOf('car'),
        life.perMeter,
        1 / 30,
        range,
      );
      return calls;
    };
    for (const range of [8.37, 14.73])
      expect(queries(tracer.pedestrianPath(car, 30, range), range)).toEqual(
        queries(tracer.pedestrianPath(car, range)),
      );
    const p = path.find((p) => p.ahead > 8)!;
    const human = person(life);
    human.x = p.x * life.perMeter;
    human.y = p.y * life.perMeter;
    life.movers.push(car, human);
    const target = pedestrianLimit(
      guard(world).pedestrians(life),
      path,
      1.2,
      4.4,
      car.speed,
      kinematicsOf('car'),
      life.perMeter,
      1 / 30,
    );
    expect(target).toBeLessThan(car.speed);
    expect(car).toEqual(original);
    const stopped = life as unknown as {
      pedestrianSegments(m: Mover, range: number, physicalRange: number): PedestrianSegment[];
    };
    car.v = 0;
    expect(stopped.pedestrianSegments(car, 20, 20)).toEqual(path);
    const cached = stopped.pedestrianSegments(car, 20, 20);
    const unrelated = vi.spyOn(life.scenes, 'hasCurbScenes', 'get').mockReturnValue(true);
    try {
      expect(stopped.pedestrianSegments(car, 20, 20)).toBe(cached);
    } finally {
      unrelated.mockRestore();
    }
    // A stopped vehicle can receive a new committed exit without moving.
    car.next = -1;
    expect(stopped.pedestrianSegments(car, 20, 20)).toEqual([...tracer.pedestrianPath(car, 20)]);
    expect(stopped.pedestrianSegments(car, 20, 20).every((p) => p.line === 0)).toBe(true);
    car.junctionRoute = { key: 'turn', exits: [2] };
    expect(stopped.pedestrianSegments(car, 20, 20).some((p) => p.line === 1)).toBe(true);
    car.junctionRoute = { key: 'turn', exits: [] };
    expect(stopped.pedestrianSegments(car, 20, 20).every((p) => p.line === 0)).toBe(true);
  });
});

function crossingFixture(angle = 0, reverse = false, signal = false) {
  const pm = 1 / metersPerUnit(tile),
    cx = 2000,
    cy = 2000;
  const hx = Math.cos(angle),
    hy = Math.sin(angle);
  const point = (x: number, y: number) => ({
    x: cx + (x * hx - y * hy) * pm,
    y: cy + (x * hy + y * hx) * pm,
  });
  const builder = new LifeBuilder();
  builder.line([point(-80, 0), point(80, 0)], LifeLine.roadMajor, 14);
  // The mapped walking path is much longer than the stripe.
  builder.line([point(0, -40), point(0, 40)], LifeLine.path, 3);
  builder.area('crossing', [[point(-1.5, -7), point(1.5, -7), point(1.5, 7), point(-1.5, 7)]]);
  if (signal) builder.signal(point(-10, 0), 8, 90, 0, true);
  const geo = builder.finish(),
    life = new StandaloneLife(tile, geo, 1);
  const crossings = new PedestrianCrossings(tile, pm);
  complete(crossings.prepare(geo, life.signals));
  const p = point(reverse ? 15 : -15, reverse ? -3.5 : 3.5);
  const path: PedestrianSegment[] = [
    {
      x: p.x / pm,
      y: p.y / pm,
      hx: reverse ? -hx : hx,
      hy: reverse ? -hy : hy,
      length: 30,
      ahead: 0,
      line: 0,
    },
  ];
  const occupied = new Occupancy(),
    view = pedestrianView(occupied, 0.9);
  const body = (x: number, y: number, dx = 0, dy = 1): Body => {
    const p = point(x, y);
    return {
      x: p.x / pm,
      y: p.y / pm,
      hx: dx * hx - dy * hy,
      hy: dx * hy + dy * hx,
      length: 0.9,
      width: 1,
      kind: BODY_KIND.human,
    };
  };
  const limit = (holds?: readonly PedestrianHold[], dt = 0.1) =>
    crossings.limit(view, path, 1.2, 4.4, 30, 8 * pm, kinematicsOf('car'), dt, holds);
  return { pm, crossings, path, occupied, view, body, limit };
}
describe('unsignalised pedestrian crossings', () => {
  for (const [centre, speed] of [
    [0, 3],
    [-3.2, 3],
    [-6, 8],
  ] as const)
    it(`clears a late crossing arrival from ${centre} m at ${speed} m/s`, () => {
      const { world, life, car } = pedestrianWorld(-9.5);
      car.x = car.d = 2000 + centre * life.perMeter;
      car.v = speed * life.perMeter;
      const start = car.x;
      world.step(0.1, undefined, 18);
      expect(car.pedestrianHolds?.[0]?.committed).toBe(true);
      const record = car.pedestrianHolds![0]!;
      for (let i = 0; i < 40; i++) {
        const previous = car.v / life.perMeter;
        world.step(0.1, undefined, 18);
        expect(car.v / life.perMeter).toBeGreaterThan(0);
        expect(Math.abs(car.v / life.perMeter - previous)).toBeLessThanOrEqual(
          kinematicsOf('car').maxBrake * 0.1 + 1e-6,
        );
        if (car.pedestrianHolds) expect(car.pedestrianHolds[0]?.committed).toBe(true);
      }
      expect(record.committed).toBe(true);
      expect(car.x).toBeGreaterThan(start + 10 * life.perMeter);
      expect(car.pedestrianHolds).toBeUndefined();
      expect(life.motionStats.hardCaps).toBe(0);
    });
  it('keeps lane braking active for a committed crossing', () => {
    const f = crossingFixture();
    f.path[0]!.x += 12;
    f.occupied.set({}, [f.body(0, -9.5), f.body(10, 3.5)]);
    const crossing = f.limit();
    expect(crossing.holds?.[0]?.committed).toBe(true);
    expect(crossing.target).toBe(8 * f.pm);
    expect(
      pedestrianLimit(f.view, f.path, 1.2, 4.4, crossing.target, kinematicsOf('car'), f.pm, 0.1),
    ).toBeLessThan(crossing.target);
  });
  it('matches direct and indexed road associations for rotated and reverse lookahead', () => {
    const pm = 1 / metersPerUnit(tile),
      angle = Math.PI / 4,
      hx = Math.cos(angle),
      hy = Math.sin(angle);
    const point = (x: number, y: number) => ({
      x: 2000 + (x * hx - y * hy) * pm,
      y: 2000 + (x * hy + y * hx) * pm,
    });
    const prepare = (count: number) => {
      const builder = new LifeBuilder();
      builder.line([point(-80, 0), point(160, 0)], LifeLine.roadMajor, 14);
      for (let i = 0; i < count; i++) {
        const x = i < 8 ? -40 + i * 10 : 100 + (i - 8) * 10;
        builder.area('crossing', [
          [point(x - 1.5, -7), point(x + 1.5, -7), point(x + 1.5, 7), point(x - 1.5, 7)],
        ]);
      }
      const geo = builder.finish(),
        life = new StandaloneLife(tile, geo, 1),
        crossings = new PedestrianCrossings(tile, pm);
      complete(crossings.prepare(geo, life.signals));
      return crossings;
    };
    const direct = prepare(8),
      indexed = prepare(10);
    for (const reverse of [false, true]) {
      const at = point(reverse ? 0 : -30, reverse ? -3.5 : 3.5);
      const path: PedestrianSegment[] = [
        {
          x: at.x / pm,
          y: at.y / pm,
          hx: reverse ? -hx : hx,
          hy: reverse ? -hy : hy,
          ahead: 0,
          length: 30,
          line: 0,
        },
      ];
      const values = (crossings: PedestrianCrossings) =>
        [...crossings.along(path, 1.2)]
          .map(([c, distance]) => ({ key: c.identity.key, distance }))
          .sort((a, b) => a.key.localeCompare(b.key));
      const expected = values(direct),
        actual = values(indexed);
      expect(expected.length).toBeGreaterThan(0);
      expect(actual).toEqual(expected);
    }
  });
  it('skips signal-associated entrance holds while still braking for a person in the lane', () => {
    const f = crossingFixture(0, false, true);
    expect(f.crossings.along(f.path, 1.2).size).toBe(0);
    f.path[0]!.x += 5;
    f.occupied.set({}, [f.body(0, 3.5)]);
    expect(
      pedestrianLimit(f.view, f.path, 1.2, 4.4, 8 * f.pm, kinematicsOf('car'), f.pm, 0.1),
    ).toBeLessThan(8 * f.pm);
  });
  it('retains active records through real zoom adoption', () => {
    const { world, entry, car } = pedestrianWorld();
    world.step(0.1, undefined, 18);
    const saved = structuredClone(car.pedestrianHolds);
    const child = { z: tile.z + 1, x: tile.x * 2, y: tile.y * 2 },
      f = frameBetween(tile, child);
    const coords = entry.life.coords.map((value, i) => (i % 2 ? f.y : f.x) + value * f.scale);
    const areas = entry.life.areas?.map((a) => ({
      ...a,
      rings: a.rings.map((ring) =>
        ring.map((p) => ({ x: f.x + p.x * f.scale, y: f.y + p.y * f.scale })),
      ),
    }));
    world.sync([{ key: 'child-crossing', tile: child, life: { ...entry.life, coords, areas } }]);
    expect(worldTiles(world).get('child-crossing')!.movers).toContain(car);
    expect(car.pedestrianHolds).toEqual(saved);
    world.step(0.1, undefined, 18);
    expect(car.pedestrianHolds?.[0]?.elapsed).toBe(0.2);
    expect(car.pedestrianHolds?.[0]?.key).toBe(saved?.[0]?.key);
  });
  for (const hz of [30, 60, 120])
    it(`replays complete braking and expired hold state at ${hz} Hz`, () => {
      const a = pedestrianWorld(1.75),
        b = pedestrianWorld(1.75);
      for (let i = 0; i < 21 * hz; i++) {
        for (const f of [a, b])
          f.world.step(1 / hz, undefined, 18, undefined, undefined, undefined, 0.9);
      }
      expect(a.car.pedestrianHolds?.[0]?.expired).toBe(true);
      expect(completeScenarioState(a.world)).toEqual(completeScenarioState(b.world));
    });
  it('releases an off-lane curb hold after twenty active seconds', () => {
    const { world, car } = pedestrianWorld(-9.5);
    for (let i = 0; i < 199; i++) world.step(0.1, undefined, 18);
    expect(car.v).toBe(0);
    const x = car.x;
    for (let i = 0; i < 3; i++) world.step(0.1, undefined, 18);
    expect(car.pedestrianHolds?.[0]?.expired).toBe(true);
    expect(car.x).toBeGreaterThan(x);
  });
  it('stops the bumper before the edge for a far-side blocker and resumes when clear', () => {
    const { world, life, car, human } = pedestrianWorld();
    for (let i = 0; i < 60; i++)
      world.step(0.1, undefined, 18, undefined, undefined, undefined, 0.9);
    const front = life.groundBodies(car)[0]!;
    expect(2000 / life.perMeter - 1.5 - front.x - front.length / 2).toBeGreaterThanOrEqual(
      FOLLOW.minGap - 1e-6,
    );
    expect(car.v).toBe(0);
    expect(car.pedestrianHolds?.[0]?.elapsed).toBeCloseTo(6);
    life.movers.splice(life.movers.indexOf(human), 1);
    for (let i = 0; i < 100; i++) world.step(0.1, undefined, 18);
    expect(car.x).toBeGreaterThan(2000 + 10 * life.perMeter);
    expect(car.pedestrianHolds).toBeUndefined();
  });
  it('retains the physical stopping gap and bounded braking after an in-lane hold expires', () => {
    const { world, life, car, human } = pedestrianWorld(laneOffset(14, VEHICLES.car.width, 0));
    let afterHold = 0;
    for (let i = 0; i < 240; i++) {
      const velocity = (car.v ?? car.speed) / life.perMeter;
      world.step(0.1, undefined, 18, undefined, undefined, undefined, 0.9);
      expect((car.v ?? 0) / life.perMeter).toBeGreaterThanOrEqual(
        Math.max(0, velocity - kinematicsOf('car').maxBrake * 0.1) - 1e-6,
      );
      if (i === 199) afterHold = car.x;
      expect(bodiesOverlap(life.groundBodies(car)[0]!, life.groundBodies(human)[0]!, 0)).toBe(
        false,
      );
    }
    expect(car.pedestrianHolds?.[0]).toMatchObject({ expired: true, elapsed: 20 });
    expect(car.x).toBeGreaterThan(afterHold);
    expect(car.x).toBeLessThan(human.x);
    const body = life.groundBodies(human)[0]!;
    const gap =
      (human.x - car.x) / life.perMeter -
      (Math.abs(body.hx) * body.length + Math.abs(body.hy) * body.width) / (2 * life.perMeter) -
      VEHICLES.car.length / 2;
    expect(gap).toBeGreaterThanOrEqual(FOLLOW.minGap - 0.01);
    expect(life.motionStats.hardCaps).toBe(0);
  });
  it('freezes active hold time during inspection and retirement', () => {
    const { world, entry, car } = pedestrianWorld();
    world.step(0.1, undefined, 18);
    const saved = structuredClone(car.pedestrianHolds);
    (world as unknown as { inspection: { owner: object } }).inspection = { owner: car };
    for (let i = 0; i < 20; i++) world.step(0.1, undefined, 18);
    expect(car.pedestrianHolds).toEqual(saved);
    (world as unknown as { inspection: undefined }).inspection = undefined;
    world.sync([]);
    for (let i = 0; i < 20; i++) world.step(0.1);
    world.sync([entry]);
    expect(car.pedestrianHolds).toEqual(saved);
    world.step(0.1, undefined, 18);
    expect(car.pedestrianHolds?.[0]?.elapsed).toBe(0.2);
  });
  for (const [angle, reverse] of [
    [0, false],
    [0, true],
    [Math.PI / 3, false],
  ] as const)
    it(`derives stripe edges and curb entrances at ${angle}, reverse=${reverse}`, () => {
      const f = crossingFixture(angle, reverse);
      const matches = [...f.crossings.along(f.path, 1.2)];
      expect(matches).toHaveLength(1);
      const [crossing, edge] = matches[0]!;
      expect(edge).toBeCloseTo(13.5, 3);
      expect(
        Math.hypot(
          crossing.entrances[0].x - crossing.entrances[1].x,
          crossing.entrances[0].y - crossing.entrances[1].y,
        ),
      ).toBeCloseTo(16, 3);
      f.occupied.set({}, [f.body(0, reverse ? 5 : -5)]);
      const held = f.limit();
      expect(held.target / f.pm).toBeLessThan(8);
      expect(held.holds?.[0]?.elapsed).toBe(0.1);
    });
  it('holds for inward curb arrivals, misses distant or outward humans, and releases immediately', () => {
    const f = crossingFixture(),
      owner = {};
    f.occupied.set(owner, [f.body(0, -9.5)]);
    const held = f.limit();
    const saved = structuredClone(held);
    expect(held.holds).toHaveLength(1);
    const shortened = f.crossings.limit(
      f.view,
      f.path,
      1.2,
      4.4,
      5,
      8 * f.pm,
      kinematicsOf('car'),
      0.1,
      held.holds,
    );
    expect(shortened.holds?.[0]?.elapsed).toBe(0.2);
    expect(held).toEqual(saved);
    f.occupied.set(owner, [f.body(0, -9.5, 0, -1)]);
    const released = f.limit(held.holds);
    expect(released.target / f.pm).toBe(8);
    expect(released.holds?.[0]?.elapsed).toBe(0.1);
    f.occupied.set(owner, [f.body(0, -10.1)]);
    expect(f.limit().holds).toBeUndefined();
    f.occupied.set(owner, [f.body(0, -9.5)]);
    expect(f.limit(released.holds).holds?.[0]?.elapsed).toBe(0.2);
  });
  it('latches courtesy expiry while retaining physical lane braking and abandons an unused route', () => {
    const f = crossingFixture(),
      owner = {};
    f.occupied.set(owner, [f.body(0, 3.5)]);
    let result = f.limit();
    for (let i = 1; i < 210; i++) result = f.limit(result.holds);
    expect(result.holds?.[0]).toMatchObject({ expired: true, elapsed: PEDESTRIAN.holdMax });
    expect(result.target / f.pm).toBe(8);
    expect(f.view.walkersAhead(f.path[0]!.x, f.path[0]!.y, 1, 0, 1.2, 30)).toBeCloseTo(14.5, 3);
    f.path[0]!.x += 5;
    expect(
      pedestrianLimit(f.view, f.path, 1.2, 4.4, result.target, kinematicsOf('car'), f.pm, 0.1),
    ).toBeLessThan(result.target);
    f.occupied.set(owner, [f.body(-5, 3.5)]);
    expect(f.view.walkersAhead(f.path[0]!.x, f.path[0]!.y, 1, 0, 1.2, 30)).toBeCloseTo(4.5, 3);
    f.path[0]!.line = 1;
    expect(f.limit(result.holds).holds).toBeUndefined();
  });
  it('preserves the timer across an equivalent geographic index at another zoom', () => {
    const f = crossingFixture();
    f.occupied.set({}, [f.body(0, -9.5)]);
    const first = f.limit();
    const coarse = { z: tile.z - 1, x: tile.x >> 1, y: tile.y >> 1 };
    const frame = frameBetween(tile, coarse),
      pm = 1 / metersPerUnit(coarse);
    const crossing = [...f.crossings.along(f.path, 1.2).keys()][0]!;
    const builder = new LifeBuilder();
    const convert = (p: { x: number; y: number }) => ({
      x: frame.x + p.x * f.pm * frame.scale,
      y: frame.y + p.y * f.pm * frame.scale,
    });
    const p = f.path[0]!;
    builder.line(
      [convert(p), convert({ x: p.x + p.hx * 30, y: p.y + p.hy * 30 })],
      LifeLine.roadMajor,
      14,
    );
    builder.area(
      'crossing',
      crossing.polygon.map((ring) => ring.map(convert)),
    );
    const geo = builder.finish(),
      life = new StandaloneLife(coarse, geo, 1),
      index = new PedestrianCrossings(coarse, pm);
    complete(index.prepare(geo, life.signals));
    const at = convert(p),
      path = [{ ...p, x: at.x / pm, y: at.y / pm }];
    const body = f.body(0, -9.5),
      b = convert(body),
      occupied = new Occupancy();
    occupied.set({}, [{ ...body, x: b.x / pm, y: b.y / pm }]);
    const result = index.limit(
      pedestrianView(occupied, 0.9),
      path,
      1.2,
      4.4,
      30,
      8 * pm,
      kinematicsOf('car'),
      0.1,
      first.holds,
    );
    expect(result.holds?.[0]?.key).toBe(first.holds?.[0]?.key);
    expect(result.holds?.[0]?.elapsed).toBe(0.2);
  });
});
