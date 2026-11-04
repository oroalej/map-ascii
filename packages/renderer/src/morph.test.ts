import { describe, expect, it, vi } from 'vitest';
import { project } from './camera';
import type { GL } from './gpu';
import type { Programs } from './gpu-context';
import type { Grid, View } from './passes';
import {
  createMorphSnapshot,
  MORPH_MS,
  morphFragment,
  morphMapping,
  morphPass,
  morphProgress,
  releaseMorph,
} from './morph';
import type * as twgl from 'twgl.js';

const size = { width: 800, height: 600 };
const camera = { lng: 123.18, lat: 13.62, zoom: 16.5 };

describe('morphMapping', () => {
  it('is the identity for an unmoved camera, at any pixel ratio', () => {
    for (const dpr of [1, 2]) {
      const { scale, offset } = morphMapping(camera, camera, size, dpr);
      expect(scale).toBe(1);
      expect(offset[0]).toBeCloseTo(0, 6);
      expect(offset[1]).toBeCloseTo(0, 6);
    }
  });

  it('keeps the center fixed and shrinks the sampled area when zooming in', () => {
    const closer = { ...camera, zoom: camera.zoom + 1 };
    const { scale, offset } = morphMapping(camera, closer, size, 1);
    expect(scale).toBe(0.5);
    expect(400 * scale + offset[0]).toBeCloseTo(400, 6);
    expect(300 * scale + offset[1]).toBeCloseTo(300, 6);
    // A pixel at the corner comes from halfway to the old corner.
    expect(0 * scale + offset[0]).toBeCloseTo(200, 6);
  });

  it('samples outside the snapshot when zooming out', () => {
    const farther = { ...camera, zoom: camera.zoom - 1 };
    const { scale, offset } = morphMapping(camera, farther, size, 1);
    expect(scale).toBe(2);
    expect(0 * scale + offset[0]).toBeCloseTo(-400, 6);
    expect(800 * scale + offset[0]).toBeCloseTo(1200, 6);
  });

  it('follows a pan, in device pixels', () => {
    const [x, y] = project(camera.lng, camera.lat, camera.zoom);
    const east = { ...camera, lng: camera.lng + 0.001 };
    const [panned] = project(east.lng, east.lat, east.zoom);
    expect(panned).toBeGreaterThan(x);
    const { scale, offset } = morphMapping(camera, east, size, 2);
    expect(scale).toBe(1);
    expect(offset[0]).toBeCloseTo((panned - x) * 2, 6);
    expect(offset[1]).toBeCloseTo((project(east.lng, east.lat, east.zoom)[1] - y) * 2, 6);
  });
});

const spies = () => ({
  FRAMEBUFFER: 1,
  COLOR_ATTACHMENT0: 2,
  TEXTURE_2D: 3,
  RGBA8: 4,
  RGBA: 5,
  UNSIGNED_BYTE: 6,
  TEXTURE_MIN_FILTER: 7,
  TEXTURE_MAG_FILTER: 8,
  LINEAR: 9,
  NEAREST: 10,
  TEXTURE_WRAP_S: 11,
  TEXTURE_WRAP_T: 12,
  CLAMP_TO_EDGE: 13,
  UNPACK_ALIGNMENT: 14,
  TRIANGLES: 15,
  createTexture: vi.fn(() => ({})),
  bindTexture: vi.fn(),
  pixelStorei: vi.fn(),
  texImage2D: vi.fn<(...args: unknown[]) => void>(),
  texParameteri: vi.fn(),
  createFramebuffer: vi.fn(() => ({})),
  bindFramebuffer: vi.fn<(...args: unknown[]) => void>(),
  framebufferTexture2D: vi.fn(),
  deleteFramebuffer: vi.fn(),
  deleteTexture: vi.fn(),
  viewport: vi.fn(),
  useProgram: vi.fn(),
  bindVertexArray: vi.fn(),
  drawArrays: vi.fn(),
});

const view = (over: Partial<View> = {}) =>
  ({
    camera,
    width: 800,
    height: 600,
    dpr: 1,
    cellDev: { w: 5, h: 9 },
    labelDev: { w: 10, h: 18 },
    ...over,
  }) as unknown as View;
const grid: Grid = { originCol: 3, originRow: 4, shiftX: 1, shiftY: 2 };
const program = {
  program: {},
  uniformSetters: {},
} as unknown as twgl.ProgramInfo;
const programs = { emptyVao: {} } as unknown as Programs;

describe('the snapshot', () => {
  it('sizes its texture to the canvas and its blank overlay to the label grid, then releases both', () => {
    const spy = spies();
    const context = spy as unknown as GL;
    const morph = createMorphSnapshot(context, 100, camera, 800, 600, 80, 34);
    const sizes = spy.texImage2D.mock.calls.map((call) => [call[3], call[4]]);
    expect(sizes).toEqual([
      [800, 600],
      [80, 34],
    ]);
    expect(spy.framebufferTexture2D).toHaveBeenCalledWith(1, 2, 3, morph.texture, 0);
    releaseMorph(context, morph);
    expect(spy.deleteTexture).toHaveBeenCalledTimes(2);
    expect(spy.deleteFramebuffer).toHaveBeenCalledOnce();
  });

  it('runs for MORPH_MS, then reports it has gone without drawing', () => {
    const spy = spies();
    const context = spy as unknown as GL;
    const morph = createMorphSnapshot(context, 100, camera, 800, 600, 80, 34);
    const overlay = {} as WebGLTexture;
    const at = (now: number) =>
      morphPass(context, programs, program, morph, overlay, view(), grid, grid, now);
    expect(morphProgress(morph, 100)).toBe(0);
    expect(morphProgress(morph, 100 + MORPH_MS / 2)).toBe(0.5);
    expect(at(100)).toBe(true);
    expect(at(100 + MORPH_MS - 1)).toBe(true);
    expect(spy.drawArrays).toHaveBeenCalledTimes(2);
    expect(at(100 + MORPH_MS)).toBe(false);
    expect(spy.drawArrays).toHaveBeenCalledTimes(2);
  });

  it('gives up when the canvas changed size', () => {
    const spy = spies();
    const context = spy as unknown as GL;
    const morph = createMorphSnapshot(context, 0, camera, 800, 600, 80, 34);
    const overlay = {} as WebGLTexture;
    expect(
      morphPass(context, programs, program, morph, overlay, view({ width: 900 }), grid, grid, 1),
    ).toBe(false);
    expect(spy.drawArrays).not.toHaveBeenCalled();
  });

  it('keeps labels out of the dissolve and goes out in the world-anchored cell order', () => {
    expect(morphFragment).toContain('u_overlay');
    expect(morphFragment).toContain('cellHash(u_origin + cell)');
    expect(morphFragment.length).toBeLessThan(2000);
  });
});
