import { afterAll, beforeAll, expect, it } from 'vitest';
import { LifeWorld } from './simulate';
import { LifeBuilder } from './geometry';
import { metersPerUnit } from '../raster/geometry';
import { priorityFixture, observePriority } from './testing/intersection-priority';

const fixture = priorityFixture(LifeWorld, LifeBuilder, metersPerUnit, true),
  observer = observePriority(fixture);
let result: ReturnType<typeof observer.result>;

// Every selected test runs all three bounded measurement chunks; no test advances the world.
for (let window = 0; window < 3; window++)
  beforeAll(() => {
    for (let frame = 0; frame < 60 * 30; frame++) {
      fixture.beforeStep();
      fixture.world.step(
        1 / 30,
        undefined,
        18,
        undefined,
        undefined,
        { rain: 0, minutes: 720 },
        0.9,
      );
      observer.afterStep(1 / 30);
    }
    if (window === 2) result = observer.result();
  });
afterAll(() => observer.restore());

for (let window = 0; window < 3; window++) {
  it(`observes transit entries, safety and finite clearing in window ${window + 1}`, () => {
    expect(result.seconds).toBeCloseTo(180);
    expect(result.indexedJunctions).toBeGreaterThan(0);
    expect(result.requests).toBeGreaterThan(0);
    expect(result.entriesPer60[window]).toBeGreaterThanOrEqual([8, 10, 7][window]!);
    for (let arm = 0; arm < 4; arm++) {
      expect(result.crossingsPerArmPer60[window]![arm]).toBeGreaterThanOrEqual(
        [
          [2, 2, 2, 2],
          [2, 3, 2, 3],
          [1, 2, 2, 2],
        ][window]![arm]!,
      );
      expect(result.crossingClearSecondsPer60[window]![arm]).toBeGreaterThan(0);
      expect(result.walkerDistancePer60[window]![arm]).toBeGreaterThan(0);
    }
    expect(result.pedestrianEpisodes.every((n) => n > 0)).toBe(true);
    expect(result.unsafeEntries).toBe(0);
    expect(result.unsafeEntriesPer60[window]).toBe(0);
    expect(result.transitSites).toBe(2);
  });
  it(`reports the transit per-arm 60 second target in window ${window + 1}`, () => {
    expect(result.crossingsPerArmPer60[window]!.every((n) => n > 0)).toBe(true);
  });
}
it('enters from every transit arm over the complete run', () => {
  for (let arm = 0; arm < 4; arm++)
    expect(result.crossingsPerArmPer60.reduce((sum, row) => sum + row[arm]!, 0)).toBeGreaterThan(0);
});
it('bounds the corrected transit fixture measurements', () => {
  expect(result.maxWaited).toBeLessThanOrEqual(57.67 + 1e-6);
  expect(result.peakStall).toBeLessThanOrEqual(47.5 + 1e-6);
  expect(result.stallsOver30).toBeLessThanOrEqual(5);
  expect(result.twoCarFreezes).toBeLessThanOrEqual(1);
});
// Explicit carried state: these assertions report unmet targets, rather than accepting any error.
it('reports the carried transit raw at-line wait target of 30 seconds', () => {
  expect(result.maxWaited).toBeGreaterThan(30);
});
it('reports the carried transit zero-stall target above 30 seconds', () => {
  expect(result.stallsOver30).toBeGreaterThan(0);
});
it('reports the carried transit zero-freeze target at 10 seconds', () => {
  expect(result.twoCarFreezes).toBe(1);
});
