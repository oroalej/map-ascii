/**
 * Remove a merged task's worktree folder and local branch (the counterpart of worktree-new.ts).
 * The remote branch is never touched.
 *
 * The folder is deleted in Node because Codex rejects recursive shell deletes
 * (`Remove-Item -Recurse`, `rm -rf`) as "blocked by policy" when it can't ask for approval.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { TilesLock } from '../packages/shared/src/schemas';
import { sha256 } from '../packages/data/scripts/lib/tiles-release';
import { git, gitRaw, gitSucceeds, listWorktrees, mainCheckout } from './git';
import { withCleanupError } from './fs-cleanup';
import { claudeSettingsPath, isGeneratedClaudeSettings } from './claude-worktree-settings';

export { listWorktrees } from './git';

export interface RemoveWorktreeOptions {
  /** Any checkout of the repository; git commands run there. */
  repo: string;
  branch: string;
  /** The ref the branch must already be merged into, e.g. `origin/main`. */
  mergedInto: string;
  /** The merged PR head; refuse a same-name branch that was recreated or advanced. */
  expectedHead?: string;
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
  /** Absent only in markers written by the older, in-place removal. */
  tomb?: string;
  phase?: 'prepared' | 'prepared-legacy' | 'deleting';
}

function readMarker(path: string): RemovalMarker | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.worktree !== 'string' || typeof record.head !== 'string') return null;
    const { worktree, head, tomb, phase } = record;
    if (tomb === undefined && phase === undefined) return { worktree, head };
    if (
      typeof tomb !== 'string' ||
      !isAbsolute(worktree) ||
      !isAbsolute(tomb) ||
      relative(dirname(worktree), dirname(tomb)) !== '' ||
      !basename(tomb).startsWith(`${basename(worktree)}.atlas-removal-`) ||
      !/^[a-f0-9-]{36}$/.test(
        basename(tomb).slice(`${basename(worktree)}.atlas-removal-`.length),
      ) ||
      (phase !== 'prepared' && phase !== 'prepared-legacy' && phase !== 'deleting')
    )
      return null;
    return { worktree, head, tomb, phase };
  } catch {
    return null;
  }
}

function saveMarker(path: string, value: RemovalMarker): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

function realDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Refusing linked or non-directory removal folder ${path}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Explicitly disposable build/dependency caches; local data and configuration stay protected. */
const workspaceCacheDirectories = ['node_modules/', 'coverage/', 'blob-report/'];
const webCacheDirectories = ['.next/', 'out/', 'test-results/', 'playwright-report/'];
const otherCacheDirectories = ['packages/data/build/'];
const workspaceCacheFiles = ['tsconfig.tsbuildinfo'];
const osJunkFiles = ['desktop.ini', 'Thumbs.db', '.DS_Store'];

function disposableIgnored(path: string): boolean {
  const workspacePath = path.replace(/^(?:apps|packages)\/[^/]+\//, '');
  return (
    workspaceCacheDirectories.includes(workspacePath) ||
    workspaceCacheFiles.includes(workspacePath) ||
    (path.startsWith('apps/web/') &&
      webCacheDirectories.includes(path.slice('apps/web/'.length))) ||
    otherCacheDirectories.includes(path) ||
    osJunkFiles.includes(path.split('/').at(-1) ?? '')
  );
}

/** Empty ignored scaffolding is disposable; links, files and unreadable trees are protected. */
function emptyIgnoredTree(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      readdirSync(path).every((name) => emptyIgnoredTree(join(path, name)))
    );
  } catch {
    return false;
  }
}

