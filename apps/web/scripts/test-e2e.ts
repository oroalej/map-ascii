import { runE2E } from './e2e';

try {
  process.exitCode = await runE2E(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
