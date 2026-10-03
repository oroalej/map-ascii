/**
 * Delete a handoff task's scratch from the main checkout's `.plans/` (scripts/plans-cleanup.ts):
 *   pnpm plans:clean <task> [--keep <path>]... [--dry-run]
 * keeps `handoff.md` and each `--keep` path (relative to the task folder, nested allowed),
 * removes the folder when nothing is kept, and works from any worktree.
 */
import { join } from 'node:path';
import { mainCheckout } from './git';
import { cleanTask } from './plans-cleanup';

const usage = 'usage: pnpm plans:clean <task> [--keep <path>]... [--dry-run]';
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

try {
  const { folder, deleted, kept, removedFolder } = cleanTask(
    join(mainCheckout(process.cwd()), '.plans'),
    tasks[0]!,
    keep,
    dryRun,
  );
  console.log(folder);
  console.log(
    `${dryRun ? 'would delete' : 'deleted'} ${deleted.length}: ${deleted.join(', ') || '-'}`,
  );
  console.log(`kept ${kept.length}: ${kept.join(', ') || '-'}`);
  if (removedFolder) console.log(`${dryRun ? 'would remove' : 'removed'} the empty folder`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
