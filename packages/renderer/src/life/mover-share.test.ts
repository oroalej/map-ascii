import { describe, expect, it } from 'vitest';
import type { CityLifeConfig } from '@atlas/shared';
import { activityChanged, activityLevels, DISTRICT } from './config';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import { LifeBuilder, LifeLine } from './geometry';
import { inCentre, moverShare, peopleShare } from './mover-share';
import { LifeWorld, TileLife } from './simulate';
import { continuityMover, continuityTile, left, right } from './testing/continuity';

const life: Pick<CityLifeConfig, 'rhythm' | 'rhythm_days'> = {
  rhythm: {
    person: [[0, 1]],
    vehicle: [[0, 0.5]],
    centre: [
      [0, 0.2],
      [10, 1],
      [22, 0.2],
    ],
    home: [
      [0, 0.8],
      [12, 0.4],
      [18, 1],
    ],
  },
  rhythm_days: [{ weekdays: [0], rhythm: { vehicle: [[0, 0.25]] } }],
};
const at = (hour: number, weekday = 1) => activityLevels(1, { minutes: hour * 60, weekday, life });

describe('people by district', () => {
  it('stays out of the levels unless the city tells districts apart', () => {
    expect(activityLevels(1).districts).toBeUndefined();
    expect(activityLevels(1, { minutes: 600, weekday: 1 }).districts).toBeUndefined();
    expect(
      activityLevels(1, { minutes: 600, weekday: 1, life: { rhythm: { person: [[0, 1]] } } })
        .districts,
    ).toBeUndefined();
  });

  it('thins the centre at night while home streets stay out', () => {
    const night = at(22);
    expect(night.districts!.centre).toBeCloseTo(0.2);
    expect(night.districts!.home).toBeGreaterThan(night.districts!.centre);
    const morning = at(10);
    expect(morning.districts!.centre).toBeCloseTo(1);
    expect(morning.districts!.home).toBeLessThan(morning.districts!.centre);
  });

  it('reads each person by where they belong: home streets unless marked', () => {
    const levels = at(22);
    const rank = 0.5;
    expect(rank < peopleShare({ district: 'centre' }, levels)).toBe(false);
    expect(rank < peopleShare({}, levels)).toBe(true);
    expect(peopleShare({}, levels)).toBe(levels.districts!.home);
    expect(peopleShare({ district: 'city' }, levels)).toBe(levels.person);
    expect(peopleShare({ district: 'centre' }, activityLevels(1))).toBe(activityLevels(1).person);
    expect(peopleShare({}, activityLevels(1))).toBe(activityLevels(1).person);
  });

  it('leaves every other kind on its own share', () => {
    const levels = at(22);
    expect(moverShare({ kind: 'vehicle', district: 'centre' }, levels)).toBe(levels.vehicle);
    expect(moverShare({ kind: 'person', district: 'centre' }, levels)).toBe(
      levels.districts!.centre,
    );
  });

  it('notices a change in a district alone', () => {
    const levels = at(10);
    const moved = { ...levels, districts: { ...levels.districts!, home: 0 } };
    expect(activityChanged(levels, moved)).toBe(true);
    expect(activityChanged(levels, levels)).toBe(false);
  });

  it('follows the weekday', () => {
    expect(at(10, 1).vehicle).toBeCloseTo(0.5);
    expect(at(10, 0).vehicle).toBeCloseTo(0.25);
  });
});

describe('inCentre', () => {
  const perMeter = 2;
  const shops = (count: number, distanceM: number) => {
    const out = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) out[i * 2] = distanceM * perMeter;
    return out;
  };

  it('is a centre with enough shops in reach', () => {
    expect(inCentre(0, 0, shops(DISTRICT.minShops, DISTRICT.radiusM - 1), perMeter)).toBe(true);
  });

  it('is not with too few shops, shops out of reach, or none at all', () => {
    expect(inCentre(0, 0, shops(DISTRICT.minShops - 1, 10), perMeter)).toBe(false);
    expect(inCentre(0, 0, shops(DISTRICT.minShops, DISTRICT.radiusM + 1), perMeter)).toBe(false);
    expect(inCentre(0, 0, new Float32Array(), perMeter)).toBe(false);
    expect(inCentre(0, 0, undefined, perMeter)).toBe(false);
  });
});

describe('a tile with people', () => {
  const tile = { z: 16, x: 55192, y: 30266 };
  const center = tileToLngLat(tile, { x: 2048, y: 2048 });
  const geometry = (shops: number) => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 200, y: 2048 },
        { x: 3900, y: 2048 },
      ],
      LifeLine.path,
    );
    for (let i = 0; i < shops; i++) b.commerceAt({ x: 2048 + i, y: 2060 }, `shop-${i}`);
    return b.finish();
  };
  const people = (shops: number) => {
    const life = new TileLife(tile, geometry(shops), 7);
    return life.movers.filter((m) => m.kind === 'person');
  };

  it('fixes each person a district from the shops around where they start', () => {
    const reach = DISTRICT.radiusM / metersPerUnit(tile);
    const distance = (m: { x: number; y: number }) => Math.hypot(m.x - 2048, m.y - 2060);
    const all = people(DISTRICT.minShops);
    const near = all.filter((m) => distance(m) < reach - 8);
    const far = all.filter((m) => distance(m) > reach + 8);
    expect(near.length).toBeGreaterThan(0);
    expect(far.length).toBeGreaterThan(0);
    expect(near.every((m) => m.district === 'centre')).toBe(true);
    expect(far.every((m) => m.district === undefined)).toBe(true);
    expect(people(0).every((m) => !('district' in m))).toBe(true);
  });

  it('keeps their district when they cross into a tile with no shops', () => {
    const source = new TileLife(left, continuityTile(left, LifeLine.path).life, 1);
    const target = new TileLife(right, continuityTile(right, LifeLine.path).life, 1);
    for (const life of [source, target]) life.movers.length = 0;
    const m = continuityMover(source, 4095, 'person');
    m.district = 'centre';
    source.movers.push(m);
    expect(target.adoptFrom(m, source)).toBe(true);
    expect(target.movers).toContain(m);
    expect(m.district).toBe('centre');
  });

  it('keeps seasonal stalls on the city share', () => {
    const levels = { ...at(10), districts: { centre: 0, home: 0 } };
    expect(peopleShare({ district: 'city' }, levels)).toBe(levels.person);
  });

  it('shows only the district that is out', () => {
    const world = new LifeWorld();
    world.sync([{ key: 'a', tile, life: geometry(0) }]);
    const levels = activityLevels(1, { minutes: 600, weekday: 1 });
    const walkers = (home: number) =>
      world
        .visible(18, { ...levels, person: 1, districts: { centre: 1, home } }, center)
        .filter((agent) => agent.kind === 'person').length;
    expect(walkers(1)).toBeGreaterThan(0);
    expect(walkers(0)).toBe(0);
  });
});
