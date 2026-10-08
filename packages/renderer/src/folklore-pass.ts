import * as twgl from 'twgl.js';
import { project } from './camera';
import { metersPerCssPx, type Grid, type View } from './grid';
import { createProgram, type GL, type CellTargets } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';
import { folkloreMinimumZoom, type FolklorePacket, type FolkloreSprite } from './life/folklore';
import { FOLKLORE_GLYPHS } from './life/folklore-glyphs';
import { FOLKLORE } from './life/folklore-config';
import { folkloreVertex, folkloreFragment } from './shaders/folklore';
import { focusPulse, normalizeFocus } from './focus';

export type FolkloreQuad = {
  sprite: FolkloreSprite;
  x: number;
  y: number;
  w: number;
  h: number;
  glyph: number;
};
/** Device-pixel bounds include the same minimum halo used by drawing and hover. */
export function folkloreLayout(packet: FolklorePacket, view: View): FolkloreQuad[] {
  const [cx, cy] = project(view.camera.lng, view.camera.lat, view.camera.zoom),
    scale = view.dpr / metersPerCssPx(view.camera);
  return packet.sprites.flatMap((sprite) => {
    if (sprite.alpha <= 0.001 || view.camera.zoom < folkloreMinimumZoom(sprite)) return [];
    const [px, py] = project(sprite.lng, sprite.lat, view.camera.zoom),
      x = (px - cx) * view.dpr + view.width / 2,
      y = (py - cy) * view.dpr + view.height / 2;
    const ghost = sprite.kind === 'ghost',
      lower = sprite.kind === 'lower-half';
    const w = Math.max(
      view.dpr * (ghost ? 14 : lower ? 9 : 24),
      scale * (ghost ? 1.6 : lower ? 0.7 : 4),
    );
    const h = Math.max(
      view.dpr * (ghost ? 20 : lower ? 14 : 18),
      scale * (ghost ? 2.4 : lower ? 1.4 : 3),
    );
    const heading = ((Math.round(sprite.heading / (Math.PI / 2)) % 4) + 4) % 4;
    const glyph = ghost
      ? sprite.pose === 'wisp'
        ? 2 + Math.min(3, Math.floor(sprite.wisp * 4))
        : sprite.phase > 0
          ? 1
          : 0
      : lower
        ? 15
        : sprite.pose === 'perched'
          ? 14
          : 6 + heading * 2 + (sprite.phase > 0 ? 1 : 0);
    return x + w / 2 < 0 || y + h / 2 < 0 || x - w / 2 > view.width || y - h / 2 > view.height
      ? []
      : [{ sprite, x, y, w, h, glyph }];
  });
}
export function folkloreHit(
  quads: readonly FolkloreQuad[],
  point: readonly [number, number],
  dpr: number,
) {
  const x = point[0] * dpr,
    y = point[1] * dpr;
  for (let i = quads.length - 1; i >= 0; i--) {
    const q = quads[i]!;
    if (Math.abs(x - q.x) <= q.w / 2 && Math.abs(y - q.y) <= q.h / 2) return q.sprite;
  }
}
export const createHauntUniformScratch = () => ({
  u_haunts: new Float32Array(FOLKLORE.hauntCount * 3),
  u_hauntCount: 0,
  u_hauntOrigin: new Float32Array(2),
  u_hauntCell: new Float32Array(2),
});
export function hauntUniforms(
  packet: FolklorePacket,
  view: View,
  grid: Grid,
  active = true,
  scratch = createHauntUniformScratch(),
) {
  const values = scratch.u_haunts,
    mpp = metersPerCssPx(view.camera),
    [cx, cy] = project(view.camera.lng, view.camera.lat, view.camera.zoom);
  values.fill(0);
  const count = active ? Math.min(packet.haunts.length, FOLKLORE.hauntCount) : 0;
  for (let i = 0; i < count; i++) {
    const p = packet.haunts[i]!;
    const [x, y] = project(p.lng, p.lat, view.camera.zoom);
    values[i * 3] = (x - cx) * mpp;
    values[i * 3 + 1] = (y - cy) * mpp;
    values[i * 3 + 2] = p.radius;
  }
  const device = mpp / view.dpr;
  scratch.u_hauntCount = count;
  scratch.u_hauntOrigin[0] = (-grid.shiftX - view.width / 2) * device;
  scratch.u_hauntOrigin[1] = (-grid.shiftY - view.height / 2) * device;
  scratch.u_hauntCell[0] = view.cellDev.w * device;
  scratch.u_hauntCell[1] = view.cellDev.h * device;
  return scratch;
}
export type FolkloreResources = {
  program: twgl.ProgramInfo;
  vao: WebGLVertexArrayObject | null;
  buffer: WebGLBuffer | null;
  data: Float32Array;
};
function createFolklore(gl: GL, programs: Programs): FolkloreResources {
  const pending = programs.glyphWarmup?.pending;
  let program = programs.folkloreProgram;
  if (!program && pending?.key === 16) {
    program = pending.program.finish();
    programs.glyphWarmup!.pending = undefined;
  }
  program ??= createProgram(gl, folkloreVertex, folkloreFragment);
  programs.folkloreProgram = undefined;
  const vao = gl.createVertexArray(),
    buffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  for (let i = 0; i < 2; i++) {
    gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 32, i * 16);
    gl.vertexAttribDivisor(i, 1);
  }
  gl.bindVertexArray(null);
  return { program, vao, buffer, data: new Float32Array(64) };
}
export function deleteFolklore(gl: GL, r: FolkloreResources) {
  gl.deleteProgram(r.program.program);
  gl.deleteVertexArray(r.vao);
  gl.deleteBuffer(r.buffer);
}
export function folklorePass(
  gl: GL,
  programs: Programs,
  targets: CellTargets,
  theme: ThemeResources,
  view: View,
  labelGrid: Grid,
  quads: readonly FolkloreQuad[],
  focus = normalizeFocus(null),
  time = 0,
  reducedMotion = false,
) {
  if (!quads.length) return;
  const r = (programs.folklore ??= createFolklore(gl, programs));
  if (r.data.length < quads.length * 8)
    r.data = new Float32Array(2 ** Math.ceil(Math.log2(quads.length * 8)));
  const data = r.data;
  for (let i = 0; i < quads.length; i++) {
    const q = quads[i]!,
      offset = i * 8;
    data[offset] = q.x;
    data[offset + 1] = q.y;
    data[offset + 2] = q.w;
    data[offset + 3] = q.h;
    data[offset + 4] = theme.map.atlas.index(FOLKLORE_GLYPHS[q.glyph]!);
    data[offset + 5] = q.sprite.alpha;
    data[offset + 6] = q.sprite.kind === 'ghost' ? 0 : 1;
    data[offset + 7] = 0;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, view.width, view.height);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(r.program.program);
  twgl.setUniforms(r.program, {
    u_size: [view.width, view.height],
    u_atlas: theme.map.atlasTex,
    u_columns: theme.map.atlas.columns,
    u_cell: [view.cellDev.w, view.cellDev.h],
    u_overlay: targets.overlayTex,
    u_labelCell: [view.labelDev.w, view.labelDev.h],
    u_labelShift: [labelGrid.shiftX, labelGrid.shiftY],
    u_height: view.height,
    u_accent: theme.uniforms.accent,
    u_focusMode: focus.folklore
      ? 2
      : focus.mask[0] !== 0 || focus.mask[1] !== 0 || focus.life.size > 0
        ? 1
        : 0,
    u_pulse: focusPulse(time, !reducedMotion),
  });
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindVertexArray(r.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, r.buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, quads.length);
  gl.bindVertexArray(null);
  gl.disable(gl.BLEND);
}
