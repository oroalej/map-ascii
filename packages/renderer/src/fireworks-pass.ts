import type { FireworksConfig } from '@atlas/shared';
import * as twgl from 'twgl.js';
import { createProgram, type CellTargets, type GL } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';
import type { Grid, View } from './grid';
import type { WindNow } from './life/wind';
import {
  FIREWORKS,
  createFireworkDisplay,
  fireworkInstances,
  fireworkScale,
  fireworkShellCount,
  fireworkShells,
  fireworkVariantCodes,
  type FireworkDisplay,
} from './fireworks-layout';
import { fireworksFragment, fireworksVertex } from './shaders/fireworks';

export type FireworksResources = {
  program: twgl.ProgramInfo;
  vao: WebGLVertexArrayObject | null;
  buffer: WebGLBuffer | null;
  shells: Float32Array;
  display: FireworkDisplay;
  variants: Int32Array;
  config?: FireworksConfig;
};

/** Created lazily for a pack that opts in; one static upload for the entire context lifetime. */
function createFireworks(gl: GL): FireworksResources {
  const program = createProgram(gl, fireworksVertex, fireworksFragment);
  const vao = gl.createVertexArray(),
    buffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, fireworkInstances(), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
  gl.vertexAttribDivisor(0, 1);
  gl.bindVertexArray(null);
  return {
    program,
    vao,
    buffer,
    shells: new Float32Array(FIREWORKS.shells * 4),
    display: createFireworkDisplay(),
    variants: new Int32Array(4),
  };
}

export function deleteFireworks(gl: GL, resources: FireworksResources) {
  gl.deleteProgram(resources.program.program);
  gl.deleteVertexArray(resources.vao);
  gl.deleteBuffer(resources.buffer);
}

/** Atmospheric ASCII shells above the map; labels/halos stay readable and picking is untouched. */
export function fireworksPass(
  gl: GL,
  programs: Programs,
  targets: CellTargets,
  theme: ThemeResources,
  view: View,
  grid: Grid,
  labelGrid: Grid,
  config: FireworksConfig | undefined,
  time: number,
  reduced: boolean,
  wind: WindNow,
  daylight: number,
) {
  if (!config?.variants.length || !fireworkShellCount(view.camera.zoom)) return;
  const resources = (programs.fireworks ??= createFireworks(gl));
  if (resources.config !== config) {
    resources.variants.fill(0);
    resources.variants.set(fireworkVariantCodes(config));
    resources.config = config;
  }
  const count = fireworkShells(view, grid, resources.shells, resources.display, time, reduced);
  const windScale = view.dpr * fireworkScale(view.camera.zoom);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, view.width, view.height);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(resources.program.program);
  twgl.setUniforms(resources.program, {
    u_shells: resources.shells,
    u_size: [view.width, view.height],
    u_cell: [view.cellDev.w, view.cellDev.h],
    u_shift: [grid.shiftX, grid.shiftY],
    u_flights: resources.display.flights,
    u_wind: reduced
      ? [0, 0]
      : [wind.dir[0] * wind.strength * windScale, wind.dir[1] * wind.strength * windScale],
    u_variants: resources.variants,
    u_variantCount: config.variants.length,
    u_atlas: theme.map.atlasTex,
    u_columns: theme.map.atlas.columns,
    u_codes: ['·', '*', '+', '─', '╱', '│', '╲'].map((glyph) => theme.map.atlas.index(glyph)),
    u_overlay: targets.overlayTex,
    u_labelCell: [view.labelDev.w, view.labelDev.h],
    u_labelShift: [labelGrid.shiftX, labelGrid.shiftY],
    u_height: view.height,
    u_daylight: daylight,
  });
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindVertexArray(resources.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, resources.buffer);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count * FIREWORKS.smoke);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, FIREWORKS.shells * FIREWORKS.smoke * 16);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count * FIREWORKS.stars * FIREWORKS.tails);
  gl.bindVertexArray(null);
  gl.disable(gl.BLEND);
}
