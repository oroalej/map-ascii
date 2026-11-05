import { describe, expect, it } from 'vitest';
import { MAX_STEER_SLOPE, steerLength, steerLimits, steerStep, steerStraight } from './lane-steer';

function drive(delta: number, dx: number, limits = steerLimits('car', 11), slope = 0) {
  let remaining = delta,
    s = slope,
    length = 0,
    peak = 0,
    largestChange = 0;
  for (let n = 0; n < 200_000 && (remaining !== 0 || s !== 0); n++) {
    const next = steerStep(s, remaining, dx, limits);
    largestChange = Math.max(largestChange, Math.abs(next.slope - s));
    s = next.slope;
    remaining -= next.sideways;
    peak = Math.max(peak, Math.abs(s));
    length += dx;
  }
  return { remaining, slope: s, length, peak, largestChange };
}

describe('steerLimits', () => {
  it('turns gently at speed and down to the turning circle at a crawl', () => {
    const fast = steerLimits('car', 11),
      crawl = steerLimits('car', 0.5);
    expect(fast.curvature).toBeCloseTo(1 / 121);
    expect(crawl.curvature).toBeCloseTo(1 / 5.5);
    expect(crawl.maxSlope).toBe(MAX_STEER_SLOPE);
    expect(fast.maxSlope).toBeCloseTo(1.5 / 11);
  });

  it('never allows a heading past the bound the road envelope assumes', () => {
    for (const speed of [0, 0.1, 1, 5, 30])
      expect(steerLimits('motorcycle', speed).maxSlope).toBeLessThanOrEqual(MAX_STEER_SLOPE);
  });

  it('gives a two-wheeler a tighter line than a bus', () => {
    expect(steerLimits('motorcycle', 3).curvature).toBeGreaterThan(steerLimits('bus', 3).curvature);
  });
});

describe('steerStep', () => {
  it.each([3.2, -3.2, 0.4, -0.05])('arrives exactly and straight for %s m', (delta) => {
    const done = drive(delta, 0.1);
    expect(done.remaining).toBe(0);
    expect(done.slope).toBe(0);
  });

  it('takes a realistic path for a lane change at cruising speed', () => {
    const { length, peak } = drive(3.2, 0.1);
    expect(length).toBeGreaterThan(30);
    expect(length).toBeLessThan(50);
    expect((Math.atan(peak) * 180) / Math.PI).toBeGreaterThan(6);
    expect((Math.atan(peak) * 180) / Math.PI).toBeLessThan(10);
  });

  it('holds the slope limit on a long move at a crawl', () => {
    const limits = steerLimits('car', 1);
    expect(drive(6, 0.05, limits).peak).toBeCloseTo(MAX_STEER_SLOPE, 3);
  });

  it('follows the same path whatever the step length', () => {
    const lengths = [0.02, 0.1, 0.37, 1].map((dx) => drive(3.2, dx).length);
    for (const length of lengths) expect(Math.abs(length - lengths[0]!)).toBeLessThan(2.5);
  });

  it('changes nothing without travel', () => {
    expect(steerStep(0.1, 2, 0, steerLimits('car', 0))).toEqual({ slope: 0.1, sideways: 0 });
  });

  it('turns the nose gradually, never by more than the curvature allows', () => {
    const limits = steerLimits('car', 11);
    expect(drive(3.2, 0.2, limits).largestChange).toBeLessThanOrEqual(
      limits.curvature * 0.2 + 1e-12,
    );
  });

  it('recovers when a change of plan finds it heading the wrong way', () => {
    const done = drive(1, 0.1, steerLimits('car', 4), -0.2);
    expect(done.remaining).toBe(0);
    expect(done.slope).toBe(0);
  });

  it('settles when it cannot avoid passing the target', () => {
    const done = drive(0.01, 0.1, steerLimits('car', 11), 0.15);
    expect(done.remaining).toBe(0);
    expect(done.slope).toBe(0);
  });
});

describe('steerStraight', () => {
  it('straightens over distance and drifts only as far as that heading carries it', () => {
    const limits = steerLimits('car', 4);
    let slope = 0.2,
      sideways = 0;
    for (let n = 0; n < 1000 && slope !== 0; n++) {
      const next = steerStraight(slope, 0.1, limits);
      slope = next.slope;
      sideways += next.sideways;
    }
    expect(slope).toBe(0);
    expect(sideways).toBeCloseTo((0.2 * 0.2) / (2 * limits.curvature), 6);
  });

  it('stays put without travel', () => {
    expect(steerStraight(0.2, 0, steerLimits('car', 4))).toEqual({ slope: 0.2, sideways: 0 });
  });
});

describe('steerLength', () => {
  it.each([
    [3.2, 0, 11],
    [3.2, 0, 1],
    [1.5, 0, 5],
    [6, 0, 2],
    [3.2, 0.05, 8],
    [0.5, 0.1, 8],
    [2, -0.1, 4],
  ])('matches driving %s m from slope %s at %s m/s', (delta, slope, speed) => {
    const limits = steerLimits('car', speed);
    expect(
      Math.abs(steerLength(delta, slope, limits) - drive(delta, 0.01, limits, slope).length),
    ).toBeLessThan(1);
  });

  it('is zero when already there and straight', () => {
    expect(steerLength(0, 0, steerLimits('car', 8))).toBe(0);
  });
});
