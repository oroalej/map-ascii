import { expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, TileLife, type Mover, type Walker, type WorldGroundGuard } from './simulate';
import { worldTiles } from './testing/scenarios';
import { tileToLngLat, metersPerUnit } from '../raster/geometry';
import { JunctionTable } from './junctions';
import { packLife } from './draw';
import { themes } from '../theme';
import { FOLLOW, WALK } from './config';
import { VEHICLES } from './vehicles';
import { snapshotMover } from './mover-pose';
import { bodiesOverlap, PolygonIndex } from './occupancy';

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);
function fixture(
  kind: LifeLine,
  width: number,
  besideRoad = false,
  terrain?: (b: LifeBuilder) => void,
  oneway = 0,
) {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 1000, y: 2048 },
      { x: 1000 + 220 * pm, y: 2048 },
    ],
    kind,
    width,
    0,
    oneway,
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
  // Isolate clearance/recovery from intentional pauses and ordinary random turns.
  (life as unknown as { walkerRng: () => number }).walkerRng = () => 1;
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

it.each([0, 1])(
  'tightens a blocked inside-corner curve through checked poses (one-way %s)',
  (oneway) => {
    const b = new LifeBuilder(),
      corner = 1000 + 60 * pm;
    const obstacle = new PolygonIndex();
    obstacle.add(rectangle(corner / pm - 20, 2048 / pm + 3, corner / pm - 3, 2048 / pm + 20));
    b.line(
      [
        { x: 1000, y: 2048 },
        { x: corner, y: 2048 },
        { x: corner, y: 2048 + 100 * pm },
      ],
      LifeLine.roadMajor,
      6,
      0,
      oneway,
    );
    b.area('blocked', rectangle(corner - 20 * pm, 2048 + 3 * pm, corner - 3 * pm, 2048 + 20 * pm));
    const world = new LifeWorld(undefined, undefined, { enabled: false });
    world.sync([{ key: 'curve', tile, life: b.finish() }]);
    const life = worldTiles(world).get('curve')!;
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    const m = mover('vehicle', 45, 1);
    life.movers.push(m);
    for (let frame = 0; frame < 600; frame++) {
      const before = life.pose(m);
      world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
      const after = life.pose(m);
      expect(Math.hypot(after.x - before.x, after.y - before.y) / pm).toBeLessThan(0.2);
      expect(m.dir).toBe(1);
      expect(obstacle.hits(life.groundBodies(m))).toBe(false);
    }
    expect(
      m.from,
      JSON.stringify({
        curve: m.curveLengthM,
        shift: m.roadShift,
        d: m.d / pm,
        waiting: m.waiting,
      }),
    ).toBe(1);
    expect(m.y).toBeGreaterThan(2048 + 15 * pm);
  },
);

it.each([false, true])(
  'takes the legal shared interior road vertex (disconnected nearby road %s)',
  (disconnected) => {
    const b = new LifeBuilder(),
      x = 1000 + 60 * pm;
    b.line(
      [
        { x: 1000, y: 2048 },
        { x, y: 2048 },
      ],
      LifeLine.roadMinor,
      6,
      101,
      1,
    );
    b.line(
      [
        { x: x + Number(disconnected), y: 2048 - 100 * pm },
        { x: x + Number(disconnected), y: 2048 },
        { x: x + Number(disconnected), y: 2048 + 100 * pm },
      ],
      LifeLine.roadMajor,
      6,
      102,
      1,
    );
    const world = new LifeWorld(undefined, undefined, { enabled: false });
    world.sync([{ key: 'interior', tile, life: b.finish() }]);
    const life = worldTiles(world).get('interior')!;
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    const m = mover('vehicle', 40, 1);
    m.speed = 3 * pm;
    m.v = 0;
    life.movers.push(m);
    const table = (world as unknown as { junctions: JunctionTable }).junctions;
    let granted = false;
    for (let frame = 0; frame < 600; frame++) {
      const before = life.pose(m);
      world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
      const after = life.pose(m);
      expect(Math.hypot(after.x - before.x, after.y - before.y) / pm).toBeLessThan(0.16);
      expect(m.dir).toBe(1);
      granted ||= table.granted(m);
    }
    expect(m.line).toBe(disconnected ? 0 : 1);
    if (!disconnected) {
      expect(granted).toBe(true);
      expect(table.movement(m)).toBeUndefined();
      expect(m.from).toBe(3);
      expect(m.y - 2048).toBeGreaterThan(VEHICLES.car.length * pm);
      expect(m.routing?.turns).toBe(1);
    } else expect(m.x).toBeLessThan(x);
  },
);

for (const minimum of [2.9, 1.45])
  it(`lets head-on walkers each travel 20 metres within 30 seconds at minimum ${minimum}`, () => {
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
  });

