import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Preserve status columns and NUL separators for callers that need raw Git output. */
export const gitRaw = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export const git = (cwd: string, ...args: string[]): string => gitRaw(cwd, ...args).trim();
export const gitSucceeds = (cwd: string, ...args: string[]): boolean =>
  spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0;

/** `git worktree list --porcelain` as `{ path, branch }`, the main checkout first. */
export function listWorktrees(repo: string): { path: string; branch: string | null }[] {
  return gitRaw(repo, 'worktree', 'list', '--porcelain')
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
