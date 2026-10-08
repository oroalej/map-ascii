/** Hardware glyph-only on/off and control campaign; run under heavy.ts --exclusive. */
/* eslint-disable @typescript-eslint/unbound-method -- Native GL methods retain their receiver. */
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cities } from '../e2e/helpers';
import { currentSourceHash } from '../../../packages/renderer/scripts/snapshot';
import { e2ePort } from './e2e-port';
import { prepareExport } from './static-export';
import { serveExport } from './serve-export';

type Sample = { block: number; ms: number };
type Capture = {
  on: boolean;
  block: number;
  samples: Sample[];
  issued: Record<number, number>;
  supported: boolean;
  renderer: string | null;
  errors: string[];
  disjoint: number;
  probe: boolean;
  probes: { on: boolean; hash: number; mean: number }[];
};
type CaptureWindow = Window & { cloudCapture: Capture };

function installCapture() {
  // Pin only Date. Leave native performance, RAF and timers available for GPU sampling.
  const NativeDate = Date,
    fixed = NativeDate.parse('2026-07-10T04:00:00Z');
  globalThis.Date = new Proxy(NativeDate, {
    construct: (target, args) => Reflect.construct(target, args.length ? args : [fixed]) as Date,
    apply: () => new NativeDate(fixed).toString(),
    get: (target, key) => (key === 'now' ? () => fixed : (Reflect.get(target, key) as unknown)),
  });
  localStorage.setItem('atlas.quality', JSON.stringify('high'));
  localStorage.setItem(
    'atlas.life',
    JSON.stringify({ enabled: false, time: 'noon', wind: 'calm' }),
  );
  const c: Capture = {
    on: false,
    block: -1,
    samples: [],
    issued: {},
    supported: false,
    renderer: null,
    errors: [],
    disjoint: 0,
    probe: false,
    probes: [],
  };
  (window as unknown as CaptureWindow).cloudCapture = c;
  const proto = WebGL2RenderingContext.prototype;
  const location = proto.getUniformLocation,
    scalar = proto.uniform1f,
    integer = proto.uniform1i,
    unsigned = proto.uniform1ui,
    vector = proto.uniform2fv,
    draw = proto.drawArrays;
  const names = new WeakMap<WebGLUniformLocation, string>();
  const glyphs = new WeakMap<WebGLProgram, boolean>();
  type Extension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
  const contexts = new Map<
    WebGL2RenderingContext,
    { ext: Extension | null; pending: { query: WebGLQuery; block: number }[] }
  >();
  proto.getUniformLocation = function (program, name) {
    const at = location.call(this, program, name);
    if (at) names.set(at, name);
    return at;
  };
  proto.uniform1f = function (at, value) {
    const name = at && names.get(at);
    scalar.call(
      this,
      at,
      name === 'u_cloudCover'
        ? c.on
          ? 0.6
          : 0
        : name === 'u_daylight'
          ? 1
          : name === 'u_wind'
            ? 0
            : name === 'u_time' ||
                name === 'u_lifeTime' ||
                name === 'u_moon' ||
                name === 'u_rain' ||
                name === 'u_buntingWind'
              ? 0
              : value,
    );
  };
  proto.uniform1i = function (at, value) {
    const name = at && names.get(at);
    integer.call(
      this,
      at,
      name === 'u_cloudDetail'
        ? Number(c.on)
        : name === 'u_shimmer'
          ? 0
          : name === 'u_pulse'
            ? -1
            : value,
    );
  };
  proto.uniform1ui = function (at, value) {
    unsigned.call(this, at, at && names.get(at) === 'u_cloudSeed' ? 1234567 : value);
  };
  proto.uniform2fv = function (at, value, offset, length) {
    const name = at && names.get(at);
    if (name === 'u_cloudOffset') vector.call(this, at, [0, 0]);
    else if (name === 'u_windDir' || name === 'u_buntingWindDir') vector.call(this, at, [1, 0]);
    else vector.call(this, at, value, offset, length);
  };
  proto.drawArrays = function (mode, first, count) {
    const program = this.getParameter(this.CURRENT_PROGRAM) as WebGLProgram | null;
    if (!program) return draw.call(this, mode, first, count);
    let glyph = glyphs.get(program);
    if (glyph === undefined) {
      glyph = location.call(this, program, 'u_cloudCover') !== null;
      glyphs.set(program, glyph);
    }
    if (!glyph) return draw.call(this, mode, first, count);
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = {
        ext: this.getExtension('EXT_disjoint_timer_query_webgl2') as Extension | null,
        pending: [],
      };
      contexts.set(this, ctx);
      c.supported = !!ctx.ext;
      const info = this.getExtension('WEBGL_debug_renderer_info');
      if (info) c.renderer = this.getParameter(info.UNMASKED_RENDERER_WEBGL) as string;
    }
    const { ext, pending } = ctx;
    const disjoint = !!ext && !!this.getParameter(ext.GPU_DISJOINT_EXT);
    if (disjoint) {
      c.disjoint++;
      for (const p of pending) this.deleteQuery(p.query);
      pending.length = 0;
    }
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i]!;
      if (!this.getQueryParameter(p.query, this.QUERY_RESULT_AVAILABLE)) continue;
      const ms = Number(this.getQueryParameter(p.query, this.QUERY_RESULT)) / 1e6;
      if (Number.isFinite(ms) && ms > 0) c.samples.push({ block: p.block, ms });
      this.deleteQuery(p.query);
      pending.splice(i, 1);
    }
    if (ext && this.getQuery(ext.TIME_ELAPSED_EXT, this.CURRENT_QUERY))
      c.errors.push('Unexpected nested elapsed query');
    const query =
      ext &&
      !disjoint &&
      c.block >= 0 &&
      (c.issued[c.block] ?? 0) < 30 &&
      pending.length < 8 &&
      !this.getQuery(ext.TIME_ELAPSED_EXT, this.CURRENT_QUERY)
        ? this.createQuery()
        : null;
    if (query && ext) this.beginQuery(ext.TIME_ELAPSED_EXT, query);
    draw.call(this, mode, first, count);
    if (query && ext) {
      this.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push({ query, block: c.block });
      c.issued[c.block] = (c.issued[c.block] ?? 0) + 1;
    }
    if (c.probe) {
      c.probe = false;
      const viewport = this.getParameter(this.VIEWPORT) as Int32Array;
      const pixels = new Uint8Array(viewport[2]! * viewport[3]! * 4);
      this.readPixels(0, 0, viewport[2]!, viewport[3]!, this.RGBA, this.UNSIGNED_BYTE, pixels);
      let hash = 2166136261,
        sum = 0;
      for (let i = 0; i < pixels.length; i++) {
        hash = Math.imul(hash ^ pixels[i]!, 16777619);
        if (i % 4 !== 3) sum += pixels[i]!;
      }
      c.probes.push({ on: c.on, hash: hash >>> 0, mean: sum / ((pixels.length / 4) * 3) });
    }
    const error = this.getError();
    if (error !== this.NO_ERROR) c.errors.push(`WebGL error ${error}`);
  };
}

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q,
    lo = Math.floor(index),
    f = index - lo;
  return sorted[lo]! * (1 - f) + sorted[Math.ceil(index)]! * f;
};
const median = (values: number[]) => quantile(values, 0.5);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const outputArg = process.argv.find((v) => v.startsWith('--output='));
if (!process.argv.includes('--interleaved') || !outputArg)
  throw new Error('Use --interleaved --output=<task scratch>/gpu.json under heavy.ts --exclusive');
