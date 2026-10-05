import { expect, it } from 'vitest';
import { priorityReplaySteps } from './testing/priority-replay';
const steps = priorityReplaySteps(60);
for (let section = 0; section < 4; section++)
  it(`replays complete 60 Hz priority state through section ${section + 1}`, () => {
    expect(steps.next().done).toBe(section === 3);
  });
