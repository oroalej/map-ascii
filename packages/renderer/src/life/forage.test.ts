import { describe, expect, it, vi } from 'vitest';
import type { SeasonalDisplayRecord } from '@atlas/shared';
import { lngLatToTile, metersPerUnit, tileToLngLat } from '../raster/geometry';
import { BIRD_SPECIES, BirdPose, Habitat, type BirdSpecies } from './birds';
import { FORAGE, type AgentKind } from './config';
import { LifeBuilder, LifeLine } from './geometry';
import {
  FORAGE_SPECIES,
  forageable,
  forageMovement,
  forageSpot,
  prepareForageTerrain,
  prepareForageTerrainSteps,
  rebaseForagers,
  stepForager,
  shoreDistance,
  type GroundForager,
} from './forage';
import { random } from './random';
import { complete } from './cooperate';
import { pointInside, PolygonIndex } from './occupancy';
import { LifeWorld, TileLife, trainLength, type Flock, type Mover } from './simulate';
import { worldTiles } from './testing/scenarios';

const tile = { z: 16, x: 55192, y: 30266 };
const perMeter = 1 / metersPerUnit(tile);
const point = (x: number, y: number) => ({ x: 2048 + x * perMeter, y: 2048 + y * perMeter });
const ring = (x0: number, y0: number, x1: number, y1: number) => [
  point(x0, y0),
  point(x1, y0),
  point(x1, y1),
  point(x0, y1),
  point(x0, y0),
];
const ground = (): GroundForager => ({ gx: 0, gy: 0, tx: 0, ty: 0, face: 0, wait: 0 });

