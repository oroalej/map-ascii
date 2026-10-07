import { describe, expect, it } from 'vitest';
import { hotAt } from './config';

describe('midday heat', () => {
  it.each([
    [659, 0, 60, false],
    [660, 0, 45, true],
    [869, 0, 60, true],
    [870, 0, 60, false],
    [720, 0.01, 60, false],
    [720, 1, 60, false],
    [720, 0, 44, false],
    [720, 0, 45, true],
    [undefined, 0, 60, false],
    [720, 0, undefined, false],
  ] as const)('checks minute %s, rain %s, altitude %s', (minutes, rain, altitude, expected) => {
    expect(hotAt(minutes, rain, altitude)).toBe(expected);
  });
});
