import type { CityLifeConfig } from '@atlas/shared';
import { CityLife } from '@atlas/shared/schemas';
import { describe, expect, it } from 'vitest';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import { activityChanged, activityLevels, DISTRICT } from './config';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, TileLife, type Parked } from './simulate';
import { worldTiles } from './testing/scenarios';

const tile = { z: 16, x: 55192, y: 30266 };
const perMeter = 1 / metersPerUnit(tile);
const center = tileToLngLat(tile, { x: 2048, y: 2048 });

const parking: NonNullable<CityLifeConfig['parking']> = {
  lot: [
    [6, 0.1],
    [9, 0.8],
    [18, 0.9],
    [21, 0.25],
  ],
  centre: [
    [6, 0.2],
    [10, 0.9],
    [18, 0.9],
    [21, 0.3],
  ],
  home: [
    [6.5, 1],
    [9, 0.45],
    [16, 0.45],
    [19, 1],
  ],
  source: 'test',
};

/** One wide road among shops, one too far from them, and a row of a lot's stalls between. */
function town() {
  const b = new LifeBuilder();
  const road = (y: number, id: number) =>
    b.line(
      [
        { x: 0, y },
        { x: 4095, y },
      ],
      LifeLine.roadMid,
      14,
      id,
    );
  road(600, 1);
  road(3400, 2);
  for (let i = 0; i < DISTRICT.minShops + 2; i++) b.commerceAt({ x: 1800 + i * 40, y: 620 });
  for (let i = 0; i < 40; i++) b.spot({ x: 200 + i * 90, y: 2000 }, 1, 0);
  return b.finish();
}

/** A seed that parked on both curbs and in the lot. */
function parkedTown() {
  const geo = town();
  for (let seed = 1; seed < 80; seed++) {
    const life = new TileLife(tile, geo, seed);
    const slots = new Set(life.parked.map((p) => p.slot));
    if (slots.size === 3) return { geo, seed, life };
  }
  throw new Error('no seed parked on both curbs and in the lot');
}

/** A world drawing exactly these cars. */
function drawing(geo: ReturnType<typeof town>, cars: readonly Parked[]) {
  const world = new LifeWorld();
  world.sync([{ key: 'town', tile, life: geo }]);
  const life = worldTiles(world).get('town')!;
  life.parked.length = 0;
  life.parked.push(...cars);
  return { world, life };
}

const clock = (minutes: number, life?: Pick<CityLifeConfig, 'parking'>) =>
  activityLevels(1, { minutes, weekday: 2, life });

describe('parking through the day', () => {
  it('reaches its centre test in this fixture', () => {
    expect(DISTRICT.radiusM * perMeter).toBeLessThan(2500);
  });

  it('sorts cars by where they stand: lots, commercial curbs and home curbs', () => {
    const { life } = parkedTown();
    for (const p of life.parked) {
      if (p.y > 1000 && p.y < 3000) expect(p.slot).toBe('lot');
      else if (p.y < 1000) expect(p.slot).toBe('centre');
      else expect(p.slot).toBe('home');
      expect(p.share).toBeGreaterThanOrEqual(0);
      expect(p.share).toBeLessThan(1);
    }
  });

  it('gives a car the same slot and share however often the tile is rebuilt', () => {
    const { geo, seed, life } = parkedTown();
    expect(new TileLife(tile, geo, seed).parked).toEqual(life.parked);
  });

  it('shows and hides cars by the clock, without touching the list', () => {
    const { geo, seed } = parkedTown();
    const cars = new TileLife(tile, geo, seed).parked;
    const { world, life } = drawing(geo, cars);
    const shown = (minutes: number) =>
      world
        .visible(18, clock(minutes, { parking }), center)
        .filter((a) => a.kind === 'vehicle' && a.parked).length;
    const lots = cars.filter((car) => car.slot === 'lot').length;
    expect(lots).toBeGreaterThan(4);
    const day = shown(12 * 60);
    expect(shown(21 * 60 + 30)).toBeLessThan(day);
    expect(shown(6 * 60)).toBeLessThan(day);
    // Hidden cars stay obstacles: only the draw loop filters.
    expect(life.parked.length).toBe(cars.length);
  });

  it('compares each car only with its own slot', () => {
    const { geo, seed } = parkedTown();
    const cars = new TileLife(tile, geo, seed).parked;
    const { world } = drawing(geo, cars);
    const visible = (lot: number, centre: number, home: number) =>
      world
        .visible(18, { ...activityLevels(1), parking: { lot, centre, home } }, center)
        .filter((a) => a.kind === 'vehicle' && a.parked).length;
    expect(visible(0, 0, 0)).toBe(0);
    expect(visible(1, 1, 1)).toBe(cars.length);
    expect(visible(1, 0, 0)).toBe(cars.filter((car) => car.slot === 'lot').length);
    expect(visible(0, 1, 0)).toBe(cars.filter((car) => car.slot === 'centre').length);
    expect(visible(0, 0, 0.5)).toBe(
      cars.filter((car) => car.slot === 'home' && car.share! < 0.5).length,
    );
  });

  it('leaves every car showing without the option', () => {
    const { geo, seed } = parkedTown();
    const cars = new TileLife(tile, geo, seed).parked;
    const { world } = drawing(geo, cars);
    expect(clock(3 * 60).parking).toBeUndefined();
    for (const minutes of [3 * 60, 12 * 60])
      expect(
        world.visible(18, clock(minutes), center).filter((a) => a.kind === 'vehicle' && a.parked)
          .length,
      ).toBe(cars.length);
  });

  it('notices when a slot changes', () => {
    expect(activityChanged(clock(7 * 60, { parking }), clock(8 * 60, { parking }))).toBe(true);
    expect(activityChanged(clock(7 * 60), clock(7 * 60))).toBe(false);
  });

  it('validates the pack option and requires a source', () => {
    const { source: _source, ...unsourced } = parking;
    expect(CityLife.safeParse({ parking, source: 'x' }).success).toBe(true);
    expect(CityLife.safeParse({ parking: unsourced, source: 'x' }).success).toBe(false);
  });
});
