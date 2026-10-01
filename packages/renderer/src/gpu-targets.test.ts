import { expect, it, vi } from 'vitest';
import { createCellTargets, deleteCellTargets, type GL } from './gpu';

function context(failAt = 0, nullAt = 0) {
  const allocated = new Set<object>(),
    released = new Set<object>();
  let checks = 0,
    allocations = 0;
  let bound: object;
  const filters = new Map<object, Map<number, number>>();
  const make = () => {
    if (++allocations === nullAt) return null;
    const handle = {};
    allocated.add(handle);
    return handle;
  };
  const drop = (handle: object) => {
    expect(released.has(handle)).toBe(false);
    released.add(handle);
  };
  const gl = {
    FRAMEBUFFER_COMPLETE: 1,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    NEAREST: 0x2600,
    LINEAR: 0x2601,
    createTexture: vi.fn(make),
    createFramebuffer: vi.fn(make),
    createRenderbuffer: vi.fn(make),
    deleteTexture: vi.fn(drop),
    deleteFramebuffer: vi.fn(drop),
    deleteRenderbuffer: vi.fn(drop),
    bindTexture: vi.fn((_target: number, texture: object) => {
      bound = texture;
    }),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(),
    texParameteri: vi.fn((_target: number, parameter: number, value: number) => {
      const textureFilters = filters.get(bound) ?? new Map<number, number>();
      textureFilters.set(parameter, value);
      filters.set(bound, textureFilters);
    }),
    bindFramebuffer: vi.fn(),
    framebufferTexture2D: vi.fn(),
    framebufferRenderbuffer: vi.fn(),
    bindRenderbuffer: vi.fn(),
    renderbufferStorage: vi.fn(),
    drawBuffers: vi.fn(),
    checkFramebufferStatus: () => (++checks === failAt ? 0 : 1),
  };
  return { gl: gl as unknown as GL, allocated, released, filters };
}

it('smooths only foliage light, keeping packed glyph and picking metadata exact', () => {
  const { gl, filters } = context();
  const targets = createCellTargets(gl, 12, 8, 6, 4);
  for (const parameter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) {
    expect(filters.get(targets.foliageLightTex)?.get(parameter)).toBe(gl.LINEAR);
    for (const texture of [targets.glyphTex, targets.selectTex, targets.idTex, targets.attrTex])
      expect(filters.get(texture)?.get(parameter)).toBe(gl.NEAREST);
  }
  deleteCellTargets(gl, targets);
});

it.each([1, 2, 3, 4, 5, 6])(
  'releases partial raster and glyph targets if framebuffer %i fails',
  (failAt) => {
    const { gl, allocated, released } = context(failAt);
    expect(() => createCellTargets(gl, 12, 8, 6, 4)).toThrow(/framebuffer incomplete/);
    expect(released).toEqual(allocated);
  },
);

it('keeps selection input distinct from its destination and releases both across resize', () => {
  const { gl, allocated, released } = context();
  const first = createCellTargets(gl, 12, 8, 6, 4);
  const resized = createCellTargets(gl, 24, 16, 12, 8);
  expect(new Set([first.selectTex, first.glyphTex, first.foliageLightTex]).size).toBe(3);
  expect(first.selectFbo).not.toBe(first.glyphFbo);
  expect(resized.selectTex).not.toBe(first.selectTex);
  deleteCellTargets(gl, first);
  expect(released.has(resized.selectTex)).toBe(false);
  deleteCellTargets(gl, resized);
  expect(released).toEqual(allocated);
});

it.each([1, 4, 5, 21, 22, 24, 30])('rolls back when GPU allocation %i returns null', (nullAt) => {
  const { gl, allocated, released } = context(0, nullAt);
  expect(() => createCellTargets(gl, 12, 8, 6, 4)).toThrow(
    /graphics (texture|resources) unavailable/,
  );
  expect(released).toEqual(allocated);
});
