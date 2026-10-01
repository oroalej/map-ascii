import { afterEach, expect, it, vi } from 'vitest';
import * as twgl from 'twgl.js';
import { createContext, createProgram, type GL } from './gpu';
import { createPrograms, deletePrograms } from './gpu-context';

vi.mock('twgl.js', () => ({ createProgramInfo: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it('reports all compiler diagnostics after TWGL finishes its cleanup', () => {
  const cleaned = vi.fn();
  vi.mocked(twgl.createProgramInfo).mockImplementation((_gl, _sources, report) => {
    if (typeof report !== 'function') throw new Error('Expected error callback');
    report('Error in program linking:');
    report('Fragment shader: too many instructions');
    cleaned();
    return undefined as unknown as twgl.ProgramInfo;
  });
  const gl = { isContextLost: () => false } as GL;
  expect(() => createProgram(gl, 'vertex', 'fragment', 'selection')).toThrow(
    /selection shader error:[\s\S]*Error in program linking:[\s\S]*too many instructions/,
  );
  expect(cleaned).toHaveBeenCalledOnce();
});

it('rejects a lost context even when the helper returned a program', () => {
  const info = { program: {} } as twgl.ProgramInfo;
  vi.mocked(twgl.createProgramInfo).mockReturnValue(info);
  const gl = { isContextLost: () => true, deleteProgram: vi.fn() };
  expect(() => createProgram(gl as unknown as GL, '', '', 'foliage')).toThrow(
    /foliage shader error: Graphics context lost/,
  );
  expect(gl.deleteProgram).toHaveBeenCalledWith(info.program);
});

function context() {
  return {
    createVertexArray: vi.fn(() => ({})),
    createBuffer: vi.fn(() => ({})),
    bindVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    deleteProgram: vi.fn<(program: WebGLProgram) => void>(),
    deleteVertexArray: vi.fn<(vao: WebGLVertexArrayObject | null) => void>(),
    deleteBuffer: vi.fn(),
    isContextLost: () => false,
  };
}

it('releases earlier programs and vertex resources if a later shader fails', () => {
  const gl = context();
  const made: twgl.ProgramInfo[] = [];
  vi.mocked(twgl.createProgramInfo).mockImplementation(() => {
    if (made.length === 3) throw new Error('foliage failure');
    const info = { program: {} } as twgl.ProgramInfo;
    made.push(info);
    return info;
  });
  expect(() => createPrograms(gl as unknown as GL)).toThrow('foliage failure');
  expect(gl.deleteProgram.mock.calls.map(([p]) => p)).toEqual(made.map((p) => p.program));
  expect(gl.deleteVertexArray.mock.calls.map(([v]) => v)).toEqual(
    gl.createVertexArray.mock.results.map((r) => r.value as WebGLVertexArrayObject),
  );
  expect(gl.deleteBuffer).toHaveBeenCalledWith(gl.createBuffer.mock.results[0]!.value);
});

it('recreates and releases the complete program set on restoration', () => {
  const gl = context();
  vi.mocked(twgl.createProgramInfo).mockImplementation(() => ({ program: {} }) as twgl.ProgramInfo);
  const first = createPrograms(gl as unknown as GL);
  const restored = createPrograms(gl as unknown as GL);
  expect(first.foliage.program).not.toBe(restored.foliage.program);
  deletePrograms(gl as unknown as GL, first);
  deletePrograms(gl as unknown as GL, restored);
  expect(gl.deleteProgram).toHaveBeenCalledTimes(10);
  expect(gl.deleteVertexArray).toHaveBeenCalledTimes(4);
  expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
});

it('uses the actual context options, reports creation details, and allows a later retry', () => {
  let listener: ((event: Event) => void) | undefined;
  const gl = {} as GL;
  const canvas = {
    addEventListener: vi.fn((_name: string, handler: (event: Event) => void) => {
      listener = handler;
    }),
    removeEventListener: vi.fn(),
    getContext: vi
      .fn()
      .mockImplementationOnce(() => {
        listener?.({ statusMessage: 'GPU reset' } as WebGLContextEvent);
        return null;
      })
      .mockReturnValue(gl),
  };
  expect(() => createContext(canvas as unknown as HTMLCanvasElement)).toThrow(
    /could not be initialized.*GPU reset/,
  );
  expect(createContext(canvas as unknown as HTMLCanvasElement)).toBe(gl);
  expect(canvas.getContext).toHaveBeenLastCalledWith('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
  });
  expect(canvas.removeEventListener).toHaveBeenCalledTimes(2);
});
