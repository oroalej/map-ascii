/**
 * The GPU resources the frame needs besides tile meshes: the three programs, the glyph atlases
 * and glyph table (theme resources, which depend on the device pixel ratio and, for the map's,
 * on the cell size, density.ts), and the cell-grid render targets. Each group is created and
 * deleted as a unit, so a lost WebGL context can be rebuilt from scratch (index.ts).
 */
import type * as twgl from 'twgl.js';
import {
  deleteFolklore,
  type FolkloreResources,
  type createHauntUniformScratch,
} from './folklore-pass';
import { MAX_CLASSES } from './classes';
import { buildGlyphAtlas, type GlyphAtlas } from './glyphs/atlas';
import { buildGlyphTables, MAX_GLYPHS, MAX_VARIANTS, type GlyphTables } from './glyphs/select';
import { createProgram, createTexture, prepareProgram, type GL, type PendingProgram } from './gpu';
import { cellFragment, cellVertex } from './shaders/cell';
import { fullscreenVertex } from './shaders/fullscreen';
import { glyphFragmentFor } from './shaders/glyph';
import { selectFragment } from './shaders/select';
import { labelVertex, labelFragment } from './shaders/labels';
import { labelCharacters, mapGlyphs, type Theme } from './theme';
import { buildLifeGlyphs, type LifeGlyphs } from './life/draw';
import { waterGlyphs } from './life/water';
import type { ThemeUniforms } from './theme-uniforms';
import { deleteFireworks, type FireworksResources } from './fireworks-pass';
import { fireworksFragment, fireworksVertex } from './shaders/fireworks';
import { folkloreFragment, folkloreVertex } from './shaders/folklore';

/** The rotated street names' quads (labels.ts `rotatedLabelVertices`), rebuilt with placement. */
export type StreetTextMesh = {
  vao: WebGLVertexArrayObject | null;
  buffer: WebGLBuffer | null;
  /** Vertices uploaded. */
  count: number;
};

type BaseName = 'labels' | 'cell' | 'select' | 'glyph';
type BaseLinks = {
  pending: Map<BaseName, PendingProgram>;
  finished: Map<BaseName, twgl.ProgramInfo>;
};

export type Programs = {
  /** Separate ownership lets teardown cancel links without resolving lazy getters. */
  baseLinks?: BaseLinks;
  folklore?: FolkloreResources;
  folkloreProgram?: twgl.ProgramInfo;
  folkloreUniforms?: ReturnType<typeof createHauntUniformScratch>;
  /** Lazy seasonal effect; recreated normally after context loss. */
  fireworks?: FireworksResources;
  /** An idle-linked program is consumed once when the effect creates its buffers. */
  fireworksProgram?: twgl.ProgramInfo;
  labels: twgl.ProgramInfo;
  streetText: StreetTextMesh;
  cell: twgl.ProgramInfo;
  select: twgl.ProgramInfo;
  glyph: twgl.ProgramInfo;
  /** At most eight variants; seasonal features compile only when their fixtures are needed. */
  glyphVariants?: Map<number, twgl.ProgramInfo>;
  glyphWarmup?: {
    clocks: boolean;
    seasonal: boolean;
    fireworks: boolean;
    folklore: boolean;
    pending?: { key: number; program: PendingProgram };
    cancel(): void;
  };
  glyphWarmupFailed?: boolean;
  /** For the full-screen passes, which have no vertex attributes. */
  emptyVao: WebGLVertexArrayObject;
};

