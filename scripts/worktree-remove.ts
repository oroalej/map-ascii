/**
 * Remove a merged task's worktree and local branch (scripts/worktree-removal.ts):
 *   pnpm worktree:remove <branch> [--head <sha>] [--dry-run]
 * Run it from the main checkout. The branch must be merged into origin/main and its worktree
 * clean. The remote branch stays. Rerun it to finish a removal that a busy file interrupted.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { removeWorktree } from './worktree-removal';

export function parseWorktreeRemoveArgs(args: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: args.filter((arg) => arg !== '--'),
    options: { 'dry-run': { type: 'boolean' }, head: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const [name, ...rest] = positionals;
  if (!name || rest.length > 0) throw new Error('Expected exactly one branch name');
  return { branch: name, dryRun: values['dry-run'] ?? false, expectedHead: values.head };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let options: ReturnType<typeof parseWorktreeRemoveArgs>;
  try {
    options = parseWorktreeRemoveArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(
      'usage: pnpm worktree:remove <branch> [--head <sha>] [--dry-run]  (run from the main checkout)',
    );
    process.exit(2);
  }
  const { branch, dryRun } = options;
  try {
    execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'inherit' });
    // pnpm runs scripts from the package root; INIT_CWD is where the user ran pnpm.
    const cwd = process.env.INIT_CWD ?? process.cwd();
    const { worktree, removedWorktree, deletedBranch, resumed, alreadyRemoved } = removeWorktree({
      ...options,
      repo: process.cwd(),
      mergedInto: 'origin/main',
      cwd,
    });
    if (alreadyRemoved) {
      console.log(`already removed: ${branch}`);
      console.log(`remote branch: kept origin/${branch}`);
      process.exit(0);
    }
    const verb = (done: string) => (dryRun ? `would ${done.replace(/d$/, '')}` : done);
    if (resumed) console.log('finishing an interrupted removal');
    console.log(
      `worktree: ${removedWorktree ? `${verb('removed')} ${worktree}` : (worktree ?? 'none')}`,
    );
    console.log(`local branch: ${deletedBranch ? `${verb('deleted')} ${branch}` : 'none'}`);
    console.log(`remote branch: kept origin/${branch}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
