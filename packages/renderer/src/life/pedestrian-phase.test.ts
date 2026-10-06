import { expect, it } from 'vitest';
import { pedestrianState, signalState } from './signals';
import { SIGNAL } from './config';

it('grants walk or clearance only while the crossed inbound group is red over 200 full cycles', () => {
  let walk = 0,
    flash = 0,
    dont = 0;
  for (let seed = 0; seed < 200; seed++)
    for (const midBlock of [false, true]) {
      const a = midBlock ? SIGNAL.midBlock.green : SIGNAL.greenA[0] + (seed % 16);
      const b = midBlock ? SIGNAL.midBlock.walk : SIGNAL.greenB[0] + ((seed >>> 8) % 16);
      const cycle = a + b + (midBlock ? 1 : 2) * SIGNAL.amber + 2 * SIGNAL.allRed;
      for (let tenth = 0; tenth < cycle * 10; tenth++) {
        const clock = tenth / 10,
          vehicle = signalState(seed, clock, midBlock);
        for (const group of ['a', 'b'] as const) {
          const pedestrian = pedestrianState(seed, clock, midBlock, group);
          if (pedestrian === 'dont') {
            dont++;
            continue;
          }
          if (pedestrian === 'walk') walk++;
          else flash++;
          if (midBlock) {
            expect(group).toBe('a');
            expect(vehicle.a).toBe('red');
            expect(vehicle.b).toBe('red');
          } else expect(vehicle[group === 'a' ? 'b' : 'a']).toBe('red');
          expect(vehicle.left >= SIGNAL.walkMin).toBe(pedestrian === 'walk');
        }
      }
    }
  expect(walk).toBeGreaterThan(0);
  expect(flash).toBeGreaterThan(0);
  expect(dont).toBeGreaterThan(0);
});

it('pins walk-to-flash boundaries and never gives mid-block group b a walk', () => {
  expect(pedestrianState(0, 15, false, 'a')).toBe('walk');
  expect(pedestrianState(0, 15.001, false, 'a')).toBe('flash');
  expect(pedestrianState(0, 20, false, 'a')).toBe('dont');
  for (let i = 0; i < 570; i++) expect(pedestrianState(0, i / 10, true, 'b')).toBe('dont');
});
