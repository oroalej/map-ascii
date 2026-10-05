import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Resolve once so baseline snapshotting uses a commit, with no shell or option parsing. */
export async function resolveBaselineRevision(root: string, revision: string): Promise<string> {
  if (!revision) throw new Error('Provide --baseline=<revision>');
  try {
    const { stdout } = await run(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
      { cwd: root },
    );
    return stdout.trim();
  } catch (cause) {
    throw new Error(`Unable to resolve baseline revision "${revision}" to a commit`, { cause });
  }
}
