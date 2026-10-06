/**
 * Delete a handoff task's scratch (AGENTS.md "Handoff plans"): everything in
 * `.plans/<status>/<task>/` (or `.plans/done/<group>/<task>/`) except `handoff.md`
 * and the named keep paths.
 *
 * Deletion runs in Node because Codex rejects recursive shell deletes
 * (`Remove-Item -Recurse`, `rm -rf`) as "blocked by policy" when it can't ask for approval.
 */
import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { withCleanupError } from './fs-cleanup';

export const PLAN_STATUSES = ['todo', 'active', 'paused', 'done'] as const;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export interface CleanupResult {
  folder: string;
  /** Deleted paths relative to the task folder (the top-most deleted path of each subtree). */
  deleted: string[];
  /** Kept paths relative to the task folder. */
  kept: string[];
  /** True when nothing was kept, so the folder itself went too (e.g. a `pr<N>-review-fixes/` scratch folder). */
  removedFolder: boolean;
}

const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};
const isDescendant = (path: string, folder: string) => {
  const rel = relative(folder, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * Finds the one task folder, allowing grouped completed tasks while retaining legacy direct
 * done paths. Fails on a bad slug, no or several matches, or linked/out-of-root paths.
 */
export function findTaskFolder(plansRoot: string, task: string): string {
  if (!SLUG.test(task)) {
    throw new Error(`Invalid task "${task}" (lowercase letters, digits and dashes)`);
  }
  const matches = PLAN_STATUSES.flatMap((status) => {
    const direct = join(plansRoot, status, task);
    const paths = [direct];
    if (status === 'done') {
      const doneFolder = join(plansRoot, status);
      const doneStats = lstatOrNull(doneFolder);
      if (doneStats?.isDirectory() && !doneStats.isSymbolicLink()) {
        for (const group of readdirSync(doneFolder, { withFileTypes: true })) {
          if (group.isDirectory() && !group.isSymbolicLink())
            paths.push(join(doneFolder, group.name, task));
        }
      }
    }
    return paths;
  }).filter((path) => {
    const stats = lstatOrNull(path);
    return stats !== null && (stats.isDirectory() || stats.isSymbolicLink());
  });
  if (matches.length === 0) {
    throw new Error(`No task folder ${task} under ${plansRoot}/{${PLAN_STATUSES.join(',')}}`);
  }
  if (matches.length > 1) {
    throw new Error(`Task ${task} exists in several locations: ${matches.join(', ')}`);
  }
  const folder = matches[0]!;
  if (lstatSync(folder).isSymbolicLink())
    throw new Error(`Refusing a linked task folder: ${folder}`);
  // A linked status folder would put the real task folder outside .plans.
  if (!isDescendant(realpathSync(folder), realpathSync(plansRoot))) {
    throw new Error(`Refusing ${folder}: it resolves outside ${plansRoot}`);
  }
  return folder;
}

/** Normalizes a keep path to `a/b` form, rejecting absolute paths and `..` segments. */
function keepPath(path: string): string {
  const parts = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.');
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path) || parts.length === 0 || parts.includes('..')) {
    throw new Error(`Invalid keep path "${path}" (relative to the task folder, no "..")`);
  }
  return parts.join('/');
}

/** Use directory-entry spelling so Windows lookup and preservation agree. */
function existingKeepPath(folder: string, path: string, caseInsensitive: boolean): string | null {
  const parts = path.split('/');
  const actual: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const parent = join(folder, ...actual);
    const entries = readdirSync(parent);
    const part = parts[i]!;
    const matches = entries.filter(
      (entry) => entry === part || (caseInsensitive && entry.toLowerCase() === part.toLowerCase()),
    );
    if (matches.length > 1) throw new Error(`Ambiguous keep path ${path} in ${folder}`);
    const name = matches[0];
    if (!name) {
      if (i < parts.length - 1) throw new Error(`Keep path folder ${path} is missing in ${folder}`);
      return null;
    }
    actual.push(name);
    if (i < parts.length - 1) {
      const stats = lstatSync(join(folder, ...actual));
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`Keep path folder ${actual.join('/')} is missing or a link in ${folder}`);
      }
    }
  }
  return actual.join('/');
}

function deleteScratch(path: string): void {
  withCleanupError(path, 'cleaned', () => {
    rmSync(path, { recursive: true, force: true, maxRetries: 3 });
  });
}

/**
 * Deletes everything in the task folder except `handoff.md` and the `keep` paths (relative to
 * the folder, nested allowed), and the folder itself when nothing is kept.
 */
export function cleanTask(
  plansRoot: string,
  task: string,
  keep: readonly string[] = [],
  dryRun = false,
  { caseInsensitive = process.platform === 'win32' }: { caseInsensitive?: boolean } = {},
): CleanupResult {
  const folder = findTaskFolder(plansRoot, task);
  // Resolve and validate every keep before the first deletion, including the implicit handoff.
  const normalized = keep.map(keepPath);
  const resolved = normalized.map((path) => existingKeepPath(folder, path, caseInsensitive));
  const missing = normalized.filter((_, i) => resolved[i] === null);
  if (missing.length > 0) throw new Error(`Keep paths not in ${folder}: ${missing.join(', ')}`);
  const handoff = existingKeepPath(folder, 'handoff.md', caseInsensitive);
  const keepSet = new Set(resolved.filter((path): path is string => path !== null));
  if (handoff) keepSet.add(handoff);
  // Folders holding a kept path are cleaned inside instead of deleted whole.
  const ancestors = new Set<string>();
  for (const path of keepSet) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) ancestors.add(parts.slice(0, i).join('/'));
  }
  const deleted: string[] = [];
  const kept: string[] = [];
  const walk = (prefix: string) => {
    for (const name of readdirSync(join(folder, prefix)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (keepSet.has(path)) kept.push(path);
      else if (ancestors.has(path)) walk(path);
      else {
        // rmSync removes a link itself, never its target.
        if (!dryRun) deleteScratch(join(folder, path));
        deleted.push(path);
      }
    }
  };
  walk('');
  const removedFolder = kept.length === 0;
  if (removedFolder && !dryRun) deleteScratch(folder);
  return { folder, deleted, kept, removedFolder };
}
