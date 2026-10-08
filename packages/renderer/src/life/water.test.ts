import { describe, expect, it } from 'vitest';
import { waterEffect } from './water';
describe('water effects', () => {
  it('adds cursor rings in local cells, preserves the zero-ring path and expires precisely', () => {
    const origin = [1e8, 2e8] as const;
    expect(
      waterEffect(origin[0] + 12, origin[1] + 10, 0, 0, false, 0, [[10, 10, 0.5]], origin),
    ).toBe(1);
    expect(
      waterEffect(origin[0] + 12, origin[1] + 10, 0, 0, false, 0, [[10, 10, 1.5]], origin),
    ).toBeNull();
    for (let x = -10; x < 10; x++)
      expect(waterEffect(x, 4, 3, 1, true, 3, [])).toBe(waterEffect(x, 4, 3, 1, true));
  });
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
  it('freezes fish on Life time while rain keeps following environmental time', () => {
    const sampleTimes = (time: number, rain: number, lifeTime: number) =>
      Array.from({ length: 64 * 64 }, (_, i) =>
        waterEffect((i % 64) - 32, Math.floor(i / 64) - 32, time, rain, true, lifeTime),
      );
    const first = sampleTimes(4, 0, 4);
    expect(first.some((v) => v !== null)).toBe(true);
    expect(sampleTimes(9, 0, 4)).toEqual(first);
    expect(sampleTimes(9, 0, 9)).not.toEqual(first);
    expect(sampleTimes(9, 1, 4)).not.toEqual(sampleTimes(4, 1, 4));
  });
});
