/** Capture a visible desktop browser. Static export freshness is prepared by the command wrapper. */
import { chromium, type Browser } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { cpus, release } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cities } from '../e2e/helpers';
import { currentSourceHash } from '../../../packages/renderer/scripts/snapshot';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const port = Number(process.env.E2E_PORT ?? 3198);
const city = cities.find((c) => c.hasMeta);
if (!city) throw new Error('Build city tiles before capturing a profile');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid E2E_PORT');
const serve = fileURLToPath(new URL('../node_modules/serve/build/main.js', import.meta.url));
const expected = await readFile(resolve(root, 'apps/web/out', `${city.slug}.html`), 'utf8');
const server = spawn(process.execPath, [serve, 'out', '-l', String(port)], {
  cwd: resolve(root, 'apps/web'),
  windowsHide: true,
  stdio: 'ignore',
});
let ready = false;
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    const response = await fetch(`http://localhost:${port}/${city.slug}`);
    if ((await response.text()) === expected) {
      ready = true;
      break;
    }
  } catch {
    /* Server is starting. */
  }
  if (server.exitCode !== null) break;
  await new Promise((r) => setTimeout(r, 100));
}
if (!ready) {
  server.kill();
  throw new Error(`Could not serve this export on port ${port}; choose an unused E2E_PORT`);
}
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: false });
  for (const storm of [false, true]) {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      reducedMotion: 'no-preference',
      acceptDownloads: true,
    });
    await page.addInitScript(
      (wind) =>
        localStorage.setItem('atlas.life', JSON.stringify({ enabled: true, time: 'noon', wind })),
      storm ? 'storm' : 'calm',
    );
    await page.goto(`http://localhost:${port}/${city.slug}?debug=1&z=18`);
    await page.getByRole('button', { name: 'Capture 30 seconds', exact: true }).waitFor();
    // Wait for tile loading to finish, then give shader compilation and the simulation a warmup.
    await page.waitForFunction(
      () =>
        /tiles\s+\d+ \(\+0\)/.test(document.querySelector('[class*="stats"]')?.textContent ?? ''),
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(5000);
    await page.getByRole('button', { name: 'Capture 30 seconds', exact: true }).click();
    const canvas = page.locator('canvas');
    await canvas.focus();
    // Repeated input exercises the active draw rate; equal opposite inputs keep the view local.
    for (let i = 0; i < 120; i++) {
      await canvas.press(i % 2 ? 'ArrowLeft' : 'ArrowRight');
      await page.waitForTimeout(250);
    }
    await page.waitForFunction(
      () =>
        !(
          Array.from(document.querySelectorAll('button')).find(
            (b) => b.textContent === 'Download profile',
          )?.disabled ?? true
        ),
    );
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download profile', exact: true }).click();
    const download = await downloading;
    const output = resolve(root, `test-results/browser-${storm ? 'storm' : 'calm'}.json`);
    await mkdir(dirname(output), { recursive: true });
    await download.saveAs(output);
    const report = JSON.parse(await readFile(output, 'utf8')) as Record<string, unknown>;
    report.source = {
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      hash: await currentSourceHash(root),
    };
    report.desktop = {
      cpu: cpus()[0]?.model,
      os: release(),
      browser: browser.version(),
      input: 'alternating arrows every 250 ms',
      warmupSeconds: 5,
    };
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(`Captured ${output}`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.kill();
}
