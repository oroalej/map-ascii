/**
 * Night bloom: the lights' soft halo over everything they stand above, roofs and trees included.
 * The pools on the ground are the glyph pass's; this is the glow in the air. It reads the light
 * texture on the cell grid (life/lights.ts), so lit windows, which only the shaders know, don't
 * bloom. Three small programs at cell resolution, kept apart from the big select and glyph ones so
 * they add nothing to the cold compile. Off by day and on the lower quality tiers.
 */
import { BRAKE_COLOR, BRAKE_GLOW } from './life/lamps';
import { LampState } from './life/lights';
import { createTexture, setChangedUniforms, type GL } from './gpu';
import type { Programs } from './gpu-context';
import type { FrameLighting, Grid, View } from './passes';
import { metersPerCssPx } from './grid';
import { fullscreenVertex } from './shaders/fullscreen';
import { lampGlsl } from './shaders/glyph';
import { cellHashGlsl } from './shaders/hash';
import { optionalProgram } from './optional-programs';
import type * as twgl from 'twgl.js';

const float = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

export const BLOOM = {
  /** The halo's reach on the ground, m. */
  meters: 11,
  minCells: 1.5,
  /** The blur's taps stay continuous up to here; beyond it, a lamp would show as separate dots. */
  maxCells: 8,
  /** Added light at full dark. Low enough that labels over a glow stay readable. */
  strength: 1.1,
  /** Rain scatters light a little further into the air. */
  rain: 0.35,
  /** What each part of a light gives off. */
  head: 1,
  pool: 0.55,
  beam: 0.12,
  brake: 0.3,
} as const;

/** `lamps()` in shaders/glyph.ts, which the streetlights' fade-in follows. */
const lampsAt = (daylight: number) => {
  const t = Math.min(1, Math.max(0, (1 - daylight - 0.25) / 0.55));
  return t * t * (3 - 2 * t);
};

/** How strongly to add the halo now; 0 skips every bloom pass and allocation. */
export function bloomStrength(
  daylight: number,
  lampShow: number,
  rain: number,
  fireworks: boolean,
): number {
  const dark = lampsAt(daylight);
  if (dark <= 0 || (lampShow <= 0 && !fireworks)) return 0;
  return dark * BLOOM.strength * (1 + BLOOM.rain * Math.min(1, Math.max(0, rain)));
}

/** The halo's radius in cells: a set distance on the ground, within what the blur can draw. */
export function bloomRadiusCells(view: Pick<View, 'camera' | 'cellDev' | 'dpr'>): [number, number] {
  const cellMeters = (metersPerCssPx(view.camera) * view.cellDev.w) / view.dpr;
  const x = Math.min(BLOOM.maxCells, Math.max(BLOOM.minCells, BLOOM.meters / cellMeters));
  // Cells are taller than wide, so the same distance is fewer cells up and down.
  return [x, Math.max(1, (x * view.cellDev.w) / view.cellDev.h)];
}

/** Each light on the cell grid, in its colour; the target's rows run bottom-up, like the canvas. */
export const bloomExtractFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_light;
uniform int u_rows;
uniform float u_time;
uniform float u_daylight;
uniform float u_lampShow;
uniform float u_lifeTime;
uniform bool u_shimmer;
uniform sampler2D u_effectClocks;
uniform bool u_hasEffectClocks;
uniform vec3 u_haunts[8];
uniform int u_hauntCount;
uniform vec2 u_hauntOrigin;
uniform vec2 u_hauntCell;

out vec4 o_color;

${cellHashGlsl}
${lampGlsl}

void main() {
  ivec2 cell = ivec2(int(gl_FragCoord.x), u_rows - 1 - int(gl_FragCoord.y));
  vec4 light = texelFetch(u_light, cell, 0);
  o_color = vec4(0.0, 0.0, 0.0, 1.0);
  if (light.a < 0.5) return;
  int g = int(light.g * 255.0 + 0.5);
  int state = g & 7;
  float clock = state == ${LampState.candle} ? effectTime(cell, 1) : u_lifeTime;
  float on = lampOn(g, clock, vec2(cell) + 0.5) * switchedOn(g) * u_lampShow;
  if (on <= 0.0) return;
  vec3 color = state == ${LampState.flood} ? vec3(1.0, 0.9, 0.7)
    : state == ${LampState.shop} ? vec3(1.0, 0.74, 0.42) : vec3(1.0, 0.78, 0.45);
  float amount = max(light.b * ${float(BLOOM.head)}, light.r * light.r * ${float(BLOOM.pool)});
  if (state == ${LampState.beam}) {
    bool brake = (g >> 3) == ${BRAKE_GLOW.seed};
    color = brake ? vec3(${BRAKE_COLOR.night.map(float).join(', ')}) : color;
    amount = light.r * ${float(BLOOM.beam)} * (brake ? ${float(BLOOM.brake / BLOOM.beam)} : 1.0);
  }
  o_color = vec4(color * amount * on, 1.0);
}
`;

/** One direction of the blur. Linear reads between texel pairs give 17 taps' worth from nine. */
export const bloomBlurFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_source;
uniform vec2 u_radius;

out vec4 o_color;

void main() {
  vec2 size = vec2(textureSize(u_source, 0));
  vec2 uv = gl_FragCoord.xy / size;
  // A step of a quarter radius, each read centered between two texels at the widest.
  vec2 stepBy = u_radius / size / 4.0;
  vec3 sum = texture(u_source, uv).rgb * 0.17;
  sum += (texture(u_source, uv + stepBy * 0.75).rgb + texture(u_source, uv - stepBy * 0.75).rgb) * 0.16;
  sum += (texture(u_source, uv + stepBy * 1.75).rgb + texture(u_source, uv - stepBy * 1.75).rgb) * 0.125;
  sum += (texture(u_source, uv + stepBy * 2.75).rgb + texture(u_source, uv - stepBy * 2.75).rgb) * 0.08;
  sum += (texture(u_source, uv + stepBy * 3.75).rgb + texture(u_source, uv - stepBy * 3.75).rgb) * 0.05;
  o_color = vec4(sum, 1.0);
}
`;

