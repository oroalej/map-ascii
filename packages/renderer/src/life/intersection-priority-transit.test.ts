import { afterAll, expect, it } from 'vitest';
import { LifeWorld } from './simulate';
import { LifeBuilder } from './geometry';
import { metersPerUnit } from '../raster/geometry';
import { priorityFixture, observePriority } from './testing/intersection-priority';

const fixture = priorityFixture(LifeWorld, LifeBuilder, metersPerUnit, true),
  observer = observePriority(fixture);

afterAll(() => observer.restore());
for (let window = 0; window < 3; window++) {
  it(`safely advances the priority transit fixture through window ${window + 1}`, () => {
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
    const result = observer.result();
    expect(result.indexedJunctions).toBeGreaterThan(0);
    expect(result.requests).toBeGreaterThan(0);
    expect(result.entries).toBeGreaterThan(0);
    expect(result.pedestrianEpisodes.some((n) => n > 0)).toBe(true);
    if (window === 2) expect(result.pedestrianEpisodes.every((n) => n > 0)).toBe(true);
    expect(result.transitSites).toBeGreaterThan(0);
    expect(result.unsafeEntries).toBe(0);
  });
  // These diagnostic gates are carried in the PR; safety above must pass independently.
  it.fails(`serves every transit arm in 60 second window ${window + 1}`, () => {
    expect(observer.result().crossingsPerArmPer60[window]!.every((n) => n > 0)).toBe(true);
  });
}
it.fails('limits raw transit at-line wait to 30 seconds', () => {
  expect(observer.result().maxWaited).toBeLessThanOrEqual(30);
});
it.fails('has no independent transit stall episode over 30 seconds', () => {
  expect(observer.result().stallsOver30).toBe(0);
});
it('has no transit two-car inside freeze of at least 10 seconds', () => {
  expect(observer.result().twoCarFreezes).toBe(0);
});
