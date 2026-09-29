import { describe, expect, it } from 'vitest';
import { CellState } from '../picking';
import { EDGE_STATE, inShadow, SHADOW, SHADOW_STATE, WIND_STATE } from './select';

describe('shadows', () => {
  const tan = (degrees: number) => Math.tan((degrees * Math.PI) / 180);
  /** A building `height` meters tall `at` steps toward the sun, open ground elsewhere. */
  const building = (height: number, at: number) => (k: number) => (k === at ? height : 0);

  it('falls on the ground behind a building, as long as the sun is low', () => {
    // A 12 m building 2 steps of 3 m away: shaded while the sun is under atan(12 / 6) ≈ 63°.
    expect(inShadow(0, building(12, 2), tan(60), 3)).toBe(true);
    expect(inShadow(0, building(12, 2), tan(70), 3)).toBe(false);
    // Farther away needs a lower sun.
    expect(inShadow(0, building(12, 5), tan(45), 3)).toBe(false);
    expect(inShadow(0, building(12, 5), tan(30), 3)).toBe(true);
  });

  it('shades a roof only under something taller', () => {
    expect(inShadow(12, building(12, 1), tan(10), 3)).toBe(false);
    expect(inShadow(6, building(12, 1), tan(45), 3)).toBe(true);
  });

  it('looks only so far, and not at all without a sun', () => {
    expect(inShadow(0, building(200, SHADOW.steps + 1), tan(5), 3)).toBe(false);
    expect(inShadow(0, building(12, 1), 0, 3)).toBe(false);
  });

  it('has its own bit in the state byte', () => {
    for (const bit of [EDGE_STATE, WIND_STATE, ...Object.values(CellState)]) {
      expect(bit & SHADOW_STATE).toBe(0);
    }
    expect(SHADOW_STATE + WIND_STATE + EDGE_STATE + CellState.selected).toBeLessThan(256);
  });
});
