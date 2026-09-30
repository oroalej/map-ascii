import { describe, expect, it } from 'vitest';
import { waterEffect } from './water';
describe('water effects', () => {
  const sample = (time: number, rain: number, fish: boolean) => {
    const out: (number | null)[] = [];
    for (let y = -32; y < 32; y++)
      for (let x = -32; x < 32; x++) out.push(waterEffect(x, y, time, rain, fish));
    return out;
  };
  it('shows nothing without rain or fish', () =>
    expect(sample(4, 0, false).every((v) => v === null)).toBe(true));
  it('anchors sparse rain rings to world cells and changes their radius', () => {
    const a = sample(4, 1, false);
    expect(a).toEqual(sample(4, 1, false));
    expect(a.filter((v) => v !== null).length).toBeGreaterThan(0);
    expect(a).not.toEqual(sample(4.4, 1, false));
    expect(a.every((v) => v === null || v < 3)).toBe(true);
  });
  it('shows occasional fish and their rings only when enabled', () => {
    const frames = Array.from({ length: 18 }, (_, t) => sample(t, 0, true));
    expect(frames.some((f) => f.includes(3))).toBe(true);
    expect(frames.some((f) => f.includes(0) || f.includes(1))).toBe(true);
  });
});
