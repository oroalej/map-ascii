/**
 * Render the README promo clip (`docs/media/demo.avif`) from the static export, frame by frame.
 *
 * Playwright's fake clock advances the app exactly one video frame between screenshots, so the
 * clip is smooth however slowly this machine renders. Shots are derived from the city pack and
 * its generated meta, never hardcoded. Needs ffmpeg (with libsvtav1) on PATH or in `FFMPEG`.
 *
 *   pnpm demo:video [-- --city <slug>] [--output <path.avif>] [--mp4 <path.mp4>]
 */
import { chromium, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cities, mapReady } from '../e2e/helpers';
import { serveExport } from './serve-export';

const FPS = 30;
// Glyphs keep their CSS size, so a smaller viewport frames fewer of them: legible when scaled
// down, and small enough to encode.
const VIEW = { width: 1280, height: 720 };
const FADE = 10;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const port = Number(process.env.E2E_PORT ?? 3196);
const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const city = cities.find((c) => c.slug === (flag('city') ?? c.slug) && c.hasMeta);
if (!city) throw new Error('Build or fetch the city tiles before rendering the demo');
const output = resolve(flag('output') ?? resolve(root, 'docs/media/demo.avif'));
const mp4 = flag('mp4');
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
if (spawnSync(ffmpeg, ['-hide_banner', '-version']).status !== 0)
  throw new Error('ffmpeg not found: install it (winget install Gyan.FFmpeg) or set FFMPEG');

type Camera = { lat: number; lng: number; zoom: number };
const meta = JSON.parse(
  await readFile(resolve(root, `apps/web/public/tiles/${city.slug}.meta.json`), 'utf8'),
) as { defaultCamera: Camera };
const home = meta.defaultCamera;
const place = city.smokePlace!;

// A seasonal street procession (its crowds read best), else a parade.
const seasonal = (kind: string) =>
  city.processions.find((p) => p.kind === kind && city.seasons.some((s) => s.id === p.season));
const event = seasonal('procession') ?? seasonal('parade');
const eventSeason = city.seasons.find((s) => s.id === event?.season);

type Time = 'noon' | 'dusk' | 'night';
type Shot = {
  caption: string;
  seconds: number;
  time: Time;
  start: Camera;
  /**
   * Zoom at the end of the shot, eased. Omitted, the camera holds still: a moving camera shifts
   * every glyph cell each frame, which no codec compresses, so only the opening and closing move.
   */
  endZoom?: number;
  /** Seconds into the shot at which to step the HUD's time-of-day button. */
  timeSteps?: number[];
  /** Play the season's procession first, then hold at `start.zoom` on its route. */
  event?: boolean;
};

/** The camera centre that shows `lat` a sixth of the view above the middle, clear of the caption. */
const framed = ({ lat, lng }: { lat: number; lng: number }, zoom: number): Camera => {
  const degreesPerPx = (360 / (512 * 2 ** zoom)) * Math.cos((lat * Math.PI) / 180);
  return { lat: lat - (VIEW.height / 6) * degreesPerPx, lng, zoom };
};

const shots: Shot[] = [
  {
    caption: `${city.name}, drawn in text`,
    seconds: 5,
    time: 'noon',
    start: { lat: place.lat, lng: place.lng, zoom: 15 },
    endZoom: 18.4,
  },
  {
    caption: 'Every street alive: traffic, people, weather',
    seconds: 5,
    time: 'noon',
    start: framed(place, 19.2),
  },
  {
    caption: 'Day into night',
    seconds: 6,
    time: 'noon',
    start: framed(place, 18.4),
    timeSteps: [1.5, 3.5],
  },
  ...(event
    ? [
        {
          caption: `${eventSeason?.title.en ?? event.label?.en ?? 'Fiesta'}, replayed`,
          seconds: 6,
          time: 'noon' as const,
          start: { ...home, zoom: 19 },
          event: true,
        },
      ]
    : []),
  {
    caption: 'ASCII Atlas',
    seconds: 4,
    time: 'night',
    start: { lat: place.lat, lng: place.lng, zoom: 18.4 },
    endZoom: 15,
  },
];

const tilesSettled = (page: Page) =>
  page.waitForFunction(
    () => /tiles\s+\d+ \(\+0\)/.test(document.querySelector('[class*="stats"]')?.textContent ?? ''),
    undefined,
    { timeout: 60_000 },
  );

/** Hide the app's chrome (the map and its attribution stay), and add the caption and fade. */
const STAGE = `
  main > :not(canvas) { visibility: hidden !important; }
  footer, footer * { visibility: visible !important; }
  #demo-caption {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 10; pointer-events: none;
    padding: 112px 48px 56px;
    background: linear-gradient(to bottom, transparent, rgba(4, 5, 10, 0.88) 55%);
    font: 600 30px/1.2 var(--font-mono, ui-monospace, monospace); letter-spacing: 0.02em;
    color: #f2ecdc; text-shadow: 0 0 18px rgba(255, 214, 150, 0.45), 0 2px 0 #04050a;
  }
  #demo-fade { position: fixed; inset: 0; z-index: 11; background: #04050a; pointer-events: none; }
`;

const ease = (t: number) => t * t * (3 - 2 * t);

