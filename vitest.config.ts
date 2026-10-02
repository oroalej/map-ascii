import { defineConfig } from 'vitest/config';

const ci = !!process.env.CI;

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/web',
      { test: { name: 'scripts', environment: 'node', include: ['scripts/**/*.test.ts'] } },
    ],
    // Several agent sessions share one machine locally; CI runners don't.
    maxWorkers: ci ? undefined : 4,
    reporters: ci ? ['default', './scripts/test-budget.ts'] : ['default'],
  },
});
