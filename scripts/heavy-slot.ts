import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire } from './file-lock';

/** Heavy jobs (site builds, e2e, perf) that may run at once across every worktree on this machine. */
export const HEAVY_SLOTS = 2;

export type HeavySlotOptions = {
  /** Take every slot: perf measurements are meaningless while other heavy jobs run. */
  exclusive?: boolean;
  env?: Record<string, string | undefined>;
  directory?: string;
  log?: (message: string) => void;
};

/**
 * Run `job` once a machine-wide heavy slot is free. Several agent sessions share one machine;
 * without this, parallel builds and software-WebGL browsers starve each other's tests into
 * timeouts. CI runners are not shared, so the queue is skipped there.
 */
export async function withHeavySlot<T>(
  job: () => Promise<T>,
  options: HeavySlotOptions = {},
): Promise<T> {
  const env = options.env ?? process.env;
  if (env.CI) return job();
  const directory = options.directory ?? join(tmpdir(), 'atlas-heavy-slots');
  const log = options.log ?? ((message: string) => console.log(`[heavy] ${message}`));
  const paths = Array.from({ length: HEAVY_SLOTS }, (_, i) => join(directory, `slot-${i}.lock`));
  const release = await acquire(paths, {
    count: options.exclusive ? HEAVY_SLOTS : 1,
    // Queues behind other sessions' builds and perf runs can be long; never fail a job for waiting.
    timeoutMs: 2 * 60 * 60_000,
    onWait: () =>
      log(
        options.exclusive
          ? 'waiting for every heavy slot (exclusive run)'
          : 'waiting for a heavy slot; other worktrees are building or testing',
      ),
    timeoutMessage: 'Timed out waiting for a heavy slot.',
  });
  try {
    return await job();
  } finally {
    await release();
  }
}
