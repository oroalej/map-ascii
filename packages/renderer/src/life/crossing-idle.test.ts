import { describe, expect, it } from 'vitest';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import { activityLevels } from './config';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, TileLife, type Mover, type Walker } from './simulate';
import { stripRing } from './terrain';
import { worldTiles } from './testing/scenarios';

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);
const center = tileToLngLat(tile, { x: 2000, y: 2000 });
const walker: Walker = {
  figure: 'adult',
  shirt: 0,
  umbrella: 1,
  canopy: 0,
  lateral: 0,
  back: 0,
  step: 0,
};
const crossing = (x = 2000) => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2000 },
      { x: 4095, y: 2000 },
    ],
    LifeLine.path,
    2,
  );
  b.line(
    [
      { x, y: 0 },
      { x, y: 4095 },
    ],
    LifeLine.roadMinor,
    6,
  );
  b.area('crossing', [stripRing({ x: x - 4 * pm, y: 2000 }, { x: x + 4 * pm, y: 2000 }, 2 * pm)]);
  return b;
};
const mover = (kind: 'person' | 'dog' | 'cat', x = 2000): Mover => ({
  kind,
  line: 0,
  from: 0,
  dir: 1,
  d: x,
  speed: 2 * pm,
  paint: 0,
  lane: 0,
  pause: 0,
  rank: 0,
  x,
  y: 2000,
  hx: 1,
  hy: 0,
  walked: 0,
  ...(kind === 'person' ? { group: [{ ...walker }] } : {}),
});
const clear = (life: TileLife) => {
  life.movers.length = life.gatherers.length = life.stalls.length = life.parked.length = 0;
  life.scenes.sites.length = 0;
};
const forceIdle = (life: TileLife) => {
  const streams = life as unknown as {
    rng: () => number;
    walkerRng: () => number;
    dogRng: () => number;
    catRng: () => number;
  };
  streams.rng = streams.walkerRng = streams.dogRng = streams.catRng = () => 0;
};
const setup = () => {
  const world = new LifeWorld();
  world.sync([{ key: 'crossing', tile, life: crossing().finish() }]);
  const life = worldTiles(world).get('crossing')!;
  clear(life);
  forceIdle(life);
  world.visible(18, activityLevels(1), center);
  return { world, life };
};

