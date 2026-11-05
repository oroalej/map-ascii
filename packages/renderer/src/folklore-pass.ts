import * as twgl from 'twgl.js';
import { project } from './camera';
import { metersPerCssPx, type Grid, type View } from './grid';
import { createProgram, createTexture, type GL, type CellTargets } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';
import { folkloreMinimumZoom, type FolklorePacket, type FolkloreSprite } from './life/folklore';
import { FOLKLORE_GLYPHS } from './life/folklore-glyphs';
import { FOLKLORE } from './life/folklore-config';
import { SpriteFrame } from './life/manananggal-frames';
import { folkloreVertex, folkloreFragment } from './shaders/folklore';
import { focusPulse, normalizeFocus } from './focus';

export type FolkloreQuad = {
  sprite: FolkloreSprite;
  x: number;
  y: number;
  w: number;
  h: number;
  /** A ghost's atlas glyph; else its sprite frame, plus 64 times one more than a frame under it. */
  glyph: number;
  /** How far to turn the figure from head-up, radians clockwise. */
  turn: number;
};
/** The figure's quad, CSS px at least and metres beyond that: its frames are this many px across. */
const FIGURE = { px: 48, meters: 5 } as const;
const under = (frame: number, trail: number) =>
  frame + 64 * (SpriteFrame.trail + Math.min(SpriteFrame.trails - 1, trail) + 1);
/** Which frames show this moment of the manananggal: wings beating, folding in, or on a roof. */
export function manananggalFrames(sprite: FolkloreSprite): number {
  const fold = sprite.fold ?? 0,
    wave = sprite.wave ?? 0;
  if (fold >= 1)
    return (
      SpriteFrame.perch + Math.min(SpriteFrame.perches - 1, Math.floor(wave * SpriteFrame.perches))
    );
  const trail = Math.floor(wave * SpriteFrame.trails);
  return fold > 0
    ? under(
        SpriteFrame.fold + Math.min(SpriteFrame.folds - 1, Math.floor(fold * SpriteFrame.folds)),
        trail,
      )
    : under(
        SpriteFrame.flap +
          Math.min(SpriteFrame.flaps - 1, Math.floor(sprite.phase * SpriteFrame.flaps)),
        trail,
      );
}
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
    const w = Math.max(view.dpr * (ghost ? 14 : FIGURE.px), scale * (ghost ? 1.6 : FIGURE.meters));
    const h = ghost ? Math.max(view.dpr * 20, scale * 2.4) : w;
    const glyph = ghost
      ? sprite.pose === 'wisp'
        ? 2 + Math.min(3, Math.floor(sprite.wisp * 4))
        : sprite.phase > 0
          ? 1
          : 0
      : lower
        ? SpriteFrame.lower
        : manananggalFrames(sprite);
    // Its head is at the top of the frame, and a heading of 0 is east.
    const turn = sprite.kind === 'manananggal' ? sprite.heading + Math.PI / 2 : 0;
    return x + w / 2 < 0 || y + h / 2 < 0 || x - w / 2 > view.width || y - h / 2 > view.height
      ? []
      : [{ sprite, x, y, w, h, glyph, turn }];
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
  /** Painted and uploaded the first time the manananggal shows, which most visits it never does. */
  sprites?: WebGLTexture;
  sheet?: { width: number; height: number; data: Uint8Array };
  sheetRequested?: boolean;
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
  if (r.sprites) gl.deleteTexture(r.sprites);
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
  if (!r.sprites && quads.some((q) => q.sprite.kind !== 'ghost')) {
    if (r.sheet) {
      const { width, height, data } = r.sheet;
      r.sprites = createTexture(gl, gl.RGBA8, gl.RGBA, width, height, data);
      r.sheet = undefined;
    } else if (!r.sheetRequested) {
      r.sheetRequested = true;
      // Without the painter the figure just stays unseen; ghosts don't depend on it.
      void import('./life/manananggal-sprite').then(
        ({ bakeSpriteSheet }) => {
          r.sheet = bakeSpriteSheet();
        },
        () => undefined,
      );
    }
  }
  // Until its sheet arrives there is nothing to draw the figure from.
  const shown = r.sprites ? quads : quads.filter((q) => q.sprite.kind === 'ghost');
  if (!shown.length) return;
  if (r.data.length < shown.length * 8)
    r.data = new Float32Array(2 ** Math.ceil(Math.log2(shown.length * 8)));
  const data = r.data;
  for (let i = 0; i < shown.length; i++) {
    const q = shown[i]!,
      offset = i * 8;
    data[offset] = q.x;
    data[offset + 1] = q.y;
    data[offset + 2] = q.w;
    data[offset + 3] = q.h;
    const ghost = q.sprite.kind === 'ghost';
    data[offset + 4] = ghost ? theme.map.atlas.index(FOLKLORE_GLYPHS[q.glyph]!) : q.glyph;
    data[offset + 5] = q.sprite.alpha;
    data[offset + 6] = ghost ? 0 : q.sprite.kind === 'lower-half' ? 2 : 1;
    data[offset + 7] = q.turn;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, view.width, view.height);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(r.program.program);
  twgl.setUniforms(r.program, {
    u_size: [view.width, view.height],
    u_atlas: theme.map.atlasTex,
    u_sprites: r.sprites ?? theme.map.atlasTex,
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
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, shown.length);
  gl.bindVertexArray(null);
  gl.disable(gl.BLEND);
}
