/** Run from the repo root after pnpm build. Hardware Chromium by default; exit 2 means pending. */
/* eslint-disable @typescript-eslint/unbound-method -- Native GL methods retain their receiver. */
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { cities } from '../e2e/helpers';
import { serveExport } from './serve-export';
import { classId, Flags, groundClasses } from '../../../packages/renderer/src/classes';
import { awningReport, type AwningSample } from './awning-report';
import { verifyAwningColors } from './awning-shader';
import { partyWallsGlsl } from '../../../packages/renderer/src/shaders/party-walls';
import { wallJoinGlsl } from '../../../packages/renderer/src/shaders/wall-mask';
import { ROOF_BUILDING_CLASSES } from '../../../packages/shared/src/roof-plan';
import { verifyPartyWalls } from './party-wall-shader';
import { prepareExport } from './static-export';
import { currentSourceHash } from '../../../packages/renderer/scripts/snapshot';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// A concurrent edit during a build deliberately leaves no freshness stamp.
// Confirm reuse before recording source provenance, with a bounded retry.
for (let attempt = 0; await prepareExport(); attempt++) {
  if (attempt >= 2)
    throw new Error('Sources are still changing; rerun after the other build finishes');
}
const sourceHash = await currentSourceHash(root);
const partyMode = process.argv.includes('--party-walls');
const port = Number(process.env.E2E_PORT ?? 3218);
const city = cities.find(
  (c) => c.hasMeta && (!process.env.PERF_CITY || c.slug === process.env.PERF_CITY),
);
if (!city) throw new Error('Build the requested city before capturing awning acceptance');
const meta = JSON.parse(
  await readFile(resolve(root, `apps/web/out/tiles/${city.slug}.meta.json`), 'utf8'),
) as { defaultCamera: { lat: number; lng: number } };
const zoom = Number(process.env.PERF_ZOOM ?? 18);
if (!Number.isFinite(zoom) || zoom < 0 || zoom > 21) throw new Error('Invalid PERF_ZOOM');
const camera = { ...meta.defaultCamera, zoom };
const outputName = partyMode ? `party-walls${zoom === 18 ? '' : `-z${zoom}`}` : 'awnings';
const tileHash = createHash('sha256')
  .update(await readFile(resolve(root, `apps/web/out/tiles/${city.slug}.pmtiles`)))
  .digest('hex');
