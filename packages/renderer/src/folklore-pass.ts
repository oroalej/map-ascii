import * as twgl from 'twgl.js';
import { project } from './camera';
import { metersPerCssPx, type Grid, type View } from './grid';
import { createProgram, type GL, type CellTargets } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';
import { folkloreMinimumZoom, type FolklorePacket, type FolkloreSprite } from './life/folklore';
import { FOLKLORE_GLYPHS } from './life/folklore-glyphs';
import { FOLKLORE } from './life/folklore-config';

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
  return [...quads]
    .reverse()
    .find((q) => Math.abs(x - q.x) <= q.w / 2 && Math.abs(y - q.y) <= q.h / 2)?.sprite;
}
export function hauntUniforms(packet: FolklorePacket, view: View, grid: Grid, active = true) {
  const values = new Float32Array(FOLKLORE.hauntCount * 3),
    mpp = metersPerCssPx(view.camera),
    [cx, cy] = project(view.camera.lng, view.camera.lat, view.camera.zoom);
  const points = active ? packet.haunts.slice(0, FOLKLORE.hauntCount) : [];
  points.forEach((p, i) => {
    const [x, y] = project(p.lng, p.lat, view.camera.zoom);
    values.set([(x - cx) * mpp, (y - cy) * mpp, p.radius], i * 3);
  });
  const device = mpp / view.dpr;
  return {
    u_haunts: values,
    u_hauntCount: points.length,
    u_hauntOrigin: [
      (-grid.shiftX - view.width / 2) * device,
      (-grid.shiftY - view.height / 2) * device,
    ],
    u_hauntCell: [view.cellDev.w * device, view.cellDev.h * device],
  };
}
const vertex = `#version 300 es
precision highp float;
layout(location=0) in vec4 a_quad;
layout(location=1) in vec4 a_style;
uniform vec2 u_size;
out vec2 v_uv;flat out vec4 v_style;
void main(){vec2 p=vec2((gl_VertexID==1||gl_VertexID==2||gl_VertexID==4)?1.0:0.0,(gl_VertexID==2||gl_VertexID==4||gl_VertexID==5)?1.0:0.0);v_uv=p;v_style=a_style;vec2 xy=a_quad.xy+(p-0.5)*a_quad.zw;gl_Position=vec4(xy/u_size*vec2(2.0,-2.0)+vec2(-1.0,1.0),0,1);}`;
const fragment = `#version 300 es
precision highp float;precision highp int;
in vec2 v_uv;flat in vec4 v_style;
uniform sampler2D u_atlas;uniform int u_columns;uniform vec2 u_cell;
uniform sampler2D u_overlay;uniform vec2 u_labelCell;uniform vec2 u_labelShift;uniform float u_height;
out vec4 o_color;
void main(){ivec2 label=ivec2(floor((vec2(gl_FragCoord.x,u_height-gl_FragCoord.y)+u_labelShift)/u_labelCell));vec4 cover=texelFetch(u_overlay,label,0);if(cover.r>0.0||cover.g>0.0||cover.b>0.0)discard;
int code=int(v_style.x);vec2 slot=vec2(code%u_columns,code/u_columns);ivec2 pixel=ivec2(slot*u_cell+min(floor(v_uv*u_cell),u_cell-1.0));float ink=texelFetch(u_atlas,pixel,0).r;
float halo=pow(max(0.0,1.0-length((v_uv-0.5)*2.0)),2.0)*0.22;bool ghost=v_style.z<0.5;vec3 color=ghost?vec3(0.73,0.94,1.0):mix(vec3(0.05,0.02,0.09),vec3(0.75,0.09,0.16),halo*3.0);float alpha=v_style.y*max(ink,halo);if(alpha<0.001)discard;o_color=vec4(color,alpha);}`;
export type FolkloreResources = {
  program: twgl.ProgramInfo;
  vao: WebGLVertexArrayObject | null;
  buffer: WebGLBuffer | null;
};
function createFolklore(gl: GL): FolkloreResources {
  const program = createProgram(gl, vertex, fragment),
    vao = gl.createVertexArray(),
    buffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  for (let i = 0; i < 2; i++) {
    gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 32, i * 16);
    gl.vertexAttribDivisor(i, 1);
  }
  gl.bindVertexArray(null);
  return { program, vao, buffer };
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
) {
  if (!quads.length) return;
  const r = (programs.folklore ??= createFolklore(gl)),
    data = new Float32Array(quads.length * 8);
  quads.forEach((q, i) =>
    data.set(
      [
        q.x,
        q.y,
        q.w,
        q.h,
        theme.map.atlas.index(FOLKLORE_GLYPHS[q.glyph]!),
        q.sprite.alpha,
        q.sprite.kind === 'ghost' ? 0 : 1,
        0,
      ],
      i * 8,
    ),
  );
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
