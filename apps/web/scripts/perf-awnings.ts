/** Fixed-scene capture against this export. PERF_HEADLESS=false and PERF_BROWSER_CHANNEL=chrome allow a hardware-backed browser. */
/* eslint-disable @typescript-eslint/unbound-method -- Native methods are reinstalled and called with their original GL receiver. */
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cities } from '../e2e/helpers';
import { classId, renderClasses } from '../../../packages/renderer/src/classes';
const port = Number(process.env.E2E_PORT ?? 3218);
const city = cities.find((city) => city.hasMeta);
if (!city) throw new Error('Build a city before capturing awning acceptance');
const meta = JSON.parse(await readFile(`apps/web/public/tiles/${city.slug}.meta.json`, 'utf8')) as {
  defaultCamera: { lat: number; lng: number };
};
const camera = { ...meta.defaultCamera, zoom: 18 };
const browser = await chromium.launch({
  headless: process.env.PERF_HEADLESS !== 'false',
  channel: process.env.PERF_BROWSER_CHANNEL,
});
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  reducedMotion: 'no-preference',
});
type Capture = {
  on: boolean;
  samples: { on: boolean; ms: number }[];
  supported: boolean;
  renderer: string | null;
  buildings: number;
  awnings: number;
  errors: string[];
};
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const buildingClasses = renderClasses.filter((c) => c.startsWith('building')).map(classId);
try {
  await page.addInitScript(
    ({ buildingClasses }) => {
      localStorage.setItem('atlas.quality', JSON.stringify('high'));
      localStorage.setItem(
        'atlas.life',
        JSON.stringify({ enabled: false, time: 'noon', wind: 'calm' }),
      );
      const capture: Capture = {
        on: false,
        samples: [],
        supported: false,
        renderer: null,
        buildings: 0,
        awnings: 0,
        errors: [],
      };
      (window as unknown as { awningCapture: Capture }).awningCapture = capture;
      const proto = WebGL2RenderingContext.prototype,
        use = proto.useProgram,
        location = proto.getUniformLocation,
        scalar = proto.uniform1f,
        integer = proto.uniform1i;
      const names = new WeakMap<WebGLUniformLocation, string>();
      proto.getUniformLocation = function (program, name) {
        const result = location.call(this, program, name);
        if (result) names.set(result, name);
        return result;
      };
      proto.uniform1f = function (at, value) {
        return scalar.call(this, at, at && names.get(at) === 'u_time' ? 0 : value);
      };
      proto.uniform1i = function (at, value) {
        return integer.call(
          this,
          at,
          at && names.get(at) === 'u_awnings' ? Number(capture.on) : value,
        );
      };
      const seen = new WeakMap<WebGLProgram, boolean>();
      let current:
        | {
            gl: WebGL2RenderingContext;
            program: WebGLProgram;
            fbo: WebGLFramebuffer | null;
            width: number;
            height: number;
            query: WebGLQuery | null;
            on: boolean;
          }
        | undefined;
      const pending: { gl: WebGL2RenderingContext; query: WebGLQuery; on: boolean }[] = [];
      let lastRead = -Infinity;
      proto.useProgram = function (program) {
        const ext = this.getExtension('EXT_disjoint_timer_query_webgl2') as {
          TIME_ELAPSED_EXT: number;
          GPU_DISJOINT_EXT: number;
        } | null;
        capture.supported ||= !!ext;
        const info = this.getExtension('WEBGL_debug_renderer_info') as {
          UNMASKED_RENDERER_WEBGL: number;
        } | null;
        if (info) capture.renderer = this.getParameter(info.UNMASKED_RENDERER_WEBGL) as string;
        if (current) {
          if (current.query && ext) {
            current.gl.endQuery(ext.TIME_ELAPSED_EXT);
            pending.push({ gl: current.gl, query: current.query, on: current.on });
          }
          if (capture.on && performance.now() - lastRead > 1000) {
            lastRead = performance.now();
            const gl = current.gl,
              saved = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
            gl.bindFramebuffer(gl.FRAMEBUFFER, current.fbo);
            const pixels = new Uint8Array(current.width * current.height * 4);
            gl.readPixels(0, 0, current.width, current.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            const active = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
            const sampler = location.call(gl, current.program, 'u_id');
            gl.activeTexture(gl.TEXTURE0 + Number(gl.getUniform(current.program, sampler!)));
            const texture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture;
            gl.activeTexture(active);
            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(
              gl.FRAMEBUFFER,
              gl.COLOR_ATTACHMENT0,
              gl.TEXTURE_2D,
              texture,
              0,
            );
            const ids = new Uint8Array(pixels.length);
            gl.readPixels(0, 0, current.width, current.height, gl.RGBA, gl.UNSIGNED_BYTE, ids);
            const buildings = new Set<number>(),
              awnings = new Set<number>();
            for (let i = 0; i < pixels.length; i += 4)
              if (buildingClasses.includes(pixels[i + 1]!)) {
                const id = ids[i]! | (ids[i + 1]! << 8) | (ids[i + 2]! << 16) | (ids[i + 3]! << 24);
                if (id) {
                  buildings.add(id);
                  if (pixels[i + 2]! >> 4 > 0) awnings.add(id);
                }
              }
            capture.buildings = buildings.size;
            capture.awnings = awnings.size;
            gl.bindFramebuffer(gl.FRAMEBUFFER, saved);
            gl.deleteFramebuffer(fbo);
          }
          current = undefined;
        }
        for (let i = pending.length - 1; i >= 0; i--) {
          const entry = pending[i]!,
            gl = entry.gl;
          if (!gl.getQueryParameter(entry.query, gl.QUERY_RESULT_AVAILABLE)) continue;
          if (ext && !gl.getParameter(ext.GPU_DISJOINT_EXT))
            capture.samples.push({
              on: entry.on,
              ms: Number(gl.getQueryParameter(entry.query, gl.QUERY_RESULT)) / 1e6,
            });
          gl.deleteQuery(entry.query);
          pending.splice(i, 1);
        }
        use.call(this, program);
        if (!program) return;
        let select = seen.get(program);
        if (select === undefined) {
          select = location.call(this, program, 'u_awnings') !== null;
          seen.set(program, select);
        }
        if (!select) return;
        const viewport = this.getParameter(this.VIEWPORT) as Int32Array;
        const query =
          ext && pending.length < 8 && !this.getParameter(ext.GPU_DISJOINT_EXT)
            ? this.createQuery()
            : null;
        if (query && ext) this.beginQuery(ext.TIME_ELAPSED_EXT, query);
        current = {
          gl: this,
          program,
          fbo: this.getParameter(this.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
          width: viewport[2]!,
          height: viewport[3]!,
          query,
          on: capture.on,
        };
      };
    },
    { buildingClasses },
  );
  await page.goto(
    `http://localhost:${port}/${city.slug}?lat=${camera.lat}&lng=${camera.lng}&z=${camera.zoom}`,
  );
  await page.locator('canvas').waitFor();
  await page.waitForTimeout(10000);
  const supported = await page.evaluate(
    () => (window as unknown as { awningCapture: Capture }).awningCapture.supported,
  );
  for (const on of supported ? [false, true, false, true] : [false, true]) {
    await page.evaluate((on) => {
      const c = (window as unknown as { awningCapture: Capture }).awningCapture;
      c.on = on;
    }, on);
    for (let i = 0; i < (supported ? 100 : 20); i++) {
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await page.waitForTimeout(40);
    }
  }
  await page.waitForTimeout(500);
  const capture = await page.evaluate(
    () => (window as unknown as { awningCapture: Capture }).awningCapture,
  );
  const stats = (on: boolean) => {
    const samples = capture.samples
      .filter((s) => s.on === on)
      .map((s) => s.ms)
      .slice(20)
      .sort((a, b) => a - b);
    return {
      count: samples.length,
      p50: samples[Math.floor(samples.length * 0.5)] ?? null,
      p95: samples[Math.floor(samples.length * 0.95)] ?? null,
    };
  };
  const off = stats(false),
    on = stats(true);
  const report = {
    viewport: [1920, 1080],
    dpr: 1,
    quality: 'high',
    camera,
    shaderTime: 0,
    life: false,
    wind: 'calm',
    supported: capture.supported,
    renderer: capture.renderer,
    off,
    on,
    buildings: capture.buildings,
    awnings: capture.awnings,
    share: capture.buildings ? capture.awnings / capture.buildings : null,
    errors,
    pending: off.count < 45 || on.count < 45,
  };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/awnings.json', JSON.stringify(report, null, 2));
  await page.screenshot({ path: 'test-results/awnings-centro.png' });
  console.log(JSON.stringify(report));
  if (
    errors.length ||
    (report.share ?? 0) > 0.3 ||
    (off.p95 !== null && on.p95 !== null && on.p95 - off.p95 > Math.max(0.5, off.p95 * 0.1))
  )
    process.exitCode = 1;
} finally {
  await browser.close();
}
