/**
 * Remove a merged task's worktree and local branch (scripts/worktree-removal.ts):
 *   pnpm worktree:remove <branch>
 * Run it from the main checkout. The branch must be merged into origin/main and its worktree
 * clean. The remote branch stays.
 */
import { execFileSync } from 'node:child_process';
import { removeWorktree } from './worktree-removal';

const [branch, ...rest] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!branch || rest.length > 0) {
  console.error('usage: pnpm worktree:remove <branch>  (run from the main checkout)');
  process.exit(2);
}

try {
  execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'inherit' });
  // pnpm runs scripts from the package root; INIT_CWD is where the user ran pnpm.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const { worktree, removedWorktree, deletedBranch } = removeWorktree({
    repo: process.cwd(),
    branch,
    mergedInto: 'origin/main',
    cwd,
  });
  console.log(`worktree: ${removedWorktree ? `removed ${worktree}` : (worktree ?? 'none')}`);
  console.log(`local branch: ${deletedBranch ? `deleted ${branch}` : 'none'}`);
  console.log(`remote branch: kept origin/${branch}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
