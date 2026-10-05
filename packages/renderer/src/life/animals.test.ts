import { describe, expect, it } from 'vitest';
import { lngLatToTile, metersPerUnit, tileToLngLat } from '../raster/geometry';
import { themes } from '../theme';
import { activityLevels, CAT, spawnRules, usableLines } from './config';
import { packLife, type LifeGrid } from './draw';
import { LifeBuilder, LifeLine, type LifeGeometry } from './geometry';
import { animalSize, bodiesOverlap } from './occupancy';
import { LifeWorld, TileLife, type Mover, type VisibleAgent } from './simulate';
import { signalState } from './signals';
import { stripRing } from './terrain';
import { worldTiles } from './testing/scenarios';

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);
const center = tileToLngLat(tile, { x: 2048, y: 2000 });
const kinds = ['dog', 'cat'] as const;
const line = (b: LifeBuilder, kind: LifeLine, y: number, width = 0) =>
  b.line(
    [
      { x: 0, y },
      { x: 4095, y },
    ],
    kind,
    width,
  );
const setup = (geo: LifeGeometry) => {
  const world = new LifeWorld();
  world.sync([{ key: 'animals', tile, life: geo }]);
  const life = worldTiles(world).get('animals')!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  // Disable random pauses and turns to isolate terrain and collision behavior.
  const streams = life as unknown as { dogRng: () => number; catRng: () => number };
  streams.dogRng = streams.catRng = () => 1;
  world.visible(18, activityLevels(1), center);
  return { world, life };
};
const animal = (kind: 'dog' | 'cat', x = 1000, y = 2000): Mover => ({
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
  y,
  hx: 1,
  hy: 0,
  walked: 0,
});