const output = resolve(outputArg.slice('--output='.length));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: Awaited<ReturnType<typeof serveExport>> | undefined;
const scenes: Record<string, unknown>[] = [];
let exitCode = 2;
try {
  for (let attempt = 0; await prepareExport({ root }); attempt++) {
    if (attempt >= 2) throw new Error('Export inputs remain unstable');
  }
  const city = cities.find(
    (c) => c.hasMeta && (!process.env.PERF_CITY || c.slug === process.env.PERF_CITY),
  );
  if (!city) throw new Error('No generated city archive');
  const meta = JSON.parse(
    await readFile(resolve(root, `apps/web/out/tiles/${city.slug}.meta.json`), 'utf8'),
  ) as { defaultCamera: { lat: number; lng: number } };
  const sourceHash = await currentSourceHash(root);
  const archive = resolve(root, `apps/web/out/tiles/${city.slug}.pmtiles`);
  const archiveHash = async () =>
    createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
  const tileHash = await archiveHash();
  server = await serveExport(root, e2ePort(process.env, root), city.slug);
  browser = await chromium.launch({
    headless: process.env.PERF_HEADLESS === 'true',
    channel: process.env.PERF_BROWSER_CHANNEL ?? 'chromium',
    args: [
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  for (const zoom of [16, 18]) {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      reducedMotion: 'no-preference',
    });
    const errors: string[] = [];
    const failedRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('requestfailed', (request) =>
      failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`),
    );
    await page.addInitScript({
      content: `globalThis.__name = (value) => value; (${installCapture.toString()})();`,
    });
    await page.goto(
      `${server.origin}/${city.slug}?lat=${meta.defaultCamera.lat}&lng=${meta.defaultCamera.lng}&z=${zoom}`,
    );
    await page.bringToFront();
    // Read actual GL readiness rather than waiting for unrelated network requests.
    const waitCapture = async (ready: (capture: Capture) => boolean) => {
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) {
        const capture = await page.evaluate(
          () => (window as unknown as CaptureWindow).cloudCapture,
        );
        if (capture && ready(capture)) return;
        await page.waitForTimeout(50);
      }
      throw new Error('Cloud capture did not become ready within 30 seconds');
    };
    try {
      await waitCapture((c) => c.renderer !== null);
    } catch (error) {
      throw new Error(
        JSON.stringify({
          reason: String(error),
          url: page.url(),
          title: await page.title(),
          body: (await page.locator('body').innerText()).slice(0, 2000),
          errors,
          failedRequests,
          viewport: await page.evaluate(() => {
            const rect = document.querySelector('canvas')?.getBoundingClientRect();
            return {
              width: innerWidth,
              height: innerHeight,
              canvas: rect && { width: rect.width, height: rect.height },
              visibility: document.visibilityState,
              capture: (window as unknown as CaptureWindow).cloudCapture,
            };
          }),
        }),
      );
    }
    await page.waitForTimeout(3000);
    const capture = () => page.evaluate(() => (window as unknown as CaptureWindow).cloudCapture);
    const probe = async (on: boolean) => {
      const before = (await capture()).probes.length;
      await page.evaluate((on) => {
        const c = (window as unknown as CaptureWindow).cloudCapture;
        c.on = on;
        c.block = -1;
        c.probe = true;
        window.dispatchEvent(new Event('resize'));
      }, on);
      await waitCapture((c) => c.probes.length > before);
    };
    await probe(false);
    await probe(true);
    await probe(false);
    const initial = await capture();
    const hardware =
      !!initial.renderer &&
      !/swiftshader|llvmpipe|software|basic render|lavapipe/i.test(initial.renderer);
    const blocks: {
      id: number;
      label: string;
      on: boolean;
      pair: number;
      control: boolean;
      warmup: boolean;
    }[] = [];
    let id = 0;
    const block = async (
      label: string,
      on: boolean,
      pair: number,
      control: boolean,
      warmup = false,
    ) => {
      const current = id++;
      blocks.push({ id: current, label, on, pair, control, warmup });
      await page.evaluate(
        ({ id, on }) => {
          const c = (window as unknown as CaptureWindow).cloudCapture;
          c.on = on;
          c.block = id;
          window.dispatchEvent(new Event('resize'));
        },
        { id: current, on },
      );
      try {
        await waitCapture((c) => c.samples.filter((s) => s.block === current).length === 30);
      } catch {
        return false;
      }
      console.log(`z${zoom} ${label}: 30 valid glyph timings`);
      return true;
    };
    let complete = hardware && initial.supported;
    if (complete) {
      for (let i = 0; i < 2; i++)
        for (const on of [false, true])
          complete = (await block(`warmup-${i}-${on}`, on, i, false, true)) && complete;
      for (let pair = 0; pair < 6 && complete; pair++) {
        for (const on of pair % 2 ? [true, false] : [false, true]) {
          complete = (await block(on ? 'on' : 'off', on, pair, false)) && complete;
        }
        for (const label of pair % 2 ? ['off-B', 'off-A'] : ['off-A', 'off-B'])
          complete = (await block(label, false, pair, true)) && complete;
        await probe(false);
      }
    }
    await probe(false);
    const evidence = await capture();
    const offProbes = evidence.probes.filter((p) => !p.on),
      onProbe = evidence.probes.find((p) => p.on);
    const stable =
      sourceHash === (await currentSourceHash(root)) &&
      tileHash === (await archiveHash()) &&
      offProbes.every((p) => p.hash === offProbes[0]!.hash);
    const exercised =
      !!onProbe && onProbe.hash !== offProbes[0]!.hash && onProbe.mean < offProbes[0]!.mean;
    const blockMedian = (label: string, pair: number) => {
      const b = blocks.find((b) => b.label === label && b.pair === pair)!;
      return median(evidence.samples.filter((s) => s.block === b.id).map((s) => s.ms));
    };
    const changes = complete
      ? Array.from({ length: 6 }, (_, p) => blockMedian('on', p) - blockMedian('off', p))
      : [];
    const control = complete
      ? Array.from({ length: 6 }, (_, p) => blockMedian('off-B', p) - blockMedian('off-A', p))
      : [];
    const deltaMs = complete ? median(changes) : null;
    const controlSpreadMs = complete ? quantile(control, 0.95) - quantile(control, 0.05) : null;
    const limitMs = controlSpreadMs === null ? null : Math.max(0.5, 2 * controlSpreadMs);
    const allErrors = [...errors, ...evidence.errors];
    const status = allErrors.length
      ? 'fail'
      : !hardware || !initial.supported || !complete || !stable || !exercised || evidence.disjoint
        ? 'pending'
        : deltaMs! <= limitMs!
          ? 'pass'
          : 'fail';
    scenes.push({
      zoom,
      camera: meta.defaultCamera,
      status,
      hardware,
      stable,
      exercised,
      deltaMs,
      controlSpreadMs,
      limitMs,
      changes,
      control,
      blocks,
      evidence: { ...evidence, errors: allErrors },
    });
    console.log(
      JSON.stringify({
        zoom,
        status,
        renderer: evidence.renderer,
        deltaMs,
        controlSpreadMs,
        limitMs,
        complete,
        stable,
        exercised,
      }),
    );
    await page.close();
  }
  exitCode = scenes.some((s) => s.status === 'fail')
    ? 1
    : scenes.every((s) => s.status === 'pass')
      ? 0
      : 2;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        status: exitCode === 0 ? 'pass' : exitCode === 1 ? 'fail' : 'pending',
        sourceHash,
        tileHash,
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        city: city.slug,
        viewport: [1920, 1080],
        dpr: 1,
        quality: 'high',
        life: false,
        date: '2026-07-10T04:00:00Z',
        scenes,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify({ status: 'pending', reason: String(error), scenes }, null, 2),
  );
  console.error(error);
} finally {
  await browser?.close();
  server?.close();
  process.exitCode = exitCode;
}
