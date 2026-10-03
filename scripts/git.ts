import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** `git worktree list --porcelain` as `{ path, branch }`, the main checkout first. */
export function listWorktrees(repo: string): { path: string; branch: string | null }[] {
  return execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .trim()
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
      const ref = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
      return { path: resolve(path ?? ''), branch: ref?.replace(/^refs\/heads\//, '') ?? null };
    });
}

export function mainCheckout(repo: string, worktrees = listWorktrees(repo)): string {
  const main = worktrees[0];
  if (!main) throw new Error(`No main checkout for ${repo}`);
  return main.path;
}