async function wheelTo(page: Page, from: number, to: number) {
  // The atlas zooms 1/300 per wheel pixel, anchored where the event lands (the center here).
  await page.evaluate(
    ({ deltaY, x, y }) =>
      document
        .querySelector('canvas')!
        .dispatchEvent(
          new WheelEvent('wheel', { deltaY, clientX: x, clientY: y, cancelable: true }),
        ),
    { deltaY: -(to - from) * 300, x: VIEW.width / 2, y: VIEW.height / 2 },
  );
}

const urlZoom = (page: Page) =>
  page.evaluate(() => Number(new URL(location.href).searchParams.get('z')));

let frame = 0;
async function renderShot(browser: Browser, shot: Shot, index: number, frames: string) {
  const page = await browser.newPage({ viewport: VIEW, reducedMotion: 'no-preference' });
  try {
    await page.clock.install();
    await page.addInitScript(
      ({ time, seasonKey, season }) => {
        localStorage.setItem('atlas.life', JSON.stringify({ enabled: true, time, wind: 'breeze' }));
        localStorage.setItem(seasonKey, season);
        localStorage.setItem('atlas.quality', JSON.stringify('high'));
      },
      {
        time: shot.time,
        seasonKey: `atlas.life.season.${city!.slug}`,
        season: shot.event ? (event!.season ?? 'auto') : 'auto',
      },
    );
    const { lat, lng, zoom } = shot.start;
    await page.goto(
      `http://localhost:${port}/${city!.slug}?debug=1&lat=${lat}&lng=${lng}&z=${zoom}`,
    );
    await mapReady(page);
    await page.mouse.move(-10, -10);
    if (shot.event) {
      const button = page.getByRole('button', { name: `▶ ${event!.label!.en}`, exact: true });
      await button.waitFor();
      await button.press('Enter');
      await page.mouse.move(-10, -10);
      // Let the flight to the route finish, then join the procession closer in.
      await page.waitForTimeout(4000);
      await wheelTo(page, await urlZoom(page), shot.start.zoom);
    }
    await tilesSettled(page);
    // Warm up: shaders, the simulation, the first wave of traffic and pedestrians.
    await page.waitForTimeout(4000);
    await page.addStyleTag({ content: STAGE });
    await page.evaluate((caption) => {
      const text = Object.assign(document.createElement('div'), { id: 'demo-caption' });
      text.textContent = caption;
      document.body.append(text, Object.assign(document.createElement('div'), { id: 'demo-fade' }));
    }, shot.caption);
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + 50);

    const total = Math.round(shot.seconds * FPS);
    let zoomNow = await urlZoom(page);
    const startZoom = zoomNow;
    for (let f = 0; f < total; f++) {
      if (shot.endZoom !== undefined) {
        const zoom = startZoom + (shot.endZoom - startZoom) * ease(f / (total - 1));
        await wheelTo(page, zoomNow, zoom);
        zoomNow = zoom;
      }
      if (shot.timeSteps?.some((at) => f === Math.round(at * FPS)))
        await page
          .getByRole('button', { name: /^Time: /, includeHidden: true })
          .dispatchEvent('click');
      const fade =
        index === 0 && f < FADE
          ? 1 - f / FADE
          : f >= total - FADE && index === shots.length - 1
            ? (f - (total - FADE)) / FADE
            : 0;
      await page.evaluate((o) => {
        document.getElementById('demo-fade')!.style.opacity = String(o);
      }, fade);
      await page.clock.runFor(1000 / FPS);
      // Let the life and tile workers answer this frame's step before it is shot.
      await page.waitForTimeout(15);
      await page.screenshot({
        path: join(frames, `${String(frame++).padStart(6, '0')}.jpg`),
        type: 'jpeg',
        quality: 95,
      });
    }
    console.log(`shot ${index + 1}/${shots.length}: ${shot.caption} (${total} frames)`);
  } finally {
    await page.close();
  }
}

function encode(frames: string, args: string[]) {
  const input = ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(FPS)];
  const result = spawnSync(ffmpeg, [...input, '-i', join(frames, '%06d.jpg'), ...args], {
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`ffmpeg failed (${result.status})`);
}

await mkdir(dirname(output), { recursive: true });
const frames = await mkdtemp(join(tmpdir(), 'atlas-demo-'));
try {
  const server = await serveExport(root, port, city.slug);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: false });
    for (const [i, shot] of shots.entries()) await renderShot(browser, shot, i, frames);
  } finally {
    await browser?.close();
    server.close();
  }
  // An animated AVIF plays inline and loops in a README image, which a committed video file can't;
  // AV1 keeps it a fraction of an animated WebP's size.
  encode(frames, [
    '-vf',
    'scale=1280:-2:flags=lanczos,format=yuv420p',
    '-c:v',
    'libsvtav1',
    '-crf',
    '42',
    '-preset',
    '6',
    '-g',
    '300',
    '-svtav1-params',
    'svt-log-level=1',
    '-an',
    '-f',
    'avif',
    output,
  ]);
  if (mp4)
    encode(frames, [
      '-vf',
      'scale=1280:-2',
      '-c:v',
      'libx264',
      '-crf',
      '24',
      '-preset',
      'slow',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      resolve(mp4),
    ]);
} finally {
  await rm(frames, { recursive: true, force: true });
}
console.log(`${output}: ${((await stat(output)).size / 2 ** 20).toFixed(1)} MiB`);
