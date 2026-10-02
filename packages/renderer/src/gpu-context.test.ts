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

  it('reuses an unfinished parallel link when input arrives and cancels the next link on disposal', () => {
    gl.getExtension.mockReturnValue({ COMPLETION_STATUS_KHR: 123 });
    const pending = {
      ready: vi.fn(() => false),
      finish: vi.fn(() => ({ program: {} }) as ReturnType<typeof createProgram>),
      cancel: vi.fn(),
    };
    vi.mocked(prepareProgram).mockReturnValue(pending);
    const programs = createPrograms(context);
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
    deletePrograms(context, before);
    const after = createPrograms(context);
    expect(after.glyph).not.toBe(before.glyph);
    expect(after.glyphVariants?.size).toBe(1);
    expect(glyphProgram(context, after, false, false)).toBe(after.glyph);
  });

  it('publishes completed parallel variants once and retains demand compilation after a warmup failure', () => {
    gl.getExtension.mockReturnValue({ COMPLETION_STATUS_KHR: 123 });
    vi.mocked(prepareProgram).mockImplementation(() => ({
      ready: () => true,
      finish: () => ({ program: {} }) as ReturnType<typeof createProgram>,
      cancel: vi.fn(),
    }));
    const programs = createPrograms(context);
    prewarmGlyphPrograms(context, programs, () => true);
    vi.advanceTimersByTime(700);
    expect(programs.glyphVariants?.size).toBe(4);
    expect(prepareProgram).toHaveBeenCalledTimes(3);
    glyphProgram(context, programs, true, true);
    expect(createProgram).toHaveBeenCalledTimes(4);
    deletePrograms(context, programs);
    const failed = createPrograms(context);
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
