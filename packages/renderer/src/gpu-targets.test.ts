import { expect, it, vi } from 'vitest';
import { createCellTargets, deleteCellTargets, type GL } from './gpu';

function context(failAt = 0, nullAt = 0) {
  const allocated = new Set<object>(),
    released = new Set<object>();
  let checks = 0,
    allocations = 0;
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
    createTexture: vi.fn(make),
    createFramebuffer: vi.fn(make),
    createRenderbuffer: vi.fn(make),
    deleteTexture: vi.fn(drop),
    deleteFramebuffer: vi.fn(drop),
    deleteRenderbuffer: vi.fn(drop),
    bindTexture: vi.fn(),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(),
    texParameteri: vi.fn(),
    bindFramebuffer: vi.fn(),
    framebufferTexture2D: vi.fn(),
    framebufferRenderbuffer: vi.fn(),
    bindRenderbuffer: vi.fn(),
    renderbufferStorage: vi.fn(),
    drawBuffers: vi.fn(),
    checkFramebufferStatus: () => (++checks === failAt ? 0 : 1),
  };
  return { gl: gl as unknown as GL, allocated, released };
}

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
  expect(first.selectTex).not.toBe(first.glyphTex);
  expect(first.selectFbo).not.toBe(first.glyphFbo);
  expect(resized.selectTex).not.toBe(first.selectTex);
  deleteCellTargets(gl, first);
  expect(released.has(resized.selectTex)).toBe(false);
  deleteCellTargets(gl, resized);
  expect(released).toEqual(allocated);
});

it.each([1, 4, 5, 21, 22, 29])('rolls back when GPU allocation %i returns null', (nullAt) => {
  const { gl, allocated, released } = context(0, nullAt);
  expect(() => createCellTargets(gl, 12, 8, 6, 4)).toThrow(
    /graphics (texture|resources) unavailable/,
  );
  expect(released).toEqual(allocated);
});
