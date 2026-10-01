import { describe, expect, it } from 'vitest';
import { BUNTING_MOTION, buntingMotion, buntingWindResponse } from './bunting-motion';
import { WIND_PRESETS, windAt, type WindNow } from './wind';
import { drawProcedural } from '../glyphs/atlas';
import { SEASONAL_GLYPHS } from './seasonal-glyphs';

describe('bunting motion', () => {
  it('holds the entire Calm range still and smoothly increases through stronger winds', () => {
    for (let time = 0; time <= 600; time += 0.7)
      expect(buntingWindResponse(windAt(time, { from: 225, strength: 'calm' }).strength)).toBe(0);
    for (const strength of [-1, 0, NaN, Infinity]) expect(buntingWindResponse(strength)).toBe(0);
    const values = [0.325, 0.33, 0.4, 0.49, 0.7, 1, 1.5, 1.95].map((s) => buntingWindResponse(s));
    expect(values[0]).toBe(0);
    expect(values[1]).toBeGreaterThan(0);
    expect(values[1]).toBeLessThan(0.001);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(values.at(-1)).toBe(1);
    for (const strength of Object.values(WIND_PRESETS))
      expect(buntingWindResponse(strength, true)).toBe(0);
  });

  it('fixes the attachment and bounds free-edge displacement and folds for every wind direction', () => {
    for (const direction of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [Math.SQRT1_2, Math.SQRT1_2],
    ] as WindNow['dir'][])
      for (let seed = 0; seed < 32; seed++)
        for (let time = 0; time < 3; time += 0.17) {
          for (const uv of [
            [0.08, 0.22],
            [0.92, 0.25],
          ] as [number, number][])
            expect(buntingMotion([12345, -6789], seed, uv, time, 1, direction)).toEqual({
              source: uv,
              fold: 1,
            });
          const uv = [0.5, BUNTING_MOTION.freeEdge] as const;
          const motion = buntingMotion([12345, -6789], seed, uv, time, 1, direction);
          expect(Math.abs(motion.source[0] - uv[0])).toBeLessThanOrEqual(BUNTING_MOTION.maxX);
          expect(Math.abs(motion.source[1] - uv[1])).toBeLessThanOrEqual(BUNTING_MOTION.maxY);
          expect(motion.fold).toBeGreaterThanOrEqual(1 - BUNTING_MOTION.fold);
          expect(motion.fold).toBeLessThanOrEqual(1);
        }
  });

  it('uses deterministic per-flag waves and preserves their phase when viewport origin changes', () => {
    const uv = [0.5, 0.85] as const;
    const at = (origin: [number, number], cell: [number, number]) =>
      buntingMotion([origin[0] + cell[0], origin[1] + cell[1]], 7, uv, 1.2, 0.7, [1, 0]);
    expect(at([1000, 2000], [50, 30])).toEqual(at([1040, 2010], [10, 20]));
    expect(at([1000, 2000], [50, 30])).toEqual(at([1000, 2000], [50, 30]));
    expect(at([1000, 2000], [50, 30])).not.toEqual(at([1000, 2000], [51, 30]));
    expect(buntingMotion([1050, 2030], 8, uv, 1.2, 0.7, [1, 0])).not.toEqual(
      at([1000, 2000], [50, 30]),
    );
    const still = buntingMotion([1050, 2030], 7, uv, 10, 0, [1, 0]);
    expect(still).toEqual(buntingMotion([1050, 2030], 7, uv, 100, 0, [1, 0]));
    expect(still).toEqual({ source: [...uv], fold: 1 });
  });

  it('changes both pennant and rectangle coverage while their attachment pixels remain unchanged', () => {
    const w = 5,
      h = 9;
    for (const glyph of SEASONAL_GLYPHS.slice(1)) {
      const data = new Uint8Array(w * h);
      expect(drawProcedural({ data, stride: w, x0: 0, y0: 0, w, h }, glyph)).toBe(true);
      const texel = (x: number, y: number) =>
        x < 0 || x >= w || y < 0 || y >= h ? 0 : data[y * w + x]!;
      const frame = (time: number) =>
        Array.from(data, (_, i) => {
          const x = i % w,
            y = Math.floor(i / w);
          const uv = [(x + 0.5) / w, (y + 0.5) / h] as const;
          const { source } = buntingMotion([1050, 2030], 7, uv, time, 1, [1, 0]);
          const px = source[0] * w - 0.5,
            py = source[1] * h - 0.5;
          const bx = Math.floor(px),
            by = Math.floor(py),
            fx = px - bx,
            fy = py - by;
          return (
            (texel(bx, by) * (1 - fx) + texel(bx + 1, by) * fx) * (1 - fy) +
            (texel(bx, by + 1) * (1 - fx) + texel(bx + 1, by + 1) * fx) * fy
          );
        });
      const a = frame(0),
        b = frame(0.3);
      expect(a, glyph).not.toEqual(b);
      for (let i = 0; i < w * Math.floor(h * BUNTING_MOTION.anchor); i++) {
        expect(a[i], glyph).toBe(data[i]);
        expect(b[i], glyph).toBe(data[i]);
      }
    }
  });
});
