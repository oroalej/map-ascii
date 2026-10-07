import { describe, expect, it, vi } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, TileLife, type Mover, type GroundGuard } from './simulate';
import { worldTiles } from './testing/scenarios';
import { activityLevels, laneOffset } from './config';
import { FOLLOW, LANE, kinematicsOf } from './config';
import { VEHICLES } from './vehicles';
import { bodiesOverlap } from './occupancy';
import { JunctionTable } from './junctions';
import { visibleTurnSignal, blinkOn } from './turn-signals';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);
function road(dir: 1 | -1 = 1, width = 9.6, oneway: 0 | 1 | -1 = dir) {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2000 },
      { x: 4095, y: 2000 },
    ],
    LifeLine.roadMinor,
    width,
    1,
    oneway,
  );
  const life = new TileLife(tile, b.finish(), 42);
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  // These synthetic roads need their full width regardless of the parking draw.
  (life as unknown as { parkingLines: Set<number> }).parkingLines.clear();
  life.scenes.sites.length = 0;
  const m: Mover = {
    kind: 'vehicle',
    vehicle: 'car',
    line: 0,
    from: dir === 1 ? 0 : 1,
    dir,
    d: 50 * pm,
    x: dir === 1 ? 50 * pm : 4095 - 50 * pm,
    y: 2000,
    hx: dir,
    hy: 0,
    speed: 4 * pm,
    v: 4 * pm,
    paint: 0,
    lane: 0.9,
    pause: 0,
    rank: 0,
    routing: { seed: 123, turns: 0 },
  };
  life.movers.push(m);
  return { life, m };
}

