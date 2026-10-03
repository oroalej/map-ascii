/**
 * Remove a merged task's worktree folder and local branch (the counterpart of worktree-new.ts).
 * The remote branch is never touched.
 *
 * The folder is deleted in Node because Codex rejects recursive shell deletes
 * (`Remove-Item -Recurse`, `rm -rf`) as "blocked by policy" when it can't ask for approval.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { TilesLock } from '../packages/shared/src/schemas';
import { listWorktrees } from './git';

export { listWorktrees } from './git';

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

function removeFolder(path: string): void {
  const options = { recursive: true, force: true, maxRetries: 3 };
  // Keep Git access and ignore rules intact until all ordinary subtrees were removed.
  for (const name of readdirSync(path).filter((name) => name !== '.git' && name !== '.gitignore')) {
    rmSync(join(path, name), options);
  }
  rmSync(join(path, '.gitignore'), options);
  rmSync(join(path, '.git'), options);
  rmSync(path, options);
}

interface RemovalMarker {
  worktree: string;
  head: string;
}

function readMarker(path: string): RemovalMarker | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    return typeof record.worktree === 'string' && typeof record.head === 'string'
      ? { worktree: record.worktree, head: record.head }
      : null;
  } catch {
    return null;
  }
}

/** Explicitly disposable build/dependency caches; local data and configuration stay protected. */
function disposableIgnored(path: string): boolean {
  return (
    /^(?:(?:(?:apps|packages)\/[^/]+\/)?node_modules|(?:apps\/web\/)?(?:\.next|out|test-results|playwright-report)|\.turbo)\/$/.test(
      path,
    ) || /^(?:(?:apps|packages)\/[^/]+\/)?(?:\.eslintcache|tsconfig\.tsbuildinfo)$/.test(path)
  );
}

/** Published artifacts are reproducible only when they match the captured commit's lock. */
function generatedFiles(main: string, worktree: string, head: string): (path: string) => boolean {
  const locks = new Map<string, TilesLock | null>();
  const pinnedTile = (path: string): boolean => {
    const match = /^apps\/web\/public\/tiles\/([a-z0-9][a-z0-9-]*)\.[^/]+$/.exec(path);
    if (!match) return false;
    try {
      if (!lstatSync(join(worktree, path)).isFile()) return false;
      const city = match[1]!;
      if (!locks.has(city)) {
        try {
          locks.set(
            city,
            TilesLock.parse(
              JSON.parse(
                git(main, 'show', `${head}:packages/content/cities/${city}/tiles.lock.json`),
              ),
            ),
          );
        } catch {
          locks.set(city, null);
        }
      }
      const name = path.slice('apps/web/public/tiles/'.length);
      const expected = locks.get(city)?.files[name];
      return (
        expected !== undefined &&
        createHash('sha256')
          .update(readFileSync(join(worktree, path)))
          .digest('hex') === expected
      );
    } catch {
      return false;
    }
  };
  return (path) => {
    if (path === 'apps/web/next-env.d.ts') {
      return lstatSync(join(worktree, path)).isFile();
    }
    if (path === 'apps/web/public/tiles/') {
      return readdirSync(join(worktree, path)).every((name) => pinnedTile(`${path}${name}`));
    }
    return pinnedTile(path);
  };
}

function worktreeStatus(main: string, common: string, worktree: string): string[] {
  let metadata: string;
  if (existsSync(join(worktree, '.git'))) {
    metadata = git(worktree, 'rev-parse', '--absolute-git-dir');
  } else {
    // A previous removal may have deleted the pointer before it reached a busy file.
    const directory = join(common, 'worktrees');
    const matches = existsSync(directory)
      ? readdirSync(directory)
          .map((name) => join(directory, name))
          .filter((path) => {
            try {
              return (
                relative(
                  resolve(readFileSync(join(path, 'gitdir'), 'utf8').trim()),
                  join(worktree, '.git'),
                ) === ''
              );
            } catch {
              return false;
            }
          })
      : [];
    if (matches.length !== 1)
      throw new Error(
        `Cannot establish safe status for ${worktree}: worktree Git metadata is missing or ambiguous`,
      );
    metadata = matches[0]!;
  }
  // -z avoids quoted filenames; do not trim away the leading status column in " D".
  return execFileSync(
    'git',
    [
      '--git-dir',
      metadata,
      '--work-tree',
      worktree,
      'status',
      '--porcelain',
      '--ignored=matching',
      '--untracked-files=all',
      '-z',
    ],
    { cwd: main, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .split('\0')
    .filter(Boolean);
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
  const common = resolve(main, git(main, 'rev-parse', '--git-common-dir'));
  const markers = join(common, 'atlas-worktree-removal');
  const marker = join(markers, encodeURIComponent(branch));
  const previous = readMarker(marker);
  const head = branchExists ? git(main, 'rev-parse', `refs/heads/${branch}`) : null;
  const resumed =
    worktree !== null &&
    previous !== null &&
    relative(resolve(previous.worktree), worktree) === '' &&
    previous.head === head;
  if (!dryRun && !resumed) rmSync(marker, { force: true });
  if (!worktree && !branchExists) throw new Error(`No local branch or worktree for ${branch}`);
  if (!head || !succeeds(main, 'merge-base', '--is-ancestor', head, mergedInto)) {
    throw new Error(`${branch} is not merged into ${mergedInto}; nothing was removed`);
  }
  const folderExists = worktree !== null && existsSync(worktree);
  if (folderExists) {
    const generated = generatedFiles(main, worktree, head);
    const changes = worktreeStatus(main, common, worktree).filter((entry) => {
      if (entry.startsWith('!! '))
        return !disposableIgnored(entry.slice(3)) && !generated(entry.slice(3));
      if (entry.startsWith('?? ')) return !generated(entry.slice(3));
      return !(resumed && entry.slice(0, 2) === ' D');
    });
    if (changes.length)
      throw new Error(
        `${worktree} has uncommitted changes or protected ignored files:\n${changes.join('\n')}`,
      );
    if (inside(cwd, worktree)) {
      throw new Error(`The current directory is inside ${worktree}. Run this from ${main}.`);
    }
  }
  const result = { worktree, removedWorktree: folderExists, deletedBranch: branchExists, resumed };
  if (dryRun) return result;

  if (folderExists) {
    mkdirSync(markers, { recursive: true });
    writeFileSync(marker, JSON.stringify({ worktree, head }));
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
  // Compare-and-delete preserves any newer branch head another session created meanwhile.
  if (branchExists) git(main, 'update-ref', '-d', `refs/heads/${branch}`, head);
  rmSync(marker, { force: true });
  return result;
}
