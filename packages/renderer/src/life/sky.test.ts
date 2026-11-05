import { describe, expect, it } from 'vitest';
import { project } from '../camera';
import { placeGrid } from '../grid';
import {
  cloudCover,
  driftClouds,
  MIST,
  mistAmount,
  morningMist,
  shadowAt,
  SKY,
  skyAnchor,
  skyGrid,
  skyNoise,
} from './sky';

it('seeds cover and spatial octaves independently and deterministically', () => {
  const at = new Date('2026-07-10T04:00:00Z');
  expect(cloudCover(at, 12)).toBe(cloudCover(new Date(at), 12));
  expect(cloudCover(at, 12)).not.toBe(cloudCover(at, 15));
  expect(skyNoise([23, 57], SKY.coarseCells, 12)).not.toBe(skyNoise([23, 57], SKY.coarseCells, 15));
  expect(skyAnchor([122, 12, 124, 14]).seed).toBe(skyAnchor([122.000001, 12, 124, 14]).seed);
});

it('keeps a smooth bounded cover curve with near-clear spells over thirty days', () => {
  const start = Date.parse('2026-07-01T00:00:00Z');
  const seed = skyAnchor([123.05, 13.5, 123.5, 13.8]).seed;
  let clear = 0,
    previous = cloudCover(new Date(start - 60_000), seed),
    maxDelta = 0;
  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < 30 * 24 * 60; i++) {
    const cover = cloudCover(new Date(start + i * 60_000), seed);
    min = Math.min(min, cover);
    max = Math.max(max, cover);
    maxDelta = Math.max(maxDelta, Math.abs(cover - previous));
    if (cover < 0.1) clear++;
    previous = cover;
  }
  expect(min).toBeGreaterThanOrEqual(0);
  expect(max).toBeLessThanOrEqual(0.75);
  expect(clear / (30 * 24 * 60)).toBeGreaterThanOrEqual(0.3);
  expect(clear / (30 * 24 * 60)).toBeLessThanOrEqual(0.5);
  expect(maxDelta).toBeLessThanOrEqual(0.02);
});

it('tiles both octaves continuously, including negative coordinates and both wrap axes', () => {
  for (const scale of [SKY.coarseCells, SKY.fineCells]) {
    for (let i = 0; i < 500; i++) {
      const x = i * 23.37 - SKY.wrap,
        y = i * 39.91 - 2 * SKY.wrap;
      const a = skyNoise([x, y], scale, 913);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      expect(Math.abs(a - skyNoise([x + 1, y + 1], scale, 913))).toBeLessThanOrEqual(0.05);
      expect(skyNoise([x + SKY.wrap, y - SKY.wrap], scale, 913)).toBeCloseTo(a, 10);
      expect(
        Math.abs(skyNoise([8191.9, y], scale, 913) - skyNoise([0, y], scale, 913)),
      ).toBeLessThan(0.05);
      expect(
        Math.abs(skyNoise([x, 8191.9], scale, 913) - skyNoise([x, 0], scale, 913)),
      ).toBeLessThan(0.05);
    }
  }
});

it('makes endpoint cover uniform and moves patches downwind without changing their shape', () => {
  for (const at of [
    [0, 0],
    [278, 193],
    [-500, 12000],
  ] as const) {
    expect(shadowAt(at, 0, [8, 9], 12)).toBe(0);
    expect(shadowAt(at, 1, [8, 9], 12)).toBe(1);
    expect(shadowAt([at[0] + 32, at[1] - 50], 0.6, [40, -41], 12)).toBeCloseTo(
      shadowAt(at, 0.6, [8, 9], 12),
      10,
    );
  }
});