it.each([true, false])(
  'counts only traffic beyond an interior entry as outgoing leaders (behind %s)',
  (behind) => {
    const b = new LifeBuilder(),
      x = 1000 + 60 * pm;
    b.line(
      [
        { x: 1000, y: 2048 },
        { x, y: 2048 },
      ],
      LifeLine.roadMinor,
      6,
      101,
      1,
    );
    b.line(
      [
        { x, y: 2048 - 100 * pm },
        { x, y: 2048 },
        { x, y: 2048 + 100 * pm },
      ],
      LifeLine.roadMajor,
      6,
      102,
      1,
    );
    const world = new LifeWorld(undefined, undefined, { enabled: false });
    world.sync([{ key: 'interior-leader', tile, life: b.finish() }]);
    const life = worldTiles(world).get('interior-leader')!;
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    const entrant = mover('vehicle', 40, 1),
      leader = mover('vehicle', 0, 1);
    entrant.speed = 3 * pm;
    entrant.v = 0;
    Object.assign(leader, {
      line: 1,
      from: behind ? 2 : 3,
      d: (behind ? 30 : 10) * pm,
      x,
      y: 2048 + (behind ? -70 : 10) * pm,
      hx: 0,
      hy: 1,
      speed: 0,
      v: 0,
    });
    life.movers.push(entrant, leader);
    leader.x = life.geo.coords[leader.from * 2]!;
    leader.y = life.geo.coords[leader.from * 2 + 1]! + leader.d;
    const stopped = structuredClone(leader);
    for (let frame = 0; frame < 600; frame++)
      world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
    expect([leader.x, leader.y, leader.dir, leader.d]).toEqual([
      stopped.x,
      stopped.y,
      stopped.dir,
      stopped.d,
    ]);
    if (behind) {
      expect(entrant.line).toBe(1);
      expect(entrant.y - 2048).toBeGreaterThan(VEHICLES.car.length * pm);
    } else {
      expect(entrant.line).toBe(0);
      expect(entrant.x).toBeLessThan(x);
      expect((world as unknown as { junctions: JunctionTable }).junctions.granted(entrant)).toBe(
        false,
      );
    }
  },
);

it.each([false, true])(
  'checks a blocked walker reversal and rolls all group slots back (social facing %s)',
  (social) => {
    const { life } = fixture(LifeLine.path, 3);
    const m = mover('person', 70, 1);
    m.group = [walker(-0.3), { ...walker(0.3), back: 1.2 }];
    m.waiting = 4;
    if (social) m.momentFacing = { hx: 0, hy: 1 };
    life.movers.push(m);
    const before = { ...m };
    const slots = m.group.map((w) => ({ ...w }));
    let reversed = false;
    life.step(1 / 30, undefined, undefined, undefined, {}, (owner, previous) => {
      if (owner.hx === -1) {
        reversed = true;
        const shift = (owner.x - before.x) / pm;
        expect(shift).toBeLessThanOrEqual(1e-8);
        expect(shift).toBeGreaterThanOrEqual(-0.5 - 1e-8);
        expect(owner.y).toBeCloseTo(before.y);
        const now = life.groundBodies(owner).map((b) => [b.x, b.y]);
        const then = life.groundBodies(previous!).map((b) => [b.x, b.y]);
        now.forEach((point, index) => {
          expect(point[0]).toBeCloseTo(then[index]![0]! + shift);
          expect(point[1]).toBeCloseTo(then[index]![1]!);
        });
      }
      return false;
    });
    expect(reversed).toBe(true);
    expect(m).toEqual({ ...before, waiting: 4 + 1 / 30 });
    expect(m.group).toEqual(slots);
    expect(m.group).toBe(before.group);
  },
);

it('leaves a social facing pose without moving rear members into a wall', () => {
  const { world, life } = fixture(LifeLine.path, 2, false, (b) =>
    b.area(
      'blocked',
      rectangle(1000 + 68.5 * pm, 2048 - 0.5 * pm, 1000 + 69 * pm, 2048 + 0.5 * pm),
    ),
  );
  const m = mover('person', 70, 1);
  m.group = [walker(), { ...walker(0.3), back: 1.2, figure: 'child' }];
  m.momentFacing = { hx: 0, hy: 1 };
  const group = m.group,
    before = life.groundBodies(m).map((b) => ({ x: b.x, y: b.y }));
  life.movers.push(m);
  for (let frame = 0; frame < 10; frame++)
    world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
  expect((m.x - 1000) / pm).toBeGreaterThan(70.3);
  expect(m.group).toBe(group);
  expect(m.momentFacing).toBeUndefined();
  const after = life.groundBodies(m),
    travel = (m.x - 1000) / pm - 70;
  after.forEach((b, i) => {
    expect(b.x - before[i]!.x).toBeCloseTo(travel);
    expect(b.y - before[i]!.y).toBeCloseTo(0);
  });
});

it('backs a blocked curbside group away before attempting a physical rotation', () => {
  const { world, life } = fixture(LifeLine.path, 2, false, (b) => {
    b.line(
      [
        { x: 1000, y: 2048 - 0.53 * pm },
        { x: 1000 + 220 * pm, y: 2048 - 0.53 * pm },
      ],
      LifeLine.roadMajor,
      0.02,
    );
    b.area('blocked', rectangle(1000 + 70.6 * pm, 2048 - 2 * pm, 1000 + 72 * pm, 2048 + 2 * pm));
    b.area('blocked', rectangle(1000 + 65 * pm, 2048 + 0.53 * pm, 1000 + 80 * pm, 2048 + 5 * pm));
  });
  const m = mover('person', 70, 1);
  m.group = [walker(), { ...walker(0.1), figure: 'child', back: 1 }];
  life.movers.push(m);
  const bodies = life.groundBodies(m).map((b) => ({ x: b.x, y: b.y }));
  const group = m.group;
  for (let frame = 0; frame < 8 * 30; frame++) {
    const before = life.groundBodies(m);
    world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
    const after = life.groundBodies(m);
    after.forEach((body, i) =>
      expect(Math.hypot(body.x - before[i]!.x, body.y - before[i]!.y)).toBeLessThan(0.06),
    );
  }
  expect(m.dir).toBe(-1);
  expect(m.group).toBe(group);
  const after = life.groundBodies(m);
  after.forEach((body, i) => expect(bodies[i]!.x - body.x).toBeGreaterThan(2));
});

