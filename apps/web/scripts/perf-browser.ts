/** Capture a visible desktop browser. Static export freshness is prepared by the command wrapper. */
import { chromium, type Browser, type Page } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { cpus, release } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cities } from '../e2e/helpers';
import { serveExport } from './serve-export';
import { runStartup } from './startup-browser';
import { browserOptions, summarize, type CapturedProfile, type Scene } from './perf-browser-report';
// This dev-only capture intentionally shares the renderer's runtime source hash.
import { currentSourceHash } from '../../../packages/renderer/scripts/snapshot';

type LongTask = { startTime: number; duration: number };
type ProfileWindow = Window & { atlasLongTasks: LongTask[] };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const port = Number(process.env.E2E_PORT ?? 3198);
const options = browserOptions(process.argv.slice(2));
const city = cities.find((c) => c.hasMeta);
if (!city) throw new Error('Build city tiles before capturing a profile');
if (options.startup) {
  await runStartup(root, port, city.slug, process.argv.slice(2));
  process.exit(0);
}

/** A capture: its Life preferences, starting zoom and the input played over the capture. */
type Run = {
  name: string;
  scene?: Scene;
  output: string;
  time: 'noon' | 'night';
  wind: 'calm' | 'breeze' | 'storm';
  zoom: number;
  input: string;
};
const legacy = (name: string): Run => ({
  name,
  output: resolve(root, `test-results/browser-${name}.json`),
  time: 'noon',
  wind: name === 'storm' ? 'storm' : 'calm',
  zoom: 18,
  input:
    name === 'pan' ? 'pan 30x right/down/left/up every 250 ms' : 'alternating arrows every 250 ms',
});
const SCENE_RUNS: Record<Scene, Omit<Run, 'output' | 'name' | 'scene'>> = {
  idle: { time: 'noon', wind: 'breeze', zoom: 18, input: 'none; pointer off the canvas' },
  pan: {
    time: 'noon',
    wind: 'breeze',
    zoom: 18,
    input: 'pan 30x right/down/left/up every 250 ms',
  },
  zoom: {
    time: 'noon',
    wind: 'breeze',
    zoom: 16,
    input: 'wheel 9 notches in then 9 out every 100 ms at the view center, z16-z19',
  },
  night: { time: 'night', wind: 'breeze', zoom: 18, input: 'none; pointer off the canvas' },
  fiesta: {
    time: 'noon',
    wind: 'breeze',
    zoom: 18,
    input: 'played street event; 15 right then 15 left arrows every 500 ms, twice',
  },
};
const runs: Run[] = options.scene
  ? [
      {
        name: options.scene,
        scene: options.scene,
        output: options.output!,
        ...SCENE_RUNS[options.scene],
      },
    ]
  : options.pan
    ? [legacy('pan')]
    : [legacy('calm'), legacy('storm')];
// The first season with a street event and a mass, as the seasonal smoke test plays.
const eventsSeason = city.seasons.find(
  (s) =>
    city.processions.some(
      (p) => p.season === s.id && (p.kind === 'procession' || p.kind === 'parade'),
    ) && city.processions.some((p) => p.season === s.id && p.kind === 'mass'),
);
const streetEvent =
  eventsSeason &&
  (city.processions.find((p) => p.season === eventsSeason.id && p.kind === 'procession') ??
    city.processions.find((p) => p.season === eventsSeason.id && p.kind === 'parade'));
const query = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);
const tilesSettled = (page: Page) =>
  page.waitForFunction(
    () => /tiles\s+\d+ \(\+0\)/.test(document.querySelector('[class*="stats"]')?.textContent ?? ''),
    undefined,
    { timeout: 30_000 },
  );

/** Play the season's street event and wait for its camera flight to settle at the start. */
async function playEvent(page: Page) {
  if (!eventsSeason || !streetEvent) throw new Error(`${city!.slug}: no seasonal street event`);
  const button = page.getByRole('button', { name: `▶ ${streetEvent.label!.en}`, exact: true });
  await button.waitFor();
  await button.press('Enter');
  await page.mouse.move(-10, -10);
  const generated = city!.generatedProcessions.find((p) => p.id === streetEvent.id)!;
  const [lng, lat] = generated.kind === 'mass' ? generated.site.anchor : generated.route[0]!;
  await page.waitForFunction(
    ([lng, lat]) => {
      const q = new URL(location.href).searchParams;
      return Math.hypot(Number(q.get('lng')) - lng!, Number(q.get('lat')) - lat!) < 0.0001;
    },
    [lng, lat],
    { timeout: 30_000 },
  );
}

