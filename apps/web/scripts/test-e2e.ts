import { withHeavySlot } from '../../../scripts/heavy-slot';
import { launchesBrowsers, runE2E } from './e2e';

try {
  const args = process.argv.slice(2);
  // The build and the software-WebGL browsers queue behind other worktrees' heavy jobs.
  process.exitCode = launchesBrowsers(args)
    ? await withHeavySlot(() => runE2E(args))
    : await runE2E(args);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
