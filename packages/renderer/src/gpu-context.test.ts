import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram, prepareProgram } from './gpu';
import {
  BOOT_GRACE_MS,
  createPrograms,
  deletePrograms,
  glyphProgram,
  prewarmGlyphPrograms,
} from './gpu-context';
import { bootGlyphFragment, bootSelectFragment } from './shaders/boot';
import { glyphFragmentFor } from './shaders/glyph';
import { selectFragment } from './shaders/select';
import type { GL } from './gpu';

/** The full programs in use, past the boot shaders (see 'boot shaders' below). */
const fullPrograms = (gl: GL) => {
  const programs = createPrograms(gl);
  programs.boot!.drewTiles();
  if (programs.boot!.poll(Infinity) === 'full') programs.boot?.commit();
  programs.boot = undefined;
  return programs;
};

vi.mock('./gpu', () => ({
  createProgram: vi.fn(),
  createTexture: vi.fn(),
  prepareProgram: vi.fn(),
}));

describe('glyph program variants', () => {
  const gl = {
    createVertexArray: vi.fn(() => ({})),
    createBuffer: vi.fn(() => ({})),
    bindVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    deleteProgram: vi.fn<(program: WebGLProgram) => void>(),
    deleteVertexArray: vi.fn(),
    deleteBuffer: vi.fn(),
    getExtension: vi.fn<() => object | null>(() => null),
    isContextLost: vi.fn(() => false),
  };
  // Only the resource lifecycle is exercised; drawing uses real browser GL checks.
  const context = gl as unknown as GL;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    gl.getExtension.mockReturnValue(null);
    gl.isContextLost.mockReturnValue(false);
    vi.mocked(createProgram).mockImplementation(
      () => ({ program: {} }) as ReturnType<typeof createProgram>,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('issues all base links before first-use finalization and shares the base glyph', () => {
    gl.getExtension.mockReturnValue({ COMPLETION_STATUS_KHR: 123 });
    const pending = Array.from({ length: 6 }, () => ({
      ready: () => false,
      finish: vi.fn(() => ({ program: {} }) as ReturnType<typeof createProgram>),
      cancel: vi.fn(),
    }));
    let index = 0;
    vi.mocked(prepareProgram).mockImplementation(() => pending[index++]!);
    const programs = fullPrograms(context);
    expect(prepareProgram).toHaveBeenCalledTimes(6);
    expect(pending.every((p) => p.finish.mock.calls.length === 0)).toBe(true);
    expect(programs.cell).toBe(programs.cell);
    expect(pending[3]!.finish).toHaveBeenCalledOnce();
    expect(glyphProgram(context, programs, false, false)).toBe(programs.glyph);
    expect(pending[5]!.finish).toHaveBeenCalledOnce();
    deletePrograms(context, programs);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(2);
    expect(pending[2]!.cancel).toHaveBeenCalledOnce();
    expect(pending[4]!.cancel).toHaveBeenCalledOnce();
  });
  describe('boot shaders', () => {
    const links = (done: Set<number>) => {
      const made: {
        ready: () => boolean;
        finish: ReturnType<typeof vi.fn<() => ReturnType<typeof createProgram>>>;
        cancel: ReturnType<typeof vi.fn<() => void>>;
      }[] = [];
      vi.mocked(prepareProgram).mockImplementation(() => {
        const index = made.length;
        const link = {
          ready: () => done.has(index),
          finish: vi.fn(
            () => ({ program: { index } }) as unknown as ReturnType<typeof createProgram>,
          ),
          cancel: vi.fn<() => void>(),
        };
        made.push(link);
        return link;
      });
      return made;
    };
    const BOOT_SELECT = 0,
      BOOT_GLYPH = 1,
      LABELS = 2,
      CELL = 3,
      SELECT = 4,
      GLYPH = 5;
    const SMALL = [BOOT_SELECT, BOOT_GLYPH, LABELS, CELL];
    const parallelContext = () => {
      gl.getExtension.mockReturnValue({ COMPLETION_STATUS_KHR: 123 });
      return context;
    };

    it('submits the small programs first and never waits on a pending link', () => {
      const made = links(new Set());
      const programs = createPrograms(parallelContext());
      expect(vi.mocked(prepareProgram).mock.calls.map((call) => call[2].length)).toEqual(
        expect.any(Array),
      );
      expect(made).toHaveLength(6);
      expect(programs.boot!.poll(0)).toBe('wait');
      expect(made.every((link) => link.finish.mock.calls.length === 0)).toBe(true);
    });

    it('holds the screen through the grace, then draws boot until both full links are done', () => {
      const done = new Set(SMALL);
      const made = links(done);
      const programs = createPrograms(parallelContext());
      const start = performance.now();
      expect(programs.boot!.poll(start)).toBe('grace');
      expect(programs.boot!.poll(start + BOOT_GRACE_MS + 1)).toBe('boot');
      expect(programs.select).toBe(made[BOOT_SELECT]!.finish.mock.results[0]!.value);
      expect(programs.glyph).toBe(made[BOOT_GLYPH]!.finish.mock.results[0]!.value);
      expect(glyphProgram(context, programs, true, true)).toBe(programs.glyph);
      expect(made[SELECT]!.finish).not.toHaveBeenCalled();
      done.add(SELECT);
      expect(programs.boot!.poll(start + BOOT_GRACE_MS + 2)).toBe('boot');
      expect(made[SELECT]!.finish).not.toHaveBeenCalled();
      done.add(GLYPH);
      expect(programs.boot!.poll(start + BOOT_GRACE_MS + 3)).toBe('full');
      // Until committed, the boot programs still draw: the morph snapshots the last boot frame.
      expect(programs.glyph).toBe(made[BOOT_GLYPH]!.finish.mock.results[0]!.value);
      programs.boot!.commit();
      expect(programs.boot).toBeUndefined();
      expect(programs.select).toBe(made[SELECT]!.finish.mock.results[0]!.value);
      expect(programs.glyph).toBe(made[GLYPH]!.finish.mock.results[0]!.value);
      // The two boot programs are released at the swap.
      expect(gl.deleteProgram).toHaveBeenCalledTimes(2);
    });

    it('skips boot on a warm cache', () => {
      const made = links(new Set([...SMALL, SELECT, GLYPH]));
      const programs = createPrograms(parallelContext());
      expect(programs.boot!.poll(performance.now())).toBe('full');
      programs.boot!.commit();
      expect(made[BOOT_SELECT]!.finish).not.toHaveBeenCalled();
      expect(made[BOOT_SELECT]!.cancel).toHaveBeenCalledOnce();
      expect(made[BOOT_GLYPH]!.cancel).toHaveBeenCalledOnce();
    });

    it('records when each link was first seen done', () => {
      const done = new Set([SELECT]);
      links(done);
      const programs = createPrograms(parallelContext());
      programs.boot!.poll(0);
      const timing = (name: string) => programs.timings!.find((t) => t.name === name)!;
      expect(timing('select').readyMs).toEqual(expect.any(Number));
      expect(timing('select').blockedMs).toBeNull();
      expect(timing('glyph').readyMs).toBeNull();
    });

    it('cancels every link when the context goes', () => {
      const made = links(new Set(SMALL));
      const programs = createPrograms(parallelContext());
      programs.boot!.poll(performance.now() + BOOT_GRACE_MS + 1);
      deletePrograms(context, programs);
      expect(programs.boot).toBeUndefined();
      expect(made[SELECT]!.cancel).toHaveBeenCalledOnce();
      expect(made[GLYPH]!.cancel).toHaveBeenCalledOnce();
      expect(made[SELECT]!.finish).not.toHaveBeenCalled();
    });

    it('never submits the full programs while held', () => {
      const made = links(new Set(SMALL));
      const programs = createPrograms(parallelContext(), false, true);
      expect(made).toHaveLength(4);
      expect(programs.boot!.poll(0)).toBe('boot');
      expect(programs.boot!.poll(1e9)).toBe('boot');
    });

    it('waits for the full programs when a boot link fails', () => {
      const done = new Set(SMALL);
      const made = links(done);
      const programs = createPrograms(parallelContext());
      made[BOOT_SELECT]!.finish.mockImplementation(() => {
        throw new Error('driver');
      });
      expect(programs.boot!.poll(performance.now() + BOOT_GRACE_MS + 1)).toBe('wait');
      done.add(SELECT).add(GLYPH);
      expect(programs.boot!.poll(performance.now() + BOOT_GRACE_MS + 2)).toBe('full');
    });

    it('links the full programs after a boot frame without parallel compile', () => {
      const programs = createPrograms(context);
      expect(vi.mocked(createProgram)).toHaveBeenCalledTimes(4);
      expect(programs.boot!.poll(performance.now() + BOOT_GRACE_MS + 1)).toBe('boot');
      expect(vi.mocked(createProgram)).toHaveBeenCalledTimes(4);
      programs.boot!.drewTiles();
      expect(programs.boot!.poll(performance.now() + BOOT_GRACE_MS + 2)).toBe('full');
      expect(vi.mocked(createProgram)).toHaveBeenCalledTimes(6);
      expect(programs.timings!.find((t) => t.name === 'glyph')!.blockedMs).toEqual(
        expect.any(Number),
      );
    });

    it('keeps the boot sources small enough to link quickly', () => {
      expect(bootSelectFragment.length).toBeLessThan(4000);
      expect(bootGlyphFragment.length).toBeLessThan(3500);
      expect(bootSelectFragment).toContain('location = 1');
      // The same uniforms the full passes upload, so the passes need no boot path.
      for (const name of [...bootSelectFragment.matchAll(/uniform [^ ]+ (u_\w+)/g)].map(
        (m) => m[1]!,
      ))
        expect(selectFragment).toContain(name);
      for (const name of [...bootGlyphFragment.matchAll(/uniform [^ ]+ (u_\w+)/g)].map(
        (m) => m[1]!,
      ))
        expect(glyphFragmentFor()).toContain(name);
    });
  });

  it('records each base program without querying a pending link', () => {
    gl.getExtension.mockReturnValue({ COMPLETION_STATUS_KHR: 123 });
    const ready = vi.fn(() => false);
    const finish = vi.fn(() => ({ program: {} }) as ReturnType<typeof createProgram>);
    vi.mocked(prepareProgram).mockImplementation(() => ({ ready, finish, cancel: vi.fn() }));
    const programs = createPrograms(context);
    expect(programs.timings!.map((t) => t.name).sort()).toEqual([
      'bootGlyph',
      'bootSelect',
      'cell',
      'glyph',
      'labels',
      'select',
    ]);
    expect(programs.timings!.every((t) => t.chars > 0 && t.readyMs === null)).toBe(true);
    expect(finish).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    void programs.cell;
    const cell = programs.timings!.find((t) => t.name === 'cell')!;
    expect(cell.blockedMs).toEqual(expect.any(Number));
    expect(cell.readyMs).toEqual(expect.any(Number));
    expect(programs.timings!.find((t) => t.name === 'select')!.blockedMs).toBeNull();
  });
  it('records a synchronous link as both ready and blocking', () => {
    const programs = fullPrograms(context);
    void programs.glyph;
    for (const timing of programs.timings!) {
      expect(timing.readyMs).toEqual(expect.any(Number));
      expect(timing.blockedMs).toBe(timing.readyMs);
    }
  });
  it('cancels unused links and cleans partial construction without finalization', () => {
    gl.getExtension.mockReturnValue({ COMPLETION_STATUS_KHR: 123 });
    const links: {
      ready: () => boolean;
      finish: ReturnType<typeof vi.fn<() => ReturnType<typeof createProgram>>>;
      cancel: ReturnType<typeof vi.fn<() => void>>;
    }[] = [];
    vi.mocked(prepareProgram).mockImplementation(() => {
      const link = {
        ready: () => false,
        finish: vi.fn<() => ReturnType<typeof createProgram>>(),
        cancel: vi.fn<() => void>(),
      };
      links.push(link);
      return link;
    });
    const programs = fullPrograms(context);
    deletePrograms(context, programs);
    expect(
      links.every((p) => p.cancel.mock.calls.length === 1 && p.finish.mock.calls.length === 0),
    ).toBe(true);
    expect(gl.deleteProgram).not.toHaveBeenCalled();
    vi.mocked(prepareProgram)
      .mockImplementationOnce(() => links[0]!)
      .mockImplementationOnce(() => {
        throw new Error('allocation');
      });
    expect(() => createPrograms(context)).toThrow('allocation');
    expect(links[0]!.cancel).toHaveBeenCalledTimes(2);
  });

  it('warms folklore only when eligible and deletes an unused prepared program once', () => {
    const programs = fullPrograms(context);
    prewarmGlyphPrograms(context, programs, () => true, false, false, false, false);
    vi.advanceTimersByTime(200);
    expect(programs.folkloreProgram).toBeUndefined();
    prewarmGlyphPrograms(context, programs, () => true, false, false, false, true);
    vi.advanceTimersByTime(200);
    expect(programs.folklore).toBeUndefined();
    const prepared = programs.folkloreProgram!.program;
    expect(prepared).toBeDefined();
    prewarmGlyphPrograms(context, programs, () => true, false, false, false, true);
    expect(vi.getTimerCount()).toBe(0);
    deletePrograms(context, programs);
    expect(gl.deleteProgram.mock.calls.filter(([p]) => p === prepared)).toHaveLength(1);
  });

  it('cancels pending folklore links on ineligibility, context loss and disposal', () => {
    const pending = { ready: () => false, finish: vi.fn(), cancel: vi.fn() };
    vi.mocked(prepareProgram).mockReturnValue(pending);
    const programs = fullPrograms(context);
    gl.getExtension.mockReturnValue({ COMPLETION_STATUS_KHR: 123 });
    prewarmGlyphPrograms(context, programs, () => true, false, false, false, true);
    vi.advanceTimersByTime(100);
    expect(programs.glyphWarmup?.pending?.key).toBe(16);
    prewarmGlyphPrograms(context, programs, () => true, false, false, false, false);
    expect(pending.cancel).toHaveBeenCalledOnce();
    prewarmGlyphPrograms(context, programs, () => true, false, false, false, true);
    vi.advanceTimersByTime(100);
    gl.isContextLost.mockReturnValue(true);
    vi.advanceTimersByTime(100);
    expect(pending.cancel).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    gl.isContextLost.mockReturnValue(false);
    prewarmGlyphPrograms(context, programs, () => true, false, false, false, true);
    vi.advanceTimersByTime(100);
    deletePrograms(context, programs);
    expect(pending.cancel).toHaveBeenCalledTimes(3);
    expect(pending.finish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for input to settle and warms one variant per idle turn without the extension', () => {
    const programs = fullPrograms(context);
    let quiet = false;
    prewarmGlyphPrograms(context, programs, () => quiet);
    prewarmGlyphPrograms(context, programs, () => quiet);
    vi.advanceTimersByTime(100);
    expect(createProgram).toHaveBeenCalledTimes(6);
    quiet = true;
    vi.advanceTimersByTime(100);
    expect(createProgram).toHaveBeenCalledTimes(7);
    glyphProgram(context, programs, true, false);
    expect(createProgram).toHaveBeenCalledTimes(7);
    vi.advanceTimersByTime(300);
    expect(programs.glyphVariants?.size).toBe(4);
    expect(createProgram).toHaveBeenCalledTimes(9);
    expect(vi.getTimerCount()).toBe(0);
    deletePrograms(context, programs);
  });

  it('warms only focus until candles appear, including an upgrade during a pending warmup', () => {
    const programs = fullPrograms(context);
    prewarmGlyphPrograms(context, programs, () => true, false);
    vi.advanceTimersByTime(200);
    expect(programs.glyphVariants?.size).toBe(2);
    expect(createProgram).toHaveBeenCalledTimes(7);
    prewarmGlyphPrograms(context, programs, () => true, false);
    expect(vi.getTimerCount()).toBe(0);
    prewarmGlyphPrograms(context, programs, () => true, true);
    vi.advanceTimersByTime(300);
    expect(programs.glyphVariants?.size).toBe(4);
    deletePrograms(context, programs);
    const upgraded = fullPrograms(context);
    prewarmGlyphPrograms(context, upgraded, () => true, false);
    prewarmGlyphPrograms(context, upgraded, () => true, true);
    vi.advanceTimersByTime(400);
    expect(upgraded.glyphVariants?.size).toBe(4);
    deletePrograms(context, upgraded);
  });

  it('reuses an unfinished parallel link when input arrives and cancels the next link on disposal', () => {
    const pending = {
      ready: vi.fn(() => false),
      finish: vi.fn(() => ({ program: {} }) as ReturnType<typeof createProgram>),
      cancel: vi.fn(),
    };
    vi.mocked(prepareProgram).mockReturnValue(pending);
    const programs = fullPrograms(context);
    gl.getExtension.mockReturnValue({ COMPLETION_STATUS_KHR: 123 });
    prewarmGlyphPrograms(context, programs, () => true);
    vi.advanceTimersByTime(200);
    expect(prepareProgram).toHaveBeenCalledTimes(1);
    expect(pending.finish).not.toHaveBeenCalled();
    expect(glyphProgram(context, programs, true, false)).toBe(
      pending.finish.mock.results[0]!.value,
    );
    expect(createProgram).toHaveBeenCalledTimes(6);
    vi.advanceTimersByTime(100);
    expect(prepareProgram).toHaveBeenCalledTimes(2);
    deletePrograms(context, programs);
    expect(pending.cancel).toHaveBeenCalledOnce();
    expect(gl.deleteProgram).toHaveBeenCalledTimes(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts at most one parallel link per rendered frame and finishes only ready links', () => {
    let ready = false;
    const links: { ready: () => boolean; finish: () => unknown; cancel: () => void }[] = [];
    vi.mocked(prepareProgram).mockImplementation(() => {
      const link = {
        ready: vi.fn(() => ready),
        finish: vi.fn(() => ({ program: {} }) as ReturnType<typeof createProgram>),
        cancel: vi.fn(),
      };
      links.push(link);
      return link;
    });
    const programs = fullPrograms(context);
    gl.getExtension.mockReturnValue({ COMPLETION_STATUS_KHR: 123 });
    let frame = 0;
    const gates: boolean[] = [];
    // Input is continuous: only the parallel path may run.
    prewarmGlyphPrograms(
      context,
      programs,
      (parallel) => {
        gates.push(parallel);
        return parallel;
      },
      true,
      false,
      false,
      false,
      () => frame,
    );
    vi.advanceTimersByTime(100);
    expect(gates).toEqual([true]);
    expect(links).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(links).toHaveLength(1);
    expect(links[0]!.finish).not.toHaveBeenCalled();
    ready = true;
    vi.advanceTimersByTime(100);
    expect(links[0]!.finish).toHaveBeenCalledOnce();
    expect(programs.glyphVariants?.size).toBe(2);
    // The finished link does not let another start until a new frame is drawn.
    vi.advanceTimersByTime(300);
    expect(links).toHaveLength(1);
    ready = false;
    frame = 1;
    vi.advanceTimersByTime(200);
    expect(links).toHaveLength(2);
    expect(programs.glyphWarmup?.pending).toBeDefined();
    deletePrograms(context, programs);
    expect(links[1]!.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps quiet-only synchronous warmup without the extension', () => {
    const programs = fullPrograms(context);
    let quiet = false;
    const gates: boolean[] = [];
    prewarmGlyphPrograms(
      context,
      programs,
      (parallel) => {
        gates.push(parallel);
        return quiet;
      },
      true,
      false,
      false,
      false,
      () => 0,
    );
    vi.advanceTimersByTime(300);
    expect(createProgram).toHaveBeenCalledTimes(6);
    expect(gates.every((parallel) => !parallel)).toBe(true);
    quiet = true;
    vi.advanceTimersByTime(100);
    expect(createProgram).toHaveBeenCalledTimes(7);
    deletePrograms(context, programs);
  });

  it('reports a demand compile or an unfinished link as a separate wait', () => {
    const now = vi.spyOn(performance, 'now');
    let clock = 0;
    now.mockImplementation(() => clock);
    vi.mocked(createProgram).mockImplementation(() => {
      clock += 7;
      return { program: {} } as ReturnType<typeof createProgram>;
    });
    const programs = fullPrograms(context);
    expect(programs.demandWaitMs ?? 0).toBe(0);
    glyphProgram(context, programs, true, false);
    expect(programs.demandWaitMs).toBe(7);
    glyphProgram(context, programs, true, false);
    expect(programs.demandWaitMs).toBe(7);
    deletePrograms(context, programs);
    // Quiet synchronous warmup compiles leave demand timing alone; a later demand still counts.
    const warmed = fullPrograms(context);
    prewarmGlyphPrograms(context, warmed, () => true, false);
    vi.advanceTimersByTime(100);
    expect(warmed.glyphVariants?.size).toBe(2);
    expect(warmed.demandWaitMs ?? 0).toBe(0);
    glyphProgram(context, warmed, false, true);
    expect(warmed.demandWaitMs).toBe(7);
    deletePrograms(context, warmed);
    now.mockRestore();
  });

  it('cancels an owned idle callback on context loss and warms the restored context independently', () => {
    const idle = new Map<number, () => void>();
    let next = 0;
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
      idle.set(++next, callback);
      return next;
    });
    vi.stubGlobal('cancelIdleCallback', (id: number) => idle.delete(id));
    const before = fullPrograms(context);
    prewarmGlyphPrograms(context, before, () => true);
    const stale = idle.get(1)!;
    gl.isContextLost.mockReturnValue(true);
    before.glyphWarmup!.cancel();
    stale();
    expect(idle.size).toBe(0);
    expect(createProgram).toHaveBeenCalledTimes(6);
    gl.isContextLost.mockReturnValue(false);
    const restored = fullPrograms(context);
    prewarmGlyphPrograms(context, restored, () => true);
    expect(restored.glyphWarmup).toBeDefined();
    deletePrograms(context, restored);
    expect(idle.size).toBe(0);
  });

  it('compiles inactive features away and reuses each combination across toggles', () => {
    const programs = fullPrograms(context);
    expect(glyphProgram(context, programs, false, false)).toBe(programs.glyph);
    const focus = glyphProgram(context, programs, true, false);
    const clocks = glyphProgram(context, programs, false, true);
    const both = glyphProgram(context, programs, true, true);
    expect(new Set([programs.glyph, focus, clocks, both]).size).toBe(4);
    expect(glyphProgram(context, programs, true, false)).toBe(focus);
    expect(glyphProgram(context, programs, false, true)).toBe(clocks);
    expect(glyphProgram(context, programs, true, true)).toBe(both);
    expect(glyphProgram(context, programs, false, false)).toBe(programs.glyph);
    expect(createProgram).toHaveBeenCalledTimes(9);
    const fragments = vi.mocked(createProgram).mock.calls.map((call) => call[2]);
    // Boot select and glyph, labels, cell, select, glyph, then the variants.
    expect(fragments[5]).toContain('const bool u_focus = false;');
    expect(fragments[5]).toContain('const bool u_hasEffectClocks = false;');
    expect(fragments[6]).toContain('uniform bool u_focus;');
    expect(fragments[6]).toContain('const bool u_hasEffectClocks = false;');
    expect(fragments[7]).toContain('const bool u_focus = false;');
    expect(fragments[7]).toContain('uniform bool u_hasEffectClocks;');
    expect(fragments[8]).toContain('uniform bool u_focus;');
    expect(fragments[8]).toContain('uniform bool u_hasEffectClocks;');

    deletePrograms(context, programs);
    const deleted = gl.deleteProgram.mock.calls.map(([program]) => program);
    expect(deleted).toHaveLength(9);
    expect(new Set(deleted).size).toBe(9);
    expect(programs.glyphVariants?.size).toBe(0);
  });

  it('creates a fresh minimal variant after context recreation', () => {
    const before = fullPrograms(context);
    glyphProgram(context, before, true, true);
    const oldGlyph = before.glyph;
    deletePrograms(context, before);
    const after = fullPrograms(context);
    expect(after.glyph).not.toBe(oldGlyph);
    expect(after.glyphVariants?.size).toBe(1);
    expect(glyphProgram(context, after, false, false)).toBe(after.glyph);
  });
  it('compiles palay and mist only on demand, as their own variant', () => {
    const programs = fullPrograms(context);
    expect(vi.mocked(createProgram).mock.calls[0]![2]).not.toContain('mistOver');
    const plain = glyphProgram(context, programs, false, false);
    expect(plain).toBe(programs.glyph);
    const field = glyphProgram(context, programs, false, false, false, true, true);
    expect(field).not.toBe(plain);
    expect(vi.mocked(createProgram).mock.calls.at(-1)![2]).toContain('mistOver(');
    expect(glyphProgram(context, programs, false, false, false, true, true)).toBe(field);
    expect(glyphProgram(context, programs, false, false)).toBe(plain);
  });

  it('warms the palay and mist variants only when asked', () => {
    const programs = fullPrograms(context);
    prewarmGlyphPrograms(context, programs, () => true, true, false, false, false, undefined, true);
    vi.advanceTimersByTime(1000);
    expect([32, 33, 34, 35].every((key) => programs.glyphVariants?.has(key))).toBe(true);
    deletePrograms(context, programs);
  });

  it('compiles seasonal code only on demand and keeps ordinary warmup independent', () => {
    const programs = fullPrograms(context);
    const base = vi.mocked(createProgram).mock.calls[0]![2];
    expect(base).not.toContain('vec4 carnivalSurface');
    expect(base).not.toContain('float buntingInk');
    expect(base).not.toContain('float festivePulse');
    const seasonal = glyphProgram(context, programs, false, false, true);
    const source = vi.mocked(createProgram).mock.calls.at(-1)![2];
    expect(source).toContain('carnivalSurface(');
    expect(source).toContain('buntingInk(');
    expect(source).toContain('festivePulse(');
    expect(glyphProgram(context, programs, false, false, true)).toBe(seasonal);
    expect(glyphProgram(context, programs, false, false)).toBe(programs.glyph);
    glyphProgram(context, programs, true, false, true);
    glyphProgram(context, programs, false, true, true);
    expect(programs.glyphVariants?.size).toBe(4);
    prewarmGlyphPrograms(context, programs, () => true);
    vi.advanceTimersByTime(400);
    expect([0, 1, 2, 3].every((key) => programs.glyphVariants?.has(key))).toBe(true);
    deletePrograms(context, programs);
    expect(gl.deleteProgram.mock.calls).toHaveLength(12);
  });
  it('warms selected seasonal programs without allocating fireworks buffers and deletes unused links', () => {
    const programs = fullPrograms(context);
    prewarmGlyphPrograms(context, programs, () => true, false, true, true);
    vi.advanceTimersByTime(600);
    expect(programs.fireworksProgram).toBeDefined();
    expect(programs.fireworks).toBeUndefined();
    expect([0, 1, 4, 5].every((key) => programs.glyphVariants?.has(key))).toBe(true);
    const count = vi.mocked(createProgram).mock.calls.length;
    glyphProgram(context, programs, false, false, true);
    prewarmGlyphPrograms(context, programs, () => true, false, true, true);
    expect(createProgram).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
    const unused = programs.fireworksProgram!.program;
    deletePrograms(context, programs);
    expect(gl.deleteProgram.mock.calls.filter(([p]) => p === unused)).toHaveLength(1);
  });

  it('cancels a pending seasonal link when its season leaves and on teardown', () => {
    const pending = { ready: () => false, finish: vi.fn(), cancel: vi.fn() };
    vi.mocked(prepareProgram).mockReturnValue(pending);
    const programs = fullPrograms(context);
    gl.getExtension.mockReturnValue({ COMPLETION_STATUS_KHR: 123 });
    prewarmGlyphPrograms(context, programs, () => true, false, false, true);
    vi.advanceTimersByTime(100);
    expect(programs.glyphWarmup?.pending?.key).toBe(8);
    prewarmGlyphPrograms(context, programs, () => true, false, false, false);
    expect(pending.cancel).toHaveBeenCalledOnce();
    expect(programs.glyphWarmup?.pending).toBeUndefined();
    prewarmGlyphPrograms(context, programs, () => true, false, true, true);
    vi.advanceTimersByTime(100);
    deletePrograms(context, programs);
    expect(pending.cancel).toHaveBeenCalledTimes(2);
    expect(pending.finish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('publishes completed parallel variants once and retains demand compilation after a warmup failure', () => {
    vi.mocked(prepareProgram).mockImplementation(() => ({
      ready: () => true,
      finish: () => ({ program: {} }) as ReturnType<typeof createProgram>,
      cancel: vi.fn(),
    }));
    const programs = fullPrograms(context);
    gl.getExtension.mockReturnValue({ COMPLETION_STATUS_KHR: 123 });
    prewarmGlyphPrograms(context, programs, () => true);
    vi.advanceTimersByTime(700);
    expect(programs.glyphVariants?.size).toBe(4);
    expect(prepareProgram).toHaveBeenCalledTimes(3);
    glyphProgram(context, programs, true, true);
    expect(createProgram).toHaveBeenCalledTimes(6);
    deletePrograms(context, programs);
    gl.getExtension.mockReturnValue(null);
    const failed = fullPrograms(context);
    gl.getExtension.mockReturnValue({ COMPLETION_STATUS_KHR: 123 });
    const cancel = vi.fn();
    vi.mocked(prepareProgram).mockReturnValue({
      ready: () => true,
      finish: () => {
        throw new Error('compile failed');
      },
      cancel,
    });
    prewarmGlyphPrograms(context, failed, () => true);
    vi.advanceTimersByTime(200);
    expect(cancel).toHaveBeenCalledOnce();
    expect(failed.glyphVariants?.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    glyphProgram(context, failed, true, false);
    expect(failed.glyphVariants?.size).toBe(2);
    deletePrograms(context, failed);
  });
});
