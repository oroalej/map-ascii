import { afterAll, expect, it } from 'vitest';
import { LifeWorld } from './simulate';
import { LifeBuilder } from './geometry';
import { metersPerUnit } from '../raster/geometry';
import { priorityFixture, observePriority } from './testing/intersection-priority';

const fixture = priorityFixture(LifeWorld, LifeBuilder, metersPerUnit, true),
  observer = observePriority(fixture);

afterAll(() => observer.restore());
for (let window = 0; window < 3; window++)
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
    // Throughput/wait gates are measured separately and carried as unmet in the PR.
    expect(result.unsafeEntries).toBe(0);
  });