describe('animal walking routes', () => {
  it('shares permitted walking lines and has no road spawn rules', () => {
    for (const kind of kinds) {
      expect(usableLines[kind]).toBe(usableLines.person);
      for (const road of [LifeLine.roadMajor, LifeLine.roadMid, LifeLine.roadMinor]) {
        expect(spawnRules[road].some((r) => r.kind === kind)).toBe(false);
        const b = new LifeBuilder();
        line(b, road, 2000, 10);
        for (const seed of [1, 7, 42])
          expect(new TileLife(tile, b.finish(), seed).movers.some((m) => m.kind === kind)).toBe(
            false,
          );
      }
    }
  });

  it('spawns safely and deterministically on mapped sidewalk paths and plaza routes', () => {
    const b = new LifeBuilder();
    line(b, LifeLine.roadMinor, 2000, 6);
    line(b, LifeLine.path, 2000 + 4 * pm, 2);
    line(b, LifeLine.plaza, 2600);
    const geo = b.finish();
    const worlds = [new LifeWorld(), new LifeWorld()];
    for (const world of worlds) world.sync([{ key: 'safe-animals', tile, life: geo }]);
    const lives = worlds.map((world) => worldTiles(world).get('safe-animals')!);
    expect(lives[0]!.movers).toEqual(lives[1]!.movers);
    for (const kind of kinds) {
      const animals = lives[0]!.movers.filter((m) => m.kind === kind);
      expect(animals.length).toBeGreaterThan(0);
      for (const m of animals) {
        expect(usableLines[kind]).toContain(geo.kinds[m.line]);
        expect(lives[0]!.roadTerrain.access.allows(lives[0]!.groundBodies(m))).toBe(true);
        expect(lives[0]!.groundBodies(m)[0]).toMatchObject(animalSize(kind));
      }
    }
    expect(lives[0]!.movers.filter((m) => m.kind === 'cat').length).toBeLessThanOrEqual(
      CAT.maxPerTile,
    );
  });

  for (const kind of kinds) {
    it(`${kind} crosses only within crossing footprints`, () => {
      for (const crossing of [false, true]) {
        const b = new LifeBuilder();
        line(b, LifeLine.roadMinor, 2000, 6);
        b.line(
          [
            { x: 1200, y: 1800 },
            { x: 1200, y: 2000 },
            { x: 1200, y: 2300 },
          ],
          LifeLine.path,
          2,
        );
        if (crossing)
          b.area('crossing', [
            stripRing({ x: 1200 - 1.5 * pm, y: 2000 }, { x: 1200 + 1.5 * pm, y: 2000 }, 3 * pm),
          ]);
        const { world, life } = setup(b.finish());
        const m = animal(kind, 1200, 1800);
        Object.assign(m, { line: 1, from: 2, d: 0, hx: 0, hy: 1 });
        life.movers.push(m);
        let crossed = false;
        for (let i = 0; i < 500; i++) {
          world.step(0.1, undefined, 18);
          crossed ||= m.y > 2000 + 3 * pm;
          expect(life.roadTerrain.access.allows(life.groundBodies(m))).toBe(true);
          expect(m.line).toBe(1);
        }
        expect(crossed).toBe(crossing);
      }
    });

    it(`${kind} turns back instead of taking a road at a shared walking-line endpoint`, () => {
      const b = new LifeBuilder();
      b.line(
        [
          { x: 1000, y: 2000 },
          { x: 1200, y: 2000 },
        ],
        LifeLine.path,
      );
      b.line(
        [
          { x: 1200, y: 2000 },
          { x: 1600, y: 2000 },
        ],
        LifeLine.roadMinor,
        6,
      );
      const life = new TileLife(tile, b.finish(), 1);
      life.movers.length = 0;
      life.scenes.sites.length = 0;
      const streams = life as unknown as { dogRng: () => number; catRng: () => number };
      streams.dogRng = streams.catRng = () => 0.99;
      const m = animal(kind, 1195);
      m.d = 195;
      m.speed = 200;
      life.movers.push(m);
      // Isolate line selection from footprint admission at the end of the path.
      life.step(0.1, undefined, undefined, undefined, undefined, () => true);
      expect(m.line).toBe(0);
      expect(m.dir).toBe(-1);
      expect(m.x).toBeLessThan(1200);
    });

    it(`${kind} waits at a pedestrian signal and clears a crossing once inside`, () => {
      const b = new LifeBuilder();
      line(b, LifeLine.path, 2000, 2);
      const geo = { ...b.finish(), signals: Float32Array.from([2048, 2000, 8, 90, 0, 1]) };
      const life = new TileLife(tile, geo, 1);
      life.movers.length = life.stalls.length = life.gatherers.length = 0;
      life.scenes.sites.length = 0;
      const streams = life as unknown as { dogRng: () => number; catRng: () => number };
      streams.dogRng = streams.catRng = () => 1;
      const signal = life.signals.signals[0]!;
      let red = 0;
      while (signalState(signal.seed, red).walkA) red++;
      const m = animal(kind, 2048 - 10 * pm);
      life.movers.push(m);
      for (let i = 0; i < 30; i++)
        life.step(0.1, undefined, undefined, undefined, { rain: 0, clock: red });
      expect(m.x).toBeCloseTo(2048 - 8.5 * pm);
      let green = red;
      while (!signalState(signal.seed, green).walkA || signalState(signal.seed, green).left < 10)
        green++;
      for (let i = 0; i < 10; i++)
        life.step(0.1, undefined, undefined, undefined, { rain: 0, clock: green });
      const inside = m.x;
      life.step(0.1, undefined, undefined, undefined, { rain: 0, clock: red });
      expect(m.x).toBeGreaterThan(inside);
    });

    it(`${kind} cannot tunnel through a building or water and keeps its gait still when blocked`, () => {
      for (const water of [false, true]) {
        const b = new LifeBuilder();
        line(b, LifeLine.path, 2000, 1);
        b.area('blocked', [stripRing({ x: 1200, y: 1900 }, { x: 1200, y: 2100 }, 2 * pm)], water);
        const { world, life } = setup(b.finish());
        const m = animal(kind);
        m.speed = 100 * pm;
        life.movers.push(m);
        for (let i = 0; i < 60; i++) world.step(0.1, undefined, 18);
        expect(m.x).toBeLessThan(1200 - 2 * pm);
        m.pause = 0;
        const before = m.walked;
        world.step(0.1, undefined, 18);
        if (m.waiting) expect(m.walked).toBe(before);
      }
    });

    it(`${kind} yields to a parked vehicle without overlap`, () => {
      const b = new LifeBuilder();
      line(b, LifeLine.path, 2000, 1);
      const { world, life } = setup(b.finish());
      const m = animal(kind);
      life.movers.push(m);
      const parked = { x: 1200, y: 2000, hx: 1, hy: 0, vehicle: 'car' as const, paint: 0 };
      life.parked.push(parked);
      const body = { ...parked, x: parked.x / pm, y: parked.y / pm, length: 4.4, width: 1.8 };
      for (let i = 0; i < 200; i++) {
        world.step(0.1, undefined, 18);
        expect(bodiesOverlap(life.groundBodies(m)[0]!, body, 0)).toBe(false);
      }
      expect(m.x).toBeLessThan(parked.x);
      expect(m.walked).toBeLessThan(40);
    });
  }

  it('uses loaded neighboring road footprints for animals and their coarse drawing cells', () => {
    const b = new LifeBuilder();
    line(b, LifeLine.path, 2000);
    const { world, life } = setup(b.finish());
    const neighbor = { ...tile, x: tile.x + 1 };
    const n = new LifeBuilder();
    n.line(
      [
        { x: -100, y: 1800 },
        { x: -100, y: 2200 },
      ],
      LifeLine.roadMinor,
      6,
    );
    world.sync([
      { key: 'animals', tile, life: life.geo },
      { key: 'neighbor', tile: neighbor, life: n.finish() },
    ]);
    const neighborLife = worldTiles(world).get('neighbor')!;
    neighborLife.movers.length = 0;
    const guard = world.groundCellGuard((lng, lat) => {
      const p = lngLatToTile(tile, lng, lat);
      return [p.x / pm, p.y / pm];
    })!;
    for (const kind of kinds) {
      const m = animal(kind, 3900);
      life.movers.splice(0, life.movers.length, m);
      for (let i = 0; i < 120; i++) world.step(0.1, undefined, 18);
      expect(m.x).toBeLessThan(3996 - 3 * pm);
      expect(
        guard(
          { kind, lng: center[0], lat: center[1], flap: 0 },
          Math.floor(3996 / pm),
          Math.floor(2000 / pm),
        ),
      ).toBe(false);
    }
  });
});

