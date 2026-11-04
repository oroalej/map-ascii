/**
 * The dissolve between two drawings of the map: a cell-size step, where every cell changes at once
 * (density.ts), and the boot shaders giving way to the full ones (shaders/boot.ts). The last frame
 * is drawn once more without its labels into a texture, and that image follows the camera over the
 * new map, cell by cell going out in a scattered order like the band fades (shaders/cell.ts).
 */
import { project } from './camera';
import { createTexture, setChangedUniforms, type GL } from './gpu';
import type { Programs } from './gpu-context';
import type { Grid, View } from './passes';
import { cellHashGlsl } from './shaders/hash';
import type * as twgl from 'twgl.js';

export const MORPH_MS = 280;

export const morphFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_snapshot;
uniform sampler2D u_overlay;
uniform vec2 u_size;
uniform float u_scale;
uniform vec2 u_offset;
uniform vec2 u_cell;
uniform vec2 u_shift;
uniform ivec2 u_origin;
uniform vec2 u_labelCell;
uniform vec2 u_labelShift;
uniform float u_progress;

out vec4 o_color;

${cellHashGlsl}

void main() {
  vec2 screen = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  // Labels keep to the new frame: the snapshot has none, and they should never flicker.
  vec4 over = texelFetch(u_overlay, ivec2(floor((screen + u_labelShift) / u_labelCell)), 0);
  if (over.r + over.g > 0.0) discard;
  ivec2 cell = ivec2(floor((screen + u_shift) / u_cell));
  if (float(cellHash(u_origin + cell) & 255u) / 255.0 < u_progress) discard;
  vec2 from = screen * u_scale + u_offset;
  if (from.x < 0.0 || from.y < 0.0 || from.x >= u_size.x || from.y >= u_size.y) discard;
  o_color = vec4(texture(u_snapshot, vec2(from.x, u_size.y - from.y) / u_size).rgb, 1.0);
}
`;

type Camera = { lng: number; lat: number; zoom: number };

/**
 * Where a device pixel of the current view falls in the snapshot: `pixel * scale + offset`. Both
 * views are north-up, so a uniform scale and an offset are the whole of it.
 */
export function morphMapping(
  from: Camera,
  to: Camera,
  size: { width: number; height: number },
  dpr: number,
): { scale: number; offset: [number, number] } {
  const scale = 2 ** (from.zoom - to.zoom);
  const [fromX, fromY] = project(from.lng, from.lat, from.zoom);
  const [toX, toY] = project(to.lng, to.lat, to.zoom);
  return {
    scale,
    offset: [
      dpr * ((toX - size.width / 2) * scale - fromX + size.width / 2),
      dpr * ((toY - size.height / 2) * scale - fromY + size.height / 2),
    ],
  };
}

export type MorphSnapshot = {
  startedAt: number;
  camera: Camera;
  width: number;
  height: number;
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  /** An empty overlay the size of the label grid, which keeps labels out of the snapshot. */
  blankOverlay: WebGLTexture;
};

export function createMorphSnapshot(
  gl: GL,
  startedAt: number,
  camera: Camera,
  width: number,
  height: number,
  labelCols: number,
  labelRows: number,
): MorphSnapshot {
  const texture = createTexture(gl, gl.RGBA8, gl.RGBA, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const blankOverlay = createTexture(gl, gl.RGBA8, gl.RGBA, labelCols, labelRows);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  return { startedAt, camera, width, height, texture, framebuffer, blankOverlay };
}

export function releaseMorph(gl: GL, morph: MorphSnapshot): void {
  gl.deleteFramebuffer(morph.framebuffer);
  gl.deleteTexture(morph.texture);
  gl.deleteTexture(morph.blankOverlay);
}

export const morphProgress = (morph: Pick<MorphSnapshot, 'startedAt'>, now: number): number =>
  Math.max(0, (now - morph.startedAt) / MORPH_MS);

/** Draw the rest of the snapshot over the frame. False once it has gone, or no longer fits. */
export function morphPass(
  gl: GL,
  programs: Programs,
  program: twgl.ProgramInfo,
  morph: MorphSnapshot,
  overlay: WebGLTexture,
  view: View,
  grid: Grid,
  labelGrid: Grid,
  now: number,
): boolean {
  const progress = morphProgress(morph, now);
  if (progress >= 1 || morph.width !== view.width || morph.height !== view.height) return false;
  const { scale, offset } = morphMapping(
    morph.camera,
    view.camera,
    { width: view.width / view.dpr, height: view.height / view.dpr },
    view.dpr,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, view.width, view.height);
  gl.useProgram(program.program);
  setChangedUniforms(
    program,
    {
      u_snapshot: morph.texture,
      u_overlay: overlay,
      u_size: [view.width, view.height],
      u_scale: scale,
      u_offset: offset,
      u_cell: [view.cellDev.w, view.cellDev.h],
      u_shift: [grid.shiftX, grid.shiftY],
      u_origin: [grid.originCol, grid.originRow],
      u_labelCell: [view.labelDev.w, view.labelDev.h],
      u_labelShift: [labelGrid.shiftX, labelGrid.shiftY],
      u_progress: progress,
    },
    programs.fullUniforms,
  );
  gl.bindVertexArray(programs.emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
  return true;
}
