import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from './gpu';
import { createPrograms, deletePrograms, glyphProgram } from './gpu-context';
import type { GL } from './gpu';

vi.mock('./gpu', () => ({ createProgram: vi.fn(), createTexture: vi.fn() }));

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
  };
  // Only the resource lifecycle is exercised; drawing uses real browser GL checks.
  const context = gl as unknown as GL;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createProgram).mockImplementation(
      () => ({ program: {} }) as ReturnType<typeof createProgram>,
    );
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
});
