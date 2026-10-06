import { afterAll, beforeAll, expect, it } from 'vitest';
import { LifeWorld } from './simulate';
import { LifeBuilder } from './geometry';
import { metersPerUnit } from '../raster/geometry';
import { priorityFixture, observePriority } from './testing/intersection-priority';

const fixture = priorityFixture(LifeWorld, LifeBuilder, metersPerUnit),
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
  it(`observes crossroads entries, safety and finite clearing in window ${window + 1}`, () => {
    expect(result.seconds).toBeCloseTo(180);
    expect(result.indexedJunctions).toBeGreaterThan(0);
    expect(result.requests).toBeGreaterThan(0);
    expect(result.entriesPer60[window]).toBeGreaterThanOrEqual([10, 12, 4][window]!);
    for (let arm = 0; arm < 4; arm++) {
      expect(result.crossingsPerArmPer60[window]![arm]).toBeGreaterThanOrEqual(
        [
          [2, 3, 2, 3],
          [3, 3, 3, 3],
          [2, 0, 2, 0],
        ][window]![arm]!,
      );
      expect(result.crossingClearSecondsPer60[window]![arm]).toBeGreaterThan(0);
      expect(result.walkerDistancePer60[window]![arm]).toBeGreaterThan(0);
    }
    expect(result.pedestrianEpisodes.every((n) => n > 0)).toBe(true);
    expect(result.unsafeEntries).toBe(0);
    expect(result.unsafeEntriesPer60[window]).toBe(0);
  });
}
it('enters from every crossroads arm over the complete run', () => {
  for (let arm = 0; arm < 4; arm++)
    expect(result.crossingsPerArmPer60.reduce((sum, row) => sum + row[arm]!, 0)).toBeGreaterThan(0);
});
it('bounds the corrected crossroads fixture measurements', () => {
  expect(result.maxWaited).toBeLessThanOrEqual(53.14 + 1e-6);
  expect(result.peakStall).toBeLessThanOrEqual(50.4 + 1e-6);
  expect(result.stallsOver30).toBeLessThanOrEqual(2);
  expect(result.twoCarFreezes).toBeLessThanOrEqual(1);
});