it('anchors the same ground point across pan, zoom, density and DPR', () => {
  const anchor = skyAnchor([123.05, 13.5, 123.5, 13.8]);
  const point = [123.183, 13.623] as const;
  const projected = project(...point, 0);
  const ground = [
    (projected[0] - anchor.point[0]) * anchor.meters,
    (projected[1] - anchor.point[1]) * anchor.meters,
  ] as const;
  for (const zoom of [14, 18])
    for (const w of [8, 5])
      for (const dpr of [1, 2]) {
        const placement = placeGrid(
          { camera: { lng: 123.19, lat: 13.62, zoom }, dpr, width: 800, height: 600 },
          { w: w * dpr, h: w * 1.8 * dpr },
          160,
          80,
        );
        const grid = skyGrid(anchor, placement.world!);
        const local = placement.toCell(...point);
        const meters = [
          grid.meterOrigin[0] + local[0] * grid.meterStep[0],
          grid.meterOrigin[1] + local[1] * grid.meterStep[1],
        ] as const;
        expect(shadowAt(meters, 0.6, [12, 23], anchor.seed)).toBeCloseTo(
          shadowAt(ground, 0.6, [12, 23], anchor.seed),
          8,
        );
      }
});

it('freezes displacement for reduced motion, clamps elapsed time and wraps both axes', () => {
  const offset = [8191, 1] as const,
    wind = { dir: [1, -1] as [number, number], strength: 0.7, from: 315 };
  expect(driftClouds(offset, wind, 10, true)).toBe(offset);
  expect(driftClouds(offset, wind, 10, false)).toEqual([0.5, 8191.5]);
  expect(driftClouds(offset, wind, -1, false)).toEqual(offset);
});

describe('dawn mist', () => {
  it('rises before sunrise, holds, and is gone by 14 degrees', () => {
    const at = (altitude: number) => mistAmount(altitude, 1, 1, false);
    expect(at(-20)).toBe(0);
    expect(at(MIST.start)).toBe(0);
    expect(at(-4)).toBeCloseTo(0.5);
    expect(at(0)).toBe(1);
    expect(at(MIST.hold)).toBe(1);
    expect(at(8)).toBeGreaterThan(0);
    expect(at(8)).toBeLessThan(1);
    expect(at(MIST.gone)).toBe(0);
    expect(at(60)).toBe(0);
  });

  it('scales with the month and varies from 60 % to all of it by day', () => {
    expect(mistAmount(0, 0.5, 1, false)).toBeCloseTo(0.5);
    expect(mistAmount(0, 0.5, 0, false)).toBeCloseTo(0.3);
    expect(mistAmount(0, 0, 1, false)).toBe(0);
  });

  it('lifts in a storm', () => {
    expect(mistAmount(0, 1, 1, true)).toBe(0);
  });

  const months = Array.from({ length: 12 }, (_, i) => (i + 1) / 12);
  const at = (minutes: number, month = 6, day = 20_000) => ({ minutes, month, day });

  it('comes only in the morning, though dusk passes the same altitudes', () => {
    expect(morningMist(months, at(330), 0, 7, false)).toBeGreaterThan(0);
    expect(morningMist(months, at(1090), 0, 7, false)).toBe(0);
  });

  it('is absent without the pack key, and follows its month', () => {
    expect(morningMist(undefined, at(330), 0, 7, false)).toBe(0);
    expect(morningMist(months, at(330, 12), 0, 7, false)).toBeGreaterThan(
      morningMist(months, at(330, 1), 0, 7, false),
    );
  });

  it('differs from day to day by the same hash for every visitor', () => {
    const days = Array.from({ length: 30 }, (_, i) =>
      morningMist(months, at(330, 6, 20_000 + i), 0, 7, false),
    );
    expect(new Set(days).size).toBeGreaterThan(10);
    expect(morningMist(months, at(330, 6, 20_000), 0, 7, false)).toBe(days[0]);
    const min = 0.5 * MIST.dayBase - 1e-9;
    for (const amount of days) {
      expect(amount).toBeGreaterThanOrEqual(min);
      expect(amount).toBeLessThanOrEqual(0.5);
    }
  });

  it('drifts at a quarter of the clouds, held by reduced motion', () => {
    const wind = { dir: [1, 0] as [number, number], strength: 1, from: 270 };
    const clouds = driftClouds([100, 100], wind, 0.2, false);
    const mist = driftClouds([100, 100], wind, 0.2, false, MIST.speed);
    expect(mist[0] - 100).toBeCloseTo((clouds[0] - 100) * MIST.speed);
    const held = [5, 5] as const;
    expect(driftClouds(held, wind, 0.2, true, MIST.speed)).toBe(held);
  });
});
