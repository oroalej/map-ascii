/** Small WebGL2 helpers: programs, textures, framebuffers, and per-tile meshes. */
import * as twgl from 'twgl.js';
import { SUB } from './glyphs/select';
import type { GeometryArrays, GroundGeometry, TileGeometry } from './raster/geometry';

export type GL = WebGL2RenderingContext;

/** A failed context request can be transient; it does not establish browser API support. */
export function createContext(canvas: HTMLCanvasElement): GL {
  let detail = '';
  const onError = (event: Event) => {
    detail = (event as WebGLContextEvent).statusMessage;
  };
  canvas.addEventListener('webglcontextcreationerror', onError);
  try {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false });
    if (!gl)
      throw new Error(
        `ASCII Atlas: WebGL2 context could not be initialized.${detail ? ` ${detail}` : ''}`,
      );
    return gl;
  } finally {
    canvas.removeEventListener('webglcontextcreationerror', onError);
  }
}

export function createProgram(
  gl: GL,
  vertex: string,
  fragment: string,
  name = 'unnamed',
): twgl.ProgramInfo {
  const messages: string[] = [];
  // TWGL reports link errors before shader logs and then releases failed resources. Throwing
  // in its callback interrupts both diagnostics and cleanup.
  const info = twgl.createProgramInfo(gl, [vertex, fragment], (message: string) => {
    messages.push(message);
  });
  if (!info || gl.isContextLost()) {
    if (info) gl.deleteProgram(info.program);
    const reason = gl.isContextLost()
      ? 'Graphics context lost during initialization.'
      : 'Program creation failed.';
    throw new Error(`ASCII Atlas ${name} shader error: ${reason}\n${messages.join('\n')}`);
  }
  return info;
}

/** A nearest-filtered, edge-clamped 2D texture. */
export function createTexture(
  gl: GL,
  internalFormat: number,
  format: number,
  width: number,
  height: number,
  data: ArrayBufferView | null = null,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('ASCII Atlas: graphics texture unavailable.');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** The cell-resolution render targets: the map's grid, and the labels' coarser one. */
export type CellTargets = {
  cols: number;
  rows: number;
  /** The label grid (density.ts: labels keep their own cell size). */
  labelCols: number;
  labelRows: number;
  classTex: WebGLTexture;
  attrTex: WebGLTexture;
  idTex: WebGLTexture;
  /** Core selection before the foliage pass (never sampled while attached for drawing). */
  selectTex: WebGLTexture;
  selectFbo: WebGLFramebuffer;
  glyphTex: WebGLTexture;
  /** R8 crown lighting computed once per cell; zero marks an uncached edge/non-crown. */
  foliageLightTex: WebGLTexture;
  /** RGBA8 overlay on the label grid: 16-bit label glyph code, color index (labels.ts). */
  overlayTex: WebGLTexture;
  /** RGBA8 life layer (passes.ts `lifePass`): glyph index, life class id, agent kind bit. */
  lifeTex: WebGLTexture;
  /** RGBA8 streetlights (passes.ts `lightPass`): pool of light, lamp state and seed, lamp head. */
  lightTex: WebGLTexture;
  /** Static fixtures: ten-bit glyph, part, lamp/phase state, opacity. */
  fixtureTex: WebGLTexture;
  /** Signal light source offsets, approach direction, and occupancy. */
  signalLightTex: WebGLTexture;
  depth: WebGLRenderbuffer;
  cellFbo: WebGLFramebuffer;
  glyphFbo: WebGLFramebuffer;
  /**
   * The cell pass again at `SUB.cols × SUB.rows` samples per cell, for sub-cell
   * edges: class, attributes, and feature id, like the cell-resolution targets.
   */
  sub: RasterTargets;
  /**
   * The cell pass without tree crowns, at cell and sub-cell resolution: the crown pass copies
   * them into the live targets and draws the crowns over them, every frame they sway.
   */
  base: RasterTargets;
  subBase: RasterTargets;
};

/** Class, attribute, and id textures with a depth buffer, drawn to together by the cell pass. */
export type RasterTargets = {
  width: number;
  height: number;
  classTex: WebGLTexture;
  attrTex: WebGLTexture;
  idTex: WebGLTexture;
  depth: WebGLRenderbuffer;
  fbo: WebGLFramebuffer;
};

function checkComplete(gl: GL, what: string) {
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`ASCII Atlas: ${what} framebuffer incomplete (0x${status.toString(16)})`);
  }
}