const server = await serveExport(root, port, city.slug);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
type Capture = {
  on: boolean;
  block: number;
  samples: AwningSample[];
  supported: boolean;
  renderer: string | null;
  buildings: number;
  awnings: number;
  contacts?: number;
  errors: string[];
  disjoint: number;
  read: boolean;
  reads: number;
  fingerprint: string;
  dispose?: () => void;
};
type CaptureWindow = Window & { awningCapture: Capture };
try {
  browser = await chromium.launch({
    headless: process.env.PERF_HEADLESS === 'true',
    channel: process.env.PERF_BROWSER_CHANNEL,
    args: [
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });
  await page.clock.setFixedTime(new Date('2026-10-01T04:00:00Z'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const installCapture = (input: {
    buildingClasses: number[];
    roofClasses: number[];
    landmark: number;
    crown: number;
    party: boolean;
    partySource: string;
    bypass: string;
  }) => {
    const { buildingClasses } = input;
    localStorage.setItem('atlas.quality', JSON.stringify('high'));
    localStorage.setItem(
      'atlas.life',
      JSON.stringify({ enabled: false, time: 'noon', wind: 'calm' }),
    );
    const c: Capture = {
      on: false,
      block: -1,
      samples: [],
      supported: false,
      renderer: null,
      buildings: 0,
      awnings: 0,
      errors: [],
      disjoint: 0,
      read: false,
      reads: 0,
      fingerprint: '',
    };
    (window as unknown as CaptureWindow).awningCapture = c;
    const proto = WebGL2RenderingContext.prototype,
      location = proto.getUniformLocation,
      scalar = proto.uniform1f,
      vector = proto.uniform2fv,
      integer = proto.uniform1i,
      draw = proto.drawArrays;
    const linked = proto.linkProgram,
      used = proto.useProgram;
    const bypasses = new Map<WebGLProgram, WebGLProgram>();
    const current = new WeakMap<WebGL2RenderingContext, WebGLProgram>();
    const originalUniforms = new Map<string, unknown>();
    if (input.party) {
      proto.linkProgram = function (program) {
        linked.call(this, program);
        const shaders = this.getAttachedShaders(program) ?? [];
        const fragment = shaders.find(
          (s) => this.getShaderParameter(s, this.SHADER_TYPE) === this.FRAGMENT_SHADER,
        );
        const source = fragment && this.getShaderSource(fragment);
        if (!source?.includes(input.partySource)) return;
        const off = this.createProgram();
        for (const shader of shaders) {
          const type = this.getShaderParameter(shader, this.SHADER_TYPE) as number;
          const copy = this.createShader(type)!;
          this.shaderSource(
            copy,
            type === this.FRAGMENT_SHADER
              ? source.replace(input.partySource, input.bypass)
              : this.getShaderSource(shader)!,
          );
          this.compileShader(copy);
          if (!this.getShaderParameter(copy, this.COMPILE_STATUS))
            throw new Error(this.getShaderInfoLog(copy)!);
          this.attachShader(off, copy);
          this.deleteShader(copy);
        }
        linked.call(this, off);
        if (!this.getProgramParameter(off, this.LINK_STATUS))
          throw new Error(this.getProgramInfoLog(off)!);
        bypasses.set(program, off);
      };
      proto.useProgram = function (program) {
        const actual = program && !c.on ? (bypasses.get(program) ?? program) : program;
        if (actual) current.set(this, actual);
        used.call(this, actual);
      };
    }
    const names = new WeakMap<WebGLUniformLocation, string>();
    const programs = new WeakMap<WebGLProgram, boolean>();
    type Extension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
    const contexts = new Map<
      WebGL2RenderingContext,
      { ext: Extension | null; pending: { query: WebGLQuery; block: number }[] }
    >();
    proto.getUniformLocation = function (program, name) {
      const result = location.call(this, program, name);
      if (result) names.set(result, name);
      return result;
    };
    proto.uniform1f = function (at, value) {
      const name = at && names.get(at);
      scalar.call(this, at, name === 'u_time' ? 0 : name === 'u_wind' ? 0.25 : value);
    };
    proto.uniform2fv = function (at, value, offset, length) {
      if (at && names.get(at) === 'u_windDir') vector.call(this, at, [1, 0]);
      else vector.call(this, at, value, offset, length);
    };
    proto.uniform1i = function (at, value) {
      integer.call(
        this,
        at,
        at && names.get(at) === 'u_awnings' ? Number(input.party || c.on) : value,
      );
    };
    // TWGL caches original-program uniform locations. Resolve the same names on the bypass.
    if (input.party)
      for (const key of Object.getOwnPropertyNames(proto).filter((k) => /^uniform/.test(k))) {
        const methods = proto as unknown as Record<string, unknown>;
        const method = methods[key];
        if (typeof method !== 'function') continue;
        originalUniforms.set(key, method);
        methods[key] = function (
          this: WebGL2RenderingContext,
          at: WebGLUniformLocation | null,
          ...values: unknown[]
        ) {
          const program = current.get(this),
            name = at && names.get(at);
          const mapped = program && name ? location.call(this, program, name) : at;
          if (mapped && name) names.set(mapped, name);
          Reflect.apply(method, this, [mapped, ...values]);
        };
      }
    proto.drawArrays = function (mode, first, count) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- Nested readback helpers share this GL receiver.
      const gl = this,
        program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
      if (!program) {
        draw.call(gl, mode, first, count);
        return;
      }
      let select = programs.get(program);
      if (select === undefined) {
        select = location.call(gl, program, 'u_awnings') !== null;
        programs.set(program, select);
      }
      if (!select) {
        draw.call(gl, mode, first, count);
        return;
      }
      let ctx = contexts.get(gl);
      if (!ctx) {
        ctx = {
          ext: gl.getExtension('EXT_disjoint_timer_query_webgl2') as Extension | null,
          pending: [],
        };
        contexts.set(gl, ctx);
        c.supported = !!ctx.ext;
        const info = gl.getExtension('WEBGL_debug_renderer_info') as {
          UNMASKED_RENDERER_WEBGL: number;
        } | null;
        if (info) c.renderer = gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as string;
      }
      const { ext, pending } = ctx;
      const disjoint = ext && (gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean);
      if (disjoint) {
        if (c.block >= 0) c.disjoint++;
        for (const p of pending) gl.deleteQuery(p.query);
        pending.length = 0;
      }
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i]!;
        if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) continue;
        c.samples.push({
          block: p.block,
          ms: Number(gl.getQueryParameter(p.query, gl.QUERY_RESULT)) / 1e6,
        });
        gl.deleteQuery(p.query);
        pending.splice(i, 1);
      }
      // No debug/full-frame timer is enabled in this page. Never nest elapsed queries.
      const query =
        ext &&
        !disjoint &&
        c.block >= 0 &&
        pending.length < 8 &&
        !gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)
          ? gl.createQuery()
          : null;
      if (query && ext) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      draw.call(gl, mode, first, count);
      if (query && ext) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        pending.push({ query, block: c.block });
      }
      if (!c.read || c.block >= 0) return;
      c.read = false;
      const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
      const [width, height] = [viewport[2]!, viewport[3]!];
      const saved = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const active = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
      const fbo = gl.createFramebuffer();
      const texturePixels = (name: string) => {
        const sampler = location.call(gl, program, name)!;
        gl.activeTexture(gl.TEXTURE0 + Number(gl.getUniform(program, sampler)));
        const texture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        const bytes = new Uint8Array(pixels.length);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        return bytes;
      };
      const ids = texturePixels('u_id'),
        attributes = texturePixels('u_attr');
      let contacts = 0;
      if (input.party) {
        const cls = texturePixels('u_class'),
          baseCls = texturePixels('u_baseClass'),
          baseAttr = texturePixels('u_baseAttr'),
          baseIds = texturePixels('u_baseId');
        const cell = (index: number) => {
          const crown = cls[index] === input.crown;
          const a = crown ? baseAttr : attributes,
            id = crown ? baseIds : ids;
          return {
            cls: (crown ? baseCls : cls)[index]!,
            height: a[index]!,
            landmark: a[index + 1]! & input.landmark,
            id:
              id[index]! | (id[index + 1]! << 8) | (id[index + 2]! << 16) | (id[index + 3]! << 24),
          };
        };
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const a = cell((y * width + x) * 4);
            if (!input.roofClasses.includes(a.cls) || !a.height) continue;
            for (const [dx, dy] of [
              [1, 0],
              [0, 1],
            ]) {
              if (x + dx! >= width || y + dy! >= height) continue;
              const b = cell(((y + dy!) * width + x + dx!) * 4);
              if (
                input.roofClasses.includes(b.cls) &&
                b.height === a.height &&
                b.landmark === a.landmark &&
                b.id !== a.id
              )
                contacts++;
            }
          }
      }
      c.contacts = input.party ? contacts : undefined;
      const buildings = new Set<number>(),
        awnings = new Set<number>();
      let hash = 2166136261;
      for (let i = 0; i < pixels.length; i += 4) {
        for (let j = 0; j < 4; j++) {
          hash = Math.imul(hash ^ ids[i + j]!, 16777619);
          hash = Math.imul(hash ^ attributes[i + j]!, 16777619);
        }
        if (!buildingClasses.includes(pixels[i + 1]! & 63) || !attributes[i]) continue;
        const id = ids[i]! | (ids[i + 1]! << 8) | (ids[i + 2]! << 16) | (ids[i + 3]! << 24);
        if (!id) continue;
        buildings.add(id);
        if (pixels[i + 2]! >> 4 > 0) awnings.add(id);
      }
      c.buildings = buildings.size;
      c.awnings = awnings.size;
      c.fingerprint = `${width}/${height}/${hash >>> 0}`;
      c.reads++;
      gl.activeTexture(active);
      gl.bindFramebuffer(gl.FRAMEBUFFER, saved);
      gl.deleteFramebuffer(fbo);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) c.errors.push(`WebGL error ${error}`);
    };
    c.dispose = () => {
      for (const [gl, ctx] of contexts) for (const p of ctx.pending) gl.deleteQuery(p.query);
      contexts.clear();
      for (const [key, method] of originalUniforms)
        (proto as unknown as Record<string, unknown>)[key] = method;
      for (const [gl] of contexts) for (const off of bypasses.values()) gl.deleteProgram(off);
      proto.linkProgram = linked;
      proto.useProgram = used;
      proto.getUniformLocation = location;
      proto.uniform1f = scalar;
      proto.uniform2fv = vector;
      proto.uniform1i = integer;
      proto.drawArrays = draw;
    };
  };
  // Install tsx's serialization helper before evaluating the capture function itself.
  await page.addInitScript({
    content: `globalThis.__name = (value) => value; (${installCapture.toString()})(${JSON.stringify(
      {
        buildingClasses: groundClasses.map(classId),
        roofClasses: ROOF_BUILDING_CLASSES.map(classId),
        landmark: Flags.landmark,
        crown: classId('tree_crown'),
        party: partyMode,
        partySource: partyWallsGlsl,
        bypass: `${wallJoinGlsl}
const bool partyCached3=false; uint partyIds[25]; bool partyThrough[25]; bool partyRoof[25];
int partyWallMask(ivec2 p){return -2;} bool partySeam(ivec2 p,int cls,vec4 attr){return false;}`,
      },
    )});`,
  });
  await page.goto(
    `http://localhost:${port}/${city.slug}?lat=${camera.lat}&lng=${camera.lng}&z=${camera.zoom}`,
  );
  await page.bringToFront();
  await page.waitForLoadState('networkidle');
  console.log(
    'Loaded',
    await page.evaluate(() => ({
      canvas: !!document.querySelector('canvas'),
      capture: !!(window as unknown as CaptureWindow).awningCapture,
    })),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(2000);
  const capture = () =>
    page.evaluate(() => {
      const c = (window as unknown as CaptureWindow).awningCapture;
      return {
        on: c.on,
        block: c.block,
        samples: c.samples,
        supported: c.supported,
        renderer: c.renderer,
        buildings: c.buildings,
        awnings: c.awnings,
        contacts: c.contacts,
        errors: c.errors,
        disjoint: c.disjoint,
        reads: c.reads,
        fingerprint: c.fingerprint,
      };
    });
  const readScene = async () => {
    const reads = (await capture()).reads;
    await page.evaluate(() => {
      const c = (window as unknown as CaptureWindow).awningCapture;
      c.block = -1;
      c.on = true;
      c.read = true;
      window.dispatchEvent(new Event('resize'));
    });
    const deadline = performance.now() + 30000;
    while ((await capture()).reads <= reads) {
      if (performance.now() >= deadline)
        throw new Error('Select pass did not render the coverage probe');
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await new Promise((r) => setTimeout(r, 100));
    }
    return capture();
  };
  const fingerprints: string[] = [];
  for (let i = 0; i < 3; i++) {
    fingerprints.push((await readScene()).fingerprint);
    await page.waitForTimeout(500);
  }
  const initial = await capture();
  console.log(
    JSON.stringify({
      renderer: initial.renderer,
      supported: initial.supported,
      buildings: initial.buildings,
      awnings: initial.awnings,
    }),
  );
  if (initial.supported)
    for (let block = 0; block < 6; block++) {
      await page.evaluate((block) => {
        const c = (window as unknown as CaptureWindow).awningCapture;
        c.on = block % 2 === 1;
        c.block = block;
      }, block);
      const deadline = performance.now() + 15000;
      while (performance.now() < deadline) {
        await page.evaluate(() => window.dispatchEvent(new Event('resize')));
        await page.waitForTimeout(40);
        if ((await capture()).samples.filter((s) => s.block === block).length >= 80) break;
      }
      fingerprints.push((await readScene()).fingerprint);
      console.log(
        `Block ${block + 1}/6: ${(await capture()).samples.filter((s) => s.block === block).length} samples`,
      );
    }
  const final = await readScene();
  const probe = await browser.newPage();
  let shaderChecks: Awaited<ReturnType<typeof verifyAwningColors>> = [];
  try {
    shaderChecks = await verifyAwningColors(probe);
  } catch (error) {
    errors.push(String(error));
  } finally {
    await probe.close();
  }
  const partyProbe = await browser.newPage();
  let partyShaderChecks: Awaited<ReturnType<typeof verifyPartyWalls>> = [];
  try {
    partyShaderChecks = await verifyPartyWalls(partyProbe);
  } catch (error) {
    errors.push(String(error));
  } finally {
    await partyProbe.close();
  }
  const evidence = {
    ...final,
    errors: [...errors, ...final.errors],
    stable:
      sourceHash === (await currentSourceHash(root)) &&
      tileHash ===
        createHash('sha256')
          .update(await readFile(resolve(root, `apps/web/out/tiles/${city.slug}.pmtiles`)))
          .digest('hex') &&
      fingerprints.every((f) => f === initial.fingerprint) &&
      final.fingerprint === initial.fingerprint,
  };
  const report = {
    ...awningReport(evidence),
    mode: partyMode ? 'party-walls' : 'awnings',
    shaderChecks,
    partyShaderChecks,
    evidence,
    city: city.slug,
    camera,
    viewport: [1920, 1080],
    dpr: 1,
    quality: 'high',
    theme: 'dark',
    date: '2026-10-01T04:00:00Z',
    shaderTime: 0,
    life: false,
    wind: 'calm',
    windUniforms: { strength: 0.25, direction: [1, 0] },
    tileHash,
    sourceHash,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    fingerprints,
  };
  const out = resolve(root, process.env.PERF_OUTPUT ?? 'test-results');
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, `${outputName}.json`), JSON.stringify(report, null, 2));
  await page.screenshot({
    path: resolve(out, `${outputName}-centro.png`),
  });
  await page.evaluate(() => (window as unknown as CaptureWindow).awningCapture.dispose?.());
  console.log(
    JSON.stringify({
      ...report,
      evidence: { ...evidence, samples: `${evidence.samples.length} samples saved` },
    }),
  );
  process.exitCode = report.exitCode;
} finally {
  await browser?.close();
  server.close();
}
