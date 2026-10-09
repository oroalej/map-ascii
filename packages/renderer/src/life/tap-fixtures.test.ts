import { expect, it } from 'vitest';
import type { StreetFixture } from './fixtures';
import { tapSignalFixture } from './tap-fixtures';

const fixtures: StreetFixture[] = [
  {
    kind: 'signal',
    group: 'a',
    midBlock: false,
    seed: 11,
    base: [0, 0],
    tip: [0, 1],
    forward: [1, 0],
    right: [0, 1],
  },
  {
    kind: 'pedestrian-signal',
    group: 'b',
    midBlock: true,
    crossing: 'crossing',
    side: 1,
    seed: 22,
    base: [1, 0],
    tip: [1, 1],
    forward: [2, 0],
    right: [1, 1],
  },
];
// Geographic inputs are transformed into drawing cells, where the admission radius applies.
const toCell = (lng: number, lat: number): [number, number] => [lng * 2 + 10, lat * 2 - 4];

it('chooses nearest signal base or tip and preserves mid-block identity', () => {
  expect(tapSignalFixture(fixtures, [0.2, 0], toCell)).toEqual({ seed: 11, midBlock: false });
  expect(tapSignalFixture(fixtures, [0.8, 1.1], toCell)).toEqual({ seed: 22, midBlock: true });
  expect(tapSignalFixture(fixtures, [-0.75, 0], toCell)).toEqual({ seed: 11, midBlock: false });
  expect(tapSignalFixture(fixtures, [-0.7501, 0], toCell)).toBeUndefined();
  expect(tapSignalFixture(fixtures, [1.7501, 1], toCell)).toBeUndefined();
});