it.each([false, true])(
  'checks an ordinary group turn coherently and preserves rear slots (accept %s)',
  (accept) => {
    const { life } = fixture(LifeLine.path, 2);
    const m = mover('person', 70, 1);
    m.group = [walker(-0.3), { ...walker(0.3), back: 1.2 }];
    m.avoid = 0.2;
    life.movers.push(m);
    const before = snapshotMover(m),
      group = m.group;
    let calls = 0;
    (life as unknown as { walkerRng: () => number }).walkerRng = () => (calls++ === 1 ? 0 : 1);
    let checkedTurn = false;
    life.step(1 / 30, undefined, undefined, undefined, {}, (owner, previous) => {
      if (!checkedTurn) {
        checkedTurn = true;
        expect(owner.hx).toBe(-1);
        expect(life.groundBodies(owner).map((b) => [b.x, b.y])).toEqual(
          life.groundBodies(previous!).map((b) => [b.x, b.y]),
        );
      }
      return accept;
    });
    expect(checkedTurn).toBe(true);
    expect(m.group).toBe(group);
    expect(m.dir).toBe(accept ? -1 : 1);
    if (!accept) expect(m.group).toEqual(before.group);
  },
);

it('retains physical member dimensions at zero minimum and caps forward-only inflation', () => {
  const { life } = fixture(LifeLine.path, 3);
  const m = mover('person', 70, 1);
  m.group = [walker(-0.3), { ...walker(0.3), figure: 'child' }];
  const physical = life.groundBodies(m),
    inflated = life.groundBodies(m, 7);
  expect(physical.map((b) => [b.length, b.width])).toEqual([
    [0.9, 1],
    [0.5, 0.5],
  ]);
  expect(inflated.map((b) => [b.length, b.width])).toEqual([
    [3, 1],
    [3, 0.5],
  ]);
  expect(inflated.map((b) => [b.x, b.y])).toEqual(physical.map((b) => [b.x, b.y]));
});

it('uses a visiting walker identity when checking its rollback snapshot', () => {
  const { world, life } = fixture(LifeLine.path, 3);
  const m = mover('person', 70, 1);
  m.avoid = 1;
  const start = { x: m.x, y: m.y };
  const target = { x: m.x + 5 * pm, y: m.y };
  life.scenes.visits.set(m, {
    site: {
      ...target,
      kind: 'vendor',
      modes: 0,
      covered: false,
      queue: [],
      capacity: 4,
      hx: 1,
      hy: 0,
      road: -1,
      roadWidth: 0,
      direction: 1,
    },
    state: 'return',
    path: [start, target],
    trail: [target],
    next: 1,
    time: 0,
    seat: 0,
    sheltering: false,
    blocked: 0,
  });
  life.movers.push(m);
  const snapshot = { ...m };
  expect(life.groundBodies(snapshot, 2.9, [], m)).toEqual(life.groundBodies(m, 2.9));
  expect(life.groundBodies(snapshot, 2.9)[0]!.y).not.toBe(life.groundBodies(m, 2.9)[0]!.y);
  world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
  expect(m.x).toBeGreaterThan(start.x);
  expect(m.y).toBe(start.y);
  expect(life.scenes.visits.get(m)?.blocked).toBe(0);
});

it('releases a short-path yield after the complete priority footprint passes the original anchor', () => {
  const { world, life } = fixture(LifeLine.path, 3);
  const priority = mover('person', 70, 1),
    yielding = mover('person', 71.06, -1);
  priority.waiting = 5;
  yielding.waiting = 4;
  life.movers.push(priority, yielding);
  const guard = guardFor(world, 2.9);
  priority.x += 0.02 * pm;
  guard.contact(life, priority);
  priority.x -= 0.02 * pm;
  yielding.x -= 0.02 * pm;
  guard.contact(life, yielding);
  yielding.x += 0.02 * pm;
  expect(guard.yielding(yielding)).toBe(priority);
  priority.x += 1.5 * pm;
  // Its rear still occupies the original anchor: return must keep waiting.
  expect(guard.yielding(yielding)).toBe(priority);
  priority.x += 0.8 * pm;
  // This actual clearance fits a short path, unlike twice the bounding radii.
  expect(guard.yielding(yielding)).toBeUndefined();
});

