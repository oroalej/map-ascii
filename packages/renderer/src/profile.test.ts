import { describe, expect, it } from 'vitest';
import { FrameProfiler, PROFILE_CAPACITY } from './profile';

describe('bounded frame profiles', () => {
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
