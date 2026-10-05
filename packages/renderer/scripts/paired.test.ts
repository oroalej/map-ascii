import { expect, it } from 'vitest';
import { pairedRuns, pooledSummary, withinControl } from './paired';

it.each([true, false])(
  'balances paired ordering with interleaving=%s and discards calibration',
  (interleaved) => {
    const calls: string[] = [],
      results: string[] = [];
    let before = 0,
      after = 0;
    const make = (name: string) => {
      const samples: number[] = [];
      return {
        sample(frame: number, retained: boolean) {
          calls.push(`${name}:${frame}`);
          if (retained) samples.push(frame);
        },
        result() {
          results.push(name);
          return samples;
        },
      };
    };
    const result = pairedRuns(
      () => make(`A${before++}`),
      () => make(`B${after++}`),
      {
        calibration: 2,
        warmup: 1,
        samples: 2,
        runs: 2,
        interleaved,
      },
    );
    expect(calls.slice(0, 4)).toEqual(['A0:0', 'B0:0', 'B0:1', 'A0:1']);
    expect(calls.slice(4)).toEqual(
      interleaved
        ? [
            'A1:0',
            'B1:0',
            'A1:1',
            'B1:1',
            'A1:2',
            'B1:2',
            'B2:0',
            'A2:0',
            'B2:1',
            'A2:1',
            'B2:2',
            'A2:2',
          ]
        : [
            'A1:0',
            'A1:1',
            'A1:2',
            'B1:0',
            'B1:1',
            'B1:2',
            'B2:0',
            'B2:1',
            'B2:2',
            'A2:0',
            'A2:1',
            'A2:2',
          ],
    );
    expect(results).toEqual(['A1', 'B1', 'A2', 'B2']);
    expect(result).toEqual({
      oldRuns: [
        [1, 2],
        [1, 2],
      ],
      currentRuns: [
        [1, 2],
        [1, 2],
      ],
    });
  },
);

it('pools samples rather than quantiles of unequal-sized runs', () => {
  expect(pooledSummary([[100], [1, 2, 3, 4]], (values) => values)).toEqual({ median: 3, p95: 100 });
});

it('checks both control limits inclusively and rejects drift in either direction', () => {
  expect(withinControl({ medianGain: 0.05, p95Change: -0.05 })).toBe(true);
  expect(withinControl({ medianGain: -0.051, p95Change: 0 })).toBe(false);
  expect(withinControl({ medianGain: 0, p95Change: 0.051 })).toBe(false);
  expect(withinControl({ medianGain: NaN, p95Change: 0 })).toBe(false);
});