it('rejects a holding spot on a later bend of the retained return route', () => {
  const { world, life } = fixture(LifeLine.path, 3);
  const priority = mover('person', 70, 1),
    yielding = mover('person', 71.06, -1);
  const start = { x: priority.x, y: priority.y },
    end = { x: start.x + pm, y: start.y - 3 * pm };
  life.scenes.visits.set(priority, {
    site: {
      ...end,
      kind: 'vendor',
      modes: 0,
      covered: false,
      queue: [],
      capacity: 4,
      hx: 1,
      hy: 0,
      road: -1,
      roadWidth: 0,
      direction: 1,
    },
    state: 'return',
    path: [start, { x: end.x, y: start.y }, end],
    trail: [end],
    next: 1,
    time: 0,
    seat: 0,
    sheltering: false,
    blocked: 5,
  });
  yielding.waiting = 4;
  life.movers.push(priority, yielding);
  const guard = guardFor(world, 2.9);
  guard.contact(life, priority, { ...priority, x: priority.x + 0.02 * pm });
  guard.contact(life, yielding, { ...yielding, x: yielding.x - 0.02 * pm });
  expect(guard.yielding(yielding)).toBe(priority);
  yielding.x = end.x;
  yielding.y = start.y - 1.6 * pm;
  expect(guard.holding(life, yielding)).toBe(false);
  yielding.x = start.x - 0.5 * pm;
  expect(guard.holding(life, yielding)).toBe(true);
});

it('clears a committed turning jeepney past a curbside group with retained physical facing', () => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 466, y: 378 },
      { x: 500, y: 263 },
      { x: 518, y: 208 },
    ],
    LifeLine.roadMid,
    8,
    101,
    1,
  );
  b.line(
    [
      { x: 518, y: 208 },
      { x: 181, y: 40 },
    ],
    LifeLine.roadMid,
    8,
    102,
    1,
  );
  b.line(
    [
      { x: 518, y: 208 },
      { x: 713, y: 273 },
    ],
    LifeLine.roadMid,
    8,
    103,
    0,
  );
  b.line(
    [
      { x: 533.0589, y: 272.7298 },
      { x: 466.9411, y: 253.2702 },
    ],
    LifeLine.path,
    3,
  );
  b.area('crossing', [
    [
      { x: 523.528192, y: 280.701481 },
      { x: 529.36605, y: 260.866141 },
      { x: 476.471808, y: 245.298519 },
      { x: 470.63395, y: 265.133859 },
      { x: 523.528192, y: 280.701481 },
    ],
  ]);
  const world = new LifeWorld(undefined, undefined, { enabled: false });
  world.sync([{ key: 'curb', tile, life: b.finish() }]);
  const life = worldTiles(world).get('curb')!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  (life as unknown as { walkerRng: () => number }).walkerRng = () => 1;
  const car = mover('vehicle', 0, 1),
    person = mover('person', 0, 1);
  Object.assign(car, {
    line: 0,
    from: 0,
    d: 92.919449,
    x: 492.344563,
    y: 288.893389,
    hx: 0.28352044,
    hy: -0.95896619,
    vehicle: 'jeepney',
    lane: 0.244205,
    speed: 5.7 * pm,
    v: 0,
    roadShift: -4.8,
    curveLengthM: 2,
    curveCorner: { x: 500, y: 263 },
    routing: { seed: 3544413152, turns: 1 },
    waiting: 5,
  });
  Object.assign(person, {
    line: 3,
    from: 7,
    dir: 1,
    d: 49.060868,
    x: 485.994124,
    y: 258.877845,
    hx: -0.95931394,
    hy: -0.28234156,
    momentFacing: { hx: 0.95931394, hy: 0.28234156 },
    avoid: 0.985248,
    waiting: 4,
    group: [walker(), { ...walker(1), figure: 'child' }, { ...walker(), back: 1, figure: 'child' }],
  });
  life.movers.push(car, person);
  const group = person.group,
    start = life.pose(car);
  let granted = false;
  const table = (world as unknown as { junctions: JunctionTable }).junctions;
  for (let frame = 0; frame < 25 * 30; frame++) {
    world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
    granted ||= table.granted(car);
    expect(
      life
        .groundBodies(car)
        .some((a) => life.groundBodies(person).some((b) => bodiesOverlap(a, b, 0))),
    ).toBe(false);
  }
  expect(granted).toBe(true);
  expect(Math.hypot(life.pose(car).x - start.x, life.pose(car).y - start.y) / pm).toBeGreaterThan(
    VEHICLES.jeepney.length,
  );
  expect(person.group).toBe(group);
  expect(person.walked).toBeGreaterThan(0.5);
});