describe('whole animal drawing', () => {
  const grid: LifeGrid = {
    cols: 40,
    rows: 30,
    cellWidth: 10,
    cellHeight: 18,
    toCell: (x, y) => [x, y],
  };
  for (const kind of kinds)
    for (const scale of [0.5, 12])
      it(`keeps the complete ${kind} at scale ${scale} within permitted cells`, () => {
        const m: VisibleAgent = {
          kind,
          lng: 20,
          lat: 15,
          ahead: [20 + scale, 15],
          flap: kind === 'cat' ? 3 : 2,
        };
        const out = new Uint8Array(40 * 30 * 4);
        expect(packLife(out, grid, [m], themes.dark, () => 1)).toBe(1);
        expect(out.some((v) => v !== 0)).toBe(true);
        expect(
          packLife(
            out,
            { ...grid, allowsGroundCell: (_m, col) => col < 20 },
            [m],
            themes.dark,
            () => 1,
          ),
        ).toBe(scale === 0.5 ? 1 : 0);
        if (scale === 0.5) {
          for (let cell = 0; cell < grid.cols * grid.rows; cell++)
            if (out[cell * 4 + 2]) expect(cell % grid.cols).toBeLessThan(20);
        }
        expect(
          packLife(out, { ...grid, allowsGroundCell: () => false }, [m], themes.dark, () => 1),
        ).toBe(0);
        expect(out.every((v) => v === 0)).toBe(true);
      });
});