/** Roll back only allocations made by this constructor if a later allocation fails. */
function withRollback<T>(build: (own: <R>(value: R, dispose: (value: R) => void) => R) => T): T {
  const release: (() => void)[] = [];
  try {
    return build((value, dispose) => {
      if (value == null) throw new Error('ASCII Atlas: graphics resources unavailable.');
      release.push(() => dispose(value));
      return value;
    });
  } catch (error) {
    for (const dispose of release.reverse()) dispose();
    throw error;
  }
}

function createRasterTargets(gl: GL, width: number, height: number, what: string): RasterTargets {
  return withRollback((own) => {
    // RGBA8 rather than R8 (only red is used): the legend reads it back as RGBA, which then needs
    // no format conversion.
    const classTex = own(createTexture(gl, gl.RGBA8, gl.RGBA, width, height), (value) =>
      gl.deleteTexture(value),
    );
    const attrTex = own(createTexture(gl, gl.RGBA8, gl.RGBA, width, height), (value) =>
      gl.deleteTexture(value),
    );
    const idTex = own(createTexture(gl, gl.RGBA8, gl.RGBA, width, height), (value) =>
      gl.deleteTexture(value),
    );
    const depth = own(gl.createRenderbuffer(), (value) => gl.deleteRenderbuffer(value));
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);

    const fbo = own(gl.createFramebuffer(), (value) => gl.deleteFramebuffer(value));
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, classTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, attrTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, idTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    checkComplete(gl, what);
    return { width, height, classTex, attrTex, idTex, depth, fbo };
  });
}

/**
 * Copy one set of raster targets (class, attribute, and id textures and depth) into another of
 * the same size.
 */
export function copyRaster(
  gl: GL,
  from: WebGLFramebuffer,
  to: WebGLFramebuffer,
  width: number,
  height: number,
) {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
  const all = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2];
  // A blit copies the read buffer to every draw buffer, so one attachment at a time.
  all.forEach((attachment, i) => {
    gl.readBuffer(attachment);
    gl.drawBuffers(all.map((a, j) => (j === i ? a : gl.NONE)));
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  });
  gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
  gl.drawBuffers(all);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}

function deleteRasterTargets(gl: GL, t: RasterTargets) {
  for (const tex of [t.classTex, t.attrTex, t.idTex]) gl.deleteTexture(tex);
  gl.deleteRenderbuffer(t.depth);
  gl.deleteFramebuffer(t.fbo);
}

