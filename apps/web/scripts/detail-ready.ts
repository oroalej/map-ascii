import type { Page } from '@playwright/test';

/** A fresh profile can take minutes through ANGLE D3D11, even before the machine's other load. */
const WAIT_MS = 300_000;

/** Wait for the full shaders, so a measurement never times the boot shaders (shaders/boot.ts). */
export const detailReady = (page: Page) =>
  page.waitForFunction(`performance.getEntriesByName('atlas:detail').length > 0`, undefined, {
    timeout: WAIT_MS,
  });
