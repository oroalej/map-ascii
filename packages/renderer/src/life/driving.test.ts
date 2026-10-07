import { describe, expect, it } from 'vitest';
import { DRIVE } from './config';
import { cruise, share } from './driving';
import type { Mover } from './simulate';

const mover = (rank = 0.3): Mover =>
  ({ kind: 'vehicle', vehicle: 'car', speed: 10, rank }) as Mover;

describe('driving pace', () => {
  it('gives each driver a stable share in the configured range', () => {
    const values = [0, 0.1, 0.3, 0.7, 0.999].map((rank) => {
      const m = mover(rank);
      const pace = share(m, DRIVE.rain.pace, 7919.123);
      expect(share(m, DRIVE.rain.pace, 7919.123)).toBe(pace);
      expect(pace).toBeGreaterThanOrEqual(0.8);
      expect(pace).toBeLessThan(0.85);
      return pace;
    });
    expect(new Set(values).size).toBe(values.length);
  });

  it('slows road vehicles in rain and gives dry bursts priority over normal cruise', () => {
    const m = mover();
    expect(cruise(m, false)).toBe(m.speed);
    expect(cruise(m, true) / m.speed).toBeGreaterThanOrEqual(0.8);
    expect(cruise(m, true) / m.speed).toBeLessThan(0.85);
    m.rush = 5;
    expect(cruise(m, false) / m.speed).toBeGreaterThanOrEqual(1.25);
    expect(cruise(m, false) / m.speed).toBeLessThan(1.4);
    expect(cruise(m, true)).toBe(cruise({ ...m, rush: 0 }, true));
    m.vehicle = 'bicycle';
    expect(cruise(m, true)).toBeLessThan(m.speed);
  });

  it('leaves boats, trains and untyped movers unchanged', () => {
    for (const m of [
      { ...mover(), kind: 'boat' as const, vehicle: 'motorboat' as const },
      { ...mover(), kind: 'train' as const, vehicle: 'locomotive' as const },
      { ...mover(), vehicle: undefined },
    ]) {
      m.rush = 5;
      expect(cruise(m, false)).toBe(m.speed);
      expect(cruise(m, true)).toBe(m.speed);
    }
  });
});
