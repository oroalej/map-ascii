import { expect, it, vi } from 'vitest';
import { packGlyph, unpackGlyph } from '../glyphs/select';
import {
  carnivalPose,
  CARNIVAL_MOTION,
  decodeCarnivalUv,
  encodeCarnivalUv,
} from './carnival-motion';
import { SeasonalPart } from './seasonal-glyphs';
import { packSeasonalFixtures } from './seasonal';
import type { SeasonalCarnivalRecord } from '@atlas/shared';

it('round-trips local coordinates through the existing fixture bytes without changing part or opacity', () => {
  for (const u of [-1, -0.7, 0, 0.3, 1])
    for (const v of [-1, -0.1, 0, 0.9, 1]) {
      const encoded = encodeCarnivalUv(u, v);
      for (const part of [
        SeasonalPart.carouselMotion,
        SeasonalPart.wheelMotion,
        SeasonalPart.bumperMotion,
      ]) {
        const [lo, hi] = packGlyph(encoded >>> 8, part);
        const bytes = new Uint8Array([lo, hi, encoded, 255]);
        const decoded = unpackGlyph(bytes[0]!, bytes[1]!);
        expect(decoded.cls).toBe(part);
        const [x, y] = decodeCarnivalUv((decoded.glyph << 8) | bytes[2]!);
        expect(Math.abs(x - u)).toBeLessThanOrEqual(1 / 511);
        expect(Math.abs(y - v)).toBeLessThanOrEqual(1 / 511);
        expect(bytes[3]).toBe(255);
      }
    }
});

it('animates all three rides within their footprints and freezes the same poses under reduced motion', () => {
  const start = carnivalPose(0);
  const moved = carnivalPose(1.2);
  expect(moved.carousel).not.toBe(start.carousel);
  expect(moved.gondolas).not.toEqual(start.gondolas);
  expect(moved.cars).not.toEqual(start.cars);
  for (let time = 0; time < 120; time += 0.25) {
    const pose = carnivalPose(time);
    for (const [u, v] of pose.gondolas) {
      expect(Math.abs(u) + 0.2).toBeLessThan(0.9);
      expect(Math.abs(v) + 0.065).toBeLessThan(0.9);
    }
    for (const [u, v] of pose.cars) {
      expect(Math.abs(u) + 0.145).toBeLessThan(0.9);
      expect(Math.abs(v) + 0.16).toBeLessThan(0.9);
    }
    expect(carnivalPose(time, true)).toEqual(start);
  }
  expect(carnivalPose(Infinity)).toEqual(start);
  for (const [i, position] of carnivalPose(
    (2 * Math.PI) / CARNIVAL_MOTION.wheel,
  ).gondolas.entries()) {
    expect(position[0]).toBeCloseTo(start.gondolas[i]![0], 10);
    expect(position[1]).toBeCloseTo(start.gondolas[i]![1], 10);
  }
});

it('packs ride samples as parameters rather than atlas indices and protects existing hardware', () => {
  const record: SeasonalCarnivalRecord = {
    version: 1,
    kind: 'carnival',
    id: 'wheel',
    season: 'winter',
    installation: 'fair',
    anchor: 'osm:way/1',
    seed: 1,
    style: 'ferris-wheel',
    at: [0, 0],
    size_m: [7, 22],
    angle_deg: -20,
  };
  const grid = {
    cols: 80,
    rows: 80,
    cellWidth: 5,
    cellHeight: 9,
    toCell: (lng: number, lat: number): [number, number] => [
      40 + lng * 111319.49 * 2,
      40 - lat * 111319.49,
    ],
  };
  const out = new Uint8Array(80 * 80 * 4),
    owners = new Int32Array(80 * 80).fill(-1);
  const center = 40 * 80 + 40;
  owners[center] = 7;
  out[center * 4 + 3] = 201;
  const index = vi.fn((glyph: string) => (glyph ? 300 : 0));
  const visibility = packSeasonalFixtures(
    out,
    grid,
    [{ kind: 'season-installation', record }],
    20,
    index,
    owners,
  );
  expect(visibility.installations).toBe(true);
  expect(out[center * 4 + 3]).toBe(201);
  expect(owners[center]).toBe(7);
  let samples = 0;
  for (let cell = 0; cell < owners.length; cell++) {
    const at = cell * 4,
      decoded = unpackGlyph(out[at]!, out[at + 1]!);
    if (decoded.cls !== SeasonalPart.wheelMotion) continue;
    const [u, v] = decodeCarnivalUv((decoded.glyph << 8) | out[at + 2]!);
    expect(Math.abs(u)).toBeLessThanOrEqual(1);
    expect(Math.abs(v)).toBeLessThanOrEqual(1);
    expect(out[at + 3]).toBe(255);
    samples++;
  }
  expect(samples).toBeGreaterThan(100);
  // Only the stationary border bulbs need a real glyph-atlas lookup.
  expect(index.mock.calls.every(([glyph]) => glyph !== '█')).toBe(true);
});