/** Add the halo to the canvas; a little noise keeps its 8-bit falloff from banding. */
export const bloomAddFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_bloom;
uniform vec2 u_cell;
uniform vec2 u_shift;
uniform float u_height;
uniform float u_strength;

out vec4 o_color;

void main() {
  vec2 screen = vec2(gl_FragCoord.x, u_height - gl_FragCoord.y);
  vec2 cell = (screen + u_shift) / u_cell;
  vec2 size = vec2(textureSize(u_bloom, 0));
  vec3 halo = texture(u_bloom, vec2(cell.x, size.y - cell.y) / size).rgb * u_strength;
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  o_color = vec4(max(halo + (noise - 0.5) / 255.0 * step(0.002, halo.r), vec3(0.0)), 1.0);
}
`;

type Layer = { texture: WebGLTexture; framebuffer: WebGLFramebuffer };
export type BloomTarget = { cols: number; rows: number; lit: Layer; blurred: Layer };

export function createBloomTarget(gl: GL, cols: number, rows: number): BloomTarget {
  const layer = (): Layer => {
    const texture = createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { texture, framebuffer };
  };
  return { cols, rows, lit: layer(), blurred: layer() };
}

export function releaseBloom(gl: GL, target: BloomTarget): void {
  for (const layer of [target.lit, target.blurred]) {
    gl.deleteFramebuffer(layer.framebuffer);
    gl.deleteTexture(layer.texture);
  }
}

export type BloomPrograms = {
  extract: twgl.ProgramInfo;
  blur: twgl.ProgramInfo;
  add: twgl.ProgramInfo;
};

/** All three, or undefined until they have linked. Each submits on the first ask. */
export function bloomPrograms(gl: GL, programs: Programs): BloomPrograms | undefined {
  const link = (name: string, fragment: string) =>
    optionalProgram(gl, programs, name, fullscreenVertex, fragment);
  const extract = link('bloomExtract', bloomExtractFragment);
  const blur = link('bloomBlur', bloomBlurFragment);
  const add = link('bloomAdd', bloomAddFragment);
  return extract && blur && add ? { extract, blur, add } : undefined;
}

const drawFullscreen = (gl: GL, programs: Programs) => {
  gl.bindVertexArray(programs.emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
};

/** The lights, into the target. Fireworks can then draw their sparks on top (`sparkViewport`). */
export function bloomExtractPass(
  gl: GL,
  programs: Programs,
  bloom: BloomPrograms,
  target: BloomTarget,
  light: WebGLTexture,
  lighting: FrameLighting,
  time: number,
): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.lit.framebuffer);
  gl.viewport(0, 0, target.cols, target.rows);
  gl.useProgram(bloom.extract.program);
  setChangedUniforms(
    bloom.extract,
    {
      ...lighting,
      u_light: light,
      u_effectClocks: lighting.u_effectClocks ?? light,
      u_rows: target.rows,
      u_time: time,
    },
    programs.fullUniforms,
  );
  drawFullscreen(gl, programs);
}

/** Where the canvas falls on the bloom target, in its texels, for drawing sparks into it. */
export function sparkViewport(
  target: Pick<BloomTarget, 'rows'>,
  view: Pick<View, 'width' | 'height' | 'cellDev'>,
  grid: Pick<Grid, 'shiftX' | 'shiftY'>,
): [number, number, number, number] {
  const { w, h } = view.cellDev;
  const height = view.height / h;
  return [
    Math.round(grid.shiftX / w),
    Math.round(target.rows - grid.shiftY / h - height),
    Math.round(view.width / w),
    Math.round(height),
  ];
}

/** Blur the target and add it to the canvas. Leaves blending off, as the passes expect. */
export function bloomCompositePass(
  gl: GL,
  programs: Programs,
  bloom: BloomPrograms,
  target: BloomTarget,
  view: View,
  grid: Grid,
  strength: number,
): void {
  const [radiusX, radiusY] = bloomRadiusCells(view);
  gl.viewport(0, 0, target.cols, target.rows);
  gl.useProgram(bloom.blur.program);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.blurred.framebuffer);
  setChangedUniforms(
    bloom.blur,
    { u_source: target.lit.texture, u_radius: [radiusX, 0] },
    programs.fullUniforms,
  );
  drawFullscreen(gl, programs);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.lit.framebuffer);
  setChangedUniforms(
    bloom.blur,
    { u_source: target.blurred.texture, u_radius: [0, radiusY] },
    programs.fullUniforms,
  );
  drawFullscreen(gl, programs);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, view.width, view.height);
  gl.useProgram(bloom.add.program);
  setChangedUniforms(
    bloom.add,
    {
      u_bloom: target.lit.texture,
      u_cell: [view.cellDev.w, view.cellDev.h],
      u_shift: [grid.shiftX, grid.shiftY],
      u_height: view.height,
      u_strength: strength,
    },
    programs.fullUniforms,
  );
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  drawFullscreen(gl, programs);
  gl.disable(gl.BLEND);
}
