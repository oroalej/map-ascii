import { afterAll, expect, it } from 'vitest';
import { priorityReplaySteps } from './testing/priority-replay';

const steps = priorityReplaySteps(30);
afterAll(() => steps.return());

it.each([0, 1, 2, 3])('replays complete 30 Hz priority state through section %s', (section) => {
  expect(steps.next().done === true).toBe(section === 3);
});
