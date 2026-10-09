import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram, prepareProgram } from './gpu';
import { createPrograms, deletePrograms, glyphProgram, prewarmGlyphPrograms } from './gpu-context';
import type { GL } from './gpu';

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
    const pending = Array.from({ length: 4 }, () => ({
      ready: () => false,
      finish: vi.fn(() => ({ program: {} }) as ReturnType<typeof createProgram>),
      cancel: vi.fn(),
    }));
    let index = 0;
    vi.mocked(prepareProgram).mockImplementation(() => pending[index++]!);
    const programs = createPrograms(context);
    expect(prepareProgram).toHaveBeenCalledTimes(4);
    expect(pending.every((p) => p.finish.mock.calls.length === 0)).toBe(true);
    expect(programs.cell).toBe(programs.cell);
    expect(pending[2]!.finish).toHaveBeenCalledOnce();
    expect(glyphProgram(context, programs, false, false)).toBe(programs.glyph);
    expect(pending[0]!.finish).toHaveBeenCalledOnce();
    deletePrograms(context, programs);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(2);
    expect(pending[1]!.cancel).toHaveBeenCalledOnce();
    expect(pending[3]!.cancel).toHaveBeenCalledOnce();
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
    const programs = createPrograms(context);
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
    const programs = createPrograms(context);
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
    const programs = createPrograms(context);
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
    const programs = createPrograms(context);
    let quiet = false;
    prewarmGlyphPrograms(context, programs, () => quiet);
    prewarmGlyphPrograms(context, programs, () => quiet);
    vi.advanceTimersByTime(100);
    expect(createProgram).toHaveBeenCalledTimes(4);
    quiet = true;
    vi.advanceTimersByTime(100);
    expect(createProgram).toHaveBeenCalledTimes(5);
    glyphProgram(context, programs, true, false);
    expect(createProgram).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(300);
    expect(programs.glyphVariants?.size).toBe(4);
    expect(createProgram).toHaveBeenCalledTimes(7);
    expect(vi.getTimerCount()).toBe(0);
    deletePrograms(context, programs);
  });

  it('warms only focus until candles appear, including an upgrade during a pending warmup', () => {
    const programs = createPrograms(context);
    prewarmGlyphPrograms(context, programs, () => true, false);
    vi.advanceTimersByTime(200);
    expect(programs.glyphVariants?.size).toBe(2);
    expect(createProgram).toHaveBeenCalledTimes(5);
    prewarmGlyphPrograms(context, programs, () => true, false);
    expect(vi.getTimerCount()).toBe(0);
    prewarmGlyphPrograms(context, programs, () => true, true);
    vi.advanceTimersByTime(300);
    expect(programs.glyphVariants?.size).toBe(4);
    deletePrograms(context, programs);
    const upgraded = createPrograms(context);
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
    const programs = createPrograms(context);
    gl.getExtension.mockReturnValue({ COMPLETION_STATUS_KHR: 123 });
    prewarmGlyphPrograms(context, programs, () => true);
    vi.advanceTimersByTime(200);
    expect(prepareProgram).toHaveBeenCalledTimes(1);
    expect(pending.finish).not.toHaveBeenCalled();
    expect(glyphProgram(context, programs, true, false)).toBe(
      pending.finish.mock.results[0]!.value,
    );
    expect(createProgram).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(100);
    expect(prepareProgram).toHaveBeenCalledTimes(2);
    deletePrograms(context, programs);
    expect(pending.cancel).toHaveBeenCalledOnce();
    expect(gl.deleteProgram).toHaveBeenCalledTimes(5);
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
    const programs = createPrograms(context);
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
    const programs = createPrograms(context);
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
    expect(createProgram).toHaveBeenCalledTimes(4);
    expect(gates.every((parallel) => !parallel)).toBe(true);
    quiet = true;
    vi.advanceTimersByTime(100);
    expect(createProgram).toHaveBeenCalledTimes(5);
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
    const programs = createPrograms(context);
    expect(programs.demandWaitMs ?? 0).toBe(0);
    glyphProgram(context, programs, true, false);
    expect(programs.demandWaitMs).toBe(7);
    glyphProgram(context, programs, true, false);
    expect(programs.demandWaitMs).toBe(7);
    deletePrograms(context, programs);
    // Quiet synchronous warmup compiles leave demand timing alone; a later demand still counts.
    const warmed = createPrograms(context);
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
    const before = createPrograms(context);
    prewarmGlyphPrograms(context, before, () => true);
    const stale = idle.get(1)!;
    gl.isContextLost.mockReturnValue(true);
    before.glyphWarmup!.cancel();
    stale();
    expect(idle.size).toBe(0);
    expect(createProgram).toHaveBeenCalledTimes(4);
    gl.isContextLost.mockReturnValue(false);
    const restored = createPrograms(context);
    prewarmGlyphPrograms(context, restored, () => true);
    expect(restored.glyphWarmup).toBeDefined();
    deletePrograms(context, restored);
    expect(idle.size).toBe(0);
  });

  it('compiles inactive features away and reuses each combination across toggles', () => {
    const programs = createPrograms(context);
    expect(glyphProgram(context, programs, false, false)).toBe(programs.glyph);
    const focus = glyphProgram(context, programs, true, false);
    const clocks = glyphProgram(context, programs, false, true);
    const both = glyphProgram(context, programs, true, true);
    expect(new Set([programs.glyph, focus, clocks, both]).size).toBe(4);
    expect(glyphProgram(context, programs, true, false)).toBe(focus);
    expect(glyphProgram(context, programs, false, true)).toBe(clocks);
    expect(glyphProgram(context, programs, true, true)).toBe(both);
    expect(glyphProgram(context, programs, false, false)).toBe(programs.glyph);
    expect(createProgram).toHaveBeenCalledTimes(7);
    const fragments = vi.mocked(createProgram).mock.calls.map((call) => call[2]);
    expect(fragments[0]).toContain('const bool u_focus = false;');
    expect(fragments[0]).toContain('const bool u_hasEffectClocks = false;');
    expect(fragments[4]).toContain('uniform bool u_focus;');
    expect(fragments[4]).toContain('const bool u_hasEffectClocks = false;');
    expect(fragments[5]).toContain('const bool u_focus = false;');
    expect(fragments[5]).toContain('uniform bool u_hasEffectClocks;');
    expect(fragments[6]).toContain('uniform bool u_focus;');
    expect(fragments[6]).toContain('uniform bool u_hasEffectClocks;');

    deletePrograms(context, programs);
    const deleted = gl.deleteProgram.mock.calls.map(([program]) => program);
    expect(deleted).toHaveLength(7);
    expect(new Set(deleted).size).toBe(7);
    expect(programs.glyphVariants?.size).toBe(0);
  });

  it('creates a fresh minimal variant after context recreation', () => {
    const before = createPrograms(context);
    glyphProgram(context, before, true, true);
    const oldGlyph = before.glyph;
    deletePrograms(context, before);
    const after = createPrograms(context);
    expect(after.glyph).not.toBe(oldGlyph);
    expect(after.glyphVariants?.size).toBe(1);
    expect(glyphProgram(context, after, false, false)).toBe(after.glyph);
  });
  it('compiles seasonal code only on demand and keeps ordinary warmup independent', () => {
    const programs = createPrograms(context);
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
    expect(gl.deleteProgram.mock.calls).toHaveLength(10);
  });
  it('warms selected seasonal programs without allocating fireworks buffers and deletes unused links', () => {
    const programs = createPrograms(context);
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
    const programs = createPrograms(context);
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
    const programs = createPrograms(context);
    gl.getExtension.mockReturnValue({ COMPLETION_STATUS_KHR: 123 });
    prewarmGlyphPrograms(context, programs, () => true);
    vi.advanceTimersByTime(700);
    expect(programs.glyphVariants?.size).toBe(4);
    expect(prepareProgram).toHaveBeenCalledTimes(3);
    glyphProgram(context, programs, true, true);
    expect(createProgram).toHaveBeenCalledTimes(4);
    deletePrograms(context, programs);
    gl.getExtension.mockReturnValue(null);
    const failed = createPrograms(context);
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
