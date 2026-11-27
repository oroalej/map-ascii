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
import { deleteOptionalPrograms, optionalProgram, type OptionalLinks } from './optional-programs';
import { bootGlyphFragment, bootSelectFragment } from './shaders/boot';
import { cellFragment, cellVertex } from './shaders/cell';
import { fullscreenVertex } from './shaders/fullscreen';
import { glyphFragmentFor } from './shaders/glyph';
import { selectFragment, selectLiteFragment } from './shaders/select';
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

/** How one program's compile went on this device (`AtlasStats.shaders`). */
export type ShaderTiming = {
  name: string;
  /** Vertex and fragment source length. */
  chars: number;
  /** Since the program set was created, ms. */
  submittedMs: number;
  /** From submission until the link was first seen complete, ms; null until then. */
  readyMs: number | null;
  /** Main-thread time spent finishing the link, ms; null until it finished. */
  blockedMs: number | null;
};

/**
 * Where a frame stands while the full select and glyph programs compile: `wait`, nothing can draw
 * yet; `grace`, tiles load but the screen holds, since a warm cache finishes about now; `boot`,
 * draw from the boot shaders; `full`, they just swapped for the full programs.
 */
export type BootStage = 'wait' | 'grace' | 'boot' | 'full';
/** Long enough for a warm shader cache to skip the boot shaders; unnoticeable on a cold one. */
export const BOOT_GRACE_MS = 500;
export type Boot = {
  /** Once per frame, before drawing. Never waits on a link. */
  poll(now: number): BootStage;
  /** After `poll` said `full`: drop the boot programs. Until now they are still the ones drawn. */
  commit(): void;
  /** A boot frame with tiles was drawn. Without parallel compile, the next poll links the rest. */
  drewTiles(): void;
};

type BaseName = 'labels' | 'cell' | 'select' | 'selectLite' | 'glyph' | 'bootSelect' | 'bootGlyph';
type BaseLinks = {
  pending: Map<BaseName, PendingProgram>;
  finished: Map<BaseName, twgl.ProgramInfo>;
};

export type Programs = {
  /** Present until the full programs are in use; the `select` and `glyph` getters draw boot. */
  boot?: Boot;
  /**
   * The lite select program is drawing (shaders/select.ts `selectLiteFragment`): no shadows,
   * party walls or water depth yet.
   */
  lite?: boolean;
  /** While `lite`: once per frame. True when the full select program has just taken over. */
  upgrade?(): boolean;
  /** Small programs for optional passes (optional-programs.ts). */
  optional?: OptionalLinks;
  /** Base program compile times, for the device report (ARCHITECTURE.md §8 "Device baseline"). */
  timings?: ShaderTiming[];
  /** `performance.now()` when the set was created: the origin of `timings`. */
  timingsStart?: number;
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
  /** Keyed by effect clocks (2), seasonal (4) and field (32); each compiles only when needed. */
  glyphVariants?: Map<number, twgl.ProgramInfo>;
  glyphWarmup?: {
    clocks: boolean;
    seasonal: boolean;
    fireworks: boolean;
    folklore: boolean;
    field: boolean;
    pending?: { key: number; program: PendingProgram; timing?: ShaderTiming };
    /** The rendered frame whose turn started the last parallel link. */
    started?: number;
    cancel(): void;
  };
  glyphWarmupFailed?: boolean;
  /**
   * A variant a frame asked for before it was linked. With parallel compile the frame never waits:
   * it draws with the nearest linked variant until this one is ready.
   */
  glyphDemand?: { key: number; program: PendingProgram; timing?: ShaderTiming };
  /** Main-thread ms spent compiling or finishing a glyph variant on first demand, until read. */
  demandWaitMs?: number;
  /** For the full-screen passes, which have no vertex attributes. */
  emptyVao: WebGLVertexArrayObject;
  /** Upload every select and glyph uniform each draw (`AtlasOptions.fullUniforms`). */
  fullUniforms?: boolean;
};