describe('accepted road lateral state', () => {
  it('keeps a partially refused tiny return active until its accepted residual is cleared', () => {
    const { life, m } = road();
    m.lat = 8e-7;
    m.maneuver = { kind: 'return', target: m.lane, returning: true };
    m.laneSignal = 'left';
    const guard: GroundGuard = (owner, previous) =>
      !('kind' in owner && previous && 'kind' in previous) ||
      Math.abs((owner.lat ?? 0) - (previous.lat ?? 0)) <= 4.01e-7;
    life.step(0.1, undefined, undefined, undefined, undefined, guard);
    expect(Math.abs(m.lat ?? 0)).toBeGreaterThan(1e-8);
    expect(m.maneuver?.kind).toBe('return');
    const preview = life.projectFrom(m, life)!;
    expect(Math.abs(preview.lat ?? 0)).toBeGreaterThan(1e-8);
    expect(preview.maneuver?.kind).toBe('return');
    expect(life.offsetOf(preview)).toBeCloseTo(life.offsetOf(m), 8);
    for (let frame = 0; frame < 20 && m.maneuver; frame++)
      life.step(0.1, undefined, undefined, undefined, undefined, () => true);
    expect(m.maneuver).toBeUndefined();
    expect(m.lat).toBeUndefined();
    expect(m.latYaw).toBeUndefined();
    expect(m.laneSignal).toBeUndefined();
  });

  it('computes each prospective maneuver offset once per following pass and refreshes movement queries', () => {
    const { life, m } = road();
    m.vehicle = 'motorcycle';
    m.lat = -1.6;
    m.maneuver = { kind: 'filter', target: m.lane, corridor: 2 / 3, queueSpeed: 0 };
    for (let n = 1; n < 20; n++)
      life.movers.push({
        ...m,
        vehicle: 'car',
        d: m.d + 10 * n * pm,
        x: m.x + 10 * n * pm,
        maneuver: undefined,
        lat: undefined,
      });
    life.prepareTraffic(() => true);
    const queries = life as unknown as {
      maneuverOffset(m: Mover): number;
      followLimits(dt: number, table: JunctionTable): Float64Array;
      roadGapSafe(m: Mover, target: number, continuing: boolean): boolean;
    };
    const sampled = vi.spyOn(queries, 'maneuverOffset');
    queries.followLimits(1 / 30, new JunctionTable());
    expect(sampled.mock.calls.filter(([owner]) => owner === m)).toHaveLength(1);
    sampled.mockClear();
    m.maneuver = { ...m.maneuver, corridor: 1 / 3 };
    queries.followLimits(1 / 30, new JunctionTable());
    expect(sampled.mock.calls.filter(([owner]) => owner === m)).toHaveLength(1);
    sampled.mockClear();
    queries.roadGapSafe(m, life.offsetOf(m), true);
    expect(sampled.mock.calls.some(([owner]) => owner === m)).toBe(true);
    sampled.mockRestore();
  });

  it('samples each following envelope once and leaves movement-time sweep queries fresh', () => {
    const { life, m } = road();
    m.chosenLane = 0.5;
    const peers = [10, 20].map((ahead) => ({ ...m, d: m.d + ahead * pm, x: m.x + ahead * pm }));
    life.movers.push(...peers);
    life.prepareTraffic(() => true);
    const queries = life as unknown as {
      roadEnvelope(m: Mover): { length: number; width: number };
      followLimits(dt: number, table: JunctionTable): Float64Array;
      roadGapSafe(m: Mover, target: number, continuing: boolean): boolean;
    };
    const sampled = vi.spyOn(queries, 'roadEnvelope');
    queries.followLimits(0.1, new JunctionTable());
    for (const owner of life.movers)
      expect(sampled.mock.calls.filter(([actor]) => actor === owner)).toHaveLength(1);
    sampled.mockClear();
    expect(queries.roadGapSafe(m, 0, true)).toBe(true);
    expect(sampled).toHaveBeenCalled();
    peers[0]!.d = peers[0]!.x = m.d + 5 * pm;
    expect(queries.roadGapSafe(m, 0, true)).toBe(false);
    sampled.mockRestore();
  });

  it.each([1, -1] as const)(
    'composes displacement with the travel-relative lane in direction %s',
    (dir) => {
      const { life, m } = road(dir);
      m.chosenLane = 0.5;
      m.lat = 0.4;
      m.roadShift = 0.2;
      expect(life.offsetOf(m)).toBeCloseTo(0.6);
      const before = structuredClone(m);
      const pose = life.pose(m);
      expect(pose.y - m.y).toBeCloseTo(dir * 0.6 * pm);
      expect(life.groundBodies(m)[0]!.y).toBeCloseTo(pose.y / pm);
      expect(m).toEqual(before);
      expect(m.lane).toBe(0.9);
    },
  );

  it('preserves the seeded two-way pose until a maneuver is selected', () => {
    const { life, m } = road(1, 8, 0);
    expect(life.offsetOf(m)).toBe(laneOffset(8, 1.8, m.lane));
    life.step(0.1);
    expect(m.chosenLane).toBeUndefined();
    expect(m.lat).toBeUndefined();
    expect(m.maneuver).toBeUndefined();
  });

  it('restores lateral progress, chosen lane and yaw after every refused trial', () => {
    const { life, m } = road();
    m.maneuver = { kind: 'lane', target: 0.5 };
    m.laneSignal = 'left';
    const state = m.maneuver;
    const pose = life.pose(m);
    life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    expect(life.pose(m)).toEqual(pose);
    expect(m.maneuver).toBe(state);
    expect(m.chosenLane).toBeUndefined();
    expect(m.lat).toBeUndefined();
    expect(m.latYaw).toBeUndefined();
    expect(m.laneSignal).toBe('left');
  });

  it('retries a proportional lateral step within the same physical budget', () => {
    const { life, m } = road();
    m.maneuver = { kind: 'lane', target: 0.5 };
    const before = life.pose(m);
    const guard: GroundGuard = (owner, previous) =>
      'kind' in owner && previous && 'kind' in previous
        ? Math.abs((owner.lat ?? 0) - (previous.lat ?? 0)) <= 0.06
        : true;
    life.step(0.1, undefined, undefined, undefined, undefined, guard);
    expect(m.lat).toBeCloseTo(-0.05);
    const after = life.pose(m);
    expect(Math.hypot(after.x - before.x, after.y - before.y) / pm).toBeLessThanOrEqual(0.2 + 1e-8);
    expect(Math.abs(Math.atan(m.latYaw ?? 0))).toBeLessThanOrEqual(Math.PI / 12);
  });

  it.each(['inspection', 'activity', 'near'] as const)(
    'freezes lateral state and timers during %s',
    (hold) => {
      const { life, m } = road();
      Object.assign(m, {
        maneuver: { kind: 'lane', target: 0.5 },
        lat: -0.4,
        latYaw: -0.1,
        laneCooldown: 6,
        filterRetry: 3,
      });
      const before = structuredClone(m);
      for (let frame = 0; frame < 20; frame++)
        life.step(
          0.1,
          undefined,
          undefined,
          hold === 'near' ? () => false : undefined,
          hold === 'inspection'
            ? { rain: 0, inspecting: m }
            : hold === 'activity'
              ? { rain: 0, levels: { ...activityLevels(1), vehicle: 0 } }
              : undefined,
          () => true,
        );
      expect(m).toEqual(before);
    },
  );

  it('commits normalized intent without changing the accepted physical pose', () => {
    const { life, m } = road();
    m.maneuver = { kind: 'lane', target: 0.5 };
    m.laneSignal = 'left';
    let completed = false;
    for (let frame = 0; frame < 200; frame++) {
      const previous = life.pose(m);
      life.step(0.1, undefined, undefined, undefined, undefined, () => true);
      const current = life.pose(m);
      expect(Math.hypot(current.x - previous.x, current.y - previous.y) / pm).toBeLessThanOrEqual(
        0.4 + 1e-8,
      );
      if (!m.maneuver) {
        completed = true;
        break;
      }
    }
    expect(completed).toBe(true);
    expect(m.chosenLane).toBe(0.5);
    expect(m.lane).toBe(0.9);
    expect(life.offsetOf(m)).toBeCloseTo(0);
    expect(m.laneSignal).toBeUndefined();
  });

  it.each([
    { dir: 1, lat: -3.2, lane: 0.9, side: 'right' },
    { dir: 1, lat: 3.2, lane: 0.1, side: 'left' },
    { dir: -1, lat: -3.2, lane: 0.9, side: 'right' },
    { dir: -1, lat: 3.2, lane: 0.1, side: 'left' },
  ] as const)(
    'completes a swept $side return in direction $dir after its protected-stop gap opens',
    ({ dir, lat, lane, side }) => {
      const { life, m } = road(dir);
      m.d = 4095 - 31 * pm;
      m.x = dir === 1 ? m.d : 4095 - m.d;
      m.speed = 8 * pm;
      m.v = pm;
      m.lane = lane;
      m.lat = lat;
      m.latYaw = 0.15;
      m.maneuver = { kind: 'lane', target: 0.5, returning: true };
      m.laneSignal = 'left';
      const peer = { ...m, lat: undefined, latYaw: undefined, maneuver: undefined };
      life.movers.push(peer);
      for (let frame = 0; frame < 3 * 30; frame++) {
        peer.d = m.d;
        peer.x = m.x;
        life.step(1 / 30, undefined, undefined, undefined, undefined, () => true);
      }
      expect((4095 - m.d) / pm).toBeCloseTo(LANE.clear);
      expect(m.maneuver?.kind).toBe('lane');
      expect(m.maneuver?.returning).toBe(true);
      expect(m.lat).toBe(lat);
      expect(m.latYaw).not.toBeUndefined();
      life.movers.pop();
      const stopped = m.d;
      let completed = false;
      for (let frame = 0; frame < 8 * 30; frame++) {
        const previous = life.pose(m);
        life.step(1 / 30, undefined, undefined, undefined, undefined, () => true);
        const current = life.pose(m);
        const radius = Math.hypot(VEHICLES.car.length, VEHICLES.car.width) / 2;
        const travel =
          Math.hypot(current.x - previous.x, current.y - previous.y) / pm +
          radius * Math.hypot(current.hx - previous.hx, current.hy - previous.hy);
        expect(travel).toBeLessThanOrEqual(m.speed / pm / 30 + 1e-8);
        expect(m.d).toBeCloseTo(stopped);
        if (!m.maneuver) {
          completed = true;
          break;
        }
        expect(m.laneSignal).toBe(side);
      }
      expect(completed).toBe(true);
      expect(m.lat).toBeUndefined();
      expect(m.latYaw).toBeUndefined();
      expect(m.laneSignal).toBeUndefined();
      expect(life.offsetOf(m)).toBeCloseTo(-lat);
    },
  );

  it.each([1, -1] as const)(
    'keeps a left return signal while yaw settles in direction %s',
    (dir) => {
      const { life, m } = road(dir);
      m.lane = 0.1;
      m.lat = 3.2;
      m.maneuver = { kind: 'return', target: m.lane, returning: true };
      m.laneSignal = 'left';
      m.speed = m.v = 8 * pm;
      let settling = 0;
      for (let frame = 0; frame < 200 && m.maneuver; frame++) {
        life.step(1 / 30, undefined, undefined, undefined, undefined, () => true);
        if (m.maneuver) {
          expect(m.laneSignal).toBe('left');
          if (Math.abs(m.lat ?? 0) < 1e-6 && m.latYaw !== undefined) settling++;
        }
      }
      expect(settling).toBeGreaterThan(0);
      expect(m.maneuver).toBeUndefined();
      expect(m.lat).toBeUndefined();
      expect(m.latYaw).toBeUndefined();
      expect(m.laneSignal).toBeUndefined();
    },
  );

  it.each([1 / 30, 0.1])('retries a proportional standstill return at dt=%s', (dt) => {
    const { life, m } = road();
    m.d = m.x = 4095 - LANE.clear * pm;
    m.v = 0;
    m.lat = -0.43;
    m.latYaw = 0.15;
    m.maneuver = { kind: 'return', target: m.lane, returning: true };
    const previous = life.pose(m);
    const guard: GroundGuard = (owner, before) =>
      !('kind' in owner && before && 'kind' in before) ||
      Math.abs((owner.lat ?? 0) - (before.lat ?? 0)) <= LANE.lateral * dt * 0.6;
    life.step(dt, undefined, undefined, undefined, undefined, guard);
    expect(m.lat).toBeCloseTo(-0.43 + (LANE.lateral * dt) / 2);
    const current = life.pose(m);
    const radius = Math.hypot(VEHICLES.car.length, VEHICLES.car.width) / 2;
    expect(
      Math.hypot(current.x - previous.x, current.y - previous.y) / pm +
        radius * Math.hypot(current.hx - previous.hx, current.hy - previous.hy),
    ).toBeLessThanOrEqual(((m.speed / pm) * dt) / 2 + 1e-8);
    expect(m.latYaw).toBeLessThan(0.15);
    expect(m.d).toBeCloseTo(4095 - LANE.clear * pm);
  });

  it('rolls back refused standstill returns and freezes them under inspection', () => {
    const { life, m } = road();
    m.d = m.x = 4095 - LANE.clear * pm;
    m.v = 0;
    m.lat = -0.43;
    m.latYaw = 0.15;
    m.maneuver = { kind: 'return', target: m.lane, returning: true };
    m.laneSignal = 'right';
    const pose = life.pose(m);
    for (let frame = 0; frame < 5; frame++)
      life.step(1 / 30, undefined, undefined, undefined, undefined, () => false);
    expect(life.pose(m)).toEqual(pose);
    expect(m.lat).toBe(-0.43);
    expect(m.latYaw).toBe(0.15);
    const held = structuredClone(m);
    life.step(0.1, undefined, undefined, undefined, { rain: 0, inspecting: m }, () => true);
    expect(m).toEqual(held);
  });

  it('holds a return when another vehicle closes its complete source-to-target sweep', () => {
    const { life, m } = road();
    m.lat = -3.2;
    m.maneuver = { kind: 'return', target: m.lane, returning: true };
    const peer = { ...m, lat: undefined, maneuver: undefined };
    life.movers.push(peer);
    life.step(1 / 30, undefined, undefined, undefined, undefined, () => true);
    expect(m.maneuver?.kind).toBe('lane');
    expect(m.maneuver?.returning).toBe(true);
    expect(m.lat).toBe(-3.2);
  });

  it('rejects a strictly mid-sweep peer with physically clear source and destination', () => {
    const { life, m } = road();
    m.lat = -6.4;
    m.maneuver = { kind: 'return', target: m.lane, returning: true };
    const peer = { ...m, lane: 0.5, lat: undefined, maneuver: undefined };
    life.movers.push(peer);
    life.prepareTraffic(() => true);
    const queries = life as unknown as {
      roadGapSafe(m: Mover, target: number, continuing: boolean): boolean;
      maneuverOffset(m: Mover): number;
    };
    const source = life.offsetOf(m),
      target = queries.maneuverOffset(m),
      middle = life.offsetOf(peer);
    const clearance = VEHICLES.car.width + FOLLOW.roadGap;
    expect(Math.abs(source - middle)).toBeGreaterThan(clearance);
    expect(Math.abs(target - middle)).toBeGreaterThan(clearance);
    expect(queries.roadGapSafe(m, target, true)).toBe(false);
    life.movers.pop();
    life.prepareTraffic(() => true);
    expect(queries.roadGapSafe(m, target, true)).toBe(true);
  });
});