export function createCellTargets(
  gl: GL,
  cols: number,
  rows: number,
  labelCols: number,
  labelRows: number,
): CellTargets {
  return withRollback((own) => {
    const cell = own(createRasterTargets(gl, cols, rows, 'cell'), (value) =>
      deleteRasterTargets(gl, value),
    );
    const sub = own(
      createRasterTargets(gl, cols * SUB.cols, rows * SUB.rows, 'sub-cell'),
      (value) => deleteRasterTargets(gl, value),
    );
    const base = own(createRasterTargets(gl, cols, rows, 'cell base'), (value) =>
      deleteRasterTargets(gl, value),
    );
    const subBase = own(
      createRasterTargets(gl, cols * SUB.cols, rows * SUB.rows, 'sub-cell base'),
      (value) => deleteRasterTargets(gl, value),
    );
    const selectTex = own(createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows), (value) =>
      gl.deleteTexture(value),
    );
    const selectFbo = own(gl.createFramebuffer(), (value) => gl.deleteFramebuffer(value));
    gl.bindFramebuffer(gl.FRAMEBUFFER, selectFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, selectTex, 0);
    checkComplete(gl, 'selection');
    const glyphTex = own(createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows), (value) =>
      gl.deleteTexture(value),
    );
    const foliageLightTex = own(createTexture(gl, gl.R8, gl.RED, cols, rows), (value) =>
      gl.deleteTexture(value),
    );
    const overlayTex = own(createTexture(gl, gl.RGBA8, gl.RGBA, labelCols, labelRows), (value) =>
      gl.deleteTexture(value),
    );
    const lifeTex = own(createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows), (value) =>
      gl.deleteTexture(value),
    );
    const lightTex = own(createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows), (value) =>
      gl.deleteTexture(value),
    );
    // Filtered, so the pools fade smoothly across cells (the glyph pass reads the rest unfiltered).
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const fixtureTex = own(createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows), (value) =>
      gl.deleteTexture(value),
    );
    const signalLightTex = own(createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows), (value) =>
      gl.deleteTexture(value),
    );

    const glyphFbo = own(gl.createFramebuffer(), (value) => gl.deleteFramebuffer(value));
    gl.bindFramebuffer(gl.FRAMEBUFFER, glyphFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glyphTex, 0);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT1,
      gl.TEXTURE_2D,
      foliageLightTex,
      0,
    );
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    checkComplete(gl, 'glyph');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return {
      cols,
      rows,
      labelCols,
      labelRows,
      classTex: cell.classTex,
      attrTex: cell.attrTex,
      idTex: cell.idTex,
      selectTex,
      selectFbo,
      glyphTex,
      foliageLightTex,
      overlayTex,
      lifeTex,
      lightTex,
      fixtureTex,
      signalLightTex,
      depth: cell.depth,
      cellFbo: cell.fbo,
      glyphFbo,
      sub,
      base,
      subBase,
    };
  });
}

export function deleteCellTargets(gl: GL, t: CellTargets) {
  for (const tex of [
    t.classTex,
    t.attrTex,
    t.idTex,
    t.selectTex,
    t.glyphTex,
    t.foliageLightTex,
    t.overlayTex,
    t.lifeTex,
    t.lightTex,
    t.fixtureTex,
    t.signalLightTex,
  ]) {
    gl.deleteTexture(tex);
  }
  gl.deleteRenderbuffer(t.depth);
  gl.deleteFramebuffer(t.cellFbo);
  gl.deleteFramebuffer(t.selectFbo);
  gl.deleteFramebuffer(t.glyphFbo);
  deleteRasterTargets(gl, t.sub);
  deleteRasterTargets(gl, t.base);
  deleteRasterTargets(gl, t.subBase);
}

/** Replace the overlay's contents (RGBA8 texels from labels.ts `packOverlay`). */
export function uploadOverlay(gl: GL, t: CellTargets, texels: Uint8Array) {
  gl.bindTexture(gl.TEXTURE_2D, t.overlayTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    t.labelCols,
    t.labelRows,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    texels,
  );
}

/** Replace the life layer's contents (RGBA8 texels from passes.ts `lifePass`). */
export function uploadLife(gl: GL, t: CellTargets, texels: Uint8Array) {
  gl.bindTexture(gl.TEXTURE_2D, t.lifeTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.cols, t.rows, gl.RGBA, gl.UNSIGNED_BYTE, texels);
}

/** Replace the streetlights' contents (RGBA8 texels from passes.ts `lightPass`). */
export function uploadLights(gl: GL, t: CellTargets, texels: Uint8Array) {
  gl.bindTexture(gl.TEXTURE_2D, t.lightTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.cols, t.rows, gl.RGBA, gl.UNSIGNED_BYTE, texels);
}

/** Replace the independent street-hardware texture. */
export function uploadFixtures(gl: GL, t: CellTargets, texels: Uint8Array) {
  gl.bindTexture(gl.TEXTURE_2D, t.fixtureTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.cols, t.rows, gl.RGBA, gl.UNSIGNED_BYTE, texels);
}

/** Replace the cached signal-light source lookup. */
export function uploadSignalLights(gl: GL, t: CellTargets, texels: Uint8Array) {
  gl.bindTexture(gl.TEXTURE_2D, t.signalLightTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.cols, t.rows, gl.RGBA, gl.UNSIGNED_BYTE, texels);
}