it.each([
  [false, 2],
  [true, 2],
  [false, 1.2],
  [true, 1.2],
] as const)(
  'lets opposed returning visitors pass without jumping (rear members %s, path width %s)',
  (rear, width) => {
    const { world, life } = fixture(LifeLine.path, width, true);
    const people = [mover('person', 70, 1), mover('person', 95, -1)];
    for (const [i, m] of people.entries()) {
      if (rear) m.group = [walker(), { ...walker(0.35), back: 1.2, figure: 'child' }];
      const start = { x: m.x, y: m.y };
      m.x = 1000 + (i === 0 ? 85 : 80) * pm;
      life.scenes.visits.set(m, {
        site: {
          ...start,
          kind: 'vendor',
          modes: 0,
          covered: false,
          queue: [],
          capacity: 4,
          hx: 1,
          hy: 0,
          road: -1,
          roadWidth: 0,
          direction: 1,
        },
        state: 'return',
        path: [{ x: m.x, y: m.y }, start],
        trail: [start],
        next: 1,
        time: 0,
        seat: 0,
        sheltering: false,
        blocked: 0,
      });
    }
    life.movers.push(...people);
    const groups = people.map((m) => m.group);
    const trails = people.map((m) => life.scenes.visits.get(m)!.trail);
    const anchors = structuredClone(trails);
    const returned = new Set<Mover>();
    for (let frame = 0; frame < 900; frame++) {
      const before = people.map((m) => ({ x: m.x, y: m.y }));
      const visiting = people.map((m) => life.scenes.visits.has(m));
      world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
      const physical = people.map((m) => life.groundBodies(m));
      expect(physical[0]!.some((a) => physical[1]!.some((b) => bodiesOverlap(a, b, 0)))).toBe(
        false,
      );
      for (const [i, m] of people.entries()) {
        if (visiting[i])
          expect(Math.hypot(m.x - before[i]!.x, m.y - before[i]!.y) / pm).toBeLessThan(0.2);
        if (!life.scenes.visits.has(m)) returned.add(m);
      }
      if (returned.size === 2) break;
    }
    expect(returned.size).toBe(2);
    expect(people.every((m) => (m.walked ?? 0) > 10)).toBe(true);
    expect(trails).toEqual(anchors);
    people.forEach((m, i) => expect(m.group).toBe(groups[i]));
  },
);

it('keeps a servicing vehicle snapshot at its previous curb blend', () => {
  const { life } = fixture(LifeLine.roadMajor, 8);
  const car = mover('vehicle', 70, 1);
  life.scenes.services.set(car, {
    site: {
      x: car.x,
      y: car.y,
      kind: 'stop',
      modes: 7,
      covered: false,
      queue: [],
      capacity: 4,
      hx: 1,
      hy: 0,
      road: 0,
      roadWidth: 8,
      direction: 1,
    },
    time: 10,
    boarded: 0,
    arriving: true,
  });
  const before = { ...car },
    body = life.groundBodies(car).map((b) => ({ ...b }));
  car.x += 10 * pm;
  car.d += 10 * pm;
  expect(life.groundBodies(before, 0, [], car)).toEqual(body);
  expect(life.groundBodies(before)[0]!.y).not.toBe(body[0]!.y);
});

it('rejects a predicted seam reservation with an inherited future collision', () => {
  const { world, life } = fixture(LifeLine.roadMajor, 8);
  const follower = mover('vehicle', 50, 1),
    leader = mover('vehicle', 74, 1);
  life.movers.push(follower, leader);
  const guard = (
    world as unknown as { groundGuard(minimum: number): WorldGroundGuard }
  ).groundGuard(2.9);
  const future = { ...follower, x: 1000 + 70 * pm, d: 70 * pm };
  const preview = { ...future, x: future.x - 0.1 * pm, d: future.d - 0.1 * pm };
  const before = structuredClone(life.movers);
  expect(guard(life, preview, future, undefined, false, follower)).toBe(true);
  expect(guard.clearSeam(life, preview, follower)).toBe(false);
  expect(guard(life, preview, follower, undefined, false, follower)).toBe(false);
  expect(life.movers).toEqual(before);
});

it('backs away before reversing beside a physical wall, while retaining the swept guard', () => {
  const { world, life } = fixture(LifeLine.path, 3, false, (b) => {
    b.area('blocked', rectangle(1000 + 70.46 * pm, 2048 - 5 * pm, 1000 + 73 * pm, 2048 + 5 * pm));
  });
  const m = mover('person', 70, 1);
  m.waiting = 4;
  life.movers.push(m);
  world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
  expect(m.hx).toBe(-1);
  expect((m.x - 1000) / pm).toBeLessThan(70);
  expect(m.waiting).toBeGreaterThanOrEqual(WALK.blockedTurnSeconds);
  for (let frame = 0; frame < 150; frame++)
    world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
  expect(m.waiting).toBe(0);
  expect((m.x - 1000) / pm).toBeLessThan(65);
});

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

it.each([
  [false, 2.6],
  [true, 2.6],
  [true, 1.5],
] as const)(
  'steers within the road past a curb obstruction without reversing (one-way %s, wall %s m)',
  (oneway, wall) => {
    const { world, life } = fixture(
      LifeLine.roadMajor,
      8,
      false,
      (b) =>
        b.area(
          'blocked',
          rectangle(1000 + 75 * pm, 2048 + wall * pm, 1000 + 80 * pm, 2048 + 5 * pm),
        ),
      oneway ? 1 : 0,
    );
    const m = mover('vehicle', 70, 1);
    life.movers.push(m);
    for (let frame = 0; frame < 240; frame++) {
      const before = life.pose(m);
      world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
      const after = life.pose(m);
      expect(Math.hypot(after.x - before.x, after.y - before.y) / pm).toBeLessThanOrEqual(
        5 / 30 + 1e-8,
      );
      expect(m.dir).toBe(1);
    }
    expect((m.x - 1000) / pm).toBeGreaterThan(85);
    expect(m.roadShift).toBeLessThan(-0.3);
    if (oneway) expect(life.offsetOf(m)).toBeLessThan(wall - 0.9);
    else expect(life.offsetOf(m)).toBeGreaterThanOrEqual(0.975);
  },
);