describe('foraging terrain', () => {
  it('reuses shore query scratch while preserving order and deduplicating long edges', () => {
    const builder = new LifeBuilder();
    builder.area('blocked', [ring(-400, -400, 400, 400)], true);
    const terrain = prepareForageTerrain(builder.finish(), perMeter);
    const a = point(-405, -405),
      b = point(405, 405);
    const query = () =>
      terrain.shoreIndex.nearby(a.x / perMeter, a.y / perMeter, b.x / perMeter, b.y / perMeter);
    const scratch = query();
    const first = [...scratch];
    expect(first).toHaveLength(4);
    expect(new Set(first).size).toBe(first.length);
    expect(terrain.shoreIndex.nearby(1000, 1000, 1001, 1001)).toBe(scratch);
    expect(scratch.size).toBe(0);
    expect(query()).toBe(scratch);
    expect([...scratch]).toEqual(first);
    const bank = point(400, 0);
    const right = [
      ...terrain.shoreIndex.nearby(
        bank.x / perMeter - 1,
        bank.y / perMeter - 1,
        bank.x / perMeter + 1,
        bank.y / perMeter + 1,
      ),
    ];
    expect(right).toHaveLength(1);
    expect([...query()]).toEqual(first);
    expect(right).toHaveLength(1);
  });

  it('matches indexed water membership for holes and overlaps while narrowing long-ring work', () => {
    const builder = new LifeBuilder();
    builder.area('blocked', [ring(-30, -20, 10, 20), ring(-4, -4, 4, 4)], true);
    builder.area('blocked', [ring(0, -10, 30, 10)], true);
    const terrain = prepareForageTerrain(builder.finish(), perMeter);
    for (let x = -35; x <= 35; x += 5)
      for (let y = -25; y <= 25; y += 5) {
        const p = point(x, y);
        const metric = { x: p.x / perMeter, y: p.y / perMeter };
        expect(terrain.membership.contains(metric)).toBe(
          terrain.water.polygons.some((polygon) => pointInside(metric, polygon)),
        );
      }
    const long = Array.from({ length: 2048 }, (_, i) =>
      point(200 * Math.cos((i * Math.PI) / 1024), 200 * Math.sin((i * Math.PI) / 1024)),
    );
    long.push(long[0]!);
    const large = new LifeBuilder();
    large.area('blocked', [long], true);
    const indexed = prepareForageTerrain(large.finish(), perMeter);
    for (const [x, y] of [
      [0, 0],
      [195, 0],
      [210, 0],
      [0, 150],
      [0, -150],
    ] as const) {
      const p = point(x, y);
      const metric = { x: p.x / perMeter, y: p.y / perMeter };
      expect(indexed.membership.contains(metric)).toBe(
        pointInside(metric, indexed.water.polygons[0]!),
      );
      expect(indexed.membership.candidates(metric.y)).toBeLessThan(long.length / 10);
    }
  });
  it('keeps only exposed union boundaries, including partially shared and intersecting edges', () => {
    for (const overlap of [false, true]) {
      const builder = new LifeBuilder();
      builder.area('blocked', [ring(-30, -20, overlap ? 10 : 0, 20)], true);
      builder.area('blocked', [ring(overlap ? -10 : 0, -10, 30, 10)], true);
      const terrain = prepareForageTerrain(builder.finish(), perMeter);
      const seam = point(overlap ? 10 : 0, 0);
      expect(forageable('egret', Habitat.water, seam.x, seam.y, terrain, perMeter)).toBe(false);
      const exposed = point((overlap ? 10 : 0) - 0.5, 15);
      expect(
        shoreDistance({ x: exposed.x / perMeter, y: exposed.y / perMeter }, terrain),
      ).toBeCloseTo(-0.5);
      expect(forageable('egret', Habitat.water, exposed.x, exposed.y, terrain, perMeter)).toBe(
        true,
      );
      const spot = forageSpot('egret', Habitat.water, seam, terrain, perMeter, random(1));
      expect(spot).toBeDefined();
      expect(Math.hypot(spot!.x - seam.x, spot!.y - seam.y) / perMeter).toBeGreaterThanOrEqual(10);
    }
  });

  it('cooperatively prepares and caches terrain before the first landing step', () => {
    const builder = new LifeBuilder();
    builder.area('blocked', [ring(-100, -10, 100, 10)], true);
    builder.roost(point(0, 20), Habitat.park);
    const geo = builder.finish();
    const work = prepareForageTerrainSteps(geo, perMeter);
    expect(work.next().done).toBe(false);
    const terrain = complete(work);
    const cached = prepareForageTerrainSteps(geo, perMeter).next();
    expect(cached.done).toBe(true);
    expect(cached.value).toBe(terrain);
    expect(prepareForageTerrain(geo, perMeter)).toBe(terrain);

    const fresh = new LifeBuilder();
    fresh.area('blocked', [ring(20, 20, 25, 25)]);
    const add = vi.spyOn(PolygonIndex.prototype, 'addSteps');
    try {
      const { life, flock, geo } = flockFixture('pigeon', fresh);
      expect(prepareForageTerrainSteps(geo, perMeter).next().done).toBe(true);
      expect(add).toHaveBeenCalled();
      add.mockClear();
      flock.stay = 1000;
      life.step(0.1, undefined, onlyBirds, undefined, { rain: 1 });
      expect(life.forageChecks).toBeGreaterThan(0);
      expect(add).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
    }
  });

  it('matches exact shore distances within bounded searches and uses one query for point moves', () => {
    const builder = new LifeBuilder();
    builder.area('blocked', [ring(-100, -10, 100, 10), ring(-4, -4, 4, 4)], true);
    builder.area('blocked', [ring(50, 50, 80, 80)], true);
    const terrain = prepareForageTerrain(builder.finish(), perMeter);
    const nearby = vi.spyOn(terrain.shoreIndex, 'nearby');
    for (let x = -15; x <= 15; x += 3)
      for (let y = -15; y <= 15; y += 3) {
        const p = point(x, y);
        const metric = { x: p.x / perMeter, y: p.y / perMeter };
        const exact = shoreDistance(metric, terrain);
        const bounded = shoreDistance(metric, terrain, 3);
        if (Math.abs(exact) <= 3) expect(bounded).toBeCloseTo(exact);
        else expect(bounded).toBe(Infinity);
      }
    expect(nearby).toHaveBeenCalled();
    nearby.mockRestore();
    const p = point(0, 9);
    const water = vi.spyOn(terrain.membership, 'contains');
    expect(forageable('egret', Habitat.water, p.x, p.y, terrain, perMeter)).toBe(true);
    expect(water).toHaveBeenCalledTimes(1);
    water.mockClear();
    expect(forageMovement('egret', Habitat.water, p, p, terrain, perMeter)).toBe(true);
    expect(water).toHaveBeenCalledTimes(1);
    water.mockRestore();
  });

  it('uses metric blocked, water and full carriageway footprints, preserving holes and cache scale', () => {
    const builder = new LifeBuilder();
    builder.area('blocked', [ring(-100, -10, 100, 10), ring(-4, -4, 4, 4)], true);
    builder.area('blocked', [ring(20, 20, 30, 30)]);
    builder.line([point(40, -50), point(40, 50)], LifeLine.roadMinor, 4);
    builder.area('crossing', [ring(37, 20, 43, 24)]);
    const geo = builder.finish(),
      terrain = prepareForageTerrain(geo, perMeter);
    const ok = (species: 'maya' | 'pigeon' | 'egret', x: number, y: number) => {
      const p = point(x, y);
      return forageable(species, Habitat.water, p.x, p.y, terrain, perMeter);
    };
    expect(prepareForageTerrain(geo, perMeter)).toBe(terrain);
    expect(prepareForageTerrain(geo, perMeter * 2)).not.toBe(terrain);
    for (const species of ['maya', 'pigeon'] as const) {
      expect(ok(species, 25, 25)).toBe(false);
      expect(ok(species, 40, 22)).toBe(false);
      expect(ok(species, 0, 8)).toBe(false);
      expect(ok(species, 0, 0)).toBe(true);
      expect(ok(species, 10, 30)).toBe(true);
    }
    expect(ok('egret', 0, 9)).toBe(true);
    expect(ok('egret', 0, 12)).toBe(true);
    expect(ok('egret', 0, 7)).toBe(false);
    expect(ok('egret', 0, 14)).toBe(false);
    expect(ok('egret', 3, 0)).toBe(true);
    expect(ok('egret', 0, 0)).toBe(false);
    expect(forageable('pigeon', Habitat.park, -1, 0, terrain, perMeter)).toBe(false);
  });

  it('finds segment interiors when every water vertex is beyond reach, and prefers saved points', () => {
    const builder = new LifeBuilder();
    builder.area('blocked', [ring(-150, -15, 150, 15)], true);
    const terrain = prepareForageTerrain(builder.finish(), perMeter);
    const spot = forageSpot('egret', Habitat.water, point(0, 0), terrain, perMeter, random(1));
    expect(spot).toBeDefined();
    expect(Math.hypot(spot!.x - 2048, spot!.y - 2048) / perMeter).toBeCloseTo(15);
    const check = vi.fn(() => true);
    expect(
      forageSpot('egret', Habitat.water, point(0, 0), terrain, perMeter, random(1), check, spot),
    ).toBe(spot);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('bounds failed spot searches and rejects intervening obstacles between safe endpoints', () => {
    for (const kind of ['road', 'building', 'water'] as const) {
      const builder = new LifeBuilder();
      if (kind === 'road') builder.line([point(0, -10), point(0, 10)], LifeLine.roadMinor, 0.2);
      else builder.area('blocked', [ring(-0.1, -10, 0.1, 10)], kind === 'water');
      const terrain = prepareForageTerrain(builder.finish(), perMeter);
      const a = point(-1, 0),
        b = point(1, 0);
      expect(forageable('pigeon', Habitat.park, a.x, a.y, terrain, perMeter)).toBe(true);
      expect(forageable('pigeon', Habitat.park, b.x, b.y, terrain, perMeter)).toBe(true);
      expect(forageMovement('pigeon', Habitat.park, a, b, terrain, perMeter)).toBe(false);
    }
    const terrain = prepareForageTerrain(new LifeBuilder().finish(), perMeter);
    const check = vi.fn(() => false);
    expect(
      forageSpot('pigeon', Habitat.park, point(0, 0), terrain, perMeter, random(3), check),
    ).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(8);
  });

  it('certifies egret movements entirely within the signed shore band', () => {
    const builder = new LifeBuilder();
    builder.area('blocked', [ring(-100, -10, 100, 10)], true);
    const terrain = prepareForageTerrain(builder.finish(), perMeter);
    expect(
      forageMovement('egret', Habitat.water, point(0, 9.5), point(1, 9.5), terrain, perMeter),
    ).toBe(true);
    expect(
      forageMovement('egret', Habitat.water, point(0, 8.6), point(1.2, 8.6), terrain, perMeter),
    ).toBe(false);
  });
});

describe('ground gaits', () => {
  it('provides a forage specification for every ground-capable species', () => {
    for (const species of Object.keys(BIRD_SPECIES) as BirdSpecies[])
      if (BIRD_SPECIES[species].ground > 0) expect(FORAGE_SPECIES[species]).toBeDefined();
  });
  it('converts distances and speeds to tile units, validating once before interpolation', () => {
    const bird = ground(),
      ok = vi.fn(() => true);
    const context = { ...point(0, 0), lx: 2048, ly: 2048, perMeter, ok };
    const spec = { ...FORAGE_SPECIES.pigeon!, step: [0.8, 0.8] as const };
    for (let i = 0; i < 4; i++) stepForager(bird, spec, 0.1, () => 0.5, context);
    expect(bird.gx / perMeter).toBeCloseTo(0.2);
    expect(bird.tx / perMeter).toBeCloseTo(0.8);
    expect(ok).toHaveBeenCalledTimes(1);
    const hop = ground();
    stepForager(hop, { ...FORAGE_SPECIES.maya!, step: [0.4, 0.4] }, 0.1, () => 0.5, context);
    expect(hop.gx / perMeter).toBeCloseTo(0.4);
    expect(hop.wait).toBeGreaterThan(0);
  });

  it('rejects a proposed step outside the fixed patch disk', () => {
    const bird = ground(),
      ok = vi.fn(() => true);
    stepForager(bird, { ...FORAGE_SPECIES.pigeon!, patch: 0.1, step: [0.8, 0.8] }, 0.1, () => 0.5, {
      ...point(0, 0),
      lx: 2048,
      ly: 2048,
      perMeter,
      ok,
    });
    expect(bird.gx).toBe(0);
    expect(bird.tx).toBe(0);
    expect(bird.wait).toBeGreaterThan(0);
    expect(ok).not.toHaveBeenCalled();
  });

  it('rebases current offsets and unfinished targets without changing absolute positions', () => {
    const flock = { ...point(0, 0), lx: 2048, ly: 2048 };
    const bird = { ...ground(), gx: perMeter, tx: 2 * perMeter };
    const position = flock.x + bird.gx,
      target = flock.x + bird.tx;
    rebaseForagers(flock, [bird], 6 * perMeter);
    expect(flock.x).toBeCloseTo(2048 + perMeter);
    expect(flock.x + bird.gx).toBeCloseTo(position);
    expect(flock.x + bird.tx).toBeCloseTo(target);
    expect(flock.lx).toBe(2048);
  });
});

const onlyBirds = (kind: AgentKind) => kind === 'bird';
const disturb = (life: TileLife, flock: Flock) =>
  life.movers.push({
    kind: 'person',
    line: 0,
    from: 0,
    dir: 1,
    d: 0,
    speed: 1,
    paint: 0,
    lane: 0,
    pause: 0,
    rank: 0,
    x: flock.x,
    y: flock.y,
    hx: 1,
    hy: 0,
  });
function flockFixture(
  species: BirdSpecies,
  builder = new LifeBuilder(),
  habitat: Habitat = Habitat.park,
  seed = 1,
) {
  builder.roost(point(0, 0), habitat);
  const geo = builder.finish(),
    life = new TileLife(tile, geo, seed);
  const flock = life.flocks[0]!;
  life.flocks.splice(0, life.flocks.length, flock);
  life.movers.length = life.gatherers.length = 0;
  Object.assign(flock, {
    species,
    rank: 0,
    stay: 0,
    perch: -1,
    perched: false,
    landed: false,
    landing: false,
  });
  return { life, flock, geo };
}
function land(life: TileLife, flock: Flock) {
  for (let i = 0; i < 3000 && !flock.landed; i++) {
    if (!flock.landing) flock.stay = 0;
    life.step(0.1, undefined, onlyBirds);
  }
  expect(flock.landed).toBe(true);
}
const absolute = (flock: Flock) =>
  flock.birds.map((bird) => [flock.x + bird.gx!, flock.y + bird.gy!, bird.face]);
const groundState = (flock: Flock) => ({
  stay: flock.stay,
  bout: flock.bout,
  x: flock.x,
  y: flock.y,
  birds: flock.birds.map(({ gx, gy, tx, ty, face, wait }) => ({ gx, gy, tx, ty, face, wait })),
});

describe('foraging flocks', () => {
  it('refreshes movement clearance and patch anchors between water and park flocks', () => {
    const builder = new LifeBuilder();
    builder.area('blocked', [ring(-50, -12, 50, 12)], true);
    builder.roost(point(0, 0), Habitat.water);
    builder.roost(point(60, 50), Habitat.park);
    const geo = builder.finish(),
      life = new TileLife(tile, geo, 19);
    const flocks = life.flocks.slice(0, 2);
    expect(flocks).toHaveLength(2);
    life.flocks.splice(0, life.flocks.length, ...flocks);
    life.movers.length = life.gatherers.length = 0;
    flocks.forEach((flock, i) => {
      const at = i === 0 ? point(0, 11) : point(60, 50);
      Object.assign(flock, {
        ...at,
        lx: at.x,
        ly: at.y,
        roost: i,
        species: i === 0 ? 'egret' : 'pigeon',
        rank: 0,
        stay: 1000,
        bout: 100,
        feeding: true,
        landed: true,
        landing: false,
        perched: false,
        perch: -1,
        scatter: 0,
      });
      flock.birds.splice(1);
      Object.assign(flock.birds[0]!, ground());
    });
    const rng = vi
      .spyOn(life as unknown as { forageRng: () => number }, 'forageRng')
      .mockReturnValue(0.5);
    const terrain = prepareForageTerrain(geo, perMeter);
    try {
      for (let i = 0; i < 4; i++) {
        life.flocks.reverse();
        for (const flock of flocks) {
          const bird = flock.birds[0]!;
          bird.tx = bird.gx;
          bird.ty = bird.gy;
          bird.face = bird.wait = 0;
        }
        const before = life.forageChecks;
        life.step(0.1, undefined, onlyBirds);
        expect(life.forageChecks - before).toBe(2);
        for (const flock of flocks) {
          const bird = flock.birds[0]!;
          expect(bird.tx).toBeGreaterThan(bird.gx!);
          const target = { x: flock.x + bird.tx!, y: flock.y + bird.ty! };
          expect(Math.hypot(target.x - flock.lx, target.y - flock.ly) / perMeter).toBeLessThan(
            FORAGE_SPECIES[flock.species]!.patch,
          );
          expect(
            forageable(
              flock.species,
              flock.roost === 0 ? Habitat.water : Habitat.park,
              target.x,
              target.y,
              terrain,
              perMeter,
            ),
          ).toBe(true);
        }
      }
    } finally {
      rng.mockRestore();
    }
  });
  it('keeps destination rolls but skips discarded landing preparation on unsafe and walker flushes', () => {
    for (const unsafe of [false, true]) {
      const { life, flock } = flockFixture('pigeon');
      land(life, flock);
      const internal = life as unknown as {
        birdRng: () => number;
        prepareLanding: (flock: Flock) => boolean;
      };
      const rng = vi.spyOn(internal, 'birdRng').mockReturnValue(0);
      const prepare = vi.spyOn(internal, 'prepareLanding');
      try {
        const before = life.forageChecks;
        if (unsafe) life.setForageGuard(() => false);
        else {
          disturb(life, flock);
          life.step(0.001, undefined, onlyBirds);
        }
        expect(flock.landed || flock.landing).toBe(false);
        expect(flock.scatter).toBeGreaterThan(0);
        expect(rng).toHaveBeenCalledTimes(2);
        expect(prepare).not.toHaveBeenCalled();
        expect(life.forageChecks - before).toBe(unsafe ? flock.birds.length : 0);
      } finally {
        rng.mockRestore();
        prepare.mockRestore();
      }
    }
  });
  it('prepares a bounded five-egret layout along a valid bank in rain', () => {
    const builder = new LifeBuilder();
    builder.area('blocked', [ring(-150, -12, 150, 12)], true);
    builder.roost(point(0, 0), Habitat.water);
    const geo = builder.finish();
    const life = new TileLife(tile, geo, 10);
    const flock = life.flocks.find(
      (flock) => flock.species === 'egret' && flock.birds.length === 5,
    )!;
    expect(flock).toBeDefined();
    life.flocks.splice(0, life.flocks.length, flock);
    life.movers.length = life.gatherers.length = 0;
    Object.assign(flock, { rank: 0, stay: 1000, perch: -1, perched: false });
    life.step(0.1, undefined, onlyBirds, undefined, { rain: 1 });
    expect(flock.landing).toBe(true);
    expect(life.forageChecks).toBeLessThanOrEqual(FORAGE.attempts + 5 * (FORAGE.attempts + 1));
    for (let i = 0; i < 500 && !flock.landed; i++)
      life.step(0.1, undefined, onlyBirds, undefined, { rain: 1 });
    expect(flock.landed).toBe(true);
    const terrain = prepareForageTerrain(geo, perMeter);
    for (const bird of flock.birds) {
      expect(
        forageable(
          'egret',
          Habitat.water,
          flock.x + bird.gx!,
          flock.y + bird.gy!,
          terrain,
          perMeter,
        ),
      ).toBe(true);
      expect(
        Math.hypot(flock.x + bird.gx! - flock.lx, flock.y + bird.gy! - flock.ly),
      ).toBeLessThanOrEqual(FORAGE_SPECIES.egret!.patch * perMeter);
    }
  });
  it('lands every egret inside its band and every pigeon off a road, preserving bird identities', () => {
    for (const species of ['egret', 'pigeon'] as const) {
      const builder = new LifeBuilder();
      if (species === 'egret') builder.area('blocked', [ring(-150, -15, 150, 15)], true);
      else builder.line([point(-100, 0), point(100, 0)], LifeLine.roadMinor, 4);
      const habitat = species === 'egret' ? Habitat.water : Habitat.park;
      const { life, flock, geo } = flockFixture(species, builder, habitat);
      // Force an original spread which cannot safely land as-is.
      for (const bird of flock.birds) {
        bird.ox = 10 * perMeter;
        bird.oy = 0;
      }
      const identities = [...flock.birds];
      land(life, flock);
      const terrain = prepareForageTerrain(geo, perMeter);
      for (let i = 0; i < flock.birds.length; i++) {
        const bird = flock.birds[i]!;
        expect(bird).toBe(identities[i]);
        expect(
          forageable(species, habitat, flock.x + bird.gx!, flock.y + bird.gy!, terrain, perMeter),
        ).toBe(true);
        expect(
          Math.hypot(flock.x + bird.gx! - flock.lx, flock.y + bird.gy! - flock.ly),
        ).toBeLessThanOrEqual(FORAGE_SPECIES[species]!.patch * perMeter);
      }
      expect(flock.landingBlend).toBe(1);
      expect(flock.stay).toBeGreaterThanOrEqual(FORAGE.visit[0]);
    }
  });

  it('declines blocked landings for 300 seconds and bounds failed rain retries', () => {
    const builder = new LifeBuilder();
    builder.area('blocked', [ring(-300, -300, 300, 300)]);
    const { life, flock } = flockFixture('pigeon', builder);
    flock.stay = 1000;
    life.step(0.1, undefined, onlyBirds, undefined, { rain: 1 });
    const checks = life.forageChecks;
    expect(checks).toBeGreaterThan(0);
    expect(checks).toBeLessThanOrEqual(FORAGE.attempts);
    for (let i = 0; i < 3000; i++) life.step(0.1, undefined, onlyBirds, undefined, { rain: 1 });
    expect(life.forageChecks).toBe(checks);
    expect(flock.landed).toBe(false);
    for (let i = 0; i < 3000; i++) {
      flock.stay = 0;
      life.step(0.1, undefined, onlyBirds);
      expect(flock.landed).toBe(false);
      expect(flock.landing).toBe(false);
    }
    expect(life.forageChecks).toBeGreaterThan(checks + FORAGE.attempts);
  });

  it('alternates feeding and rest, keeps every step safe, expires visits, and bounds total checks', () => {
    const { life, flock, geo } = flockFixture('pigeon');
    land(life, flock);
    const terrain = prepareForageTerrain(geo, perMeter),
      start = life.forageChecks;
    let transitions = 0,
      moved = false,
      expired = false;
    for (let i = 0; i < 3000; i++) {
      const before = absolute(flock),
        landed = flock.landed,
        feeding = flock.feeding;
      life.step(0.1, undefined, onlyBirds);
      if (landed && !flock.landed) expired = true;
      if (!landed || !flock.landed) continue;
      if (feeding !== flock.feeding) transitions++;
      if (!feeding && !flock.feeding) expect(absolute(flock)).toEqual(before);
      if (feeding && flock.feeding && JSON.stringify(absolute(flock)) !== JSON.stringify(before))
        moved = true;
      for (const bird of flock.birds) {
        const x = flock.x + bird.gx!,
          y = flock.y + bird.gy!;
        expect(forageable('pigeon', Habitat.park, x, y, terrain, perMeter)).toBe(true);
        expect(Math.hypot(x - flock.lx, y - flock.ly)).toBeLessThanOrEqual(
          FORAGE_SPECIES.pigeon!.patch * perMeter + 1e-8,
        );
      }
    }
    expect(transitions).toBeGreaterThanOrEqual(2);
    expect(moved).toBe(true);
    expect(expired).toBe(true);
    expect((life.forageChecks - start) / (300 * flock.birds.length)).toBeLessThanOrEqual(2);
  });

  it('gives tree rests their full duration and returns to the same patch despite nearly expired visits', () => {
    const builder = new LifeBuilder();
    builder.perch(point(30, 0));
    const { life, flock } = flockFixture('maya', builder);
    land(life, flock);
    const anchor = [flock.lx, flock.ly],
      identities = [...flock.birds];
    // Repeat a forced phase boundary until this seeded flock chooses the nearby tree.
    for (let i = 0; i < 20 && flock.landed; i++) {
      flock.feeding = true;
      flock.bout = 0;
      flock.stay = 0.2;
      life.step(0.1, undefined, onlyBirds);
    }
    expect(flock.home).toBe(0);
    expect(flock.landed).toBe(false);
    const travelStay = flock.stay;
    for (let i = 0; i < 100 && !flock.perched; i++) {
      life.step(0.1, undefined, onlyBirds);
      if (!flock.perched) expect(flock.stay).toBe(travelStay);
    }
    expect(flock.perched).toBe(true);
    expect(flock.stay).toBeGreaterThanOrEqual(FORAGE_SPECIES.maya!.rest[0]);
    expect(flock.stay).toBeLessThanOrEqual(FORAGE_SPECIES.maya!.rest[1]);
    for (let i = 0; i < 400 && !flock.landed; i++) life.step(0.1, undefined, onlyBirds);
    expect(flock.landed).toBe(true);
    expect([flock.lx, flock.ly]).toEqual(anchor);
    expect(flock).toMatchObject({ home: -1, perch: -1, roost: 0 });
    flock.birds.forEach((bird, i) => expect(bird).toBe(identities[i]));
  });

  it('clears return state on flush and on an unsafe saved patch', () => {
    for (const flushed of [true, false]) {
      const builder = new LifeBuilder();
      builder.perch(point(30, 0));
      builder.area('blocked', [ring(-20, -20, 20, 20)]);
      const { life, flock } = flockFixture('maya', builder);
      Object.assign(flock, {
        perched: true,
        perch: 0,
        home: 0,
        lx: 2048,
        ly: 2048,
        x: point(30, 0).x,
        y: 2048,
        stay: 0,
      });
      life.step(0.1, () => (flushed ? 1 : 0), onlyBirds);
      expect(flock.home).toBe(-1);
      expect(flock.landed).toBe(false);
      expect(flock.landing).toBe(false);
      if (!flushed) expect(life.forageChecks).toBeGreaterThanOrEqual(FORAGE.attempts);
      if (flushed) expect(flock.scatter).toBeGreaterThan(0);
    }
  });

  it('can decline a tree return even when the saved patch is suitable', () => {
    const builder = new LifeBuilder();
    builder.perch(point(30, 0));
    const { life, flock } = flockFixture('maya', builder, Habitat.park, 2);
    Object.assign(flock, {
      perched: true,
      perch: 0,
      home: 0,
      lx: 2048,
      ly: 2048,
      x: point(30, 0).x,
      y: 2048,
      stay: 0,
    });
    life.step(0.1, undefined, onlyBirds);
    expect(flock.home).toBe(-1);
    expect(flock.landing && flock.lx === 2048 && flock.ly === 2048).toBe(false);
  });

  it('freezes all ground state in rain, flushes for a walker, and never lands swallows or bats', () => {
    const { life, flock } = flockFixture('pigeon');
    land(life, flock);
    const before = groundState(flock);
    for (let i = 0; i < 30; i++) life.step(0.1, undefined, onlyBirds, undefined, { rain: 1 });
    expect(groundState(flock)).toEqual(before);
    life.movers.push({
      kind: 'person',
      line: 0,
      from: 0,
      dir: 1,
      d: 0,
      speed: 1,
      paint: 0,
      lane: 0,
      pause: 0,
      rank: 0,
      x: flock.x,
      y: flock.y,
      hx: 1,
      hy: 0,
    });
    life.step(0.1, undefined, onlyBirds);
    expect(flock).toMatchObject({ landed: false, feeding: false, home: -1 });
    expect(flock.scatter).toBeGreaterThan(0);
    for (const species of ['swallow', 'bat'] as const) {
      const f = flockFixture(species);
      for (let i = 0; i < 3000; i++) {
        f.life.step(0.1, undefined, onlyBirds, undefined, { rain: 1 });
        expect(f.flock.landed).toBe(false);
      }
      expect(f.life.forageChecks).toBe(0);
    }
  });

  it('keeps train movement and dwell identical with birds enabled or disabled, and repeats forage state', () => {
    const make = () => {
      const builder = new LifeBuilder();
      builder.line([point(-200, -100), point(200, -100)], LifeLine.rail);
      builder.station(point(-50, -100));
      builder.perch(point(20, 20));
      const fixture = flockFixture('pigeon', builder);
      const at = point(-100, -100),
        cars = ['locomotive', 'coach'] as const;
      const mover: Mover = {
        kind: 'train',
        line: 0,
        from: 0,
        dir: 1,
        d: 100 * perMeter,
        speed: 12 * perMeter,
        v: 12 * perMeter,
        paint: 0,
        lane: 0,
        pause: 0,
        rank: 0,
        ...at,
        hx: 1,
        hy: 0,
        train: {
          cars: [...cars],
          trail: [at.x - trainLength(cars) * perMeter, at.y],
          edge: false,
          reverse: false,
          stopX: NaN,
          stopY: NaN,
        },
      };
      fixture.life.movers.push(mover);
      return { ...fixture, mover };
    };
    const on = make(),
      off = make(),
      repeat = make();
    let landed = false,
      dwell = false,
      decisions = false;
    for (let i = 0; i < 500; i++) {
      if (!landed && !on.flock.landing) {
        on.flock.stay = 0;
        repeat.flock.stay = 0;
      }
      on.life.step(0.1);
      repeat.life.step(0.1);
      off.life.step(0.1, undefined, (kind) => kind !== 'bird');
      expect([on.mover.x, on.mover.y, on.mover.pause]).toEqual([
        off.mover.x,
        off.mover.y,
        off.mover.pause,
      ]);
      expect(groundState(on.flock)).toEqual(groundState(repeat.flock));
      landed ||= on.flock.landed;
      dwell ||= on.mover.pause > 0;
      decisions ||= on.flock.landingAttempted || on.flock.perch >= 0;
    }
    expect({ landed, dwell, decisions }).toEqual({ landed: true, dwell: true, decisions: true });
  });

  it('does no terrain work while interpolating an accepted ground move', () => {
    const { life, flock } = flockFixture('egret', new LifeBuilder(), Habitat.field);
    land(life, flock);
    flock.stay = flock.bout = 1000;
    const bird = flock.birds[0]!;
    flock.birds.splice(1);
    Object.assign(bird, { gx: 0, gy: 0, tx: 0, ty: 0, wait: 0, face: 0 });
    life.step(0.1, undefined, onlyBirds);
    expect(bird.gx).not.toBe(bird.tx);
    const checks = life.forageChecks;
    for (let i = 0; i < 10; i++) life.step(0.1, undefined, onlyBirds);
    expect(life.forageChecks).toBe(checks);
  });
});

describe('seasonal foraging clearance', () => {
  const fixture = (radius = 5, building = false) => {
    const builder = new LifeBuilder();
    builder.roost(point(0, 0));
    if (building) builder.area('blocked', [ring(-2, -2, 2, 2)]);
    const tree: SeasonalDisplayRecord = {
      version: 1,
      kind: 'christmas-tree',
      id: 'forage-tree',
      season: 'winter',
      installation: 'tree',
      anchor: 'osm:way/1',
      at: tileToLngLat(tile, point(0, 0)),
      radius_m: radius,
      seed: 19,
    };
    const geo = { ...builder.finish(), seasonalTrees: [tree] };
    const world = new LifeWorld();
    world.setSeasons([
      {
        id: 'winter',
        installations: [{ id: 'tree', anchor: tree.anchor, kind: 'christmas-tree' }],
      },
    ]);
    // A neighboring reference tile makes the seasonal index's metric origin different.
    world.sync([
      { key: 'neighbor', tile: { ...tile, x: tile.x - 1 }, life: new LifeBuilder().finish() },
      { key: 'seasonal-forage', tile, life: geo },
    ]);
    const life = worldTiles(world).get('seasonal-forage')!;
    const flock = life.flocks[0]!;
    life.flocks.splice(0, life.flocks.length, flock);
    life.movers.length = life.gatherers.length = 0;
    Object.assign(flock, { species: 'pigeon', rank: 0, perch: -1, perched: false, stay: 0 });
    const season = (active: boolean) =>
      world.step(0, undefined, 21, undefined, undefined, {
        rain: 0,
        season: active ? 'winter' : null,
      });
    return { world, life, flock, geo, season };
  };

  it('uses transformed shared building clearance even outside a season', () => {
    const { life, flock, geo } = fixture(0.1, true);
    const shared = prepareForageTerrain(geo, perMeter, 'world');
    expect(shared.blocked.polygons).toHaveLength(0);
    land(life, flock);
    const local = prepareForageTerrain(geo, perMeter);
    for (const bird of flock.birds)
      expect(
        forageable('pigeon', Habitat.park, flock.x + bird.gx!, flock.y + bird.gy!, local, perMeter),
      ).toBe(true);
  });

  it('retains safe unfinished movements when neighboring terrain is admitted', () => {
    const { world, life, flock, geo, season } = fixture(0.1);
    land(life, flock);
    const bird = flock.birds[0]!;
    flock.birds.splice(1);
    Object.assign(flock, { ...point(4, 0), lx: point(4, 0).x, ly: 2048 });
    Object.assign(bird, { gx: 0, gy: 0, tx: 0.9 * perMeter, ty: 0, wait: 0 });
    const beforeSeason = life.forageChecks;
    season(true);
    expect(bird.tx).toBeCloseTo(0.9 * perMeter);
    expect(flock).toMatchObject({ landed: true, scatter: 0 });
    expect(life.forageChecks).toBeGreaterThan(beforeSeason);
    const beforeAdmission = life.forageChecks;
    world.sync([
      { key: 'neighbor', tile: { ...tile, x: tile.x - 1 }, life: new LifeBuilder().finish() },
      { key: 'seasonal-forage', tile, life: geo },
      { key: 'new-neighbor', tile: { ...tile, x: tile.x + 1 }, life: new LifeBuilder().finish() },
    ]);
    expect(worldTiles(world).get('seasonal-forage')).toBe(life);
    expect(bird.tx).toBeCloseTo(0.9 * perMeter);
    expect(flock).toMatchObject({ landed: true, scatter: 0 });
    expect(life.forageChecks).toBeGreaterThan(beforeAdmission);
  });

  it('excludes active installation footprints from complete landing layouts', () => {
    const { life, flock, season } = fixture();
    season(true);
    land(life, flock);
    for (const bird of flock.birds)
      expect(
        Math.hypot(flock.x + bird.gx! - 2048, flock.y + bird.gy! - 2048) / perMeter,
      ).toBeGreaterThan(5);
  });

  it('flushes unsafe grounded and approaching flocks when a season activates', () => {
    for (const approaching of [false, true]) {
      const { life, flock, geo, season } = fixture();
      land(life, flock);
      const identities = [...flock.birds];
      Object.assign(flock, {
        ...point(0, 0),
        lx: 2048,
        ly: 2048,
        landed: !approaching,
        landing: approaching,
      });
      for (const bird of flock.birds) Object.assign(bird, { gx: 0, gy: 0, tx: 0, ty: 0 });
      const cached = prepareForageTerrain(geo, perMeter);
      season(false);
      expect(flock.landed || flock.landing).toBe(true);
      season(true);
      expect(flock).toMatchObject({ landed: false, landing: false, feeding: false, home: -1 });
      expect(flock.scatter).toBeGreaterThan(0);
      expect(flock.birds).toEqual(identities);
      expect(prepareForageTerrain(geo, perMeter)).toBe(cached);
    }
  });

  it('cancels old certificates and rejects a seasonal obstacle between safe movement endpoints', () => {
    const { life, flock, season } = fixture(0.1);
    land(life, flock);
    const bird = flock.birds[0]!;
    flock.birds.splice(1);
    Object.assign(flock, {
      ...point(-0.25, 0),
      lx: point(-0.25, 0).x,
      ly: 2048,
      feeding: true,
      stay: 100,
      bout: 100,
    });
    Object.assign(bird, { gx: 0, gy: 0, tx: 0.5 * perMeter, ty: 0, face: 0, wait: 0 });
    season(true);
    expect(flock.landed).toBe(true);
    expect(bird.tx).toBe(bird.gx);
    // Fix the new movement decision to a straight 0.5 m walk across the footprint.
    const rng = vi
      .spyOn(life as unknown as { forageRng: () => number }, 'forageRng')
      .mockReturnValue(0.5);
    try {
      life.step(0.1, undefined, onlyBirds);
      expect(bird.gx).toBe(0);
      expect(bird.tx).toBe(0);
      expect(bird.wait).toBeGreaterThan(0);
      season(false);
      bird.face = bird.wait = 0;
      life.step(0.1, undefined, onlyBirds);
      expect(bird.gx).toBeGreaterThan(0);
      expect((flock.x + bird.tx! - point(-0.25, 0).x) / perMeter).toBeCloseTo(0.5);
    } finally {
      rng.mockRestore();
    }
  });
});

describe('ground bird views', () => {
  const viewFixture = (builder = new LifeBuilder()) => {
    builder.roost(point(0, 0));
    const world = new LifeWorld(undefined, undefined, undefined, true);
    world.sync([{ key: 'forage', tile, life: builder.finish() }]);
    const life = worldTiles(world).get('forage')!,
      flock = life.flocks[0]!;
    life.movers.length = life.gatherers.length = 0;
    life.flocks.splice(0, life.flocks.length, flock);
    Object.assign(flock, { species: 'pigeon', rank: 0, perch: -1, perched: false });
    land(life, flock);
    return { world, life, flock };
  };
  it('eases tree-rest, walker and expiry departures without losing offsets to a new landing', () => {
    for (const departure of ['tree', 'walker', 'expiry'] as const) {
      const builder = new LifeBuilder();
      if (departure === 'tree') builder.perch(point(30, 0));
      const { world, life, flock } = viewFixture(builder);
      for (const bird of flock.birds)
        Object.assign(bird, { gx: 3 * perMeter, gy: 0, tx: 3 * perMeter, ty: 0, wait: 100 });
      flock.stay = 1000;
      const views = () =>
        world
          .visible(21, 1, tileToLngLat(tile, point(0, 0)))
          .filter((agent) => agent.kind === 'bird')
          .map((agent) => lngLatToTile(tile, agent.lng, agent.lat));
      const before = views();
      expect(before).toHaveLength(flock.birds.length);
      const rng = vi
        .spyOn(life as unknown as { birdRng: () => number }, 'birdRng')
        .mockReturnValue(0);
      const forage = vi
        .spyOn(life as unknown as { forageRng: () => number }, 'forageRng')
        .mockReturnValue(0);
      try {
        if (departure === 'tree') {
          flock.feeding = true;
          flock.bout = 0;
        } else if (departure === 'walker') disturb(life, flock);
        else flock.stay = 0;
        life.step(0.001, undefined, onlyBirds);
        expect(flock.landed).toBe(false);
        if (departure === 'tree') expect(flock.perch).toBe(0);
        if (departure === 'expiry') {
          expect(flock.landing).toBe(true);
          expect(flock.birds.some((bird) => bird.gx !== 3 * perMeter)).toBe(true);
        }
        const first = views();
        first.forEach((p, i) => {
          expect(p.x).toBeCloseTo(before[i]!.x, 8);
          expect(p.y).toBeCloseTo(before[i]!.y, 8);
        });
        life.step(0.05, undefined, onlyBirds);
        expect(flock.departureBlend).toBeGreaterThan(0);
        expect(flock.departureBlend).toBeLessThan(1);
        views().forEach((p, i) =>
          expect(Math.hypot(p.x - first[i]!.x, p.y - first[i]!.y) / perMeter).toBeLessThan(2),
        );
      } finally {
        rng.mockRestore();
        forage.mockRestore();
      }
    }
  });
  it('uses the same prepared positions at the end of approach and on the first landed frame', () => {
    const { world, flock } = viewFixture();
    flock.landed = false;
    flock.landing = true;
    flock.landingBlend = 1;
    const before = world.visible(21, 1, tileToLngLat(tile, point(0, 0)));
    flock.landed = true;
    flock.landing = false;
    const after = world.visible(21, 1, tileToLngLat(tile, point(0, 0)));
    expect(before.map((agent) => [agent.lng, agent.lat])).toEqual(
      after.map((agent) => [agent.lng, agent.lat]),
    );
  });
  it('emits the exact ground positions, changes feeding facing and holds rendered facing in rain/rest', () => {
    const { world, life, flock } = viewFixture();
    const views = (rain = 0) =>
      world.visible(21, 1, tileToLngLat(tile, point(0, 0)), { rain, sunAltitude: 1 });
    const shown = views();
    shown.forEach((agent, i) => {
      const bird = flock.birds[i]!,
        at = tileToLngLat(tile, { x: flock.x + bird.gx!, y: flock.y + bird.gy! });
      expect([agent.lng, agent.lat]).toEqual(at);
      expect(agent.bird?.pose).toBe(BirdPose.perched);
    });
    flock.birds.forEach((bird) => {
      bird.wait = 5;
    });
    const face = views().map((agent) => agent.ahead);
    life.step(0.4, undefined, onlyBirds);
    expect(views().map((agent) => agent.ahead)).not.toEqual(face);
    const rainy = views(1),
      state = groundState(flock);
    for (let i = 0; i < 20; i++) life.step(0.1, undefined, onlyBirds, undefined, { rain: 1 });
    expect(views(1)).toEqual(rainy);
    expect(groundState(flock)).toEqual(state);
    flock.feeding = false;
    flock.bout = 100;
    for (const bird of flock.birds) bird.face = bird.phase * 2 * Math.PI + 1;
    const rest = views();
    rest.forEach((agent, i) => {
      const bird = flock.birds[i]!;
      expect(agent.ahead).toEqual(
        tileToLngLat(tile, {
          x: flock.x + bird.gx! + Math.cos(bird.face!) * perMeter,
          y: flock.y + bird.gy! + Math.sin(bird.face!) * perMeter,
        }),
      );
    });
    life.step(1, undefined, onlyBirds);
    expect(views()).toEqual(rest);
  });

  it('keeps a rendered ground bird moving through selection and release with the same identity', () => {
    const { world, flock } = viewFixture();
    const bird = flock.birds[0]!;
    const views = () => world.visible(21, 1, tileToLngLat(tile, point(0, 0)));
    const first = views()[0]!;
    world.inspection!.select({ id: first.inspectionId!, revision: 1, time: 0 }, 0);
    flock.birds.forEach((bird) => {
      bird.wait = 0;
    });
    const before = groundState(flock);
    for (let i = 0; i < 8; i++) {
      world.step(0.1);
      expect(views()[0]!.inspectionId).toBe(first.inspectionId);
    }
    expect(groundState(flock)).not.toEqual(before);
    expect(views()[0]).not.toEqual(first);
    world.inspection!.select({ id: null, revision: 2, time: 0.8 }, 0.8);
    world.step(0.1);
    expect(views()[0]!.inspectionId).toBe(first.inspectionId);
    expect(flock.birds[0]).toBe(bird);
    expect(world.inspection!.held(bird)).toBe(false);
  });
});
