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
import { listWorktrees, mainCheckout } from './git';
import { withCleanupError } from './fs-cleanup';

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
  /** No branch, registration, or recorded folder remains; safe for merged cleanup reruns. */
  alreadyRemoved: boolean;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const succeeds = (cwd: string, ...args: string[]) =>
  spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0;

const isSelfOrDescendant = (path: string, folder: string) => {
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
    /^(?:(?:(?:apps|packages)\/[^/]+\/)?(?:node_modules|coverage|blob-report)|(?:apps\/web\/)?(?:\.next|out|test-results|playwright-report)|packages\/data\/build|\.turbo)\/$/.test(
      path,
    ) || /^(?:(?:apps|packages)\/[^/]+\/)?(?:\.eslintcache|tsconfig\.tsbuildinfo)$/.test(path)
  );
}

/** Published artifacts are reproducible when they match a lock reachable from the captured head. */
function generatedFiles(main: string, worktree: string, head: string): (path: string) => boolean {
  const hashes = new Map<string, Map<string, Set<string>>>();
  const pinnedTile = (path: string): boolean => {
    const match = /^apps\/web\/public\/tiles\/([a-z0-9][a-z0-9-]*)\.[^/]+$/.exec(path);
    if (!match) return false;
    try {
      if (!lstatSync(join(worktree, path)).isFile()) return false;
      const city = match[1]!;
      if (!hashes.has(city)) {
        const files = new Map<string, Set<string>>();
        hashes.set(city, files);
        const lockPath = `packages/content/cities/${city}/tiles.lock.json`;
        const versions = new Set([
          head,
          ...git(main, 'log', '--full-history', '--format=%H', head, '--', lockPath)
            .split(/\r?\n/)
            .filter(Boolean),
        ]);
        for (const version of versions) {
          try {
            const lock = TilesLock.parse(JSON.parse(git(main, 'show', `${version}:${lockPath}`)));
            for (const [name, hash] of Object.entries(lock.files)) {
              if (!files.has(name)) files.set(name, new Set());
              files.get(name)!.add(hash);
            }
          } catch {
            // A deleted or invalid historical lock is not proof of a published artifact.
          }
        }
      }
      const name = path.slice('apps/web/public/tiles/'.length);
      const accepted = hashes.get(city)?.get(name);
      return (
        accepted !== undefined &&
        accepted.has(
          createHash('sha256')
            .update(readFileSync(join(worktree, path)))
            .digest('hex'),
        )
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

function metadataDirectories(common: string): string[] {
  const directory = join(common, 'worktrees');
  return existsSync(directory)
    ? readdirSync(directory)
        .map((name) => join(directory, name))
        .filter((path) => lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink())
    : [];
}

function worktreeMetadata(common: string, worktree: string): string {
  // Resolve by the registered path even when an interruption removed the .git pointer.
  const matches = metadataDirectories(common).filter((path) => {
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
  });
  if (matches.length !== 1) {
    throw new Error(
      `Cannot establish safe status for ${worktree}: worktree Git metadata is missing or ambiguous`,
    );
  }
  return matches[0]!;
}

function refuseActiveOperation(common: string, branch: string): void {
  for (const metadata of [common, ...metadataDirectories(common)]) {
    for (const name of ['rebase-merge/head-name', 'rebase-apply/head-name', 'BISECT_START']) {
      const path = join(metadata, name);
      if (!existsSync(path)) continue;
      const owner = readFileSync(path, 'utf8')
        .trim()
        .replace(/^refs\/heads\//, '');
      if (owner.toLowerCase() === branch.toLowerCase()) {
        throw new Error(`${branch} has an active rebase or bisect; nothing was removed`);
      }
    }
  }
}

function worktreeStatus(main: string, metadata: string, worktree: string): string[] {
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
  const worktrees = listWorktrees(repo);
  const main = mainCheckout(repo, worktrees);
  const [primary, ...others] = worktrees;
  const refs = git(main, 'for-each-ref', '--format=%(refname)', 'refs/heads/')
    .split(/\r?\n/)
    .map((ref) => ref.slice('refs/heads/'.length));
  if (!refs.includes(branch) && refs.some((name) => name.toLowerCase() === branch.toLowerCase())) {
    throw new Error(`Use the exact branch spelling for ${branch}; nothing was removed`);
  }
  if (branch === 'main') throw new Error('Refusing to remove main');
  if (
    worktrees.some(
      (entry) =>
        entry.branch !== null &&
        entry.branch !== branch &&
        entry.branch.toLowerCase() === branch.toLowerCase(),
    )
  ) {
    throw new Error(`Worktree branch spelling differs from ${branch}; nothing was removed`);
  }
  if (primary?.branch === branch) {
    throw new Error(`${branch} is checked out in the main checkout ${main}`);
  }
  let locatedWorktree = others.find((entry) => entry.branch === branch)?.path ?? null;
  const branchExists = refs.includes(branch);
  const common = resolve(main, git(main, 'rev-parse', '--git-common-dir'));
  const markers = join(common, 'atlas-worktree-removal');
  const marker = join(markers, encodeURIComponent(branch));
  const previous = readMarker(marker);
  if (existsSync(marker) && previous === null) {
    throw new Error(
      `Removal marker pending for ${branch}: unreadable or ambiguous recovery metadata`,
    );
  }
  const head = branchExists ? git(main, 'rev-parse', `refs/heads/${branch}`) : null;
  refuseActiveOperation(common, branch);
  if (!locatedWorktree && previous && existsSync(previous.worktree)) {
    if (previous.head !== head || isSelfOrDescendant(main, previous.worktree)) {
      throw new Error(`Removal marker pending for ${branch}: recorded folder still needs recovery`);
    }
    locatedWorktree = resolve(previous.worktree);
  }
  const worktree = locatedWorktree;
  const resumed =
    worktree !== null &&
    previous !== null &&
    relative(resolve(previous.worktree), worktree) === '' &&
    previous.head === head;
  if (!dryRun && !resumed) rmSync(marker, { force: true });
  if (!worktree && !branchExists) {
    return {
      worktree: null,
      removedWorktree: false,
      deletedBranch: false,
      resumed: false,
      alreadyRemoved: true,
    };
  }
  if (!head || !succeeds(main, 'merge-base', '--is-ancestor', head, mergedInto)) {
    throw new Error(`${branch} is not merged into ${mergedInto}; nothing was removed`);
  }
  const folderExists = worktree !== null && existsSync(worktree);
  if (folderExists) {
    const metadata = worktreeMetadata(common, worktree);
    if (
      git(main, '--git-dir', metadata, 'symbolic-ref', '--quiet', 'HEAD') !== `refs/heads/${branch}`
    ) {
      throw new Error(`Cannot establish safe status for ${worktree}: branch ownership differs`);
    }
    const generated = generatedFiles(main, worktree, head);
    const changes = worktreeStatus(main, metadata, worktree).filter((entry) => {
      if (entry.startsWith('!! '))
        return !disposableIgnored(entry.slice(3)) && !generated(entry.slice(3));
      if (entry.startsWith('?? ')) return !generated(entry.slice(3));
      return !(resumed && entry.slice(0, 2) === ' D');
    });
    if (changes.length)
      throw new Error(
        `${worktree} has uncommitted changes or protected ignored files:\n${changes.join('\n')}`,
      );
    if (isSelfOrDescendant(cwd, worktree)) {
      throw new Error(`The current directory is inside ${worktree}. Run this from ${main}.`);
    }
  }
  const result = {
    worktree,
    removedWorktree: folderExists,
    deletedBranch: branchExists,
    resumed,
    alreadyRemoved: false,
  };
  if (dryRun) return result;

  if (folderExists) {
    mkdirSync(markers, { recursive: true });
    writeFileSync(marker, JSON.stringify({ worktree, head }));
    withCleanupError(
      worktree,
      'deleted',
      () => {
        remove(worktree);
      },
      ' The branch was kept.',
    );
  }
  // Remove only this registration; global pruning destroys other sessions' recovery metadata.
  if (worktree) git(main, 'worktree', 'remove', '--force', worktree);
  // Compare-and-delete preserves any newer branch head another session created meanwhile.
  if (branchExists) git(main, 'update-ref', '-d', `refs/heads/${branch}`, head);
  rmSync(marker, { force: true });
  return result;
}
