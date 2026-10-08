import { expect, it } from 'vitest';
import { compareTilePairs, firstArm, median, tileGate } from './perf-tiles-protocol';

it('balances arm order per tile and round, including warmups', () => {
  for (let tile = 0; tile < 3; tile++)
    expect(
      Array.from({ length: 12 }, (_, r) => firstArm(tile, r)).filter((arm) => arm === 'baseline'),
    ).toHaveLength(6);
});
it('uses overall build medians and round control spread without letting outliers dominate', () => {
  const pairs = [10, 10, 1000, 10, 10, 1000].map((baselineMs, i) => ({
    key: String(i % 3),
    z: 15,
    round: Math.floor(i / 3),
    first: firstArm(i % 3, Math.floor(i / 3)),
    baselineMs,
    candidateMs: baselineMs * (i < 3 ? 1.02 : 1.04),
  }));
  const result = compareTilePairs(pairs);
  expect(result.baselineMs).toBe(10);
  expect(result.candidateMs).toBeCloseTo(10.4);
  expect(result.changePercent).toBeCloseTo(4);
  expect(result.spreadPercent).toBeCloseTo(2);
  expect(median([1, 3])).toBe(2);
});
it('accepts the threshold or twice control noise only when inputs are stable', () => {
  expect(tileGate(5, 0, true).pass).toBe(true);
  expect(tileGate(6, 2, true).pass).toBe(false);
  expect(tileGate(6, 3, true).pass).toBe(true);
  expect(tileGate(-20, 0, false).pass).toBe(false);
  expect(() => median([])).toThrow();
  expect(() => median([NaN])).toThrow();
  expect(() => tileGate(1, -1, true)).toThrow();
  expect(() =>
    compareTilePairs([
      { key: 'a', z: 15, round: 0, first: 'baseline', baselineMs: 0, candidateMs: 1 },
    ]),
  ).toThrow();
});
