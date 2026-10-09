import { describe, expect, it } from 'vitest';
import { QualityController, TIERS } from './quality';

const drive = (
  q: QualityController,
  start: number,
  end: number,
  interval = 16,
  cpu = 3,
  quiet = true,
  dprOf?: (tier: number) => number,
) => {
  const changes: number[] = [];
  for (let at = start; at <= end; at += 16) {
    q.sample({ at, intervalMs: interval, cpuMs: cpu, gpuMs: null });
    const tier = q.decide(at, quiet, dprOf);
    if (tier !== undefined) changes.push(tier);
  }
  return changes;
};
describe('adaptive quality', () => {
  it('retains cloud detail on high and crowd and drops it on effects and pixels', () => {
    expect(TIERS.map((tier) => [tier.name, tier.knobs.clouds])).toEqual([
      ['high', true],
      ['crowd', true],
      ['effects', false],
      ['pixels', false],
    ]);
  });
  it('steps down under sustained load, waits for quiet, and observes cooldown', () => {
    const q = new QualityController('auto');
    expect(drive(q, 0, 4500, 30, 15, false)).toEqual([]);
    expect(drive(q, 4512, 4800, 30, 15)).toEqual([1]);
    expect(drive(q, 4816, 12_000, 50, 30)).toEqual([]);
    expect(drive(q, 12_016, 13_000, 50, 30)).toEqual([2]);
  });
  it('ignores spikes and stale observations', () => {
    const q = new QualityController('auto');
    drive(q, 0, 1000);
    q.sample({ at: 1016, intervalMs: 200, cpuMs: 100, gpuMs: null });
    expect(drive(q, 1032, 7000)).toEqual([]);
    drive(q, 7016, 10_000, 60, 40, false);
    expect(q.decide(30_000, true)).toBeUndefined();
  });
  it('recovers while idle without forcing extra draws and backs off unsuccessful trials', () => {
    const q = new QualityController('auto');
    expect(drive(q, 0, 4000, 50, 30)).toEqual([1]);
    expect(drive(q, 4016, 19_000)).toEqual([0]);
    expect(drive(q, 19_016, 27_000, 50, 30)).toEqual([1]);
    expect(drive(q, 27_016, 54_000)).toEqual([]);
    expect(drive(q, 54_016, 59_000)).toEqual([0]);
  });
  it('pins manual choices, defers their application, and starts Auto afresh', () => {
    const q = new QualityController('low');
    expect(q.tier).toBe(3);
    expect(drive(q, 0, 60_000)).toEqual([]);
    q.setChoice('high');
    expect(q.decide(60_001, false)).toBeUndefined();
    expect(q.decide(60_002, true)).toBe(0);
    expect(drive(q, 60_016, 90_000, 100, 90)).toEqual([]);
    q.setChoice('auto');
    expect(q.decide(90_001, true)).toBe(0);
    expect(q.state).toEqual({ choice: 'auto', tier: 0, name: 'high' });
    expect(q.decide(100_000, true)).toBeUndefined();
  });
  it('caps the pixel ratio by tier and never raises it on the way down', () => {
    expect(TIERS.map((tier) => tier.knobs.maxDpr)).toEqual([2, 1.5, 1.5, 1.25]);
  });
  it('steps down under severe load mid-gesture only where the pixel ratio stays', () => {
    // A 2× display: every step changes the drawing pixel ratio, so input defers it.
    const hiDpi = new QualityController('auto');
    const capped = (tier: number) => Math.min(2, TIERS[tier]!.knobs.maxDpr);
    expect(drive(hiDpi, 0, 6000, 50, 30, false, capped)).toEqual([]);
    expect(drive(hiDpi, 6016, 6400, 50, 30, true, capped)).toEqual([1]);
    // A 1× display: no tier resizes, so a severe hold steps down while input continues.
    const flat = new QualityController('auto');
    const one = () => 1;
    expect(drive(flat, 0, 1400, 50, 30, false, one)).toEqual([]);
    expect(drive(flat, 1416, 2400, 50, 30, false, one)).toEqual([1]);
    // Slow but not severe load still waits for quiet, and so does every recovery.
    const slow = new QualityController('auto');
    expect(drive(slow, 0, 6000, 30, 15, false, one)).toEqual([]);
    expect(drive(flat, 2416, 40_000, 16, 3, false, one)).toEqual([]);
    expect(drive(flat, 40_016, 41_000, 16, 3, true, one)).toEqual([0]);
  });
  it('reset discards an old overload window', () => {
    const q = new QualityController('auto');
    drive(q, 0, 3000, 50, 30, false);
    q.reset();
    expect(drive(q, 3016, 8000)).toEqual([]);
  });
});
