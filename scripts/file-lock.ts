import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export type Release = () => Promise<void>;

export type AcquireOptions = {
  /** How many of `paths` to hold at once (default 1). */
  count?: number;
  /** Give up after this long (default 15 minutes: a cold build plus a tile download). */
  timeoutMs?: number;
  /** Called once, the first time the caller has to wait. */
  onWait?: () => void;
  timeoutMessage?: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Only one waiter can reclaim an observed stale owner; never unlink a new owner's lock. */
function reclaim(path: string, observed: string): void {
  const guard = `${path}.reclaim`;
  let fd: number;
  try {
    fd = openSync(guard, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  // Keep this critical section synchronous: there are no awaits between verifying and unlinking.
  try {
    if (readFileSync(path, 'utf8') === observed) unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  } finally {
    closeSync(fd);
    unlinkSync(guard);
  }
}

/** Take the lock file if it is free, reclaiming one whose owner process has exited. */
async function tryLock(path: string): Promise<Release | undefined> {
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeFileSync(fd, owner);
      } finally {
        closeSync(fd);
      }
      return async () => {
        if ((await readFile(path, 'utf8').catch(() => '')) === owner)
          await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let observed = '';
    try {
      observed = await readFile(path, 'utf8');
      const value: unknown = JSON.parse(observed);
      if (
        record(value) &&
        typeof value.pid === 'number' &&
        Number.isInteger(value.pid) &&
        value.pid > 0
      ) {
        try {
          process.kill(value.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            reclaim(path, observed);
            continue;
          }
        }
      } else if (Date.now() - (await stat(path)).mtimeMs > 30_000) {
        reclaim(path, observed);
        continue;
      }
    } catch (error) {
      if (isMissing(error)) continue;
      if (!(error instanceof SyntaxError)) throw error;
      if (Date.now() - (await stat(path)).mtimeMs > 30_000) {
        reclaim(path, observed);
        continue;
      }
    }
    return undefined;
  }
}

/**
 * Hold `count` of the lock files in `paths` (all of them when `count` equals their number),
 * waiting while other processes own them. Locks of exited processes are reclaimed by pid.
 */
export async function acquire(
  paths: readonly string[],
  options: AcquireOptions = {},
): Promise<Release> {
  const count = options.count ?? 1;
  if (count < 1 || count > paths.length) throw new Error('Invalid lock count');
  for (const directory of new Set(paths.map((path) => dirname(path))))
    await mkdir(directory, { recursive: true });
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  const held: Release[] = [];
  const releaseAll = async () => {
    for (const release of held.splice(0)) await release();
  };
  let announced = false;
  try {
    for (;;) {
      for (const path of paths) {
        if (held.length === count) break;
        const release = await tryLock(path);
        if (release) held.push(release);
      }
      if (held.length === count) return releaseAll;
      // Taking several slots: give back partial holds so two exclusive waiters can't deadlock.
      if (count > 1) await releaseAll();
      if (Date.now() > deadline)
        throw new Error(options.timeoutMessage ?? 'Timed out waiting for a lock.');
      if (!announced) {
        options.onWait?.();
        announced = true;
      }
      await delay(count > 1 ? 250 : 100);
    }
  } catch (error) {
    await releaseAll();
    throw error;
  }
}
