import { afterAll, beforeAll, expect, it } from 'vitest';
import { LifeWorld } from '../simulate';
import { LifeBuilder } from '../geometry';
import { metersPerUnit } from '../../raster/geometry';
import { observePriority, priorityFixture } from './intersection-priority';

type Result = ReturnType<ReturnType<typeof observePriority>['result']>;
type Scenario = {
  name: string;
  transit?: boolean;
  entries: readonly number[];
  perArm: readonly (readonly number[])[];
  bounds: Pick<Result, 'maxWaited' | 'peakStall' | 'stallsOver30' | 'twoCarFreezes'>;
};

/** Vitest orchestration stays separate from the fixture used by standalone diagnostics. */
export function priorityDiagnostics(spec: Scenario): void {
  const fixture = priorityFixture(LifeWorld, LifeBuilder, metersPerUnit, spec.transit),
    observer = observePriority(fixture);
  let result: Result;

  // Every selected test runs all three bounded chunks; no test advances the world.
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

  for (let window = 0; window < 3; window++)
    it(`observes ${spec.name} entries, safety and finite clearing in window ${window + 1}`, () => {
      expect(result.entriesPer60[window]).toBeGreaterThanOrEqual(spec.entries[window]!);
      for (let arm = 0; arm < 4; arm++) {
        expect(result.crossingsPerArmPer60[window]![arm]).toBeGreaterThanOrEqual(
          spec.perArm[window]![arm]!,
        );
        expect(result.crossingClearSecondsPer60[window]![arm]).toBeGreaterThan(0);
        expect(result.walkerDistancePer60[window]![arm]).toBeGreaterThan(0);
      }
      expect(result.unsafeEntriesPer60[window]).toBe(0);
    });

  it(`observes ${spec.name} run totals and entries from every arm`, () => {
    expect(result.seconds).toBeCloseTo(180);
    expect(result.indexedJunctions).toBeGreaterThan(0);
    expect(result.requests).toBeGreaterThan(0);
    expect(result.pedestrianEpisodes.every((n) => n > 0)).toBe(true);
    expect(result.unsafeEntries).toBe(0);
    for (let arm = 0; arm < 4; arm++)
      expect(result.crossingsPerArmPer60.reduce((sum, row) => sum + row[arm]!, 0)).toBeGreaterThan(
        0,
      );
    if (spec.transit) expect(result.transitSites).toBe(2);
  });

  it(`bounds the corrected ${spec.name} fixture measurements`, () => {
    expect(result.maxWaited).toBeLessThanOrEqual(spec.bounds.maxWaited + 1e-6);
    expect(result.peakStall).toBeLessThanOrEqual(spec.bounds.peakStall + 1e-6);
    expect(result.stallsOver30).toBeLessThanOrEqual(spec.bounds.stallsOver30);
    expect(result.twoCarFreezes).toBeLessThanOrEqual(spec.bounds.twoCarFreezes);
  });
}