/** The input played while the capture runs. */
async function play(page: Page, run: Run) {
  const canvas = page.locator('canvas');
  if (run.scene === 'idle' || run.scene === 'night') {
    await page.mouse.move(-10, -10);
    return;
  }
  if (run.scene === 'zoom') {
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let cycle = 0; cycle < 16; cycle++)
      for (const direction of [-1, 1])
        for (let notch = 0; notch < 9; notch++) {
          await page.mouse.wheel(0, direction * 100);
          await page.waitForTimeout(100);
        }
    await page.mouse.move(-10, -10);
    return;
  }
  await canvas.focus();
  if (run.scene === 'fiesta') {
    for (let cycle = 0; cycle < 2; cycle++)
      for (const key of ['ArrowRight', 'ArrowLeft'])
        for (let i = 0; i < 15; i++) {
          await canvas.press(key);
          await page.waitForTimeout(500);
        }
    return;
  }
  // Pan crosses tile boundaries; the default alternating input keeps the view local.
  for (let i = 0; i < 120; i++) {
    await canvas.press(
      run.name === 'pan'
        ? ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'][Math.floor(i / 30)]!
        : i % 2
          ? 'ArrowLeft'
          : 'ArrowRight',
    );
    await page.waitForTimeout(250);
  }
}

const tilePin = async () => {
  try {
    const lock = JSON.parse(
      await readFile(resolve(root, `packages/content/cities/${city.slug}/tiles.lock.json`), 'utf8'),
    ) as { tag?: string };
    return lock.tag ?? null;
  } catch {
    return null;
  }
};

const server = await serveExport(root, port, city.slug);
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: false });
  for (const run of runs) {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      reducedMotion: 'no-preference',
      acceptDownloads: true,
    });
    await page.addInitScript(
      ({ time, wind, seasonKey, season }) => {
        const target = window as unknown as ProfileWindow;
        target.atlasLongTasks = [];
        const observer = new PerformanceObserver((list) => {
          for (const { startTime, duration } of list.getEntries())
            target.atlasLongTasks.push({ startTime, duration });
        });
        observer.observe({ type: 'longtask', buffered: true });
        localStorage.setItem('atlas.life', JSON.stringify({ enabled: true, time, wind }));
        localStorage.setItem(seasonKey, season);
        localStorage.setItem('atlas.quality', JSON.stringify('high'));
      },
      {
        time: run.time,
        wind: run.wind,
        seasonKey: `atlas.life.season.${city.slug}`,
        season: run.scene === 'fiesta' ? eventsSeason!.id : 'auto',
      },
    );
    await page.goto(`http://localhost:${port}/${city.slug}?debug=1&z=${run.zoom}`);
    await page.getByRole('button', { name: 'Capture 30 seconds', exact: true }).waitFor();
    // Wait for tile loading to finish, then give shader compilation and the simulation a warmup.
    await tilesSettled(page);
    if (run.scene === 'fiesta') {
      await playEvent(page);
      await tilesSettled(page);
    }
    // The display's own cadence, so pacing results can be read against it.
    // A string expression: tsx would wrap a named page-side function in its own helper.
    const displayHz = await page.evaluate<number>(`new Promise((done) => {
      const at = [];
      const tick = (now) => {
        at.push(now);
        if (at.length < 61) return requestAnimationFrame(tick);
        const deltas = at.slice(1).map((t, i) => t - at[i]).sort((a, b) => a - b);
        done(1000 / deltas[Math.floor(deltas.length / 2)]);
      };
      requestAnimationFrame(tick);
    })`);
    await page.waitForTimeout(5000);
    const camera = query(page);
    await page.getByRole('button', { name: 'Capture 30 seconds', exact: true }).click();
    await play(page, run);
    await page.waitForFunction(
      () =>
        !(
          Array.from(document.querySelectorAll('button')).find(
            (b) => b.textContent === 'Download profile',
          )?.disabled ?? true
        ),
      undefined,
      { timeout: 60_000 },
    );
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download profile', exact: true }).click();
    const download = await downloading;
    const output = run.output;
    await mkdir(dirname(output), { recursive: true });
    await download.saveAs(output);
    const report = JSON.parse(await readFile(output, 'utf8')) as Record<string, unknown>;
    const capture = report as {
      start: { at: string };
      end: { at: string };
      stats?: { lifeMs: number; cellPassMs: number; frameMs: number; fps: number };
      profile: CapturedProfile;
    };
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
      tiles: await tilePin(),
    };
    report.desktop = {
      cpu: cpus()[0]?.model,
      os: release(),
      browser: browser.version(),
      input: run.input,
      warmupSeconds: 5,
    };
    if (run.scene) {
      const dpr = await page.evaluate(() => {
        const canvas = document.querySelector('canvas')!;
        return {
          device: window.devicePixelRatio,
          effective: canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : null,
        };
      });
      report.scene = {
        name: run.scene,
        input: run.input,
        life: { time: run.time, wind: run.wind, quality: 'high' },
        season: run.scene === 'fiesta' ? eventsSeason!.id : 'auto',
        event: run.scene === 'fiesta' ? streetEvent!.id : null,
        camera,
        viewport: { width: 1920, height: 1080 },
        displayHz,
        dpr,
      };
      report.summary = summarize(capture.profile, capture.stats, tasks);
    }
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(`Captured ${output}`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.close();
}
