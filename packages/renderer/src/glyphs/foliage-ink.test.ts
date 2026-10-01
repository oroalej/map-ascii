import { describe, expect, it } from 'vitest';
import { foliageInkSample } from './foliage-ink';

describe('leaf ink placement', () => {
  const bitmap = (wx: number, wy: number, width = 5, height = 9) =>
    Array.from({ length: width * height }, (_, i) =>
      foliageInkSample(i % width, Math.floor(i / width), width, height, wx, wy),
    );

  it('stays anchored to the world cell through grid pans and repeated draws', () => {
    const at = (origin: number, cell: number) => bitmap(origin + cell, -800003);
    expect(at(500000, 19)).toEqual(at(500010, 9));
    expect(at(500000, 19)).toEqual(at(500000, 19));
    expect(
      new Set(Array.from({ length: 100 }, (_, x) => JSON.stringify(bitmap(x, 0)))).size,
    ).toBeGreaterThan(90);
  });

  it('retains leaf strokes while rejecting every sample outside the owned atlas slot', () => {
    for (const [width, height] of [
      [5, 9],
      [10, 18],
      [6, 9],
    ] as const) {
      for (let x = -30; x < 30; x++) {
        const samples = bitmap(x, 800000, width, height);
        expect(samples.filter(Boolean).length / samples.length).toBeGreaterThan(0.4);
        expect(samples.some((sample) => sample === null)).toBe(true);
        for (const sample of samples) {
          if (!sample) continue;
          expect(sample[0]).toBeGreaterThanOrEqual(0);
          expect(sample[1]).toBeGreaterThanOrEqual(0);
          expect(sample[0]).toBeLessThan(width);
          expect(sample[1]).toBeLessThan(height);
          expect(sample.every(Number.isInteger)).toBe(true);
        }
      }
    }
  });
});
