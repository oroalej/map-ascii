import { it } from 'vitest';
import { soak } from './testing/scenario-checks';

// Split from scenarios.test.ts: Vitest runs files in parallel, so each 180-second soak gets its own.
// eslint-disable-next-line no-restricted-syntax -- a 180 s soak; tracked by the CI file budget
it('junction, seed 1: 180 seconds retain finite positions and valid ownership', () => {
  // soak asserts the ownership and capacity invariants throughout.
  soak('junction', 1);
}, 30_000);