it('lets both head-on cars accept forward travel after recovery within 35 seconds', () => {
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

it('backs away from an oblique curb obstruction before steering, keeping its route and facing', () => {
  const { world, life } = fixture(
    LifeLine.roadMajor,
    8,
    false,
    (b) =>
      b.area('blocked', [
        [
          { x: 1000 + 75 * pm, y: 2048 },
          { x: 1000 + 76 * pm, y: 2048 + 5 * pm },
          { x: 1000 + 80 * pm, y: 2048 + 5 * pm },
          { x: 1000 + 80 * pm, y: 2048 },
          { x: 1000 + 75 * pm, y: 2048 },
        ],
      ]),
    1,
  );
  const m = mover('vehicle', 70, 1);
  life.movers.push(m);
  let backward = false;
  for (let frame = 0; frame < 15 * 30; frame++) {
    const before = life.pose(m),
      x = m.x;
    world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
    const after = life.pose(m);
    backward ||= m.x < x - 1e-8;
    expect(Math.hypot(after.x - before.x, after.y - before.y) / pm).toBeLessThanOrEqual(
      5 / 30 + 1e-8,
    );
    expect(m.dir).toBe(1);
    expect(m.line).toBe(0);
    expect(m.hx).toBe(1);
    expect(m.v).toBeGreaterThanOrEqual(0);
  }
  expect(backward).toBe(true);
  expect(m.roadShift).toBeLessThan(-2.8);
  expect((m.x - 1000) / pm).toBeGreaterThan(85);
});

it('clears mixed-width head-on traffic on an oblique road without physical overlap', () => {
  const b = new LifeBuilder();
  const hx = 0.6,
    hy = 0.8;
  b.line(
    [
      { x: 1000, y: 1500 },
      { x: 1000 + hx * 220 * pm, y: 1500 + hy * 220 * pm },
    ],
    LifeLine.roadMajor,
    3.2,
  );
  const world = new LifeWorld(undefined, undefined, { enabled: false });
  world.sync([{ key: 'oblique', tile, life: b.finish() }]);
  const life = worldTiles(world).get('oblique')!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  const cars = [mover('vehicle', 70, 1), mover('vehicle', 85, -1)];
  cars[0]!.vehicle = 'jeepney';
  cars[1]!.vehicle = 'motorcycle';
  for (const [i, m] of cars.entries()) {
    const progress = i ? 85 : 70;
    Object.assign(m, {
      x: 1000 + hx * progress * pm,
      y: 1500 + hy * progress * pm,
      hx: hx * m.dir,
      hy: hy * m.dir,
    });
  }
  life.movers.push(...cars);
  const resumed = [0, 0];
  for (let frame = 0; frame < 35 * 30; frame++) {
    const before = cars.map((m) => ({ ...m }));
    world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
    expect(bodiesOverlap(life.groundBodies(cars[0]!)[0]!, life.groundBodies(cars[1]!)[0]!, 0)).toBe(
      false,
    );
    if (frame > 30 * 30)
      for (const [i, m] of cars.entries()) {
        if ((m.v ?? 0) > 0) resumed[i]! += Math.hypot(m.x - before[i]!.x, m.y - before[i]!.y) / pm;
      }
  }
  expect(Math.min(...resumed)).toBeGreaterThan(1);
});

it('keeps a following vehicle in its queue when traffic requests no movement', () => {
  const { world, life } = fixture(LifeLine.roadMajor, 8);
  const leader = mover('vehicle', 80, 1),
    follower = mover('vehicle', 80 - 4.4 - FOLLOW.minGap, 1);
  leader.speed = leader.v = follower.v = 0;
  life.movers.push(leader, follower);
  const start = follower.x;
  for (let frame = 0; frame < 35 * 30; frame++)
    world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
  expect(follower.dir).toBe(1);
  expect(follower.x).toBeCloseTo(start);
  expect(follower.waiting).toBe(0);
});

it('requires accepted travel before rearming a vehicle recovery', () => {
  const { life } = fixture(LifeLine.roadMajor, 8);
  const m = mover('vehicle', 70, 1);
  life.movers.push(m);
  const table = new JunctionTable();
  expect(life.recoverVehicle(m, () => true, table, new Set())).toBe(true);
  const recovered = snapshotMover(m);
  expect(life.recoverVehicle(m, () => true, table, new Set())).toBe(false);
  expect(m).toEqual(recovered);
  for (let frame = 0; frame < 150; frame++)
    life.step(1 / 30, undefined, undefined, undefined, {}, () => true);
  expect(Math.abs(m.x - recovered.x) / pm).toBeGreaterThan(4.4);
  expect(life.recoverVehicle(m, () => true, table, new Set())).toBe(true);
});

it('executes a selected recovery retreat in bounded steps before reversing', () => {
  const { life } = fixture(LifeLine.roadMajor, 8);
  const m = mover('vehicle', 70, 1),
    start = m.x;
  m.waiting = 30;
  life.movers.push(m);
  let rotations = 0;
  const guard: Parameters<typeof life.recoverVehicle>[1] = (next) => {
    if ('kind' in next && next.kind === 'vehicle' && next.dir === -1) {
      rotations++;
      return next.x <= start - 0.5 * pm + 1e-8;
    }
    return true;
  };
  let reversed = false;
  for (let frame = 0; frame < 30 && !reversed; frame++) {
    const before = m.x;
    reversed = life.recoverVehicle(m, guard, new JunctionTable(), new Set(), undefined, 1 / 30);
    if (!reversed) expect(Math.abs(m.x - before) / pm).toBeLessThanOrEqual(0.6 / 30 + 1e-8);
    if (frame < 20) expect(m.dir).toBe(1);
  }
  expect(rotations).toBeGreaterThan(0);
  expect(reversed).toBe(true);
  expect(m.waiting).toBe(30);
  expect((start - m.x) / pm).toBeCloseTo(0.5);
});

it('retreats far enough to clear the complete rotation beside a narrowing building edge', () => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 2230, y: 2356 },
      { x: 2398, y: 2099 },
      { x: 2550, y: 1854 },
    ],
    LifeLine.roadMinor,
    5,
  );
  b.area('blocked', [
    [
      { x: 2147, y: 2232 },
      { x: 2257, y: 2291 },
      { x: 2221, y: 2358 },
      { x: 2111, y: 2298 },
      { x: 2147, y: 2232 },
    ],
  ]);
  const world = new LifeWorld(undefined, undefined, { enabled: false });
  world.sync([{ key: 'narrow', tile, life: b.finish() }]);
  const life = worldTiles(world).get('narrow')!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  const length = Math.hypot(168, 257),
    m = mover('vehicle', 0, -1);
  Object.assign(m, {
    line: 0,
    from: 1,
    d: length - 0.002,
    x: 2230 + (168 / length) * 0.002,
    y: 2356 - (257 / length) * 0.002,
    hx: -168 / length,
    hy: 257 / length,
    speed: 4 * pm,
    v: 0,
    vehicle: 'motorcycle',
    lane: 0.37211,
    roadShift: -0.78,
    waiting: 30,
    routing: { seed: 1415479920, turns: 0 },
  });
  life.movers.push(m);
  const start = life.pose(m);
  const blocked = new PolygonIndex();
  blocked.add(b.finish().areas![0]!.rings.map((r) => r.map((p) => ({ x: p.x / pm, y: p.y / pm }))));
  let reversed = false;
  for (let frame = 0; frame < 18 * 30; frame++) {
    const previous = { x: m.x, y: m.y };
    world.step(1 / 30, undefined, 17, undefined, undefined, undefined, 2.9);
    expect(blocked.hits(life.groundBodies(m))).toBe(false);
    // Translation stays speed-bounded; the direction change itself is a full
    // swept rotation into the opposite lane, as in the other recovery controls.
    expect(Math.hypot(m.x - previous.x, m.y - previous.y) / pm).toBeLessThanOrEqual(4 / 30 + 1e-8);
    reversed ||= m.dir === 1;
  }
  expect(reversed).toBe(true);
  expect(Math.hypot(life.pose(m).x - start.x, life.pose(m).y - start.y) / pm).toBeGreaterThan(10);
  expect(m.routing?.turns).toBe(0);
});

