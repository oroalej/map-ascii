import { describe, expect, it } from 'vitest';
import { QualityController } from './quality';

const drive = (
  q: QualityController,
  start: number,
  end: number,
  interval = 16,
  cpu = 3,
  quiet = true,
) => {
  const changes: number[] = [];
  for (let at = start; at <= end; at += 16) {
    q.sample({ at, intervalMs: interval, cpuMs: cpu, gpuMs: null });
    const tier = q.decide(at, quiet);
    if (tier !== undefined) changes.push(tier);
  }
  return changes;
};
describe('adaptive quality', () => {
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
  it('reset discards an old overload window', () => {
    const q = new QualityController('auto');
    drive(q, 0, 3000, 50, 30, false);
    q.reset();
    expect(drive(q, 3016, 8000)).toEqual([]);
  });
});
