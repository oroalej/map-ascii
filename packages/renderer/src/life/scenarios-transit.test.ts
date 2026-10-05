import { expect, it } from 'vitest';
import { soak } from './testing/scenario-checks';

// Split from scenarios.test.ts: Vitest runs files in parallel, so each 180-second soak gets its own.
// eslint-disable-next-line no-restricted-syntax -- a 180 s soak; tracked by the CI file budget
it('transit, seed 1: 180 seconds retain finite positions and valid ownership', () => {
  const { visits, services, states } = soak('transit', 1);
  expect(visits).toBeGreaterThan(0);
  expect(services).toBeGreaterThan(0);
  expect(states.has('wait')).toBe(true);
}, 30_000);
