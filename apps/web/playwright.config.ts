import { defineConfig, devices } from '@playwright/test';

// Override with E2E_PORT when 3100 is taken (e.g. by another local project).
const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // WebGL runs in software in headless Chromium; phone-sized DPRs make that slow.
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Each worker is a browser rendering WebGL in software; more than a couple pins the CPU locally.
  workers: process.env.CI ? undefined : 2,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    // Lit for the day whatever the clock says, so a night run draws the same map (the life
    // layer's time of day, apps/web/state/life.ts).
    storageState: {
      cookies: [],
      origins: [
        {
          origin: baseURL,
          localStorage: [{ name: 'atlas.life', value: '{"enabled":true,"time":"day"}' }],
        },
      ],
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Touch, a small screen, and the bottom-sheet panel (SPEC.md §8).
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    // Test the static export, which is what ships.
    command: `pnpm build && pnpm exec serve out -l ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
