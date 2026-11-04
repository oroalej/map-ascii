import * as twgl from 'twgl.js';
import { afterEach, expect, it, vi } from 'vitest';
import { setChangedUniforms } from './gpu';

const program = () => ({}) as twgl.ProgramInfo;
const spy = () => vi.spyOn(twgl, 'setUniforms').mockImplementation(() => {});
const lastUpload = (uniforms: ReturnType<typeof spy>) =>
  uniforms.mock.calls.at(-1)![1] as Record<string, unknown>;

afterEach(() => vi.restoreAllMocks());

it('uploads everything once, then only what changed', () => {
  const uniforms = spy();
  const p = program();
  setChangedUniforms(p, { u_a: 1, u_b: true, u_c: [1, 2], u_d: new Float32Array([3, 4]) });
  expect(lastUpload(uniforms)).toEqual({
    u_a: 1,
    u_b: true,
    u_c: [1, 2],
    u_d: new Float32Array([3, 4]),
  });
  setChangedUniforms(p, { u_a: 1, u_b: true, u_c: [1, 2], u_d: new Float32Array([3, 4]) });
  expect(lastUpload(uniforms)).toEqual({});
  setChangedUniforms(p, { u_a: 2, u_b: false, u_c: [1, 3], u_d: new Float32Array([3, 5]) });
  expect(lastUpload(uniforms)).toEqual({
    u_a: 2,
    u_b: false,
    u_c: [1, 3],
    u_d: new Float32Array([3, 5]),
  });
});

it('sees changes made in place to a reused scratch array', () => {
  const uniforms = spy();
  const p = program();
  const scratch = [0, 0, 0];
  setChangedUniforms(p, { u_ripples: scratch });
  setChangedUniforms(p, { u_ripples: scratch });
  expect(lastUpload(uniforms)).toEqual({});
  scratch[1] = 7;
  setChangedUniforms(p, { u_ripples: scratch });
  expect(lastUpload(uniforms)).toEqual({ u_ripples: [0, 7, 0] });
  const typed = new Uint32Array([1, 2]);
  setChangedUniforms(p, { u_mask: typed });
  typed[0] = 9;
  setChangedUniforms(p, { u_mask: typed });
  expect(lastUpload(uniforms)).toEqual({ u_mask: new Uint32Array([9, 2]) });
});

it('sends a list again when its length changes', () => {
  const uniforms = spy();
  const p = program();
  setChangedUniforms(p, { u_list: [1, 2] });
  setChangedUniforms(p, { u_list: [1, 2, 3] });
  expect(lastUpload(uniforms)).toEqual({ u_list: [1, 2, 3] });
});

it('always forwards textures and other values it cannot compare', () => {
  const uniforms = spy();
  const p = program();
  const texture = {};
  const textures = [texture, texture];
  const nested = [[1, 2]];
  for (let i = 0; i < 2; i++) {
    setChangedUniforms(p, { u_tex: texture, u_textures: textures, u_nested: nested });
    expect(lastUpload(uniforms)).toEqual({
      u_tex: texture,
      u_textures: textures,
      u_nested: nested,
    });
  }
});

it('forwards a value again after it became a texture and back', () => {
  const uniforms = spy();
  const p = program();
  setChangedUniforms(p, { u_x: 1 });
  setChangedUniforms(p, { u_x: {} });
  setChangedUniforms(p, { u_x: 1 });
  expect(lastUpload(uniforms)).toEqual({ u_x: 1 });
});

it('keeps a separate record per program, so a new variant or context starts full', () => {
  const uniforms = spy();
  setChangedUniforms(program(), { u_a: 1 });
  setChangedUniforms(program(), { u_a: 1 });
  expect(lastUpload(uniforms)).toEqual({ u_a: 1 });
});

it('uploads everything on every draw when asked', () => {
  const uniforms = spy();
  const p = program();
  setChangedUniforms(p, { u_a: 1 }, true);
  setChangedUniforms(p, { u_a: 1 }, true);
  expect(uniforms).toHaveBeenCalledTimes(2);
  expect(lastUpload(uniforms)).toEqual({ u_a: 1 });
});
