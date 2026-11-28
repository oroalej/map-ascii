/**
 * Cold shader compile (`pnpm perf:browser --cold --runs=3 --output=<absolute path>`). The GPU
 * shader cache belongs to the browser profile, so each run launches a new temporary profile.
 * Contexts within one launch can share it, which is why `--startup` doesn't measure this.
 */
import { chromium, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detailReady } from './detail-ready';
import {
  coldSummary,
  compileBusy,
  type ColdLoad,
  type ColdOptions,
  type ColdRun,
  type LongTask,
  type ShaderRecord,
} from './perf-browser-report';
import { serveExport } from './serve-export';

const WAIT_MS = 300_000;
const SETTLE_MS = 8000;
const LINGER_MS = 45_000;

type ColdWindow = Window & { atlasLongTasks: LongTask[] };
type MarkTimes = { ready: number | null; detail: number | null };

/** Ms from navigation to a mark, read from the page. An older export has no detail mark. */
const marks = (page: Page) =>
  page.evaluate<MarkTimes>(`({
    ready: performance.getEntriesByName('atlas:ready')[0]?.startTime ?? null,
    detail: performance.getEntriesByName('atlas:detail')[0]?.startTime ?? null,
  })`);

type DebugStats = {
  shaders: ShaderRecord[];
  extensions?: { parallelCompile: boolean; timerQuery: boolean };
  gpuBackend: string | null;
};

/** Load the page in `profile` and wait until no program is compiling any more. */
async function load(base: string, city: string, profile: string, lingerMs = 0): Promise<ColdLoad> {
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1920, height: 1080 },
    reducedMotion: 'no-preference',
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
    await page.goto(`${base}/${city}?debug=1&z=18`, { timeout: WAIT_MS });
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
    // The idle warm-up links more programs after the detail frame: wait until two captures
    // SETTLE_MS apart list the same programs, all linked.
    const debug = () => page.evaluate<DebugStats>(`window.atlasDebugStats()`);
    await page.waitForFunction(`typeof window.atlasDebugStats === 'function'`, undefined, {
      timeout: WAIT_MS,
    });
    let report = await debug();
    for (const deadline = Date.now() + WAIT_MS; Date.now() < deadline;) {
      await page.waitForTimeout(SETTLE_MS);
      const next = await debug();
      const settled =
        next.shaders.every((shader) => shader.readyMs !== null) &&
        next.shaders.length === report.shaders.length;
      report = next;
      if (settled) break;
    }
    if (report.gpuBackend === null || /swiftshader|llvmpipe|software/i.test(report.gpuBackend))
      throw new Error(
        `Cold compile needs a hardware GPU; this browser reports ${report.gpuBackend ?? 'none'}`,
      );
    const shaders = report.shaders;
    const tasks = await page.evaluate<LongTask[]>(`window.atlasLongTasks`);
    // The browser writes linked programs to its disk cache some time after the link.
    await page.waitForTimeout(lingerMs);
    return {
      readyMs: final.ready,
      detailMs: final.detail ?? final.ready,
      longestTaskMs: Math.max(0, ...tasks.map((task) => task.duration)),
      longTasks: tasks.filter((task) => task.duration >= 200),
      compileBusyMs: compileBusy(shaders),
      shaders,
      parallelCompile: report.extensions?.parallelCompile ?? null,
      gpuBackend: report.gpuBackend,
    };
  } finally {
    await context.close();
  }
}

async function oneRun(base: string, city: string, index: number): Promise<ColdRun> {
  const profile = await mkdtemp(join(tmpdir(), 'atlas-cold-'));
  try {
    const cold = await load(base, city, profile, LINGER_MS);
    // The same profile again: what a returning visitor compiles.
    const warm = await load(base, city, profile);
    const run: ColdRun = { run: index, ...cold, warm };
    console.log(
      `Run ${index + 1}: ready ${run.readyMs} ms, detail ${run.detailMs} ms, compiling ${run.compileBusyMs} ms over ${run.shaders.length} programs, longest task ${run.longestTaskMs} ms; warm reload detail ${warm.detailMs} ms, compiling ${warm.compileBusyMs} ms`,
    );
    return run;
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

export async function runCold(root: string, port: number, city: string, options: ColdOptions) {
  // `--base` measures a server that is already running (`pnpm dev`), not this checkout's export.
  const server = options.base ? undefined : await serveExport(root, port, city);
  const base = options.base ?? `http://localhost:${port}`;
  try {
    const runs: ColdRun[] = [];
    for (let i = 0; i < options.runs; i++) runs.push(await oneRun(base, city, i));
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(
      options.output,
      JSON.stringify(
        {
          version: 2,
          base: options.base ?? 'export',
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
    server?.close();
  }
}