it('rejects recovery departure corridors that would enter an unreserved junction', () => {
  const b = new LifeBuilder(),
    x = 1000 + 60 * pm;
  b.line(
    [
      { x: 1000, y: 2048 },
      { x, y: 2048 },
      { x: 1000 + 220 * pm, y: 2048 },
    ],
    LifeLine.roadMajor,
    8,
    1,
  );
  b.line(
    [
      { x, y: 2048 - 30 * pm },
      { x, y: 2048 },
    ],
    LifeLine.roadMinor,
    6,
    2,
  );
  const life = new TileLife(tile, b.finish(), 1),
    m = mover('vehicle', 70, 1);
  m.from = 1;
  m.d = 10 * pm;
  m.waiting = 30;
  life.movers.length = 0;
  life.movers.push(m);
  const before = snapshotMover(m),
    lines = new Set<number>();
  expect(life.junctionIndex.junctions).toHaveLength(1);
  expect(life.recoverVehicle(m, () => true, new JunctionTable(), lines)).toBe(false);
  expect(m).toEqual(before);
  expect(lines.size).toBe(0);
});

it('rolls back rejected vehicle recoveries, retains routing identity, and admits one per line', () => {
  const { life } = fixture(LifeLine.roadMajor, 8);
  const m = mover('vehicle', 70, 1);
  m.routing = { seed: 12, turns: 3, indicating: true };
  m.next = 2;
  const before = { ...m };
  const table = new JunctionTable(),
    lines = new Set<number>();
  expect(life.recoverVehicle(m, () => false, table, lines)).toBe(false);
  expect(m).toEqual(before);
  expect(m.routing).toBe(before.routing);
  expect(lines.size).toBe(0);
  expect(life.recoverVehicle(m, () => true, table, lines)).toBe(true);
  expect(m.hx).toBe(-1);
  expect(m.routing).toEqual({ seed: 12, turns: 3 });
  expect(Object.hasOwn(m, 'next')).toBe(false);
  expect(m.waiting).toBe(0);
  expect(m.v).toBe(0);
  expect(life.recoverVehicle(mover('vehicle', 90, 1), () => true, table, lines)).toBe(false);
  life.geo.oneway![0] = 1;
  expect(life.recoverVehicle(mover('vehicle', 90, 1), () => true, table, new Set())).toBe(false);
});

