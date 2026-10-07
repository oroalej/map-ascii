/** Small WebGL2 helpers: programs, textures, framebuffers, and per-tile meshes. */
import * as twgl from 'twgl.js';
import { SUB } from './glyphs/select';
import type { GeometryArrays, GroundGeometry, TileGeometry } from './raster/geometry';

export type GL = WebGL2RenderingContext;

export function createProgram(gl: GL, vertex: string, fragment: string): twgl.ProgramInfo {
  return twgl.createProgramInfo(gl, [vertex, fragment], (message: string) => {
    throw new Error(`ASCII Atlas shader error: ${message}`);
  });
}

export type PendingProgram = {
  ready(): boolean;
  finish(): twgl.ProgramInfo;
  cancel(): void;
};

/** Link without querying status until parallel compilation completes (or input needs it). */
export function prepareProgram(gl: GL, vertex: string, fragment: string): PendingProgram {
  const extension = gl.getExtension('KHR_parallel_shader_compile');
  const program = gl.createProgram();
  if (!program) throw new Error('ASCII Atlas: cannot allocate shader program');
  const shaders: WebGLShader[] = [];
  let info: twgl.ProgramInfo | undefined;
  let cancelled = false;
  const deleteShaders = () => {
    for (const shader of shaders) gl.deleteShader(shader);
    shaders.length = 0;
  };
  const cancel = () => {
    if (cancelled || info) return;
    cancelled = true;
    if (!gl.isContextLost()) {
      deleteShaders();
      gl.deleteProgram(program);
    }
  };
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('ASCII Atlas: cannot allocate shader');
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
  } catch (error) {
    cancel();
    throw error;
  }
  return {
    ready: () =>
      !cancelled &&
      !gl.isContextLost() &&
      (!extension || Boolean(gl.getProgramParameter(program, extension.COMPLETION_STATUS_KHR))),
    finish: () => {
      if (cancelled || gl.isContextLost())
        throw new Error('ASCII Atlas: shader compilation cancelled');
      if (info) return info;
      try {
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          const details = [
            gl.getProgramInfoLog(program),
            ...shaders.map((s) => gl.getShaderInfoLog(s)),
          ];
          throw new Error(`ASCII Atlas shader error: ${details.filter(Boolean).join('\n')}`);
        }
        info = twgl.createProgramInfoFromProgram(gl, program);
        deleteShaders();
        return info;
      } catch (error) {
        cancel();
        throw error;
      }
    },
    cancel,
  };
}

/** A nearest-filtered, edge-clamped 2D texture. */
export function createTexture(
  gl: GL,
  internalFormat: number,
  format: number,
  width: number,
  height: number,
  data: ArrayBufferView | null = null,
  type: number = gl.UNSIGNED_BYTE,
): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
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
  glyphTex: WebGLTexture;
  /** RGBA8 overlay on the label grid: 16-bit label glyph code, color index (labels.ts). */
  overlayTex: WebGLTexture;
  /** RGBA8 life layer (passes.ts `lifePass`): glyph index, life class id, agent kind bit. */
  lifeTex: WebGLTexture;
  /** Always a valid integer sampler, even while inactive. */
  crowdMaskTex: WebGLTexture;
  crowdMaskCols: number;
  crowdMaskRows: number;
  crowdMaskActive?: boolean;
  crowdMaskBand?: readonly [number, number];
  /** Lazy RG32F per-item candle clock tokens; never a render attachment. */
  effectClockTex?: WebGLTexture;
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

