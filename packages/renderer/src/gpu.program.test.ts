import { beforeEach, expect, it, vi } from 'vitest';
import * as twgl from 'twgl.js';
import { prepareProgram, type GL } from './gpu';

vi.mock('twgl.js', () => ({ createProgramInfoFromProgram: vi.fn() }));

function context() {
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    LINK_STATUS: 3,
    getExtension: vi.fn(() => ({ COMPLETION_STATUS_KHR: 4 })),
    createProgram: vi.fn(() => ({})),
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn((_program: WebGLProgram, query: number) => query === 3),
    getProgramInfoLog: vi.fn(() => 'link failed'),
    getShaderInfoLog: vi.fn(() => ''),
    deleteProgram: vi.fn(),
    deleteShader: vi.fn(),
    isContextLost: vi.fn(() => false),
  };
  return { gl, context: gl as unknown as GL };
}

beforeEach(() => vi.clearAllMocks());

it('defers blocking link/introspection queries until completion and transfers ownership once', () => {
  const { gl, context: ctx } = context();
  vi.mocked(twgl.createProgramInfoFromProgram).mockReturnValue({ program: {} } as twgl.ProgramInfo);
  const pending = prepareProgram(ctx, 'vertex', 'fragment');
  expect(gl.getProgramParameter).not.toHaveBeenCalled();
  expect(pending.ready()).toBe(false);
  expect(gl.getProgramParameter.mock.calls.map((call) => call[1])).toEqual([4]);
  gl.getProgramParameter.mockReturnValue(true);
  expect(pending.ready()).toBe(true);
  const info = pending.finish();
  expect(pending.finish()).toBe(info);
  pending.cancel();
  expect(twgl.createProgramInfoFromProgram).toHaveBeenCalledOnce();
  expect(gl.deleteShader).toHaveBeenCalledTimes(2);
  expect(gl.deleteProgram).not.toHaveBeenCalled();
});

it('releases partially linked resources once when cancelled or compilation fails', () => {
  const cancelled = context();
  const pending = prepareProgram(cancelled.context, 'vertex', 'fragment');
  pending.cancel();
  pending.cancel();
  expect(pending.ready()).toBe(false);
  expect(() => pending.finish()).toThrow('cancelled');
  expect(cancelled.gl.deleteShader).toHaveBeenCalledTimes(2);
  expect(cancelled.gl.deleteProgram).toHaveBeenCalledOnce();
  const failed = context();
  failed.gl.getProgramParameter.mockReturnValue(false);
  const bad = prepareProgram(failed.context, 'vertex', 'fragment');
  expect(() => bad.finish()).toThrow('link failed');
  expect(failed.gl.deleteShader).toHaveBeenCalledTimes(2);
  expect(failed.gl.deleteProgram).toHaveBeenCalledOnce();
});

it('does not poll or delete invalid GL handles after context loss', () => {
  const { gl, context: ctx } = context();
  const pending = prepareProgram(ctx, 'vertex', 'fragment');
  gl.isContextLost.mockReturnValue(true);
  expect(pending.ready()).toBe(false);
  pending.cancel();
  expect(gl.getProgramParameter).not.toHaveBeenCalled();
  expect(gl.deleteShader).not.toHaveBeenCalled();
  expect(gl.deleteProgram).not.toHaveBeenCalled();
});