export function createPrograms(gl: GL): Programs {
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // Position, UV, glyph index (shaders/labels.ts), 5 floats a vertex.
  for (const [slot, size, offset] of [
    [0, 2, 0],
    [1, 2, 8],
    [2, 1, 16],
  ]) {
    gl.enableVertexAttribArray(slot!);
    gl.vertexAttribPointer(slot!, size!, gl.FLOAT, false, 20, offset!);
  }
  gl.bindVertexArray(null);
  const links: BaseLinks = { pending: new Map(), finished: new Map() };
  const sources = {
    glyph: [
      fullscreenVertex,
      glyphFragmentFor({ focus: false, effectClocks: false, seasonal: false }),
    ],
    labels: [labelVertex, labelFragment],
    cell: [cellVertex, cellFragment],
    select: [fullscreenVertex, selectFragment],
  } as const;
  const parallel = !!gl.getExtension('KHR_parallel_shader_compile');
  const variants = new Map<number, twgl.ProgramInfo>();
  let emptyVao: WebGLVertexArrayObject | null = null;
  const finish = (name: BaseName) => {
    let info = links.finished.get(name);
    if (!info) {
      const pending = links.pending.get(name);
      if (!pending) throw new Error('ASCII Atlas: program set disposed');
      info = pending.finish();
      links.pending.delete(name);
      links.finished.set(name, info);
      if (name === 'glyph') variants.set(0, info);
    }
    return info;
  };
  try {
    for (const name of Object.keys(sources) as BaseName[]) {
      const [vertex, fragment] = sources[name];
      if (parallel) links.pending.set(name, prepareProgram(gl, vertex, fragment));
      else links.finished.set(name, createProgram(gl, vertex, fragment));
    }
    if (!parallel) variants.set(0, links.finished.get('glyph')!);
    emptyVao = gl.createVertexArray();
    if (!emptyVao) throw new Error('ASCII Atlas: cannot allocate vertex array');
    return {
      baseLinks: links,
      get labels() {
        return finish('labels');
      },
      get cell() {
        return finish('cell');
      },
      get select() {
        return finish('select');
      },
      get glyph() {
        return finish('glyph');
      },
      streetText: { vao, buffer, count: 0 },
      glyphVariants: variants,
      emptyVao,
    };
  } catch (error) {
    for (const pending of links.pending.values()) pending.cancel();
    if (!gl.isContextLost()) {
      for (const info of links.finished.values()) gl.deleteProgram(info.program);
      gl.deleteVertexArray(vao);
      gl.deleteBuffer(buffer);
      if (emptyVao) gl.deleteVertexArray(emptyVao);
    }
    throw error;
  }
}

export function glyphProgram(
  gl: GL,
  programs: Programs,
  focus: boolean,
  effectClocks: boolean,
  seasonal = false,
) {
  // Manually supplied program sets may already contain the full-feature shader.
  const variants = programs.glyphVariants;
  if (!variants) return programs.glyph;
  const key = Number(focus) | (Number(effectClocks) << 1) | (Number(seasonal) << 2);
  if (key === 0) return programs.glyph;
  let program = variants.get(key);
  if (!program) {
    const pending = programs.glyphWarmup?.pending;
    if (pending?.key === key) {
      program = pending.program.finish();
      programs.glyphWarmup!.pending = undefined;
    } else
      program = createProgram(
        gl,
        fullscreenVertex,
        glyphFragmentFor({ focus, effectClocks, seasonal }),
      );
    variants.set(key, program);
  }
  return program;
}

/** One owned idle task and at most one pending link; startup retains the minimal shader. */
export function prewarmGlyphPrograms(
  gl: GL,
  programs: Programs,
  canWarm: () => boolean,
  effectClocks = true,
  seasonal = false,
  fireworks = false,
  folklore = false,
) {
  const variants = programs.glyphVariants;
  if (!variants || programs.glyphWarmupFailed) return;
  const keys = (clocks: boolean, seasonal: boolean, fireworks: boolean, folklore: boolean) => [
    ...(folklore ? [16] : []),
    ...(fireworks ? [8] : []),
    ...(seasonal ? (clocks ? [4, 5, 6, 7] : [4, 5]) : []),
    ...(clocks ? [1, 2, 3] : [1]),
  ];
  const has = (key: number) =>
    key === 16
      ? !!(programs.folklore || programs.folkloreProgram)
      : key === 8
        ? !!(programs.fireworks || programs.fireworksProgram)
        : variants.has(key);
  if (programs.glyphWarmup) {
    const warmup = programs.glyphWarmup;
    warmup.clocks ||= effectClocks;
    warmup.seasonal = seasonal;
    warmup.fireworks = fireworks;
    warmup.folklore = folklore;
    if (
      warmup.pending &&
      !keys(warmup.clocks, seasonal, fireworks, folklore).includes(warmup.pending.key)
    ) {
      warmup.pending.program.cancel();
      warmup.pending = undefined;
    }
    return;
  }
  if (keys(effectClocks, seasonal, fireworks, folklore).every(has)) return;
  let cancelled = false;
  let cancelTask: (() => void) | undefined;
  const warmup: NonNullable<Programs['glyphWarmup']> = {
    clocks: effectClocks,
    seasonal,
    fireworks,
    folklore,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      cancelTask?.();
      warmup.pending?.program.cancel();
      warmup.pending = undefined;
      programs.glyphWarmup = undefined;
    },
  };
  const queue = () => {
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(step);
      cancelTask = () => cancelIdleCallback(id);
    } else {
      const id = setTimeout(step, 100);
      cancelTask = () => clearTimeout(id);
    }
  };
  const step = () => {
    cancelTask = undefined;
    if (cancelled) return;
    if (gl.isContextLost()) {
      warmup.cancel();
      return;
    }
    if (!canWarm()) {
      queue();
      return;
    }
    try {
      const pending = warmup.pending;
      if (pending) {
        if (pending.program.ready()) {
          const program = pending.program.finish();
          if (pending.key === 16) programs.folkloreProgram = program;
          else if (pending.key === 8) programs.fireworksProgram = program;
          else variants.set(pending.key, program);
          warmup.pending = undefined;
        }
      } else {
        const key = keys(warmup.clocks, warmup.seasonal, warmup.fireworks, warmup.folklore).find(
          (key) => !has(key),
        );
        if (key === undefined) {
          programs.glyphWarmup = undefined;
          return;
        }
        const focus = (key & 1) !== 0,
          effectClocks = (key & 2) !== 0;
        const seasonal = (key & 4) !== 0;
        if (gl.getExtension('KHR_parallel_shader_compile'))
          warmup.pending = {
            key,
            program: prepareProgram(
              gl,
              key === 16 ? folkloreVertex : key === 8 ? fireworksVertex : fullscreenVertex,
              key === 16
                ? folkloreFragment
                : key === 8
                  ? fireworksFragment
                  : glyphFragmentFor({ focus, effectClocks, seasonal }),
            ),
          };
        else if (key === 16)
          programs.folkloreProgram = createProgram(gl, folkloreVertex, folkloreFragment);
        else if (key === 8)
          programs.fireworksProgram = createProgram(gl, fireworksVertex, fireworksFragment);
        else glyphProgram(gl, programs, focus, effectClocks, seasonal);
      }
      queue();
    } catch {
      // A failed optional warmup leaves the existing demand path and its error reporting intact.
      warmup.cancel();
      programs.glyphWarmupFailed = true;
    }
  };
  programs.glyphWarmup = warmup;
  queue();
}