describe('crossing idle eligibility', () => {
  for (const kind of ['person', 'dog', 'cat'] as const) {
    it(`${kind} clears the crossing before any forced idle event or voluntary turn`, () => {
      const { world, life } = setup();
      const m = mover(kind);
      Object.assign(m, { pause: 45, lying: kind === 'dog', grooming: kind === 'cat' });
      life.movers.push(m);
      for (let i = 0; !life.canIdle(m) && i < 100; i++) {
        const x = m.x;
        world.step(0.1, undefined, 18);
        expect(m.x).toBeGreaterThan(x);
        expect(m.pause).toBe(0);
        expect(m.dir).toBe(1);
        if (kind === 'dog') expect(m.lying).toBe(false);
        if (kind === 'cat') expect(m.grooming).toBe(false);
      }
      expect(life.canIdle(m)).toBe(true);
      world.step(0.1, undefined, 18);
      expect(m.pause).toBeGreaterThan(0);
      if (kind === 'dog') expect(m.lying).toBe(true);
      if (kind === 'cat') expect(m.grooming).toBe(true);
    });
  }

  it('waits for the trailing member and uses physical footprints at every rendering density', () => {
    for (const cellMeters of [0, 0.5, 3]) {
      const { world, life } = setup();
      const m = mover('person', 2000 + 3.8 * pm);
      m.group!.push({ ...walker, back: 4 });
      life.movers.push(m);
      expect(life.roadTerrain.access.allows([life.groundBodies(m)[0]!], false)).toBe(true);
      expect(life.canIdle(m)).toBe(false);
      world.step(0.1, undefined, 18, undefined, undefined, undefined, cellMeters);
      expect(m.pause).toBe(0);
      expect(m.dir).toBe(1);
      expect(m.group![1]!.back).toBe(4);
      expect(life.canIdle(m)).toBe(false);
    }
  });

  it('suppresses random reversals independently of pause rolls', () => {
    for (const kind of ['person', 'dog'] as const) {
      const { world, life } = setup();
      const streams = life as unknown as {
        rng: () => number;
        walkerRng: () => number;
        dogRng: () => number;
      };
      let calls = 0;
      streams.rng = streams.walkerRng = streams.dogRng = () => (++calls % 3 === 0 ? 0 : 1);
      const m = mover(kind);
      life.movers.push(m);
      for (let i = 0; i < 8; i++) world.step(0.1, undefined, 18);
      expect(m.dir).toBe(1);
      expect(m.x).toBeGreaterThan(2000);
      expect(m.pause).toBe(0);
    }
  });

  it('keeps collision-based waiting while voluntary idle events are suppressed', () => {
    const { world, life } = setup();
    const m = mover('dog');
    const other = mover('person', 2000 + 1 * pm);
    other.speed = 0;
    life.movers.push(m, other);
    world.step(0.1, undefined, 18);
    expect(m.x).toBe(2000);
    expect(m.pause).toBe(0);
    expect(m.lying).toBe(false);
  });

  it('includes a neighboring tile carriageway and removes the constraint on eviction', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 2000 },
        { x: 4095, y: 2000 },
      ],
      LifeLine.path,
      2,
    );
    const world = new LifeWorld();
    world.sync([{ key: 'west', tile, life: b.finish() }]);
    const life = worldTiles(world).get('west')!;
    clear(life);
    forceIdle(life);
    const m = mover('cat', 4096 - pm);
    life.movers.push(m);
    expect(life.canIdle(m)).toBe(true);
    const east = { ...tile, x: tile.x + 1 };
    const neighbor = crossing(0);
    world.sync([
      { key: 'west', tile, life: life.geo },
      { key: 'east', tile: east, life: neighbor.finish() },
    ]);
    clear(worldTiles(world).get('east')!);
    expect(life.canIdle(m)).toBe(false);
    world.visible(18, activityLevels(1), center);
    world.step(0.1, undefined, 18);
    expect(m.pause).toBe(0);
    expect(m.x).toBeGreaterThan(4096 - pm);
    world.sync([{ key: 'west', tile, life: life.geo }]);
    expect(life.canIdle(m)).toBe(true);
  });

  it('omits stationary bench placements even on permitted crossing terrain', () => {
    const b = crossing();
    b.place({ x: 2000, y: 2000 }, 'bench', 0);
    expect(new TileLife(tile, b.finish(), 5).gatherers).toHaveLength(0);
  });

  it('revalidates seated placements when a neighboring carriageway loads', () => {
    const b = new LifeBuilder();
    b.place({ x: 4096 - pm, y: 2000 }, 'bench', 0);
    const world = new LifeWorld();
    world.sync([{ key: 'west', tile, life: b.finish() }]);
    const life = worldTiles(world).get('west')!;
    expect(life.gatherers.length).toBeGreaterThan(0);
    world.sync([
      { key: 'west', tile, life: life.geo },
      { key: 'east', tile: { ...tile, x: tile.x + 1 }, life: crossing(0).finish() },
    ]);
    expect(life.gatherers).toHaveLength(0);
  });

  it('resumes paused gathering people already crossing and pauses only at a safe destination', () => {
    const b = crossing();
    b.place({ x: 2200, y: 2000 }, 'pitch', 20 * pm);
    const world = new LifeWorld();
    world.sync([{ key: 'place', tile, life: b.finish() }]);
    const life = worldTiles(world).get('place')!;
    const g = life.gatherers[0]!;
    clear(life);
    Object.assign(g, { x: 2000, y: 2000, hx: 1, hy: 0, tx: 2200, ty: 2000, pause: 40 });
    life.gatherers.push(g);
    world.visible(18, activityLevels(1), center);
    for (let i = 0; !life.canIdle(g) && i < 100; i++) {
      const x = g.x;
      world.step(0.1, undefined, 18);
      expect(g.x).toBeGreaterThan(x);
      expect(g.pause).toBe(0);
    }
    expect(life.canIdle(g)).toBe(true);
    for (let i = 0; g.pause <= 0 && i < 1000; i++) world.step(0.1, undefined, 18);
    expect(g.pause).toBeGreaterThan(0);
    expect(life.canIdle(g)).toBe(true);
  });

  it('retains an off-road gathering target when a new target falls on the carriageway', () => {
    const b = crossing();
    b.place({ x: 2100, y: 2000 }, 'pitch', 30 * pm);
    const life = new TileLife(tile, b.finish(), 5);
    const g = life.gatherers[0]!;
    expect(g).toBeDefined();
    Object.assign(g, { cx: 2000, cy: 2000, outer: 1, tx: g.x, ty: g.y });
    const before = [g.tx, g.ty, g.sign];
    const internals = life as unknown as {
      nextTarget: (g: (typeof life.gatherers)[number]) => void;
    };
    internals.nextTarget(g);
    expect([g.tx, g.ty, g.sign]).toEqual(before);
  });

  it('replays deterministically at 30, 60, and 120 Hz', () => {
    for (const hz of [30, 60, 120]) {
      const a = setup(),
        b = setup();
      a.life.movers.push(mover('cat'));
      b.life.movers.push(mover('cat'));
      for (let i = 0; i < hz * 3; i++) {
        a.world.step(1 / hz, undefined, 18);
        b.world.step(1 / hz, undefined, 18);
      }
      expect(a.life.movers).toEqual(b.life.movers);
    }
  });
});

describe('resting pose selection', () => {
  it('uses seated bench figures and keeps open umbrellas', () => {
    const b = new LifeBuilder();
    b.place({ x: 2000, y: 2000 }, 'bench', 0);
    const world = new LifeWorld();
    world.sync([{ key: 'bench', tile, life: b.finish() }]);
    const life = worldTiles(world).get('bench')!;
    expect(life.gatherers.length).toBeGreaterThan(0);
    for (const g of life.gatherers) g.walker.umbrella = 0.5;
    const figures = (rain: number) =>
      world
        .visible(18, activityLevels(1), center, { rain, sunAltitude: 0 })
        .flatMap((a) => a.people ?? [])
        .map((p) => p.figure);
    expect(figures(0)).toEqual(life.gatherers.map(() => 'seated'));
    expect(figures(1)).toEqual(life.gatherers.map(() => 'umbrella'));
  });

  it('uses the lying frame only for lying dogs and resumes walking after the pause', () => {
    const { world, life } = setup();
    const streams = life as unknown as { dogRng: () => number };
    streams.dogRng = () => 1;
    const m = mover('dog', 2200);
    Object.assign(m, { pause: 1, lying: true });
    life.movers.push(m);
    const frame = () =>
      world.visible(18, activityLevels(1), center).find((a) => a.kind === 'dog')!.flap;
    expect(frame()).toBe(2);
    m.lying = false;
    expect(frame()).toBe(0);
    m.lying = true;
    for (let i = 0; i < 12; i++) world.step(0.1, undefined, 18);
    expect(m.lying).toBe(false);
    expect(frame()).toBeLessThan(2);
  });
});
