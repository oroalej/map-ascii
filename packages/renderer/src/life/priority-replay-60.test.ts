import { afterAll, beforeAll, expect, it } from 'vitest';
import { priorityReplaySteps } from './testing/priority-replay';
const steps = priorityReplaySteps(60);
const completed: boolean[] = [];
afterAll(() => steps.return());
for (let section = 0; section < 4; section++) {
  beforeAll(() => {
    completed.push(steps.next().done === true);
  });
  it(`replays complete 60 Hz priority state through section ${section + 1}`, () => {
    expect(completed[section]).toBe(section === 3);
  });
}
