import { beforeEach, expect, it, vi } from 'vitest';
import { prepareProgram, type GL } from './gpu';
import { deleteOptionalPrograms, optionalProgram, type OptionalLinks } from './optional-programs';
import type * as twgl from 'twgl.js';

vi.mock('./gpu', () => ({ prepareProgram: vi.fn() }));

const gl = {
  deleteProgram: vi.fn(),
  isContextLost: vi.fn(() => false),
};
const context = gl as unknown as GL;
const info = { program: {} } as twgl.ProgramInfo;
const link = (ready = true) => ({
  ready: vi.fn(() => ready),
  finish: vi.fn(() => info),
  cancel: vi.fn(),
});

beforeEach(() => vi.clearAllMocks());

it('stays off for a program set without optional links', () => {
  expect(optionalProgram(context, {}, 'morph', 'v', 'f')).toBeUndefined();
  expect(prepareProgram).not.toHaveBeenCalled();
});

it('submits once, never waits, and returns the program once linked', () => {
  const pending = link(false);
  vi.mocked(prepareProgram).mockReturnValue(pending);
  const programs = { optional: new Map() as OptionalLinks };
  expect(optionalProgram(context, programs, 'morph', 'v', 'f')).toBeUndefined();
  expect(optionalProgram(context, programs, 'morph', 'v', 'f')).toBeUndefined();
  expect(prepareProgram).toHaveBeenCalledOnce();
  expect(pending.finish).not.toHaveBeenCalled();
  pending.ready.mockReturnValue(true);
  expect(optionalProgram(context, programs, 'morph', 'v', 'f')).toBe(info);
  expect(optionalProgram(context, programs, 'morph', 'v', 'f')).toBe(info);
  expect(pending.finish).toHaveBeenCalledOnce();
});

it('stays off after a failed link or a failed submission, without throwing', () => {
  const failing = link();
  failing.finish.mockImplementation(() => {
    throw new Error('driver');
  });
  vi.mocked(prepareProgram).mockReturnValueOnce(failing);
  const programs = { optional: new Map() as OptionalLinks };
  expect(optionalProgram(context, programs, 'morph', 'v', 'f')).toBeUndefined();
  expect(optionalProgram(context, programs, 'morph', 'v', 'f')).toBeUndefined();
  expect(failing.finish).toHaveBeenCalledOnce();
  vi.mocked(prepareProgram).mockImplementationOnce(() => {
    throw new Error('allocation');
  });
  expect(optionalProgram(context, programs, 'bloom', 'v', 'f')).toBeUndefined();
});

it('deletes linked programs, cancels pending ones, and touches no GL handle after loss', () => {
  const pending = link(false);
  const linked = link();
  vi.mocked(prepareProgram).mockReturnValueOnce(pending).mockReturnValueOnce(linked);
  const programs = { optional: new Map() as OptionalLinks };
  optionalProgram(context, programs, 'pending', 'v', 'f');
  optionalProgram(context, programs, 'linked', 'v', 'f');
  deleteOptionalPrograms(context, programs.optional);
  expect(pending.cancel).toHaveBeenCalledOnce();
  expect(gl.deleteProgram).toHaveBeenCalledExactlyOnceWith(info.program);
  expect(programs.optional.size).toBe(0);

  vi.mocked(prepareProgram).mockReturnValueOnce(link());
  optionalProgram(context, programs, 'lost', 'v', 'f');
  gl.isContextLost.mockReturnValueOnce(true);
  gl.deleteProgram.mockClear();
  deleteOptionalPrograms(context, programs.optional);
  expect(gl.deleteProgram).not.toHaveBeenCalled();
});
