import { describe, expect, it } from 'vitest';
import { WATER_DEPTH, waterDepth, waterTone } from './select';

/** A map of `~` water and `.` land, read at the cell marked by `at` (column, row). */
const depthIn = (rows: readonly string[], at: readonly [number, number]) =>
  waterDepth((dx, dy) => rows[at[1] + dy]?.[at[0] + dx] === '~');

describe('waterDepth', () => {
  const open = Array.from({ length: 7 }, () => '~'.repeat(13));

  it('is 1 with no bank within any ring', () => {
    expect(depthIn(open, [6, 3])).toBe(1);
  });

  it('rises with the distance to the bank, ring by ring', () => {
    const shore = (column: number) =>
      Array.from({ length: 7 }, () =>
        Array.from({ length: 13 }, (_, x) => (x === column ? '.' : '~')).join(''),
      );
    expect(depthIn(shore(5), [6, 3])).toBe(0);
    expect(depthIn(shore(4), [6, 3])).toBeCloseTo(1 / 3);
    expect(depthIn(shore(2), [6, 3])).toBeCloseTo(2 / 3);
    // Past the farthest ring, and between the rings' samples, a bank doesn't count.
    expect(depthIn(shore(1), [6, 3])).toBe(1);
    expect(depthIn(shore(3), [6, 3])).toBe(1);
  });

  it('counts a row taller than a column: cells are taller than they are wide', () => {
    const shore = (row: number) =>
      Array.from({ length: 7 }, (_, y) => (y === row ? '.' : '~').repeat(13));
    expect(depthIn(shore(2), [6, 3])).toBe(0);
    expect(depthIn(shore(1), [6, 3])).toBeCloseTo(2 / 3);
    expect(depthIn(shore(0), [6, 3])).toBe(1);
  });

  it('gives a one-cell run one tone, whichever way it runs', () => {
    const { thin } = WATER_DEPTH;
    expect(depthIn(['.......', '~~~~~~~', '.......'], [3, 1])).toBe(thin);
    expect(depthIn(['.~.', '.~.', '.~.'], [1, 1])).toBe(thin);
    expect(depthIn(['..~', '.~.', '~..'], [1, 1])).toBe(thin);
    expect(depthIn(['...', '.~.', '...'], [1, 1])).toBe(thin);
  });

  it('keeps a narrow channel near its banks', () => {
    const wide = (width: number) =>
      Array.from({ length: 5 }, () => `.${'~'.repeat(width)}.`.padEnd(13, '.'));
    expect(depthIn(wide(2), [1, 2])).toBe(0);
    expect(depthIn(wide(3), [2, 2])).toBeCloseTo(1 / 3);
  });
});

describe('waterTone', () => {
  it('moves toward the bank below 0.5, the deep above it, and nowhere at 0.5', () => {
    expect(waterTone(0.5)).toEqual({ bank: 0, deep: 0 });
    expect(waterTone(0)).toEqual({ bank: WATER_DEPTH.bank, deep: 0 });
    expect(waterTone(1)).toEqual({ bank: 0, deep: WATER_DEPTH.deep });
    expect(waterTone(WATER_DEPTH.thin).bank).toBeCloseTo(WATER_DEPTH.bank / 2);
  });
});
