/**
 * Delete a handoff task's scratch from the main checkout's `.plans/` (scripts/plans-cleanup.ts):
 *   pnpm plans:clean <task> [--keep <path>]... [--dry-run]
 * keeps `handoff.md` and each `--keep` path (relative to the task folder, nested allowed),
 * removes the folder when nothing is kept, and works from any worktree.
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { mainCheckout } from './git';
import { cleanTask } from './plans-cleanup';

const usage = 'usage: pnpm plans:clean <task> [--keep <path>]... [--dry-run]';
export function parsePlansCleanArgs(args: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: args.filter((arg) => arg !== '--'),
    options: {
      keep: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  const [task, ...rest] = positionals;
  if (!task || rest.length > 0) throw new Error('Expected exactly one task name');
  return { task, keep: values.keep ?? [], dryRun: values['dry-run'] ?? false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let options: ReturnType<typeof parsePlansCleanArgs>;
  try {
    options = parsePlansCleanArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(usage);
    process.exit(2);
  }
  try {
    const { task, keep, dryRun } = options;
    const { folder, deleted, kept, removedFolder } = cleanTask(
      join(mainCheckout(process.cwd()), '.plans'),
      task,
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
}