export function createPrograms(gl: GL, fullUniforms = false, holdBoot = false): Programs {
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
  const created = performance.now();
  const timings: ShaderTiming[] = [];
  // The small programs go first: drivers can work through links one at a time.
  const sources = {
    bootSelect: [fullscreenVertex, bootSelectFragment],
    bootGlyph: [fullscreenVertex, bootGlyphFragment],
    labels: [labelVertex, labelFragment],
    cell: [cellVertex, cellFragment],
    select: [fullscreenVertex, selectFragment],
    selectLite: [fullscreenVertex, selectLiteFragment],
    glyph: [
      fullscreenVertex,
      // Focus is always compiled in: a uniform switches it, and a copy of this shader with it
      // costs another whole link (about as long as this one) for the first hover or selection.
      glyphFragmentFor({ focus: true, effectClocks: false, seasonal: false, field: false }),
    ],
  } as const;
  const parallel = !!gl.getExtension('KHR_parallel_shader_compile');
  const variants = new Map<number, twgl.ProgramInfo>();
  let emptyVao: WebGLVertexArrayObject | null = null;
  const timingOf = (name: BaseName) => timings.find((t) => t.name === name);
  const finish = (name: BaseName) => {
    let info = links.finished.get(name);
    if (!info) {
      const pending = links.pending.get(name);
      if (!pending) throw new Error('ASCII Atlas: program set disposed');
      const start = performance.now();
      info = pending.finish();
      const end = performance.now();
      const timing = timingOf(name);
      if (timing) {
        timing.blockedMs = end - start;
        timing.readyMs ??= end - created - timing.submittedMs;
      }
      links.pending.delete(name);
      links.finished.set(name, info);
      if (name === 'glyph') variants.set(0, info);
    }
    return info;
  };
  const submit = (name: BaseName) => {
    const [vertex, fragment] = sources[name];
    const submitted = performance.now();
    const timing: ShaderTiming = {
      name,
      chars: vertex.length + fragment.length,
      submittedMs: submitted - created,
      readyMs: null,
      blockedMs: null,
    };
    timings.push(timing);
    if (parallel) links.pending.set(name, prepareProgram(gl, vertex, fragment));
    else {
      links.finished.set(name, createProgram(gl, vertex, fragment));
      timing.readyMs = timing.blockedMs = performance.now() - submitted;
      if (name === 'glyph') variants.set(0, links.finished.get('glyph')!);
    }
  };
  /** Whether a link has finished, without waiting; records when it was first seen done. */
  const linked = (name: BaseName) => {
    if (links.finished.has(name)) return true;
    const pending = links.pending.get(name);
    if (!pending?.ready()) return false;
    const timing = timingOf(name);
    if (timing) timing.readyMs ??= performance.now() - created - timing.submittedMs;
    return true;
  };
  let drewBootTiles = false;
  let bootFailed = false;
  const dropBootPrograms = () => {
    for (const name of ['bootSelect', 'bootGlyph'] as const) {
      links.pending.get(name)?.cancel();
      links.pending.delete(name);
      const info = links.finished.get(name);
      if (info) gl.deleteProgram(info.program);
      links.finished.delete(name);
    }
  };
  const boot = (programs: Programs): Boot => ({
    poll(now) {
      if (!holdBoot) {
        if (!parallel && drewBootTiles && !links.finished.has('select')) {
          submit('select');
          submit('glyph');
        }
        // The big links start with the first frame, not with the program set: a set that is
        // disposed at once (React's development double mount) never starts them, and a
        // background tab starts them only when it is shown.
        if (parallel && !timingOf('glyph')) {
          submit('glyph');
          submit('selectLite');
        }
        // With parallel compile the lite select stands in first, and the full one is submitted
        // only now: one big link at a time keeps the driver's compiler off most of the machine.
        const first = parallel ? 'selectLite' : 'select';
        // Both polled, so each one's own finish time is recorded.
        const select = linked(first);
        const glyph = linked('glyph');
        if (select && glyph) {
          if (parallel) {
            if (!timingOf('select')) submit('select');
            if (linked('select')) {
              // A warm cache: the lite program is never drawn.
              links.pending.get('selectLite')?.cancel();
              links.pending.delete('selectLite');
            } else if (!links.finished.has('bootSelect') && now - created < BOOT_GRACE_MS) {
              // Nothing drawn yet, and a warm cache finishes about now.
              return 'grace';
            } else {
              finish('selectLite');
              programs.lite = true;
            }
          }
          if (!programs.lite) finish('select');
          finish('glyph');
          return 'full';
        }
      }
      if (bootFailed) return 'wait';
      const small = (['bootSelect', 'bootGlyph', 'labels', 'cell'] as const).map(linked);
      if (!small.every(Boolean)) return 'wait';
      if (!holdBoot && now - created < BOOT_GRACE_MS) return 'grace';
      try {
        finish('bootSelect');
        finish('bootGlyph');
      } catch {
        // A driver that rejects these still gets the full programs; only the early map is lost.
        bootFailed = true;
        return 'wait';
      }
      return 'boot';
    },
    commit() {
      programs.boot = undefined;
      dropBootPrograms();
    },
    drewTiles() {
      drewBootTiles = true;
    },
  });
  try {
    for (const name of ['bootSelect', 'bootGlyph', 'labels', 'cell'] as const) submit(name);
    // The full programs are submitted from `poll`: with parallel compile on the first frame,
    // without it once a boot frame is on screen.
    emptyVao = gl.createVertexArray();
    if (!emptyVao) throw new Error('ASCII Atlas: cannot allocate vertex array');
    const programs: Programs = {
      timings,
      timingsStart: created,
      baseLinks: links,
      get labels() {
        return finish('labels');
      },
      get cell() {
        return finish('cell');
      },
      get select() {
        if (programs.boot) return finish('bootSelect');
        return finish(programs.lite ? 'selectLite' : 'select');
      },
      upgrade() {
        if (!programs.lite || !linked('select')) return false;
        finish('select');
        programs.lite = false;
        const lite = links.finished.get('selectLite');
        links.finished.delete('selectLite');
        if (lite) gl.deleteProgram(lite.program);
        return true;
      },
      get glyph() {
        return finish(programs.boot ? 'bootGlyph' : 'glyph');
      },
      streetText: { vao, buffer, count: 0 },
      glyphVariants: variants,
      optional: new Map(),
      emptyVao,
      fullUniforms,
    };
    programs.boot = boot(programs);
    return programs;
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

/** Start a device-report entry for a glyph variant or an optional effect program. */
function variantTiming(programs: Programs, key: number, chars: number): ShaderTiming | undefined {
  if (!programs.timings || programs.timingsStart === undefined) return undefined;
  const timing: ShaderTiming = {
    name: key === 16 ? 'folklore' : key === 8 ? 'fireworks' : `glyph:${key}`,
    chars,
    submittedMs: performance.now() - programs.timingsStart,
    readyMs: null,
    blockedMs: null,
  };
  programs.timings.push(timing);
  return timing;
}
const sinceSubmitted = (programs: Programs, timing: ShaderTiming) =>
  performance.now() - (programs.timingsStart ?? 0) - timing.submittedMs;

/** Link a program on the main thread, recording how long the frame waited for it. */
export function createTimedProgram(
  gl: GL,
  programs: Programs,
  name: string,
  vertex: string,
  fragment: string,
): twgl.ProgramInfo {
  const start = performance.now();
  const program = createProgram(gl, vertex, fragment);
  if (programs.timings && programs.timingsStart !== undefined) {
    const ms = performance.now() - start;
    programs.timings.push({
      name,
      chars: vertex.length + fragment.length,
      submittedMs: start - programs.timingsStart,
      readyMs: ms,
      blockedMs: ms,
    });
  }
  return program;
}

export function glyphProgram(
  gl: GL,
  programs: Programs,
  focus: boolean,
  effectClocks: boolean,
  seasonal = false,
  /** False for warmup's own synchronous compile, which no frame is waiting on. */
  demand = true,
  /** Palay or mist is on screen. */
  field = false,
) {
  // Manually supplied program sets may already contain the full-feature shader.
  const variants = programs.glyphVariants;
  // No variant is compiled for the boot shaders, which have none of these features.
  if (!variants || programs.boot) return programs.glyph;
  // Bit 0 was the focus variant; every variant has focus now (createPrograms).
  void focus;
  const key = (Number(effectClocks) << 1) | (Number(seasonal) << 2) | (Number(field) << 5);
  if (key === 0) return programs.glyph;
  let program = variants.get(key);
  if (!program) {
    const start = performance.now();
    const pending = programs.glyphWarmup?.pending;
    if (demand && gl.getExtension('KHR_parallel_shader_compile')) {
      // A link on the main thread queues behind whatever the driver is compiling, for seconds:
      // the frame draws with a linked variant instead, and this one takes over once it is ready.
      if (pending?.key === key) {
        if (!pending.program.ready()) return standIn(programs, variants, key);
        program = pending.program.finish();
        if (pending.timing) {
          pending.timing.readyMs ??= sinceSubmitted(programs, pending.timing);
          pending.timing.blockedMs = performance.now() - start;
        }
        programs.glyphWarmup!.pending = undefined;
        variants.set(key, program);
        return program;
      }
      const asked = programs.glyphDemand;
      if (asked?.program.ready()) {
        if (asked.timing) asked.timing.readyMs ??= sinceSubmitted(programs, asked.timing);
        const linked = asked.program.finish();
        if (asked.timing) asked.timing.blockedMs = performance.now() - start;
        variants.set(asked.key, linked);
        programs.glyphDemand = undefined;
        if (asked.key === key) return linked;
      }
      // One link at a time: a second big compile only slows the first.
      if (!programs.glyphDemand && !pending) {
        const fragment = glyphFragmentFor({ focus: true, effectClocks, seasonal, field });
        programs.glyphDemand = {
          key,
          timing: variantTiming(programs, key, fullscreenVertex.length + fragment.length),
          program: prepareProgram(gl, fullscreenVertex, fragment),
        };
      }
      return standIn(programs, variants, key);
    }
    if (pending?.key === key) {
      program = pending.program.finish();
      if (pending.timing) {
        pending.timing.readyMs ??= sinceSubmitted(programs, pending.timing);
        pending.timing.blockedMs = performance.now() - start;
      }
      programs.glyphWarmup!.pending = undefined;
    } else {
      const fragment = glyphFragmentFor({ focus: true, effectClocks, seasonal, field });
      const timing = variantTiming(programs, key, fullscreenVertex.length + fragment.length);
      program = createProgram(gl, fullscreenVertex, fragment);
      if (timing) timing.readyMs = timing.blockedMs = performance.now() - start;
    }
    variants.set(key, program);
    if (demand) programs.demandWaitMs = (programs.demandWaitMs ?? 0) + performance.now() - start;
  }
  return program;
}

const bits = (n: number) => {
  let count = 0;
  for (; n; n &= n - 1) count++;
  return count;
};

/**
 * The linked variant nearest to `key`: one with every asked feature and the fewest others, since
 * uniforms switch the others off; failing that, the one missing the fewest.
 */
function standIn(programs: Programs, variants: Map<number, twgl.ProgramInfo>, key: number) {
  let best = programs.glyph;
  let score = -Infinity;
  for (const [have, program] of variants) {
    const missing = bits(key & ~have);
    const extra = bits(have & ~key);
    const s = missing === 0 ? 100 - extra : -missing;
    if (s > score) {
      score = s;
      best = program;
    }
  }
  return best;
}

/**
 * The fireworks (key 8) or folklore (key 16) program, once linked. With parallel compile the pass
 * never waits for it: until then this returns undefined and the pass skips its frame.
 */
export function effectProgram(
  gl: GL,
  programs: Programs,
  key: 8 | 16,
  vertex: string,
  fragment: string,
): twgl.ProgramInfo | undefined {
  const name = key === 16 ? 'folklore' : 'fireworks';
  const held = key === 16 ? programs.folkloreProgram : programs.fireworksProgram;
  if (held) {
    if (key === 16) programs.folkloreProgram = undefined;
    else programs.fireworksProgram = undefined;
    return held;
  }
  const pending = programs.glyphWarmup?.pending;
  if (pending?.key === key) {
    if (!pending.program.ready()) return undefined;
    if (pending.timing) pending.timing.readyMs ??= sinceSubmitted(programs, pending.timing);
    const program = pending.program.finish();
    programs.glyphWarmup!.pending = undefined;
    return program;
  }
  if (!programs.optional || !gl.getExtension('KHR_parallel_shader_compile'))
    return createTimedProgram(gl, programs, `${name} (waited)`, vertex, fragment);
  const program = optionalProgram(gl, programs, name, vertex, fragment);
  // The effect's own resources own it from here.
  if (program) programs.optional.delete(name);
  return program;
}

/**
 * One owned idle task and at most one pending link; startup retains the minimal shader.
 * `canWarm(parallel)` gates each turn: with `KHR_parallel_shader_compile` the caller may allow
 * warming during interaction, since links compile off the main thread and finish only once
 * ready; without it, a turn compiles synchronously. With `frame` (the rendered frame count),
 * at most one parallel link starts per rendered frame.
 */
export function prewarmGlyphPrograms(
  gl: GL,
  programs: Programs,
  canWarm: (parallel: boolean) => boolean,
  effectClocks = true,
  seasonal = false,
  fireworks = false,
  folklore = false,
  frame?: () => number,
  field = false,
) {
  const variants = programs.glyphVariants;
  if (!variants || programs.glyphWarmupFailed) return;
  const keys = (
    clocks: boolean,
    seasonal: boolean,
    fireworks: boolean,
    folklore: boolean,
    field: boolean,
  ) => [
    ...(folklore ? [16] : []),
    ...(fireworks ? [8] : []),
    ...(seasonal ? (clocks ? [4, 6] : [4]) : []),
    ...(field ? (clocks ? [32, 34] : [32]) : []),
    ...(clocks ? [2] : []),
  ];
  const has = (key: number) =>
    key === 16
      ? !!(programs.folklore || programs.folkloreProgram || programs.optional?.has('folklore'))
      : key === 8
        ? !!(programs.fireworks || programs.fireworksProgram || programs.optional?.has('fireworks'))
        : variants.has(key) || programs.glyphDemand?.key === key;
  if (programs.glyphWarmup) {
    const warmup = programs.glyphWarmup;
    warmup.clocks ||= effectClocks;
    warmup.seasonal = seasonal;
    warmup.fireworks = fireworks;
    warmup.folklore = folklore;
    warmup.field = field;
    if (
      warmup.pending &&
      !keys(warmup.clocks, seasonal, fireworks, folklore, field).includes(warmup.pending.key)
    ) {
      warmup.pending.program.cancel();
      warmup.pending = undefined;
    }
    return;
  }
  if (keys(effectClocks, seasonal, fireworks, folklore, field).every(has)) return;
  let cancelled = false;
  let cancelTask: (() => void) | undefined;
  const warmup: NonNullable<Programs['glyphWarmup']> = {
    clocks: effectClocks,
    seasonal,
    fireworks,
    folklore,
    field,
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
    const parallel = !!gl.getExtension('KHR_parallel_shader_compile');
    if (!canWarm(parallel)) {
      queue();
      return;
    }
    try {
      const pending = warmup.pending;
      if (pending) {
        if (pending.program.ready()) {
          if (pending.timing) pending.timing.readyMs ??= sinceSubmitted(programs, pending.timing);
          const finishing = performance.now();
          const program = pending.program.finish();
          if (pending.timing) pending.timing.blockedMs = performance.now() - finishing;
          if (pending.key === 16) programs.folkloreProgram = program;
          else if (pending.key === 8) programs.fireworksProgram = program;
          else variants.set(pending.key, program);
          warmup.pending = undefined;
        }
      } else {
        const key = keys(
          warmup.clocks,
          warmup.seasonal,
          warmup.fireworks,
          warmup.folklore,
          warmup.field,
        ).find((key) => !has(key));
        if (key === undefined) {
          programs.glyphWarmup = undefined;
          return;
        }
        const rendered = frame?.();
        // A variant a frame is waiting for links first, alone.
        if (programs.glyphDemand) {
          queue();
          return;
        }
        if (parallel && rendered !== undefined && rendered === warmup.started) {
          queue();
          return;
        }
        const focus = (key & 1) !== 0,
          effectClocks = (key & 2) !== 0;
        const seasonal = (key & 4) !== 0;
        const field = (key & 32) !== 0;
        if (parallel) {
          warmup.started = rendered;
          const vertex =
            key === 16 ? folkloreVertex : key === 8 ? fireworksVertex : fullscreenVertex;
          const fragment =
            key === 16
              ? folkloreFragment
              : key === 8
                ? fireworksFragment
                : glyphFragmentFor({ focus: true, effectClocks, seasonal, field });
          warmup.pending = {
            key,
            timing: variantTiming(programs, key, vertex.length + fragment.length),
            program: prepareProgram(gl, vertex, fragment),
          };
        } else if (key === 16)
          programs.folkloreProgram = createProgram(gl, folkloreVertex, folkloreFragment);
        else if (key === 8)
          programs.fireworksProgram = createProgram(gl, fireworksVertex, fireworksFragment);
        else glyphProgram(gl, programs, focus, effectClocks, seasonal, false, field);
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
  p.boot = undefined;
  deleteOptionalPrograms(gl, p.optional);
  p.glyphWarmup?.cancel();
  p.glyphDemand?.program.cancel();
  p.glyphDemand = undefined;
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
