/**
 * Stop processes started from a task's worktree (scripts/worktree-processes.ts):
 *   pnpm worktree:stop <branch> [--dry-run]
 * Run it from the main checkout before `pnpm worktree:remove`. It never stops the calling
 * process's ancestors or other agent sessions.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { listWorktrees } from './git';
import { ancestry, listProcesses, stopProcesses, worktreeHolders } from './worktree-processes';
import type { ProcessInfo } from './worktree-processes';

export function parseWorktreeStopArgs(args: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: args.filter((arg) => arg !== '--'),
    options: { 'dry-run': { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  const [name, ...rest] = positionals;
  if (!name || rest.length > 0) throw new Error('Expected exactly one branch name');
  return { branch: name, dryRun: values['dry-run'] ?? false };
}

export function formatHolder(verb: string, p: ProcessInfo): string {
  const command = (p.commandLine ?? p.executable ?? '').replace(/\s+/g, ' ').trim();
  return `${verb} ${p.pid} ${p.name} ${command.length > 200 ? `${command.slice(0, 199)}…` : command}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let options: ReturnType<typeof parseWorktreeStopArgs>;
  try {
    options = parseWorktreeStopArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error('usage: pnpm worktree:stop <branch> [--dry-run]  (run from the main checkout)');
    process.exit(2);
  }
  const { branch, dryRun } = options;
  try {
    const worktrees = listWorktrees(process.cwd());
    const index = worktrees.findIndex((w) => w.branch === branch);
    if (index === 0) throw new Error(`${branch} is checked out in the main checkout`);
    const worktree = worktrees[index]?.path;
    if (!worktree) {
      console.log('worktree: none');
      process.exit(0);
    }
    const processes = listProcesses();
    const holders = worktreeHolders(processes, worktree, ancestry(process.pid, processes));
    if (holders.length === 0) console.log('no processes');
    const failed = dryRun ? [] : await stopProcesses(holders, processes);
    for (const p of holders)
      console.log(
        formatHolder(
          dryRun ? 'would stop' : failed.includes(p.pid) ? 'could not stop' : 'stopped',
          p,
        ),
      );
    if (failed.length > 0) process.exit(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