type Mesh = {
  vao: WebGLVertexArrayObject | null;
  buffers: WebGLBuffer[];
  count: number;
  surfaceScale?: number;
};

type GroundMesh = { fills: Mesh; lines: Mesh; points: Mesh };

/** A tile's geometry on the GPU; `region` holds its region-only features. */
export type TileMesh = GroundMesh & {
  crowns: Mesh;
  region: GroundMesh;
};

function uploadMesh(gl: GL, arrays: GeometryArrays, indices?: Uint32Array): Mesh {
  const count = indices ? indices.length : arrays.ids.length;
  if (count === 0) return { vao: null, buffers: [], count };
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffer = (target: number, data: ArrayBufferView) => {
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return b;
  };
  const buffers = [
    buffer(gl.ARRAY_BUFFER, arrays.positions),
    buffer(gl.ARRAY_BUFFER, arrays.meta),
    buffer(gl.ARRAY_BUFFER, arrays.ids),
    buffer(gl.ARRAY_BUFFER, arrays.ridge),
  ];
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers[0]!);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.SHORT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers[1]!);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers[2]!);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers[3]!);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.SHORT, false, 0, 0);
  if (arrays.surface) {
    buffers.push(buffer(gl.ARRAY_BUFFER, arrays.surface));
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(
      4,
      arrays.surfaceSize ?? 2,
      arrays.surface instanceof Int16Array ? gl.SHORT : gl.FLOAT,
      false,
      0,
      0,
    );
  }
  if (indices) buffers.push(buffer(gl.ELEMENT_ARRAY_BUFFER, indices));
  gl.bindVertexArray(null);
  return {
    vao,
    buffers,
    count,
    ...(arrays.surfaceScale !== undefined ? { surfaceScale: arrays.surfaceScale } : {}),
  };
}

const uploadGround = (gl: GL, g: GroundGeometry): GroundMesh => ({
  fills: uploadMesh(gl, g.fills, g.fills.indices),
  lines: uploadMesh(gl, g.lines),
  points: uploadMesh(gl, g.points),
});

export function uploadTile(gl: GL, geometry: TileGeometry): TileMesh {
  return {
    ...uploadGround(gl, geometry),
    crowns: uploadMesh(gl, geometry.crowns, geometry.crowns.indices),
    region: uploadGround(gl, geometry.region),
  };
}

export function deleteTile(gl: GL, mesh: TileMesh) {
  const { region } = mesh;
  for (const m of [
    mesh.fills,
    mesh.crowns,
    mesh.lines,
    mesh.points,
    region.fills,
    region.lines,
    region.points,
  ]) {
    if (m.vao) gl.deleteVertexArray(m.vao);
    for (const b of m.buffers) gl.deleteBuffer(b);
  }
}

/** Draw a tile's tree crowns. */
export function drawCrowns(gl: GL, mesh: TileMesh) {
  const { crowns } = mesh;
  if (crowns.count === 0) return;
  gl.bindVertexArray(crowns.vao);
  gl.drawElements(gl.TRIANGLES, crowns.count, gl.UNSIGNED_INT, 0);
}

/**
 * Draw ground features (areas, lines, and points): a tile's own, or its region-only ones
 * (`mesh.region`).
 */
export function drawGround(gl: GL, mesh: GroundMesh) {
  if (mesh.fills.count > 0) {
    gl.bindVertexArray(mesh.fills.vao);
    gl.drawElements(gl.TRIANGLES, mesh.fills.count, gl.UNSIGNED_INT, 0);
  }
  if (mesh.lines.count > 0) {
    gl.bindVertexArray(mesh.lines.vao);
    gl.drawArrays(gl.LINES, 0, mesh.lines.count);
  }
  if (mesh.points.count > 0) {
    gl.bindVertexArray(mesh.points.vao);
    gl.drawArrays(gl.POINTS, 0, mesh.points.count);
  }
}
