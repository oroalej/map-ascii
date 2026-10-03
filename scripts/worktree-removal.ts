/**
 * Remove a merged task's worktree folder and local branch (the counterpart of worktree-new.ts).
 * The remote branch is never touched.
 *
 * The folder is deleted in Node because Codex rejects recursive shell deletes
 * (`Remove-Item -Recurse`, `rm -rf`) as "blocked by policy" when it can't ask for approval.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface RemoveWorktreeOptions {
  /** Any checkout of the repository; git commands run there. */
  repo: string;
  branch: string;
  /** The ref the branch must already be merged into, e.g. `origin/main`. */
  mergedInto: string;
  /** Defaults to `process.cwd()`. Windows can't delete a folder some process is using as its cwd. */
  cwd?: string;
  /** Run every check and report what would be removed, without removing anything. */
  dryRun?: boolean;
  /** Deletes the worktree folder; tests replace it to simulate an interrupted removal. */
  remove?: (path: string) => void;
}

export interface RemovalResult {
  /** The branch's worktree folder, or null when git no longer lists one. */
  worktree: string | null;
  removedWorktree: boolean;
  deletedBranch: boolean;
  /** True when this run finishes an earlier, interrupted removal. */
  resumed: boolean;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const succeeds = (cwd: string, ...args: string[]) =>
  spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0;

const inside = (path: string, folder: string) => {
  const rel = relative(resolve(folder), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const removeFolder = (path: string) =>
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });

/** `git worktree list --porcelain` as `{ path, branch }`, the main checkout first. */
export function listWorktrees(repo: string): { path: string; branch: string | null }[] {
  return git(repo, 'worktree', 'list', '--porcelain')
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
      const ref = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
      return { path: resolve(path ?? ''), branch: ref?.replace(/^refs\/heads\//, '') ?? null };
    });
}

/**
 * Removes the merged branch's worktree folder and local branch, refusing anything unsafe.
 * Before deleting, it leaves a marker in the git directory. If a process holds a file and the
 * deletion stops partway, a rerun sees the marker and finishes, instead of refusing the
 * half-deleted worktree as one with uncommitted changes.
 */
export function removeWorktree({
  repo,
  branch,
  mergedInto,
  cwd = process.cwd(),
  dryRun = false,
  remove = removeFolder,
}: RemoveWorktreeOptions): RemovalResult {
  if (branch === 'main') throw new Error('Refusing to remove main');
  const [mainCheckout, ...others] = listWorktrees(repo);
  if (mainCheckout?.branch === branch) {
    throw new Error(`${branch} is checked out in the main checkout ${mainCheckout.path}`);
  }
  const main = mainCheckout!.path;
  const worktree = others.find((entry) => entry.branch === branch)?.path ?? null;
  const branchExists = succeeds(main, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
  if (!worktree && !branchExists) throw new Error(`No local branch or worktree for ${branch}`);
  if (branchExists && !succeeds(main, 'merge-base', '--is-ancestor', branch, mergedInto)) {
    throw new Error(`${branch} is not merged into ${mergedInto}; nothing was removed`);
  }

  const markers = join(
    resolve(main, git(main, 'rev-parse', '--git-common-dir')),
    'atlas-worktree-removal',
  );
  const marker = join(markers, encodeURIComponent(branch));
  const resumed = existsSync(marker);
  const folderExists = worktree !== null && existsSync(worktree);
  if (folderExists) {
    // A resumed run already checked the worktree; the files it deleted now show as changes.
    if (!resumed) {
      const changes = git(worktree, 'status', '--porcelain');
      if (changes) throw new Error(`${worktree} has uncommitted changes:\n${changes}`);
    }
    if (inside(cwd, worktree)) {
      throw new Error(`The current directory is inside ${worktree}. Run this from ${main}.`);
    }
  }
  const result = { worktree, removedWorktree: folderExists, deletedBranch: branchExists, resumed };
  if (dryRun) return result;

  if (folderExists) {
    mkdirSync(markers, { recursive: true });
    writeFileSync(marker, `${worktree}\n`);
    try {
      remove(worktree);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') {
        throw new Error(
          `Partially deleted ${worktree}: a process (dev server, terminal, editor) is using it. ` +
            `Close it and rerun to finish. The branch was kept. (${code})`,
        );
      }
      throw error;
    }
  }
  if (worktree) git(main, 'worktree', 'prune');
  // -D, not -d: -d compares against the possibly stale local main; the merge into
  // `mergedInto` was verified above.
  if (branchExists) git(main, 'branch', '-D', branch);
  rmSync(marker, { force: true });
  return result;
}
