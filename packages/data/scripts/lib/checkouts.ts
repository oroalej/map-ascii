import { execFileSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';

/** Worktree paths in `git worktree list --porcelain` output, the main checkout first. */
export function worktreePaths(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);

/**
 * Where the other checkouts of this repository (git worktrees) keep the download saved at `file`
 * under `rawRoot` (`packages/data/raw/`), the main checkout first. A new worktree starts with no
 * downloads, so it can reuse theirs instead of asking Overpass again. None outside a git checkout.
 */
export function copiesElsewhere(rawRoot: string): (file: string) => string[] {
  const root = resolve(rawRoot, '../../..');
  let others: string[] = [];
  try {
    const porcelain = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    others = worktreePaths(porcelain).filter((path) => !samePath(path, root));
  } catch {
    // Not a git checkout (or no git): only this checkout's downloads.
  }
  return (file) =>
    others.map((checkout) => join(checkout, 'packages/data/raw', relative(rawRoot, file)));
}
