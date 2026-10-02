import { relative } from 'node:path';
import type { Reporter, TestModule } from 'vitest/node';

/**
 * Fails a CI run when one test file takes longer than the budget. Vitest runs files in parallel
 * but each file serially, so the slowest file sets the suite's wall time: split it or make it
 * cheaper instead of raising timeouts (AGENTS.md "Verifying changes").
 */
export const FILE_BUDGET_MS = 30_000;

export type FileTime = { file: string; ms: number };

/** Import plus test time per file, slowest first. */
export function fileTimes(modules: ReadonlyArray<TestModule>): FileTime[] {
  return modules
    .map((module) => {
      const { collectDuration, duration } = module.diagnostic();
      return { file: relative(process.cwd(), module.moduleId), ms: collectDuration + duration };
    })
    .sort((a, b) => b.ms - a.ms);
}

export default class TestBudgetReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>) {
    const times = fileTimes(modules);
    if (!times.length) return;
    const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    console.log('\nSlowest test files:');
    for (const { file, ms } of times.slice(0, 5))
      console.log(`  ${seconds(ms).padStart(7)}  ${file}`);
    const over = times.filter(({ ms }) => ms > FILE_BUDGET_MS);
    if (!over.length) return;
    console.error(
      `\n${over.length} test file(s) over the ${seconds(FILE_BUDGET_MS)} budget; split them or make them cheaper:`,
    );
    for (const { file, ms } of over) console.error(`  ${seconds(ms)}  ${file}`);
    process.exitCode = 1;
  }
}
