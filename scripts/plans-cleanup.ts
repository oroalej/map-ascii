/**
 * Delete a handoff task's scratch (AGENTS.md "Handoff plans"): everything in
 * `.plans/<status>/<task>/` except `handoff.md` and the named keep paths.
 *
 * Deletion runs in Node because Codex rejects recursive shell deletes
 * (`Remove-Item -Recurse`, `rm -rf`) as "blocked by policy" when it can't ask for approval.
 */
import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

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
const inside = (path: string, folder: string) => {
  const rel = relative(folder, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * Finds the one `<plansRoot>/<status>/<task>/` folder, failing on a bad slug, no or several
 * matches, or a folder that is a link (junction or symlink) or resolves outside `plansRoot`.
 */
export function findTaskFolder(plansRoot: string, task: string): string {
  if (!SLUG.test(task)) {
    throw new Error(`Invalid task "${task}" (lowercase letters, digits and dashes)`);
  }
  const matches = PLAN_STATUSES.map((status) => join(plansRoot, status, task)).filter((path) => {
    const stats = lstatOrNull(path);
    return stats !== null && (stats.isDirectory() || stats.isSymbolicLink());
  });
  if (matches.length === 0) {
    throw new Error(`No task folder ${task} under ${plansRoot}/{${PLAN_STATUSES.join(',')}}`);
  }
  if (matches.length > 1) {
    throw new Error(`Task ${task} exists in several statuses: ${matches.join(', ')}`);
  }
  const folder = matches[0]!;
  if (lstatSync(folder).isSymbolicLink())
    throw new Error(`Refusing a linked task folder: ${folder}`);
  // A linked status folder would put the real task folder outside .plans.
  if (!inside(realpathSync(folder), realpathSync(plansRoot))) {
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

/**
 * Deletes everything in the task folder except `handoff.md` and the `keep` paths (relative to
 * the folder, nested allowed), and the folder itself when nothing is kept.
 */
export function cleanTask(
  plansRoot: string,
  task: string,
  keep: readonly string[] = [],
  dryRun = false,
): CleanupResult {
  const folder = findTaskFolder(plansRoot, task);
  const keepSet = new Set(['handoff.md', ...keep.map(keepPath)]);
  // Folders holding a kept path are cleaned inside instead of deleted whole.
  const ancestors = new Set<string>();
  for (const path of keepSet) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) ancestors.add(parts.slice(0, i).join('/'));
  }
  // Check every keep path before deleting anything.
  for (const path of ancestors) {
    const stats = lstatOrNull(join(folder, path));
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Keep path folder ${path} is missing or a link in ${folder}`);
    }
  }
  const missing = keep.map(keepPath).filter((path) => !lstatOrNull(join(folder, path)));
  if (missing.length > 0) throw new Error(`Keep paths not in ${folder}: ${missing.join(', ')}`);

  const deleted: string[] = [];
  const kept: string[] = [];
  const walk = (prefix: string) => {
    for (const name of readdirSync(join(folder, prefix)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (keepSet.has(path)) kept.push(path);
      else if (ancestors.has(path)) walk(path);
      else {
        // rmSync removes a link itself, never its target.
        if (!dryRun) rmSync(join(folder, path), { recursive: true, force: true });
        deleted.push(path);
      }
    }
  };
  walk('');
  const removedFolder = kept.length === 0;
  if (removedFolder && !dryRun) rmSync(folder, { recursive: true, force: true });
  return { folder, deleted, kept, removedFolder };
}