export function deletePrograms(gl: GL, p: Programs) {
  p.glyphWarmup?.cancel();
  for (const pending of p.baseLinks?.pending.values() ?? []) pending.cancel();
  p.baseLinks?.pending.clear();
  if (!gl.isContextLost()) {
    if (p.folklore) deleteFolklore(gl, p.folklore);
    if (p.fireworks) deleteFireworks(gl, p.fireworks);
    const owned = new Set([
      ...(p.baseLinks ? p.baseLinks.finished.values() : [p.labels, p.cell, p.select, p.glyph]),
      ...(p.glyphVariants?.values() ?? []),
      ...(p.fireworksProgram ? [p.fireworksProgram] : []),
      ...(p.folkloreProgram ? [p.folkloreProgram] : []),
    ]);
    for (const info of owned) gl.deleteProgram(info.program);
    gl.deleteVertexArray(p.streetText.vao);
    gl.deleteBuffer(p.streetText.buffer);
    gl.deleteVertexArray(p.emptyVao);
  }
  p.baseLinks?.finished.clear();
  p.glyphVariants?.clear();
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
  lifeGlyphs: LifeGlyphs;
  /** The water effects' glyph indices (life/water.ts `waterGlyphs`). */
  waterGlyphs: number[];
};

export function createMapGlyphs(
  gl: GL,
  theme: Theme,
  cellCss: { width: number; height: number },
  dpr: number,
  font: string,
): MapGlyphs {
  const cellDev = toDevice(cellCss, dpr);
  const atlas = buildGlyphAtlas(mapGlyphs(theme), cellDev.w, cellDev.h, font, MAX_GLYPHS + 1);
  const atlasTex = createTexture(gl, gl.R8, gl.RED, atlas.width, atlas.height, atlas.data);
  const tables = buildGlyphTables(theme, atlas.index);
  const tableTex = createTexture(gl, gl.RG8, gl.RG, MAX_VARIANTS, MAX_CLASSES, tables.table);
  return {
    cellDev,
    atlas,
    atlasTex,
    tables,
    tableTex,
    lifeGlyphs: buildLifeGlyphs(atlas.index),
    waterGlyphs: waterGlyphs.map((g) => atlas.index(g)),
  };
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
  // The street text pass samples it between texels as it rotates (the others fetch texels).
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return { cellDev, atlas, atlasTex };
}

export function deleteLabelGlyphs(gl: GL, r: LabelGlyphs) {
  gl.deleteTexture(r.atlasTex);
}

/** The glyphs a frame draws with: the map's at the current cell size, and the labels'. */
export type ThemeResources = { map: MapGlyphs; label: LabelGlyphs; uniforms: ThemeUniforms };
