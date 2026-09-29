/** Small WebGL2 helpers: programs, textures, framebuffers, and per-tile meshes. */
import * as twgl from 'twgl.js';
import type { GeometryArrays, GroundGeometry, TileGeometry } from './raster/geometry';

export type GL = WebGL2RenderingContext;

export function createProgram(gl: GL, vertex: string, fragment: string): twgl.ProgramInfo {
  return twgl.createProgramInfo(gl, [vertex, fragment], (message: string) => {
    throw new Error(`ASCII Atlas shader error: ${message}`);
  });
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
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** The cell-resolution render targets. */
export type CellTargets = {
  cols: number;
  rows: number;
  classTex: WebGLTexture;
  attrTex: WebGLTexture;
  idTex: WebGLTexture;
  glyphTex: WebGLTexture;
  /** RGBA8 overlay (art and labels): 16-bit glyph code, color index (labels.ts). */
  overlayTex: WebGLTexture;
  depth: WebGLRenderbuffer;
  cellFbo: WebGLFramebuffer;
  glyphFbo: WebGLFramebuffer;
};

function checkComplete(gl: GL, what: string) {
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`ASCII Atlas: ${what} framebuffer incomplete (0x${status.toString(16)})`);
  }
}

export function createCellTargets(gl: GL, cols: number, rows: number): CellTargets {
  const classTex = createTexture(gl, gl.R8, gl.RED, cols, rows);
  const attrTex = createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows);
  const idTex = createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows);
  const glyphTex = createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows);
  const overlayTex = createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows);
  const depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, cols, rows);

  const cellFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, cellFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, classTex, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, attrTex, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, idTex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
  checkComplete(gl, 'cell');

  const glyphFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, glyphFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glyphTex, 0);
  checkComplete(gl, 'glyph');
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return { cols, rows, classTex, attrTex, idTex, glyphTex, overlayTex, depth, cellFbo, glyphFbo };
}

export function deleteCellTargets(gl: GL, t: CellTargets) {
  for (const tex of [t.classTex, t.attrTex, t.idTex, t.glyphTex, t.overlayTex]) {
    gl.deleteTexture(tex);
  }
  gl.deleteRenderbuffer(t.depth);
  gl.deleteFramebuffer(t.cellFbo);
  gl.deleteFramebuffer(t.glyphFbo);
}

/** Replace the overlay's contents (RGBA8 texels from labels.ts `packOverlay`). */
export function uploadOverlay(gl: GL, t: CellTargets, texels: Uint8Array) {
  gl.bindTexture(gl.TEXTURE_2D, t.overlayTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.cols, t.rows, gl.RGBA, gl.UNSIGNED_BYTE, texels);
}

type Mesh = { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; count: number };

type GroundMesh = { fills: Mesh; lines: Mesh; points: Mesh };

/** A tile's geometry on the GPU; `region` holds its region-only features. */
export type TileMesh = GroundMesh & { extrusions: Mesh; region: GroundMesh };

function uploadMesh(gl: GL, arrays: GeometryArrays, indices?: Uint32Array): Mesh {
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
  if (indices) buffers.push(buffer(gl.ELEMENT_ARRAY_BUFFER, indices));
  gl.bindVertexArray(null);
  return { vao, buffers, count: indices ? indices.length : arrays.ids.length };
}

const uploadGround = (gl: GL, g: GroundGeometry): GroundMesh => ({
  fills: uploadMesh(gl, g.fills, g.fills.indices),
  lines: uploadMesh(gl, g.lines),
  points: uploadMesh(gl, g.points),
});

export function uploadTile(gl: GL, geometry: TileGeometry): TileMesh {
  return {
    ...uploadGround(gl, geometry),
    extrusions: uploadMesh(gl, geometry.extrusions, geometry.extrusions.indices),
    region: uploadGround(gl, geometry.region),
  };
}

export function deleteTile(gl: GL, mesh: TileMesh) {
  const { region } = mesh;
  for (const m of [
    mesh.fills,
    mesh.extrusions,
    mesh.lines,
    mesh.points,
    region.fills,
    region.lines,
    region.points,
  ]) {
    gl.deleteVertexArray(m.vao);
    for (const b of m.buffers) gl.deleteBuffer(b);
  }
}

/** Draw a tile's 3D buildings (tilted cameras only). */
export function drawExtrusions(gl: GL, mesh: TileMesh) {
  if (mesh.extrusions.count === 0) return;
  gl.bindVertexArray(mesh.extrusions.vao);
  gl.drawElements(gl.TRIANGLES, mesh.extrusions.count, gl.UNSIGNED_INT, 0);
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