function createRasterTargets(gl: GL, width: number, height: number, what: string): RasterTargets {
  // RGBA8 rather than R8 (only red is used): the legend reads it back as RGBA, which then needs
  // no format conversion.
  const classTex = createTexture(gl, gl.RGBA8, gl.RGBA, width, height);
  const attrTex = createTexture(gl, gl.RGBA8, gl.RGBA, width, height);
  const idTex = createTexture(gl, gl.RGBA8, gl.RGBA, width, height);
  const depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, classTex, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, attrTex, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, idTex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
  checkComplete(gl, what);
  return { width, height, classTex, attrTex, idTex, depth, fbo };
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
  const cell = createRasterTargets(gl, cols, rows, 'cell');
  const sub = createRasterTargets(gl, cols * SUB.cols, rows * SUB.rows, 'sub-cell');
  const base = createRasterTargets(gl, cols, rows, 'cell base');
  const subBase = createRasterTargets(gl, cols * SUB.cols, rows * SUB.rows, 'sub-cell base');
  const glyphTex = createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows);
  const overlayTex = createTexture(gl, gl.RGBA8, gl.RGBA, labelCols, labelRows);
  const lifeTex = createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows);
  const crowdMaskTex = createTexture(
    gl,
    gl.RGBA32UI,
    gl.RGBA_INTEGER,
    1,
    1,
    new Uint32Array(4),
    gl.UNSIGNED_INT,
  );
  const lightTex = createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows);
  // Filtered, so the pools fade smoothly across cells (the glyph pass reads the rest unfiltered).
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const fixtureTex = createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows);
  const signalLightTex = createTexture(gl, gl.RGBA8, gl.RGBA, cols, rows);

  const glyphFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, glyphFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glyphTex, 0);
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
    glyphTex,
    overlayTex,
    lifeTex,
    crowdMaskTex,
    crowdMaskCols: 1,
    crowdMaskRows: 1,
    crowdMaskActive: false,
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
}

export function deleteCellTargets(gl: GL, t: CellTargets) {
  if (t.effectClockTex) gl.deleteTexture(t.effectClockTex);
  gl.deleteTexture(t.crowdMaskTex);
  for (const tex of [
    t.classTex,
    t.attrTex,
    t.idTex,
    t.glyphTex,
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

/** Eight words per cell encode conservative 16×16 permitted crowd coverage. */
export function uploadCrowdMask(
  gl: GL,
  t: CellTargets,
  values?: Uint32Array,
  band: readonly [number, number] = [0, t.rows],
) {
  t.crowdMaskActive = !!values;
  if (!values) return;
  gl.bindTexture(gl.TEXTURE_2D, t.crowdMaskTex);
  if (t.crowdMaskCols !== t.cols * 2 || t.crowdMaskRows !== t.rows) {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32UI,
      t.cols * 2,
      t.rows,
      0,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_INT,
      values,
    );
    t.crowdMaskCols = t.cols * 2;
    t.crowdMaskRows = t.rows;
  } else {
    // Inactive frames retain GPU coverage. Reactivation clears those old rows too.
    const first = Math.min(band[0], t.crowdMaskBand?.[0] ?? band[0]);
    const end = Math.max(band[1], t.crowdMaskBand?.[1] ?? band[1]);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      first,
      t.crowdMaskCols,
      end - first,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_INT,
      values.subarray(first * t.cols * 8, end * t.cols * 8),
    );
  }
  t.crowdMaskBand = band;
}

/** Replace the streetlights' contents (RGBA8 texels from passes.ts `lightPass`). */
export function uploadLights(gl: GL, t: CellTargets, texels: Uint8Array) {
  gl.bindTexture(gl.TEXTURE_2D, t.lightTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.cols, t.rows, gl.RGBA, gl.UNSIGNED_BYTE, texels);
}

export function uploadEffectClocks(gl: GL, targets: CellTargets, values: Float32Array | undefined) {
  if (!values) {
    if (targets.effectClockTex) gl.deleteTexture(targets.effectClockTex);
    targets.effectClockTex = undefined;
    return;
  }
  if (!targets.effectClockTex) {
    targets.effectClockTex = createTexture(
      gl,
      gl.RG32F,
      gl.RG,
      targets.cols,
      targets.rows,
      values,
      gl.FLOAT,
    );
  } else {
    gl.bindTexture(gl.TEXTURE_2D, targets.effectClockTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, targets.cols, targets.rows, gl.RG, gl.FLOAT, values);
  }
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
