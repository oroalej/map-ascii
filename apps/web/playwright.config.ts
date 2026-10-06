import { defineConfig, devices } from '@playwright/test';
import { e2ePort } from './scripts/e2e-port';

// Each worktree has its own port locally (scripts/e2e-port.ts); E2E_PORT overrides it.
const port = e2ePort();
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // WebGL runs in software in headless Chromium; phone-sized DPRs make that slow.
  timeout: 60_000,
  // End a stuck shard with a useful report before CI's six-minute job deadline.
  globalTimeout: process.env.CI ? 240_000 : 0,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Shards run in parallel. Within a CI runner, concurrent software-WebGL desktop and
  // Pixel-DPR contexts stall drawing and readbacks, so keep one browser active at a time.
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI
    ? [['github'], ['json', { outputFile: 'test-results/shard-duration.json' }]]
    : 'list',
  // Name tests that dominate the run so they get moved to unit tests before CI's job limit hits.
  reportSlowTests: { max: 5, threshold: 30_000 },
  use: {
    baseURL,
    trace: 'on-first-retry',
    // Core flows need the map to draw, but continuous animation overloads CI's software GPU.
    reducedMotion: 'reduce',
    // Noon in the city whatever the clock says, so a night run draws the same map (the life
    // layer's time of day, apps/web/state/life.ts).
    storageState: {
      cookies: [],
      origins: [
        {
          origin: baseURL,
          localStorage: [{ name: 'atlas.life', value: '{"enabled":true,"time":"noon"}' }],
        },
      ],
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Touch, a small screen, and the bottom-sheet panel (SPEC.md §8): only the tests tagged
    // @mobile, since the rest exercise the same code as on desktop.
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: {
    // The E2E wrapper prepares the export before server reuse; direct Playwright runs also
    // prepare it here when starting a server. The build command reuses unchanged exports.
    command: `${process.env.ATLAS_E2E_EXPORT_PREPARED === '1' ? '' : 'pnpm build && '}pnpm exec serve out -l ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
