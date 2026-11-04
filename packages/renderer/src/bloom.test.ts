import { describe, expect, it, vi } from 'vitest';
import {
  BLOOM,
  bloomAddFragment,
  bloomBlurFragment,
  bloomCompositePass,
  bloomExtractFragment,
  bloomExtractPass,
  bloomPrograms,
  bloomRadiusCells,
  bloomStrength,
  createBloomTarget,
  releaseBloom,
  sparkViewport,
} from './bloom';
import type { GL } from './gpu';
import type { Programs } from './gpu-context';
import type { FrameLighting, Grid, View } from './passes';
import { glyphFragmentFor } from './shaders/glyph';
import { selectFragment } from './shaders/select';
import { TIERS } from './quality';
import type * as twgl from 'twgl.js';

describe('bloomStrength', () => {
  it('is zero by day, so no pass or allocation runs', () => {
    expect(bloomStrength(1, 1, 0, false)).toBe(0);
    expect(bloomStrength(0.75, 1, 0, false)).toBe(0);
  });
  it('fades in with the lamps and reaches full strength in the dark', () => {
    const dusk = bloomStrength(0.5, 1, 0, false);
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(BLOOM.strength);
    expect(bloomStrength(0, 1, 0, false)).toBe(BLOOM.strength);
  });
  it('needs lamps in view, or fireworks to light', () => {
    expect(bloomStrength(0, 0, 0, false)).toBe(0);
    expect(bloomStrength(0, 0, 0, true)).toBe(BLOOM.strength);
  });
  it('rises a little in rain', () => {
    expect(bloomStrength(0, 1, 1, false)).toBeCloseTo(BLOOM.strength * (1 + BLOOM.rain));
    expect(bloomStrength(0, 1, 5, false)).toBeCloseTo(BLOOM.strength * (1 + BLOOM.rain));
  });
});

const camera = { lng: 123.18, lat: 13.62, zoom: 18 };
describe('bloomRadiusCells', () => {
  it('holds a ground distance, and is rounder than the cells are', () => {
    const [x, y] = bloomRadiusCells({ camera, cellDev: { w: 5, h: 9 }, dpr: 1 });
    expect(x).toBeGreaterThan(BLOOM.minCells);
    expect(x).toBeLessThanOrEqual(BLOOM.maxCells);
    expect(y * 9).toBeCloseTo(x * 5);
  });
  it('stays within what the blur can draw at either end of the zoom range', () => {
    const near = bloomRadiusCells({
      camera: { ...camera, zoom: 21 },
      cellDev: { w: 5, h: 9 },
      dpr: 1,
    });
    expect(near[0]).toBe(BLOOM.maxCells);
    const far = bloomRadiusCells({
      camera: { ...camera, zoom: 12 },
      cellDev: { w: 7, h: 13 },
      dpr: 1,
    });
    expect(far[0]).toBe(BLOOM.minCells);
    expect(far[1]).toBeGreaterThanOrEqual(1);
  });
  it('follows the cell size, not the pixel ratio', () => {
    const one = bloomRadiusCells({ camera, cellDev: { w: 5, h: 9 }, dpr: 1 });
    const two = bloomRadiusCells({ camera, cellDev: { w: 10, h: 18 }, dpr: 2 });
    expect(two[0]).toBeCloseTo(one[0]);
  });
});

it('runs only on the two top quality tiers', () => {
  expect(TIERS.map((tier) => [tier.name, tier.knobs.bloom])).toEqual([
    ['high', true],
    ['crowd', true],
    ['effects', false],
    ['pixels', false],
  ]);
});

it('keeps the big shaders untouched and its own small', () => {
  for (const source of [selectFragment, glyphFragmentFor()]) {
    expect(source).not.toContain('u_bloom');
    expect(source).not.toContain('u_strength');
  }
  expect(bloomBlurFragment.length).toBeLessThan(1500);
  expect(bloomAddFragment.length).toBeLessThan(1000);
  expect(bloomExtractFragment.length).toBeLessThan(5000);
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
  BLEND: 16,
  ONE: 17,
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
  enable: vi.fn(),
  disable: vi.fn(),
  blendFunc: vi.fn(),
});
const program = (): twgl.ProgramInfo =>
  ({ program: {}, uniformSetters: {} }) as unknown as twgl.ProgramInfo;
const programs = { emptyVao: {} } as unknown as Programs;
const linked = { extract: program(), blur: program(), add: program() };
const view = {
  camera,
  width: 800,
  height: 600,
  dpr: 1,
  cellDev: { w: 5, h: 9 },
  labelDev: { w: 10, h: 18 },
} as unknown as View;
const grid: Grid = { originCol: 3, originRow: 4, shiftX: 50, shiftY: 90 };

describe('the passes', () => {
  it('stays off until all three programs have linked', () => {
    expect(bloomPrograms(spies() as unknown as GL, {} as Programs)).toBeUndefined();
  });

  it('allocates two cell-resolution layers and releases them', () => {
    const spy = spies();
    const context = spy as unknown as GL;
    const target = createBloomTarget(context, 200, 100);
    expect(spy.texImage2D.mock.calls.map((call) => [call[3], call[4]])).toEqual([
      [200, 100],
      [200, 100],
    ]);
    releaseBloom(context, target);
    expect(spy.deleteTexture).toHaveBeenCalledTimes(2);
    expect(spy.deleteFramebuffer).toHaveBeenCalledTimes(2);
  });

  it('extracts at cell resolution into the lit layer', () => {
    const spy = spies();
    const context = spy as unknown as GL;
    const target = createBloomTarget(context, 200, 100);
    spy.bindFramebuffer.mockClear();
    bloomExtractPass(context, programs, linked, target, {}, {} as FrameLighting, 1);
    expect(spy.bindFramebuffer).toHaveBeenCalledExactlyOnceWith(1, target.lit.framebuffer);
    expect(spy.viewport).toHaveBeenCalledWith(0, 0, 200, 100);
    expect(spy.drawArrays).toHaveBeenCalledOnce();
  });

  it('blurs both ways, adds to the canvas, and leaves blending off', () => {
    const spy = spies();
    const context = spy as unknown as GL;
    const target = createBloomTarget(context, 200, 100);
    spy.bindFramebuffer.mockClear();
    bloomCompositePass(context, programs, linked, target, view, grid, 0.8);
    expect(spy.bindFramebuffer.mock.calls.map((call) => call[1])).toEqual([
      target.blurred.framebuffer,
      target.lit.framebuffer,
      null,
    ]);
    expect(spy.drawArrays).toHaveBeenCalledTimes(3);
    expect(spy.enable).toHaveBeenCalledExactlyOnceWith(16);
    expect(spy.blendFunc).toHaveBeenCalledWith(17, 17);
    expect(spy.disable).toHaveBeenCalledExactlyOnceWith(16);
    expect(spy.viewport).toHaveBeenLastCalledWith(0, 0, 800, 600);
  });

  it('places the sparks where the canvas falls on the bottom-up target', () => {
    // 50 / 5 cells in, 90 / 9 down from the top, and the screen's own size in cells.
    expect(sparkViewport({ rows: 100 }, view, grid)).toEqual([10, 100 - 10 - 67, 160, 67]);
  });
});
