/**
 * Delete a handoff task's scratch (AGENTS.md "Handoff plans"): everything in
 * `.plans/<status>/<task>/` except `handoff.md` and the named keep entries.
 *
 * Deletion runs in Node because Codex rejects recursive shell deletes
 * (`Remove-Item -Recurse`, `rm -rf`) as "blocked by policy" when it can't ask for approval.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PLAN_STATUSES = ['todo', 'active', 'paused', 'done'] as const;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export interface CleanupResult {
  folder: string;
  deleted: string[];
  kept: string[];
  /** True when nothing was kept, so the folder itself went too (e.g. a `pr<N>-review-fixes/` scratch folder). */
  removedFolder: boolean;
}

/** Finds the one `<plansRoot>/<status>/<task>/` folder, failing on a bad slug or no/several matches. */
export function findTaskFolder(plansRoot: string, task: string): string {
  if (!SLUG.test(task))
    throw new Error(`Invalid task "${task}" (lowercase letters, digits and dashes)`);
  const matches = PLAN_STATUSES.map((status) => join(plansRoot, status, task)).filter((path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  });
  if (matches.length === 0)
    throw new Error(`No task folder ${task} under ${plansRoot}/{${PLAN_STATUSES.join(',')}}`);
  if (matches.length > 1)
    throw new Error(`Task ${task} exists in several statuses: ${matches.join(', ')}`);
  return matches[0]!;
}

/**
 * Deletes every entry of the task folder except `handoff.md` and `keep` (top-level names),
 * and the folder itself when nothing is kept.
 */
export function cleanTask(
  plansRoot: string,
  task: string,
  keep: readonly string[] = [],
  dryRun = false,
): CleanupResult {
  const folder = findTaskFolder(plansRoot, task);
  const entries = readdirSync(folder).sort();
  const unknown = keep.filter((name) => !entries.includes(name));
  if (unknown.length > 0) throw new Error(`Keep entries not in ${folder}: ${unknown.join(', ')}`);
  const keepSet = new Set(['handoff.md', ...keep]);
  const deleted: string[] = [];
  const kept: string[] = [];
  for (const name of entries) {
    if (keepSet.has(name)) {
      kept.push(name);
      continue;
    }
    const target = resolve(folder, name);
    if (dirname(target) !== resolve(folder))
      throw new Error(`Refusing to delete outside ${folder}: ${target}`);
    if (!dryRun) rmSync(target, { recursive: true, force: true });
    deleted.push(name);
  }
  const removedFolder = kept.length === 0;
  if (removedFolder && !dryRun) rmSync(folder, { recursive: true, force: true });
  return { folder, deleted, kept, removedFolder };
}
