import { fileURLToPath } from 'node:url';
import { prepareExport } from './static-export';
import { runNodeCli } from './run-node-cli';

/** Prepare even with an existing server: Playwright's webServer command is skipped on reuse. */
export async function runE2E(
  args: readonly string[],
  prepare: () => Promise<unknown> = prepareExport,
  run: (args: readonly string[]) => Promise<number> = (args) =>
    runNodeCli(
      '@playwright/test/cli',
      ['test', ...args],
      fileURLToPath(new URL('../', import.meta.url)),
      { ...process.env, ATLAS_E2E_EXPORT_PREPARED: '1' },
    ),
): Promise<number> {
  const forwarded = args.filter((arg) => arg !== '--');
  if (launchesBrowsers(forwarded)) await prepare();
  return run(forwarded);
}

/** `--list` and `--help` neither build nor open a browser. */
export const launchesBrowsers = (args: readonly string[]) =>
  !args.some((arg) => ['--list', '--help', '-h'].includes(arg));