function splitTraffic(dir: 1 | -1, rearDistance = 82, differentIncoming = false, interior = false) {
  const split = dir === 1 ? 200 * pm : 4095 - 200 * pm;
  const incoming =
    dir === 1
      ? [
          { x: 0, y: 2000 },
          { x: split, y: 2000 },
        ]
      : [
          { x: split, y: 2000 },
          { x: 4095, y: 2000 },
        ];
  const outgoing = interior
    ? [
        { x: 0, y: 2000 },
        { x: split, y: 2000 },
        { x: 4095, y: 2000 },
      ]
    : dir === 1
      ? [
          { x: split, y: 2000 },
          { x: 4095, y: 2000 },
        ]
      : [
          { x: 0, y: 2000 },
          { x: split, y: 2000 },
        ];
  const b = new LifeBuilder();
  b.line(incoming, LifeLine.roadMajor, 6.4, 1, dir);
  b.line(outgoing, LifeLine.roadMajor, 6.4, 2, dir);
  if (differentIncoming) b.line(incoming, LifeLine.roadMajor, 6.4, 3, dir);
  const life = new TileLife(tile, b.finish(), 42);
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  (life as unknown as { rushRng: () => number }).rushRng = () => 1;
  const m = road(dir).m;
  Object.assign(m, {
    line: 1,
    from: interior ? 3 : dir === 1 ? 2 : 3,
    d: pm,
    x: split + dir * pm,
    came: interior ? undefined : dir === 1 ? 1 : 0,
    speed: 8 * pm,
    v: 0,
  });
  const rear: Mover = {
    ...m,
    line: differentIncoming ? 2 : 0,
    from: (differentIncoming ? 4 : 0) + (dir === 1 ? 0 : 1),
    d: rearDistance * pm,
    x: dir === 1 ? rearDistance * pm : 4095 - rearDistance * pm,
    lane: 0.1,
    speed: 10 * pm,
    v: 10 * pm,
    came: undefined,
    next: dir === 1 ? 2 : 3,
    routing: { seed: 123, turns: 0 },
  };
  const lead: Mover = { ...m, vehicle: 'truck', speed: 0, v: 0 };
  lead.d = (1 + (VEHICLES.car.length + VEHICLES.truck.length) / 2 + FOLLOW.minGap + 0.005) * pm;
  lead.x = split + dir * lead.d;
  life.movers.push(m, rear, lead);
  return { life, m, rear };
}

