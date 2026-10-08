import { expect, it } from 'vitest';
import { project } from '../camera';
import { placeGrid } from '../grid';
import { cloudCover, driftClouds, shadowAt, SKY, skyAnchor, skyGrid, skyNoise } from './sky';

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
