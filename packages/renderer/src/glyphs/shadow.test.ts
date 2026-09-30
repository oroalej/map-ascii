import { describe, expect, it } from 'vitest';
import { CellState } from '../picking';
import { EDGE_STATE, inShadow, SHADOW, SHADOW_STATE, TONE_SHIFT, WIND_SHIFT } from './select';

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
    // Nothing else in the byte overlaps it: not the picking state, the edge, the wind level
    // (2 bits) or the tone (2 bits, the top of the byte).
    const others = [EDGE_STATE, 3 << WIND_SHIFT, 3 << TONE_SHIFT, ...Object.values(CellState)];
    for (const bit of others) expect(bit & SHADOW_STATE).toBe(0);
    expect(SHADOW_STATE + EDGE_STATE + (3 << WIND_SHIFT) + (3 << TONE_SHIFT) + 3).toBe(255);
  });
});
