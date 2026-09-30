/**
 * The GPU resources the frame needs besides tile meshes: the three programs, the glyph atlases
 * and glyph table (theme resources, which depend on the device pixel ratio and, for the map's,
 * on the cell size, density.ts), and the cell-grid render targets. Each group is created and
 * deleted as a unit, so a lost WebGL context can be rebuilt from scratch (index.ts).
 */
import type * as twgl from 'twgl.js';
import { MAX_CLASSES } from './classes';
import { buildGlyphAtlas, type GlyphAtlas } from './glyphs/atlas';
import { buildGlyphTables, MAX_VARIANTS, type GlyphTables } from './glyphs/select';
import { createProgram, createTexture, type GL } from './gpu';
import { cellFragment, cellVertex } from './shaders/cell';
import { fullscreenVertex } from './shaders/fullscreen';
import { glyphFragment } from './shaders/glyph';
import { selectFragment } from './shaders/select';
import { labelCharacters, mapGlyphs, type Theme } from './theme';

export type Programs = {
  cell: twgl.ProgramInfo;
  select: twgl.ProgramInfo;
  glyph: twgl.ProgramInfo;
  /** For the full-screen passes, which have no vertex attributes. */
  emptyVao: WebGLVertexArrayObject;
};

export function createPrograms(gl: GL): Programs {
  return {
    cell: createProgram(gl, cellVertex, cellFragment),
    select: createProgram(gl, fullscreenVertex, selectFragment),
    glyph: createProgram(gl, fullscreenVertex, glyphFragment),
    emptyVao: gl.createVertexArray(),
  };
}

export function deletePrograms(gl: GL, p: Programs) {
  for (const info of [p.cell, p.select, p.glyph]) gl.deleteProgram(info.program);
  gl.deleteVertexArray(p.emptyVao);
}

/** Cell size in device pixels. */
export type CellSize = { w: number; h: number };

const toDevice = (css: { width: number; height: number }, dpr: number): CellSize => ({
  w: Math.max(1, Math.round(css.width * dpr)),
  h: Math.max(1, Math.round(css.height * dpr)),
});

/** The map's glyphs at one cell size: the atlas and the select pass's glyph table. */
export type MapGlyphs = {
  cellDev: CellSize;
  atlas: GlyphAtlas;
  atlasTex: WebGLTexture;
  tables: GlyphTables;
  tableTex: WebGLTexture;
};

export function createMapGlyphs(
  gl: GL,
  theme: Theme,
  cellCss: { width: number; height: number },
  dpr: number,
  font: string,
): MapGlyphs {
  const cellDev = toDevice(cellCss, dpr);
  const atlas = buildGlyphAtlas(mapGlyphs(theme), cellDev.w, cellDev.h, font);
  const atlasTex = createTexture(gl, gl.R8, gl.RED, atlas.width, atlas.height, atlas.data);
  const tables = buildGlyphTables(theme, atlas.index);
  const tableTex = createTexture(gl, gl.R8, gl.RED, MAX_VARIANTS, MAX_CLASSES, tables.table);
  return { cellDev, atlas, atlasTex, tables, tableTex };
}

export function deleteMapGlyphs(gl: GL, r: MapGlyphs) {
  gl.deleteTexture(r.atlasTex);
  gl.deleteTexture(r.tableTex);
}

/** Label text at the label cell size, which stays readable whatever the map's density. */
export type LabelGlyphs = { cellDev: CellSize; atlas: GlyphAtlas; atlasTex: WebGLTexture };

export function createLabelGlyphs(
  gl: GL,
  cellCss: { width: number; height: number },
  dpr: number,
  font: string,
): LabelGlyphs {
  const cellDev = toDevice(cellCss, dpr);
  const atlas = buildGlyphAtlas(labelCharacters, cellDev.w, cellDev.h, font);
  const atlasTex = createTexture(gl, gl.R8, gl.RED, atlas.width, atlas.height, atlas.data);
  return { cellDev, atlas, atlasTex };
}

export function deleteLabelGlyphs(gl: GL, r: LabelGlyphs) {
  gl.deleteTexture(r.atlasTex);
}

/** The glyphs a frame draws with: the map's at the current cell size, and the labels'. */
export type ThemeResources = { map: MapGlyphs; label: LabelGlyphs };
