import { parseArgs } from 'node:util';
import { withHeavySlot } from '../../../scripts/heavy-slot';
import { prepareExport } from './static-export';

try {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: { force: { type: 'boolean', default: false } },
  });
  // Queue behind other worktrees' builds, e2e and perf runs on this machine.
  await withHeavySlot(() => prepareExport({ force: values.force }));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