it('rejects a recovered lane pose outside the source even when its route cursor is inside', () => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0.05 * pm, y: 1000 },
      { x: 0.05 * pm, y: 1000 + 220 * pm },
    ],
    LifeLine.roadMajor,
    8,
  );
  const world = new LifeWorld(undefined, undefined, { enabled: false });
  world.sync([{ key: 'edge', tile, life: b.finish() }]);
  const life = worldTiles(world).get('edge')!;
  const m = { ...mover('vehicle', 70, -1), x: 0.05 * pm, y: 1000 + 70 * pm, hx: 0, hy: -1 };
  const before = { ...m };
  expect(life.pose(m).x).toBeGreaterThan(0);
  expect(life.recoverVehicle(m, () => true, new JunctionTable(), new Set())).toBe(false);
  expect(m).toEqual(before);
});

it('keeps admitted ordinary packing priority stable when camera distance reverses', () => {
  const { world, life } = fixture(LifeLine.roadMajor, 8);
  const a = mover('vehicle', 70, 1),
    b = mover('vehicle', 71, 1),
    far = mover('vehicle', 150, 1);
  a.paint = 1;
  b.paint = 2;
  far.paint = 3;
  life.movers.push(a, b, far);
  const grid = {
    cols: 10,
    rows: 10,
    cellWidth: 10,
    cellHeight: 18,
    toCell: () => [5.5, 5.5] as [number, number],
  };
  const out: Uint8Array[] = [];
  for (const center of [tileToLngLat(tile, a), tileToLngLat(tile, b)]) {
    const agents = world.visible(18, 1, center, undefined, undefined, undefined, 2);
    expect(agents.map((agent) => agent.paint)).toEqual([1, 2]);
    const bytes = new Uint8Array(400);
    packLife(bytes, grid, agents, themes.dark, () => 1);
    out.push(bytes);
  }
  expect(out[0]).toEqual(out[1]);
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
      b.area(
        'blocked',
        rectangle(1000 + 65 * pm, 2048 - 5 * pm, 1000 + 69 * pm, 2048 + 5 * pm),
        water,
      );
      b.area(
        'blocked',
        rectangle(1000 + 72 * pm, 2048 - 10 * pm, 1000 + 73 * pm, 2048 + 10 * pm),
        water,
      );
    });
    const before = mover('person', 70, 1);
    const next = { ...before, x: before.x + pm, d: before.d + pm };
    expect(guardFor(world, 2.9)(life, next, before)).toBe(true);
    expect(guardFor(world, 2.9)(life, { ...next, x: before.x + 5 * pm }, before)).toBe(false);
    // Initial admission still requires a legal inflated footprint.
    expect(guardFor(world, 2.9)(life, next)).toBe(false);
    const inside = { ...before, x: 1000 + 68 * pm };
    expect(guardFor(world, 2.9)(life, next, inside)).toBe(false);
  },
);

it('checks intermediate occupancy even during terrain inflation escape', () => {
  const { world, life } = fixture(LifeLine.path, 3, false, (b) =>
    b.area('blocked', rectangle(1000 + 65 * pm, 2048 - 5 * pm, 1000 + 69 * pm, 2048 + 5 * pm)),
  );
  const before = mover('person', 70, 1);
  life.movers.push(before);
  life.parked.push({ x: before.x + 10 * pm, y: before.y, hx: 1, hy: 0, vehicle: 'car', paint: 0 });
  const guard = guardFor(world, 2.9);
  const previous = { ...before };
  before.x += 20 * pm;
  expect(guard(life, before, previous)).toBe(false);
});

it('admits a physically safe turn with a new inflation-only terrain conflict', () => {
  const { world, life } = fixture(LifeLine.path, 2, false, (b) =>
    b.area('blocked', rectangle(1000 + 65 * pm, 2048 + 1.05 * pm, 1000 + 75 * pm, 2048 + 3 * pm)),
  );
  const before = mover('person', 70, 1),
    next = { ...before, hx: -1, dir: -1 as const };
  expect(guardFor(world, 2.9)(life, before)).toBe(true);
  expect(guardFor(world, 2.9)(life, next, before)).toBe(true);
  expect(guardFor(world, 2.9)(life, { ...next, y: 2048 + 1.5 * pm }, before)).toBe(false);
});

it.each([false, true])(
  'checks physical intermediate collisions during an inflated turn (parked %s)',
  (parked) => {
    const { world, life } = fixture(LifeLine.path, 2);
    const m = mover('person', 70, 1);
    life.movers.push(m);
    if (parked)
      life.parked.push({ x: m.x, y: m.y + 1.3 * pm, hx: 1, hy: 0, vehicle: 'car', paint: 0 });
    else {
      const child = mover('person', 70, 1);
      child.y += 1.3 * pm;
      child.group = [{ ...walker(), figure: 'child' }];
      life.movers.push(child);
    }
    const before = snapshotMover(m);
    m.hx = -1;
    expect(guardFor(world, 2.9)(life, m, before)).toBe(!parked);
  },
);