describe('prospective gaps across a road split', () => {
  it.each([1, -1] as const)(
    'checks incoming traffic at a passed interior vertex in direction %s',
    (dir) => {
      const { life, m, rear } = splitTraffic(dir, 198, false, true);
      life.prepareTraffic(() => true);
      const queries = life as unknown as {
        roadGapSafe(m: Mover, target: number, continuing: boolean): boolean;
        laneTargetOffset(m: Mover, target: number): number;
      };
      const target = queries.laneTargetOffset(m, 0.25);
      expect(queries.roadGapSafe(m, target, false)).toBe(false);
      expect(queries.roadGapSafe(m, target, true)).toBe(false);
      rear.d = 140 * pm;
      rear.x = dir === 1 ? rear.d : 4095 - rear.d;
      life.prepareTraffic(() => true);
      expect(queries.roadGapSafe(m, target, false)).toBe(true);
    },
  );

  it("reserves an incoming peer's destination sweep while its accepted lane is clear", () => {
    const { life, m, rear } = splitTraffic(1, 193, true);
    life.movers.pop();
    life.prepareTraffic(() => true);
    const queries = life as unknown as {
      roadGapSafe(m: Mover, target: number, continuing: boolean): boolean;
    };
    const target = life.offsetOf(m);
    expect(queries.roadGapSafe(m, target, true)).toBe(true);
    rear.maneuver = { kind: 'lane', target: 0.75 };
    expect(queries.roadGapSafe(m, target, true)).toBe(false);
  });

  it.each([1, -1] as const)(
    'checks all incoming routes for entry and return in direction %s',
    (dir) => {
      const { life, m, rear } = splitTraffic(dir, 198, true);
      life.prepareTraffic(() => true);
      const queries = life as unknown as {
        roadGapSafe(m: Mover, target: number, continuing: boolean): boolean;
        laneTargetOffset(m: Mover, target: number): number;
      };
      const target = queries.laneTargetOffset(m, 0.25);
      expect(queries.roadGapSafe(m, target, false)).toBe(false);
      expect(queries.roadGapSafe(m, target, true)).toBe(false);
      rear.d = 140 * pm;
      rear.x = dir === 1 ? rear.d : 4095 - rear.d;
      life.prepareTraffic(() => true);
      expect(queries.roadGapSafe(m, target, false)).toBe(true);
      expect(queries.roadGapSafe(m, target, true)).toBe(true);
    },
  );

  it.each([1, -1] as const)(
    'admits a normally stepped pass without hard braking at a split in direction %s',
    (dir) => {
      const { life, m, rear } = splitTraffic(dir);
      let entered = false;
      for (let frame = 0; frame < 600; frame++) {
        const before = rear.v!;
        life.step(1 / 30, undefined, undefined, undefined, undefined, () => true);
        expect(before - rear.v!).toBeLessThanOrEqual(
          (kinematicsOf('car').maxBrake * pm) / 30 + 1e-8,
        );
        entered ||= m.maneuver?.kind === 'lane';
      }
      expect(entered).toBe(true);
      expect(life.motionStats.hardCaps).toBe(0);
    },
  );
});

