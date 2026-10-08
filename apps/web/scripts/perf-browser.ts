/** Capture a visible desktop browser. Static export freshness is prepared by the command wrapper. */
import { chromium, type Browser } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { cpus, release } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cities } from '../e2e/helpers';
import { serveExport } from './serve-export';
import { runStartup } from './startup-browser';
// This dev-only capture intentionally shares the renderer's runtime source hash.
import { currentSourceHash } from '../../../packages/renderer/scripts/snapshot';

type LongTask = { startTime: number; duration: number };
type ProfileWindow = Window & { atlasLongTasks: LongTask[] };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const port = Number(process.env.E2E_PORT ?? 3198);
const pan = process.argv.includes('--pan');
const city = cities.find((c) => c.hasMeta);
if (!city) throw new Error('Build city tiles before capturing a profile');
if (process.argv.includes('--startup')) {
  await runStartup(root, port, city.slug, process.argv.slice(2));
  process.exit(0);
}
const server = await serveExport(root, port, city.slug);
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: false });
  for (const storm of pan ? [false] : [false, true]) {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      reducedMotion: 'no-preference',
      acceptDownloads: true,
    });
    await page.addInitScript(
      (wind) => {
        const target = window as unknown as ProfileWindow;
        target.atlasLongTasks = [];
        const observer = new PerformanceObserver((list) => {
          for (const { startTime, duration } of list.getEntries())
            target.atlasLongTasks.push({ startTime, duration });
        });
        observer.observe({ type: 'longtask', buffered: true });
        localStorage.setItem('atlas.life', JSON.stringify({ enabled: true, time: 'noon', wind }));
        localStorage.setItem('atlas.quality', JSON.stringify('high'));
      },
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
    // Pan crosses tile boundaries; the default alternating input keeps the view local.
    for (let i = 0; i < 120; i++) {
      await canvas.press(
        pan
          ? ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'][Math.floor(i / 30)]!
          : i % 2
            ? 'ArrowLeft'
            : 'ArrowRight',
      );
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
    const output = resolve(
      root,
      `test-results/browser-${pan ? 'pan' : storm ? 'storm' : 'calm'}.json`,
    );
    await mkdir(dirname(output), { recursive: true });
    await download.saveAs(output);
    const report = JSON.parse(await readFile(output, 'utf8')) as Record<string, unknown>;
    const capture = report as { start: { at: string }; end: { at: string } };
    const tasks = await page.evaluate(
      ({ start, end }) => {
        return (window as unknown as ProfileWindow).atlasLongTasks.filter(({ startTime }) => {
          const at = performance.timeOrigin + startTime;
          return at >= start && at <= end;
        });
      },
      { start: Date.parse(capture.start.at), end: Date.parse(capture.end.at) },
    );
    const durations = tasks.map((task) => task.duration).sort((a, b) => a - b);
    report.longTasks = {
      count: tasks.length,
      p95Ms: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] ?? null,
      maxMs: durations.at(-1) ?? null,
      samples: tasks,
    };
    report.source = {
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      hash: await currentSourceHash(root),
    };
    report.desktop = {
      cpu: cpus()[0]?.model,
      os: release(),
      browser: browser.version(),
      input: pan ? 'pan 30x right/down/left/up every 250 ms' : 'alternating arrows every 250 ms',
      warmupSeconds: 5,
    };
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(`Captured ${output}`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.close();
}
