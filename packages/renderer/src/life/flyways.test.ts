import type { FlywayConfig } from '@atlas/shared';
import { CityLife } from '@atlas/shared/schemas';
import { describe, expect, it, vi } from 'vitest';
import { BIRD_SPECIES } from './birds';
import { activityLevels, BIRD_WEATHER } from './config';
import { describeAgent } from './describe';
import { FLYWAY, flyingHome, FLYWAY_LABELS, flywayBirds } from './flyways';
import { LifeWorld, type VisibleAgent } from './simulate';

const egrets: FlywayConfig = {
  species: 'egret',
  roost: [123.187, 13.627],
  bearings: [90],
  distance_m: 3000,
  dusk: ['17:00', '18:00'],
  dawn: ['05:30', '06:30'],
  source: 'test',
};
const bats: FlywayConfig = {
  ...egrets,
  species: 'bat',
  dusk: ['18:00', '19:00'],
  dawn: ['04:00', '05:00'],
};
const center = [123.2, 13.627] as const;

const input = (minutes: number, time: number, flyways = [egrets]) => ({
  flyways,
  minutes,
  time,
  center,
  crowd: 1,
});

/** A time with some skein in the air at this clock, or the test can't say anything. */
function flying(minutes: number, flyways = [egrets]) {
  for (let time = 0; time < 20_000; time += 30) {
    const birds = flywayBirds(input(minutes, time, flyways));
    if (birds.length) return { time, birds };
  }
  throw new Error('no skein at this clock');
}

describe('flyways', () => {
  it('gives the same birds for the same time, without any random draw', () => {
    const random = vi.spyOn(Math, 'random');
    const { time, birds } = flying(17 * 60 + 30);
    expect(flywayBirds(input(17 * 60 + 30, time))).toEqual(birds);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it('stays empty outside the windows, and lets a late skein land after the last release', () => {
    const anyAt = (minutes: number) => {
      for (let time = 0; time < 20_000; time += 30)
        if (flywayBirds(input(minutes, time)).length) return true;
      return false;
    };
    expect(anyAt(12 * 60)).toBe(false);
    expect(anyAt(17 * 60 - 1)).toBe(false);
    expect(anyAt(17 * 60 + 30)).toBe(true);
    // The window has closed, but birds released before it closed are still on their way.
    expect(anyAt(18 * 60 + 2)).toBe(true);
    const trip =
      (egrets.distance_m + FLYWAY.skein[1] * FLYWAY.spacing[1]) / BIRD_SPECIES.egret.speed;
    expect(anyAt(18 * 60 + trip / 60 + 1)).toBe(false);
  });

  it('flies by species and window: egrets home at dusk, bats out at dusk', () => {
    expect(flyingHome('egret', 'dusk')).toBe(true);
    expect(flyingHome('egret', 'dawn')).toBe(false);
    expect(flyingHome('bat', 'dusk')).toBe(false);
    expect(flyingHome('bat', 'dawn')).toBe(true);
    // Bearing 90: the far point lies east of the roost.
    const west = (bird: VisibleAgent) => bird.ahead![0] < bird.lng;
    expect(flying(17 * 60 + 30).birds.every(west)).toBe(true);
    expect(flying(6 * 60).birds.some(west)).toBe(false);
    expect(flying(18 * 60 + 30, [bats]).birds.some(west)).toBe(false);
    expect(flying(4 * 60 + 30, [bats]).birds.every(west)).toBe(true);
  });

  it('moves at the species speed along its line', () => {
    const { time, birds } = flying(6 * 60);
    const later = flywayBirds(input(6 * 60, time + 5));
    // Flying due east, a bird keeps its latitude, so it is the one to follow.
    const bird = birds[0]!;
    const same = later.find((other) => other.lat === bird.lat)!;
    const meters = (same.lng - bird.lng) * 111_320 * Math.cos((13.627 * Math.PI) / 180);
    expect(meters / 5).toBeCloseTo(BIRD_SPECIES.egret.speed, 3);
  });

  it('keeps a fixed hour flying, as a pinned clock has the same minutes every frame', () => {
    const minutes = 17 * 60 + 30;
    const { time, birds } = flying(minutes);
    const later = flywayBirds(input(minutes, time + 10));
    expect(later).not.toEqual(birds);
    expect(later.length).toBeGreaterThan(0);
  });

  it('caps the birds, nearest skein first', () => {
    const many: FlywayConfig = { ...egrets, bearings: [0, 45, 90, 135, 180, 225, 270, 315] };
    let most = 0;
    for (let time = 0; time < 2_000; time += 60)
      most = Math.max(most, flywayBirds(input(17 * 60 + 30, time, [many, many, many])).length);
    expect(most).toBe(FLYWAY.maxBirds);
  });

  it('respects the view, and the crowd knob drops whole skeins', () => {
    const { time } = flying(17 * 60 + 30);
    const bounds = [0, 0, 1, 1] as const;
    expect(flywayBirds({ ...input(17 * 60 + 30, time), bounds })).toEqual([]);
    expect(flywayBirds({ ...input(17 * 60 + 30, time), crowd: 0 })).toEqual([]);
  });

  it('names what they are doing', () => {
    expect(describeAgent(flying(17 * 60 + 30).birds[0]!)).toBe(FLYWAY_LABELS.egret.home);
    expect(describeAgent(flying(6 * 60).birds[0]!)).toBe(FLYWAY_LABELS.egret.out);
  });

  it('draws in the world from the bird zoom, below people, only with the option', () => {
    const { time } = flying(17 * 60 + 30);
    const weather = (rain = 0) => ({
      rain,
      sunAltitude: 2,
      field: { time, wind: [1, 0] as const, minutes: 17 * 60 + 30 },
    });
    const flyers = (world: LifeWorld, zoom: number, rain = 0) =>
      world
        .visible(zoom, activityLevels(0.5), [123.2, 13.627], weather(rain))
        .filter((agent) => agent.kind === 'bird');
    const without = new LifeWorld();
    expect(flyers(without, 15)).toEqual([]);
    const world = new LifeWorld();
    world.setFlyways([egrets]);
    expect(flyers(world, 15).length).toBeGreaterThan(0);
    expect(flyers(world, 13)).toEqual([]);
    expect(flyers(world, 15, BIRD_WEATHER.shelter)).toEqual([]);
    // Without the clock, there are no windows to read.
    expect(
      world
        .visible(15, activityLevels(0.5), [123.2, 13.627], { rain: 0, sunAltitude: 2 })
        .filter((agent) => agent.kind === 'bird'),
    ).toEqual([]);
  });

  it('respects the world agent cap', () => {
    const { time } = flying(17 * 60 + 30);
    const world = new LifeWorld();
    world.setFlyways([egrets]);
    const birds = world.visible(
      15,
      activityLevels(0.5),
      [123.2, 13.627],
      { rain: 0, sunAltitude: 2, field: { time, wind: [1, 0], minutes: 17 * 60 + 30 } },
      undefined,
      1,
      2,
    );
    expect(birds.length).toBeLessThanOrEqual(2);
  });

  it('validates the pack option', () => {
    const parse = (flyway: unknown) =>
      CityLife.safeParse({ flyways: [flyway], source: 'x' }).success;
    expect(parse(egrets)).toBe(true);
    const { source: _source, ...unsourced } = egrets;
    expect(parse(unsourced)).toBe(false);
    expect(parse({ ...egrets, species: 'pigeon' })).toBe(false);
    expect(parse({ ...egrets, bearings: [] })).toBe(false);
    expect(parse({ ...egrets, dusk: ['18:00', '17:00'] })).toBe(false);
  });
});
