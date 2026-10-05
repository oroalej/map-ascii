import { describe, expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, type Mover } from './simulate';
import { worldTiles } from './testing/scenarios';
import { pedestrianEntry, pedestrianTile } from './testing/pedestrians';
import { metersPerUnit } from '../raster/geometry';
import { TURN_AROUND, WALK_RECOVERY } from './config';

const tile = pedestrianTile;
const pm = 1 / metersPerUnit(tile);

/** The pedestrian fixture's road and crossing, with its sidewalks or without. */
function crossingWorld(sidewalks: boolean) {
  const entry = pedestrianEntry();
  if (!sidewalks) {
    // Rebuild it without the sidewalks: a crossing joined to nothing.
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 2000 },
        { x: 4096, y: 2000 },
      ],
      LifeLine.roadMajor,
      14,
    );
    b.line(
      [
        // As raster/geometry.ts draws it: 1.5 m past the walkable cut at each end.
        { x: 2000, y: 2000 - 8.5 * pm },
        { x: 2000, y: 2000 + 8.5 * pm },
      ],
      LifeLine.path,
      3,
    );
    b.area('crossing', entry.life.areas!.find((a) => a.kind === 'crossing')!.rings);
    entry.life = b.finish();
  }
  const world = new LifeWorld();
  world.sync([entry]);
  return { world, life: worldTiles(world).get(entry.key)! };
}

const person = (y: number, dir: 1 | -1): Mover => ({
  kind: 'person',
  line: 1,
  from: dir === 1 ? 2 : 3,
  dir,
  d: dir === 1 ? (40 + y) * pm : (40 - y) * pm,
  x: 2000,
  y: 2000 + y * pm,
  hx: 0,
  hy: dir,
  speed: 1.2 * pm,
  paint: 0,
  lane: 0,
  pause: 0,
  rank: 0,
  group: [{ figure: 'adult', shirt: 3, umbrella: 0, canopy: 0, lateral: 0, back: 0, step: 0 }],
});

const car = (x: number, speed: number): Mover => ({
  kind: 'vehicle',
  vehicle: 'car',
  line: 0,
  from: 0,
  dir: 1,
  d: 2000 + x * pm,
  x: 2000 + x * pm,
  y: 2000,
  hx: 1,
  hy: 0,
  speed: speed * pm,
  v: speed * pm,
  paint: 0,
  lane: 0,
  pause: 0,
  rank: 0,
});

describe('people at crossings', () => {
  it('lives on a crossing only where it joins the walking network', () => {
    const joined = crossingWorld(true).life,
      lone = crossingWorld(false).life;
    const residents = (life: typeof joined) =>
      life.movers.filter((m) => m.kind === 'person' && m.line === 1).length;
    expect(lone.movers.filter((m) => m.kind === 'person')).toHaveLength(0);
    expect(residents(joined)).toBeGreaterThan(0);
  });

  it('waits at the curb for a car that could not stop, and crosses once it has passed', () => {
    const { world, life } = crossingWorld(true);
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    // The crossing runs 7 m either side of the road's centre line; at 12 m/s, 12 m away, the car
    // can't stop for it.
    const walker = person(-7.3, 1),
      fast = car(-12, 12);
    life.movers.push(walker, fast);
    let waited = false;
    for (let frame = 0; frame < 120; frame++) {
      world.step(0.05, undefined, 18);
      // Its rear clears the crossing's near edge 2.2 m past the walker's line.
      const passed = fast.x > 2000 + 2.2 * pm;
      if (!passed && walker.y > 2000 - 7 * pm) throw new Error('stepped out in front');
      waited ||= !passed && walker.v === undefined && walker.y < 2000 - 7 * pm;
    }
    expect(waited).toBe(true);
    expect(fast.x).toBeGreaterThan(2000);
    expect(walker.y).toBeGreaterThan(2000 - 7 * pm);
  });

  it('crosses in front of a car that is stopped', () => {
    const { world, life } = crossingWorld(true);
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    const walker = person(-8, 1),
      stopped = car(-15, 0);
    stopped.speed = 0;
    life.movers.push(walker, stopped);
    for (let frame = 0; frame < 40; frame++) world.step(0.05, undefined, 18);
    expect(walker.y).toBeGreaterThan(2000 - 7 * pm);
  });

  it('turns round on the spot gradually, keeping each member in place', () => {
    const { world, life } = crossingWorld(true);
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    const walker = person(-38, -1);
    walker.group!.push({
      figure: 'child',
      shirt: 0,
      umbrella: 0,
      canopy: 0,
      lateral: 0.6,
      back: 0.4,
      step: 0,
    });
    life.movers.push(walker);
    let turning = 0,
      held: { x: number; y: number }[] | undefined,
      heading = Math.atan2(life.pose(walker).hy, life.pose(walker).hx);
    for (let frame = 0; frame < 200; frame++) {
      world.step(0.05, undefined, 18);
      const pose = life.pose(walker);
      const now = Math.atan2(pose.hy, pose.hx);
      const swing = Math.abs(Math.atan2(Math.sin(now - heading), Math.cos(now - heading)));
      // Never a half turn in one frame.
      expect(swing).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
      heading = now;
      const bodies = life.groundBodies(walker).map((b) => ({ x: b.x, y: b.y }));
      if (walker.turning) {
        turning++;
        // Turning round, nobody moves.
        held?.forEach((b, i) => {
          expect(bodies[i]!.x).toBeCloseTo(b.x);
          expect(bodies[i]!.y).toBeCloseTo(b.y);
        });
        held ??= bodies;
      } else held = undefined;
    }
    // It takes several frames, not one.
    expect(turning).toBeGreaterThanOrEqual(Math.floor(TURN_AROUND.seconds / 0.05) - 1);
  });

  it('turns back from a planter at once instead of standing against it', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 1000, y: 2000 },
        { x: 3000, y: 2000 },
      ],
      LifeLine.path,
      2,
    );
    b.area('blocked', [
      [
        { x: 1600, y: 1900 },
        { x: 1700, y: 1900 },
        { x: 1700, y: 2100 },
        { x: 1600, y: 2100 },
        { x: 1600, y: 1900 },
      ],
    ]);
    const world = new LifeWorld();
    world.sync([{ key: 'planter', tile, life: b.finish() }]);
    const life = worldTiles(world).get('planter')!;
    (life as unknown as { walkerRng: () => number }).walkerRng = () => 1;
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    const walker: Mover = {
      ...person(0, 1),
      line: 0,
      from: 0,
      d: 500,
      x: 1500,
      y: 2000,
      hx: 1,
      hy: 0,
    };
    life.movers.push(walker);
    let stood = 0,
      longest = 0;
    for (let frame = 0; frame < 300; frame++) {
      world.step(0.05, undefined, 18);
      stood = (walker.waiting ?? 0) > 0 ? stood + 0.05 : 0;
      longest = Math.max(longest, stood);
    }
    expect(walker.dir).toBe(-1);
    expect(longest).toBeLessThan(WALK_RECOVERY.seconds / 2);
  });
});
