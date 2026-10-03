/**
 * Delete a handoff task's scratch from the main checkout's `.plans/` (scripts/plans-cleanup.ts):
 *   pnpm plans:clean <task> [--keep <name>]... [--dry-run]
 * keeps `handoff.md` and each `--keep` entry, and works from any worktree.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { cleanTask } from './plans-cleanup';

const usage = 'usage: pnpm plans:clean <task> [--keep <name>]... [--dry-run]';
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const keep: string[] = [];
const tasks: string[] = [];
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === '--dry-run') dryRun = true;
  else if (arg === '--keep') {
    const name = args[++i];
    if (!name) {
      console.error(usage);
      process.exit(2);
    }
    keep.push(name);
  } else tasks.push(arg);
}
if (tasks.length !== 1) {
  console.error(usage);
  process.exit(2);
}

// The main checkout is the common directory's parent, whichever worktree this runs from.
const common = resolve(
  execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(),
);
try {
  const { folder, deleted, kept } = cleanTask(
    join(dirname(common), '.plans'),
    tasks[0]!,
    keep,
    dryRun,
  );
  console.log(folder);
  console.log(
    `${dryRun ? 'would delete' : 'deleted'} ${deleted.length}: ${deleted.join(', ') || '-'}`,
  );
  console.log(`kept ${kept.length}: ${kept.join(', ') || '-'}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