/** Accept pristine generated setup and artifacts pinned by a lock reachable from the head. */
function createGeneratedFileChecker(
  main: string,
  worktree: string,
  head: string,
): (path: string) => boolean {
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
      return accepted !== undefined && accepted.has(sha256(readFileSync(join(worktree, path))));
    } catch {
      return false;
    }
  };
  return (path) => {
    if (path === claudeSettingsPath) return isGeneratedClaudeSettings(main, worktree);
    if (path === 'apps/web/next-env.d.ts') {
      return lstatSync(join(worktree, path)).isFile();
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

function worktreeMetadata(common: string, worktree: string): string | null {
  // Resolve by the registered path even when an interruption removed the .git pointer.
  const matches = metadataDirectories(common).filter((path) => {
    try {
      return (
        relative(
          resolve(path, readFileSync(join(path, 'gitdir'), 'utf8').trim()),
          join(worktree, '.git'),
        ) === ''
      );
    } catch {
      return false;
    }
  });
  if (matches.length > 1) {
    throw new Error(
      `Cannot establish safe status for ${worktree}: worktree Git metadata is missing or ambiguous`,
    );
  }
  return matches[0] ?? null;
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
  return gitRaw(
    main,
    '--git-dir',
    metadata,
    '--work-tree',
    worktree,
    'status',
    '--porcelain',
    '--ignored=matching',
    '--untracked-files=all',
    '-z',
  )
    .split('\0')
    .filter(Boolean);
}

/**
 * Removes the merged branch's worktree folder and local branch, refusing anything unsafe.
 * Record recovery intent before relocating the folder, then delete only that sibling folder.
 * A directory lock stops relocation without deleting contents. A rerun can finish deletion
 * while preserving newly created work and a recreated original path.
 */
export function removeWorktree({
  repo,
  branch,
  mergedInto,
  expectedHead,
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
  const pinnedHead =
    expectedHead === undefined
      ? undefined
      : git(main, 'rev-parse', '--verify', `${expectedHead}^{commit}`);
  if (head !== null && pinnedHead !== undefined && head !== pinnedHead) {
    throw new Error(`${branch} head differs from expected ${expectedHead}; nothing was removed`);
  }
  refuseActiveOperation(common, branch);
  if (
    previous?.tomb &&
    (head !== null || existsSync(previous.worktree) || existsSync(previous.tomb)) &&
    (previous.head !== head ||
      (locatedWorktree !== null && relative(previous.worktree, locatedWorktree) !== ''))
  ) {
    throw new Error(`Removal marker pending for ${branch}: recorded folder still needs recovery`);
  }
  if (
    !locatedWorktree &&
    previous &&
    (existsSync(previous.worktree) || (previous.tomb && existsSync(previous.tomb)))
  ) {
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
  if (worktree !== null && isSelfOrDescendant(main, worktree)) {
    throw new Error(`Refusing removal folder containing the main checkout ${main}`);
  }
  const originalExists = worktree !== null && realDirectory(worktree);
  const tombExists = resumed && previous.tomb !== undefined && realDirectory(previous.tomb);
  if (originalExists && resumed && previous.tomb && (tombExists || previous.phase === 'deleting')) {
    throw new Error(`Removal marker pending for ${branch}: original worktree path was recreated`);
  }
  if (resumed && previous.tomb && previous.phase !== 'deleting' && !originalExists && !tombExists) {
    throw new Error(`Removal marker pending for ${branch}: prepared folder is missing`);
  }
  let folder = tombExists ? previous.tomb! : worktree;
  const folderExists = folder !== null && realDirectory(folder);
  const metadata = worktree === null ? null : worktreeMetadata(common, worktree);
  if (metadata !== null && existsSync(join(metadata, 'locked'))) {
    throw new Error(`${worktree} is locked (git worktree unlock); nothing was removed`);
  }
  if (
    !worktree &&
    !branchExists &&
    !(previous && gitSucceeds(main, 'merge-base', '--is-ancestor', previous.head, mergedInto)) &&
    !gitSucceeds(main, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`)
  ) {
    throw new Error(`no local branch or worktree named ${branch}`);
  }
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
  if (!head || !gitSucceeds(main, 'merge-base', '--is-ancestor', head, mergedInto)) {
    throw new Error(`${branch} is not merged into ${mergedInto}; nothing was removed`);
  }
  // Legacy in-place cleanup may have removed .git before Git pruned the registration.
  // Only a matching marker and a physically empty real directory replace missing metadata.
  const prunedEmpty =
    folderExists &&
    resumed &&
    metadata === null &&
    !others.some((entry) => relative(entry.path, worktree) === '') &&
    readdirSync(folder!).length === 0 &&
    (previous.tomb === undefined || previous.phase === 'deleting');
  if (worktree !== null && metadata === null && !prunedEmpty) {
    throw new Error(
      `Cannot establish safe status for ${worktree}: worktree Git metadata is missing or ambiguous`,
    );
  }
  const allowDeleted = resumed && previous.phase !== 'prepared';
  const checkStatus = (path: string) => {
    if (metadata === null) return;
    if (
      git(main, '--git-dir', metadata, 'symbolic-ref', '--quiet', 'HEAD') !== `refs/heads/${branch}`
    ) {
      throw new Error(`Cannot establish safe status for ${worktree}: branch ownership differs`);
    }
    const isGeneratedFile = createGeneratedFileChecker(main, path, head);
    const changes = worktreeStatus(main, metadata, path).filter((entry) => {
      if (entry.startsWith('!! '))
        return (
          !disposableIgnored(entry.slice(3)) &&
          !emptyIgnoredTree(join(path, entry.slice(3))) &&
          !isGeneratedFile(entry.slice(3))
        );
      if (entry.startsWith('?? ')) return !isGeneratedFile(entry.slice(3));
      return !(allowDeleted && entry.slice(0, 2) === ' D');
    });
    if (changes.length) {
      const reason = changes.every((entry) => entry.startsWith('!! '))
        ? 'protected ignored files'
        : 'uncommitted changes';
      throw new Error(`${path} has ${reason}:\n${changes.join('\n')}`);
    }
  };
  if (folderExists) {
    checkStatus(folder!);
    if (isSelfOrDescendant(cwd, worktree!) || isSelfOrDescendant(cwd, folder!)) {
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
    let recovery: RemovalMarker;
    if (tombExists) {
      recovery = previous!;
    } else {
      const tomb =
        resumed && previous.tomb
          ? previous.tomb
          : join(dirname(worktree!), `${basename(worktree!)}.atlas-removal-${randomUUID()}`);
      if (existsSync(tomb)) throw new Error(`Removal folder already exists: ${tomb}`);
      recovery = {
        worktree: worktree!,
        tomb,
        head,
        phase: allowDeleted ? 'prepared-legacy' : 'prepared',
      };
      // Persist intent before rename, so a crash on either side is recoverable.
      saveMarker(marker, recovery);
      try {
        renameSync(worktree!, tomb);
      } catch (error) {
        throw new Error(
          `Could not relocate ${worktree}: nothing was removed. Close processes using it and rerun. The branch was kept. (${(error as NodeJS.ErrnoException).code ?? 'rename failed'})`,
        );
      }
      folder = tomb;
    }
    // Check again after relocation to preserve any work created before the rename.
    checkStatus(folder!);
    recovery = { ...recovery, phase: 'deleting' };
    saveMarker(marker, recovery);
    withCleanupError(
      folder!,
      'deleted',
      () => {
        remove(folder!);
      },
      ' The branch was kept.',
    );
  }
  if (worktree && realDirectory(worktree)) {
    throw new Error(`Removal marker pending for ${branch}: original worktree path was recreated`);
  }
  // Remove only this registration; global pruning destroys other sessions' recovery metadata.
  if (worktree && metadata !== null) git(main, 'worktree', 'remove', '--force', worktree);
  // Compare-and-delete preserves any newer branch head another session created meanwhile.
  if (branchExists) {
    git(main, 'update-ref', '-d', `refs/heads/${branch}`, head);
    gitSucceeds(main, 'config', '--remove-section', `branch.${branch}`);
  }
  rmSync(marker, { force: true });
  return result;
}
