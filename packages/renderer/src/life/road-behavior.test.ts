import { describe, expect, it, vi } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, TileLife, type Mover, type GroundGuard } from './simulate';
import { worldTiles } from './testing/scenarios';
import { activityLevels, laneOffset } from './config';
import { FOLLOW, LANE } from './config';
import { VEHICLES } from './vehicles';
import { bodiesOverlap } from './occupancy';
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
    for (const vehicle of ['car', 'tricycle'] as const) {
      const { life, m, leader } = passing();
      m.vehicle = vehicle;
      if (vehicle === 'car') {
        m.speed = 30 * pm;
        m.d = 4095 - 50 * pm;
        m.x = m.d;
        leader.d = m.d + 12 * pm;
        leader.x = leader.d;
      }
      for (let frame = 0; frame < 5 * 30; frame++) life.step(1 / 30);
      expect(m.maneuver).toBeUndefined();
      expect(m.chosenLane).toBeUndefined();
    }
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
