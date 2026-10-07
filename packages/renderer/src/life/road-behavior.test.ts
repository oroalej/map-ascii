import { describe, expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { TileLife, type Mover, type GroundGuard } from './simulate';
import { activityLevels, laneOffset } from './config';
import { metersPerUnit } from '../raster/geometry';

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
  life.parkingLines.clear();
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
            ? { inspecting: m }
            : hold === 'activity'
              ? { levels: { ...activityLevels(1), vehicle: 0 } }
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
