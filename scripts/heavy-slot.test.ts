import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEAVY_SLOTS, withHeavySlot } from './heavy-slot';

let directory: string;
const env = {};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'heavy-slot-'));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

/** A job that runs until released, recording when it starts and ends. */
function holder(events: string[], name: string) {
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  return {
    release,
    job: async () => {
      events.push(`start ${name}`);
      await done;
      events.push(`end ${name}`);
    },
  };
}
// Polls instead of sleeping a fixed time, so a loaded machine only makes the test slower.
const until = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 20 });

describe('withHeavySlot', () => {
  it(`runs ${HEAVY_SLOTS} jobs at once and queues the next until one finishes`, async () => {
    const events: string[] = [],
      waits: string[] = [];
    const jobs = ['a', 'b', 'c'].map((name) => holder(events, name));
    const runs = jobs.map((h) =>
      withHeavySlot(h.job, { directory, env, log: (message) => waits.push(message) }),
    );
    // The third job announces that it waits only after both slots are taken.
    await until(() => expect(waits).toHaveLength(1));
    expect(events).toHaveLength(2);
    jobs['abc'.indexOf(events[0]!.slice('start '.length))]!.release();
    await until(() => expect(events.filter((e) => e.startsWith('start'))).toHaveLength(3));
    for (const h of jobs) h.release();
    await Promise.all(runs);
  });

  it('runs an exclusive job only once every slot is free', async () => {
    const events: string[] = [],
      waits: string[] = [];
    const a = holder(events, 'a'),
      perf = holder(events, 'perf');
    const first = withHeavySlot(a.job, { directory, env, log: () => {} });
    await until(() => expect(events).toEqual(['start a']));
    const exclusive = withHeavySlot(perf.job, {
      directory,
      env,
      exclusive: true,
      log: (message) => waits.push(message),
    });
    await until(() => expect(waits).toHaveLength(1));
    expect(events).toEqual(['start a']);
    a.release();
    await until(() => expect(events).toEqual(['start a', 'end a', 'start perf']));
    perf.release();
    await Promise.all([first, exclusive]);
  });

  it('skips the queue in CI', async () => {
    const events: string[] = [];
    const held = [0, 1, 2].map((i) => holder(events, String(i)));
    const runs = held.map((h) => withHeavySlot(h.job, { directory, env: { CI: 'true' } }));
    await until(() => expect(events).toHaveLength(3));
    for (const h of held) h.release();
    await Promise.all(runs);
  });
});
