/**
 * Which part of a shader the driver's compiler is slow on (`pnpm perf:shaders -- --output=<absolute
 * path> [--only=select|glyph] [--min-body=400] [--base-only] [--dump=<absolute folder>]`). One fresh browser profile; each
 * variant links alone, with one function's body stubbed, and a nonce so no cache can answer. Run
 * under heavy.ts --exclusive: a busy machine stretches every number.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fullscreenVertex } from '../../../packages/renderer/src/shaders/fullscreen';
import { glyphFragmentFor } from '../../../packages/renderer/src/shaders/glyph';
import { selectFragment, selectLiteFragment } from '../../../packages/renderer/src/shaders/select';

type GlslFunction = { type: string; name: string; open: number; close: number };
type Variant = { shader: string; name: string; source: string };
type Result = {
  shader: string;
  name: string;
  chars: number;
  /** Compile and link, alone. */
  ms: number | null;
  /** The first draw to the canvas, and the first into a two-attachment framebuffer. */
  drawMs: number;
  fboMs: number;
  error?: string;
};

const HEAD = /^(float|int|uint|bool|void|[iu]?vec[234]|mat[234])\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;

/** Top-level functions with their body's brace positions. */
export function glslFunctions(source: string): GlslFunction[] {
  const found: GlslFunction[] = [];
  for (const match of source.matchAll(HEAD)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) {
        found.push({ type: match[1]!, name: match[2]!, open, close: i });
        break;
      }
    }
  }
  return found;
}

const stubBody = (type: string) =>
  type === 'void' ? '' : type === 'bool' ? ' return false; ' : ` return ${type}(0); `;

function variants(shader: string, source: string, minBody: number, baseOnly: boolean): Variant[] {
  const list: Variant[] = [{ shader, name: '(whole)', source }];
  if (baseOnly) return list;
  for (const fn of glslFunctions(source)) {
    if (fn.name === 'main' || fn.close - fn.open < minBody) continue;
    list.push({
      shader,
      name: fn.name,
      source: source.slice(0, fn.open + 1) + stubBody(fn.type) + source.slice(fn.close),
    });
  }
  // The whole shader again: the spread between the two is the run's noise.
  list.push({ shader, name: '(whole, again)', source });
  return list;
}

const args = new Map(
  process.argv.slice(2).flatMap((arg) => {
    if (arg === '--') return [];
    const [key, value] = arg.split('=', 2);
    return [[key!, value ?? 'true'] as const];
  }),
);
const output = args.get('--output');
if (!output || !isAbsolute(output))
  throw new Error('--output requires an absolute task-folder path');
const only = args.get('--only');
const minBody = Number(args.get('--min-body') ?? 400);
const baseOnly = args.has('--base-only');
const dump = args.get('--dump');

const shaders: Record<string, string> = {
  select: selectFragment,
  selectLite: selectLiteFragment,
  'glyph:0': glyphFragmentFor({ focus: false, effectClocks: false, seasonal: false, field: false }),
  'glyph:1': glyphFragmentFor({ focus: true, effectClocks: false, seasonal: false, field: false }),
  'glyph:all': glyphFragmentFor(),
};
const work = Object.entries(shaders)
  .filter(([name]) => !only || name.startsWith(only))
  // A sweep covers one shader of each kind; the other variants are for the baseline table.
  .flatMap(([name, source]) =>
    variants(name, source, minBody, baseOnly || (name !== 'select' && name !== 'glyph:all')),
  );

const profile = await mkdtemp(join(tmpdir(), 'atlas-probe-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 640, height: 480 },
});
const results: Result[] = [];
let renderer: string | null = null;
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('about:blank');
  renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && info ? (gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as string) : null;
  });
  if (!renderer || /swiftshader|llvmpipe|software/i.test(renderer))
    throw new Error(`The probe needs a hardware GPU; this browser reports ${renderer ?? 'none'}`);
  let nonce = 0;
  for (const variant of work) {
    // An unused constant changes the source, so neither the browser nor the driver has seen it.
    const fragment = variant.source.replace(
      /(precision highp float;)/,
      `$1\nconst float PROBE_${Date.now()}_${nonce++} = ${Math.random()};`,
    );
    const timed = await page.evaluate(
      async ([vertex, fragment]) => {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2')!;
        const parallel = gl.getExtension('KHR_parallel_shader_compile');
        const program = gl.createProgram();
        const start = performance.now();
        const parts = [
          [gl.VERTEX_SHADER, vertex],
          [gl.FRAGMENT_SHADER, fragment],
        ] as const;
        const compiled = parts.map(([type, source]) => {
          const shader = gl.createShader(type)!;
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          gl.attachShader(program, shader);
          return shader;
        });
        gl.linkProgram(program);
        if (parallel)
          while (!gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR))
            await new Promise((done) => setTimeout(done, 20));
        // The driver-language source the browser hands the compiler (ANGLE: HLSL), for offline use.
        const hlsl =
          gl.getExtension('WEBGL_debug_shaders')?.getTranslatedShaderSource(compiled[1]!) ?? null;
        const ok = gl.getProgramParameter(program, gl.LINK_STATUS) as boolean;
        const ms = performance.now() - start;
        // A first draw can compile again inside the driver layer; reading a pixel waits for it.
        const drawn = performance.now();
        let drawMs = 0;
        let fboMs = 0;
        if (ok) {
          const pixel = new Uint8Array(4);
          gl.useProgram(program);
          gl.bindVertexArray(gl.createVertexArray());
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          drawMs = performance.now() - drawn;
          // Again into a two-attachment framebuffer, as the select pass draws.
          const again = performance.now();
          const fbo = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          const attachments = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1];
          for (const attachment of attachments) {
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 4, 4);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, texture, 0);
          }
          gl.drawBuffers(attachments);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          fboMs = performance.now() - again;
        }
        const error = ok
          ? undefined
          : (gl.getProgramInfoLog(program) ?? '') +
            compiled.map((shader) => gl.getShaderInfoLog(shader) ?? '').join('\n');
        gl.deleteProgram(program);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return { ms, error, hlsl, drawMs, fboMs };
      },
      [fullscreenVertex, fragment] as const,
    );
    const result: Result = {
      shader: variant.shader,
      name: variant.name,
      chars: variant.source.length,
      ms: timed.error ? null : Math.round(timed.ms),
      drawMs: Math.round(timed.drawMs),
      fboMs: Math.round(timed.fboMs),
      ...(timed.error && { error: timed.error.slice(0, 300) }),
    };
    results.push(result);
    if (dump && timed.hlsl && variant.name === '(whole)') {
      await mkdir(dump, { recursive: true });
      await writeFile(join(dump, `${variant.shader.replace(':', '-')}.hlsl`), timed.hlsl);
    }
    console.log(
      `${result.shader.padEnd(11)} ${result.name.padEnd(24)} ${result.ms ?? 'failed'} draw ${result.drawMs} fbo ${result.fboMs}${result.error ? ` ${result.error.split('\n')[0]}` : ''}`,
    );
  }
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      version: 1,
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      renderer,
      minBody,
      results,
    },
    null,
    2,
  ),
);
console.log(`Captured ${output}`);
