import { describe, expect, it } from 'vitest';
import { kinematicsOf } from './config';
import { approach, nextSpeed } from './motion';

describe('motion controller', () => {
  const k = kinematicsOf('car');
  it('bounds acceleration and braking in each tile frame', () => {
    for (const pm of [0.5, 1, 8]) {
      expect(nextSpeed(0, 10 * pm, Infinity, k, pm, 0.1)).toBeCloseTo(k.accel * pm * 0.1);
      expect(nextSpeed(10 * pm, 0, Infinity, k, pm, 0.1)).toBeCloseTo((10 - k.maxBrake * 0.1) * pm);
      expect(nextSpeed(pm, pm, Infinity, k, pm, 0.1)).toBe(pm);
    }
  });
  it('obeys emergency caps without producing negative speed', () => {
    expect(nextSpeed(10, 10, 0, k, 1, 0.1)).toBe(0);
    expect(nextSpeed(0.1, 0, Infinity, k, 1, 0.1)).toBe(0);
    expect(nextSpeed(10, 20, 4, k, 1, 0.1)).toBe(4);
  });
  it('computes comfortable approach speeds and falls back for unknown craft', () => {
    expect(approach(60, 0, 3)).toBeCloseTo(Math.sqrt(360));
    expect(approach(5, 2, 3)).toBeCloseTo(Math.sqrt(34));
    expect(approach(-1, 2, 3)).toBe(2);
    expect(kinematicsOf('unknown')).toEqual(kinematicsOf());
  });
});
