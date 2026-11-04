/**
 * Cold shader compile (`pnpm perf:browser --cold --runs=3 --output=<absolute path>`). The GPU
 * shader cache belongs to the browser profile, so each run launches a new temporary profile.
 * Contexts within one launch can share it, which is why `--startup` doesn't measure this.
 */
import { chromium, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detailReady } from './detail-ready';
import {
  coldSummary,
  type ColdOptions,
  type ColdRun,
  type LongTask,
  type ShaderRecord,
} from './perf-browser-report';
import { serveExport } from './serve-export';

const WAIT_MS = 300_000;
const CAPTURE_MS = 1000;

type ColdWindow = Window & { atlasLongTasks: LongTask[] };
type MarkTimes = { ready: number | null; detail: number | null };

/** Ms from navigation to a mark, read from the page. An older export has no detail mark. */
const marks = (page: Page) =>
  page.evaluate<MarkTimes>(`({
    ready: performance.getEntriesByName('atlas:ready')[0]?.startTime ?? null,
    detail: performance.getEntriesByName('atlas:detail')[0]?.startTime ?? null,
  })`);

async function oneRun(port: number, city: string, index: number): Promise<ColdRun> {
  const profile = await mkdtemp(join(tmpdir(), 'atlas-cold-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1920, height: 1080 },
    reducedMotion: 'no-preference',
    acceptDownloads: true,
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.addInitScript(() => {
      const target = window as unknown as ColdWindow;
      target.atlasLongTasks = [];
      new PerformanceObserver((list) => {
        for (const { startTime, duration } of list.getEntries())
          target.atlasLongTasks.push({ startTime, duration });
      }).observe({ type: 'longtask', buffered: true });
      localStorage.setItem('atlas.quality', JSON.stringify('high'));
    });
    await page.goto(`http://localhost:${port}/${city}?debug=1&z=18&captureMs=${CAPTURE_MS}`);
    await page.waitForFunction(
      `performance.getEntriesByName('atlas:ready').length > 0`,
      undefined,
      {
        timeout: WAIT_MS,
      },
    );
    // An export from before the boot shaders has no detail line: its first frame was the full one.
    const hasDetail = await page
      .waitForFunction(
        `/detail\\s/.test(document.querySelector('[class*="stats"]')?.textContent ?? '')`,
        undefined,
        { timeout: 5000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (hasDetail) await detailReady(page);
    const final = await marks(page);
    const capture = page.getByRole('button', { name: /^Capture \d+ seconds$/ });
    await capture.waitFor({ timeout: WAIT_MS });
    await capture.click();
    const save = page.getByRole('button', { name: 'Download profile', exact: true });
    await page.waitForFunction(
      `!(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Download profile')?.disabled ?? true)`,
      undefined,
      { timeout: 60_000 },
    );
    const downloading = page.waitForEvent('download');
    await save.click();
    const path = await (await downloading).path();
    const report = JSON.parse(await readFile(path, 'utf8')) as {
      start: { gpuBackend: string | null; gpuClassification: string };
      stats: {
        shaders?: ShaderRecord[];
        extensions?: { parallelCompile: boolean; timerQuery: boolean };
      };
    };
    if (report.start.gpuClassification !== 'hardware-reported')
      throw new Error(
        `Cold compile needs a hardware GPU; this browser reports ${report.start.gpuBackend ?? 'none'}`,
      );
    const tasks = await page.evaluate<LongTask[]>(`window.atlasLongTasks`);
    const run: ColdRun = {
      run: index,
      readyMs: final.ready,
      detailMs: final.detail ?? final.ready,
      longestTaskMs: Math.max(0, ...tasks.map((task) => task.duration)),
      shaders: report.stats.shaders ?? [],
      parallelCompile: report.stats.extensions?.parallelCompile ?? null,
      gpuBackend: report.start.gpuBackend,
    };
    console.log(
      `Run ${index + 1}: ready ${run.readyMs} ms, detail ${run.detailMs} ms, longest task ${run.longestTaskMs} ms`,
    );
    return run;
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

export async function runCold(root: string, port: number, city: string, options: ColdOptions) {
  const server = await serveExport(root, port, city);
  try {
    const runs: ColdRun[] = [];
    for (let i = 0; i < options.runs; i++) runs.push(await oneRun(port, city, i));
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(
      options.output,
      JSON.stringify(
        {
          version: 1,
          revision: execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            encoding: 'utf8',
          }).trim(),
          viewport: { width: 1920, height: 1080 },
          summary: coldSummary(runs),
          runs,
        },
        null,
        2,
      ),
    );
    console.log(`Captured ${options.output}`);
  } finally {
    server.close();
  }
}
