import { describe, expect, it } from 'vitest';
import { FrameProfiler, PROFILE_CAPACITY } from './profile';

describe('bounded frame profiles', () => {
  it('records stages during and between callbacks, and clears pending stages on reset', () => {
    const p = new FrameProfiler(() => 0);
    p.record('terrainSnapshot', 2);
    p.record('terrainSnapshot', 3);
    p.record('lifeLatency', 12);
    expect(p.snapshot().samples).toEqual([]);
    p.begin(1);
    p.record('terrainSnapshot', 1);
    p.end();
    expect(p.snapshot().samples[0]!.ms).toEqual({
      terrainSnapshot: 6,
      lifeLatency: 12,
      callback: 0,
    });
    p.begin(2);
    p.end();
    expect(p.snapshot().stages.terrainSnapshot.count).toBe(1);
    p.record('lifeLatency', 10);
    p.reset();
    p.begin(3);
    p.end();
    expect(p.snapshot().stages.lifeLatency.count).toBe(0);
  });
  it('drains worker stages and merges replies during and between callbacks', () => {
    const worker = new FrameProfiler(() => 0);
    const main = new FrameProfiler(() => 0);
    worker.begin(1);
    worker.add('sync', 4);
    worker.add('terrainRebuild', 2);
    worker.check();
    const sample = worker.drain()!;
    expect(worker.drain()).toBeUndefined();
    expect(worker.snapshot().samples).toEqual([]);
    main.merge(sample);
    main.begin(2);
    main.merge(sample);
    main.end();
    expect(main.snapshot().samples[0]).toMatchObject({
      at: 2,
      checks: 2,
      ms: { sync: 8, terrainRebuild: 4, callback: 0 },
    });
    expect(sample.ms.sync).toBe(4);
    main.merge(sample);
    main.reset();
    main.begin(3);
    main.end();
    expect(main.snapshot().stages.sync.count).toBe(0);
  });
  it('accumulates nested stages and separates missing stages from zero measurements', () => {
    let now = 10;
    const p = new FrameProfiler(() => now);
    p.begin(1);
    p.add('clearanceChecks', 2);
    p.add('clearanceChecks', 3);
    p.check();
    p.draw(6, 12);
    now = 18;
    p.end();
    const report = p.snapshot();
    expect(report.stages.callback.medianMs).toBe(8);
    expect(report.stages.clearanceChecks.p95Ms).toBe(5);
    expect(report.stages.visible.count).toBe(0);
    expect(report.stages.visible.medianMs).toBeNull();
    expect(report.samples[0]).toMatchObject({ drawn: true, agents: 12, checks: 1 });
    expect(report.spanMs).toBe(0);
    expect(report.dropped).toBe(0);
    expect(report.gpuRenderer).toBeNull();
    report.samples[0]!.ms.callback = 999;
    expect(p.snapshot().stages.callback.medianMs).toBe(8);
  });
  it('retains background preparation CPU and measures individual slices across worker merges', () => {
    const worker = new FrameProfiler(() => 0),
      main = new FrameProfiler(() => 0);
    worker.preparationSlice(2);
    worker.preparationSlice(3);
    worker.begin(1);
    worker.preparationSlice(1);
    const sample = worker.drain()!;
    expect(sample.ms.prepareSlice).toBe(6);
    main.merge(sample);
    main.begin(1);
    main.end();
    const report = main.snapshot();
    expect(report.stages.prepareSlice).toEqual({ count: 3, medianMs: 2, p95Ms: 3 });
    expect(report.samples[0]!.ms.prepareSlice).toBe(6);
  });
  it('keeps only its bounded chronological window and clears active samples on reset', () => {
    const p = new FrameProfiler(() => 0);
    for (let i = 0; i < PROFILE_CAPACITY + 3; i++) {
      p.begin(i);
      p.end();
    }
    const report = p.snapshot();
    expect(report.dropped).toBe(3);
    expect(report.spanMs).toBe(PROFILE_CAPACITY - 1);
    const s = report.samples;
    expect(s).toHaveLength(PROFILE_CAPACITY);
    expect(s[0]!.at).toBe(3);
    expect(s.at(-1)!.at).toBe(PROFILE_CAPACITY + 2);
    p.begin(999);
    p.reset();
    p.end();
    expect(p.snapshot().samples).toHaveLength(0);
    expect(p.snapshot().dropped).toBe(0);
    expect(p.snapshot().spanMs).toBe(0);
  });
});