function passing(dir: 1 | -1 = 1) {
  const { life, m } = road(dir);
  m.speed = 8 * pm;
  m.v = pm;
  const gap = (VEHICLES.car.length + VEHICLES.truck.length) / 2 + FOLLOW.minGap + FOLLOW.headway;
  const leader: Mover = {
    ...m,
    vehicle: 'truck',
    d: m.d + gap * pm,
    x: m.x + dir * gap * pm,
    speed: pm,
    v: pm,
    routing: { seed: 321, turns: 0 },
  };
  life.movers.push(leader);
  return { life, m, leader };
}

describe('deterministic passing', () => {
  it('retains a distant fast rear follower in the braking-distance check', () => {
    const { life, m } = road();
    const peer = {
      ...m,
      lane: 0.5,
      d: m.d - 100 * pm,
      x: m.x - 100 * pm,
      speed: 50 * pm,
      v: 50 * pm,
    };
    life.movers.push(peer);
    life.prepareTraffic(() => true);
    const query = life as unknown as { roadGapSafe(m: Mover, target: number): boolean };
    expect(query.roadGapSafe(m, 0)).toBe(false);
  });
  it('freezes accepted state and blink phase during inspection, with hazards taking precedence', () => {
    const fixture = passing();
    const world = new LifeWorld(undefined, undefined, undefined, true);
    world.sync([{ key: 'road', tile, life: fixture.life.geo }]);
    const life = worldTiles(world).get('road')!;
    life.movers.splice(0, life.movers.length, fixture.m);
    life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    const m = fixture.m;
    m.maneuver = { kind: 'lane', target: 0.5 };
    m.laneSignal = 'left';
    const center = tileToLngLat(tile, m);
    const first = world.visible(21, 1, center)[0]!;
    world.inspection!.select({ id: first.inspectionId!, revision: 1, time: 0 }, 0);
    const before = structuredClone(m);
    for (let frame = 0; frame < 20; frame++) {
      world.step(0.1, undefined, 21);
      expect(world.visible(21, 1, center)[0]!.turnSignal).toEqual(first.turnSignal);
      expect(m).toEqual(before);
    }
    const held = vi.spyOn(life.scenes, 'held').mockReturnValue(true);
    const hazard = world.visible(21, 1, center)[0]!;
    expect(hazard.lamps?.kind).toBe('hazard');
    expect(hazard.turnSignal).toBeUndefined();
    held.mockRestore();
  });
  it.each([1, -1] as const)(
    'starts a left pass within five seconds and overtakes in direction %s',
    (dir) => {
      const { life, m, leader } = passing(dir);
      let started = Infinity,
        completed = false,
        passed = false;
      for (let frame = 0; frame < 40 * 30; frame++) {
        life.step(1 / 30, undefined, undefined, undefined, undefined, () => true);
        if (m.maneuver && started === Infinity) started = (frame + 1) / 30;
        completed ||= m.chosenLane !== undefined && !m.maneuver;
        passed ||= m.d - leader.d > ((VEHICLES.car.length + VEHICLES.truck.length) / 2) * pm;
        expect(bodiesOverlap(life.groundBodies(m)[0]!, life.groundBodies(leader)[0]!)).toBe(false);
      }
      expect(started).toBeLessThanOrEqual(5);
      expect(completed).toBe(true);
      expect(passed).toBe(true);
      expect(m.lane).toBe(0.9);
    },
  );

  it.each(['front', 'rear'] as const)('rejects an unsafe target-lane %s gap', (position) => {
    const { life, m } = passing();
    const peer = {
      ...m,
      lane: 0.5,
      d: m.d + (position === 'front' ? 4 : -12) * pm,
      x: m.x + (position === 'front' ? 4 : -12) * pm,
      speed: position === 'front' ? pm : 15 * pm,
      v: position === 'front' ? pm : 15 * pm,
    };
    life.movers.push(peer);
    life.prepareTraffic(() => true);
    // Candidate selection sees the unsafe snapshot without moving the blocker out of it.
    const query = life as unknown as { roadGapSafe(m: Mover, target: number): boolean };
    expect(query.roadGapSafe(m, 0)).toBe(false);
  });

  it('does not start at a fast protected approach or for tricycles', () => {
    for (const speed of [8, 30]) {
      const { life, m, leader } = passing();
      m.speed = speed * pm;
      m.v = 8 * pm;
      m.d = m.x = 4095 - 80 * pm;
      leader.d = leader.x = m.d + 12 * pm;
      let entered = false;
      for (let frame = 0; frame < 5 * 30; frame++) {
        life.step(1 / 30);
        entered ||= m.maneuver?.kind === 'lane';
      }
      expect(entered).toBe(speed === 8);
      if (speed === 8) expect(m.laneSignal).toBe('left');
      else {
        expect(m.maneuver).toBeUndefined();
        expect(m.chosenLane).toBeUndefined();
      }
    }
    const { life, m } = passing();
    m.vehicle = 'tricycle';
    for (let frame = 0; frame < 5 * 30; frame++) life.step(1 / 30);
    expect(m.maneuver).toBeUndefined();
    expect(m.chosenLane).toBeUndefined();
  });

  it('reserves the destination envelope before a simultaneous competing change', () => {
    const { life, m } = passing();
    m.maneuver = { kind: 'lane', target: 0.5 };
    const peer = { ...m, lane: 0.1, maneuver: undefined, routing: { seed: 456, turns: 0 } };
    life.movers.push(peer);
    life.prepareTraffic(() => true);
    const query = life as unknown as { roadGapSafe(m: Mover, target: number): boolean };
    expect(query.roadGapSafe(peer, 0)).toBe(false);
  });

  it('uses the routing seed phase and retains lane indication ahead of route indication', () => {
    const routing = { seed: 123, turns: 0, signal: { side: 'right' as const, remaining: 1 } };
    for (const clock of [0, 0.25, 0.75, 1.25])
      expect(visibleTurnSignal(routing, clock, 'left')).toEqual({
        side: 'left',
        on: blinkOn(123, clock),
      });
    expect(LANE).toEqual({ lateral: 1, gain: 1.5, patience: 2, clear: 30, cooldown: 6 });
  });

  it.each([30, 60, 120])('replays complete accepted pass state at %s Hz', (hz) => {
    const a = passing(),
      b = passing();
    let active = false;
    for (let frame = 0; frame < 8 * hz; frame++) {
      a.life.step(1 / hz);
      b.life.step(1 / hz);
      active ||= !!a.m.maneuver;
      expect(a.life.movers).toEqual(b.life.movers);
      expect(a.life.movers.map((m) => a.life.pose(m))).toEqual(
        b.life.movers.map((m) => b.life.pose(m)),
      );
      expect(visibleTurnSignal(a.m.routing, frame / hz, a.m.laneSignal)).toEqual(
        visibleTurnSignal(b.m.routing, frame / hz, b.m.laneSignal),
      );
    }
    expect(active).toBe(true);
  });
});
