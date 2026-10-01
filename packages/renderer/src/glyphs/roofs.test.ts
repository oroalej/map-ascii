import { expect, it } from 'vitest';
import { RoofCode, roofLineAngle, roofSlopeVariant, roofSurfaceCode } from './roofs';
import { roofSurface, RoofShape } from '../raster/roofs';

it('lights actual slope normals and keeps a parallel or zero sun on the height ramp', () => {
  expect(roofSlopeVariant(RoofCode.sidePos, 0, [0, 1])).toBe(2);
  expect(roofSlopeVariant(RoofCode.sideNeg, 0, [0, 1])).toBe(1);
  expect(roofSlopeVariant(RoofCode.sidePos, 0, [0, -1])).toBe(1);
  expect(roofSlopeVariant(RoofCode.sideNeg, 0, [0, -1])).toBe(2);
  expect(roofSlopeVariant(RoofCode.sidePos, 0, [1, 0])).toBeNull();
  expect(roofSlopeVariant(RoofCode.endPos, 0, [1, 0])).toBe(2);
  expect(roofSlopeVariant(RoofCode.endNeg, 0, [1, 0])).toBe(1);
  expect(roofSlopeVariant(RoofCode.sidePos, 0, [0, 0])).toBeNull();
  expect(roofSlopeVariant(RoofCode.ridge, 0, [0, 1])).toBeNull();
});
it('gives a 10 by 6 hip a four-meter ridge, four hips and two end slopes', () => {
  const at = (x: number, y: number) =>
    roofSurfaceCode(roofSurface({ x, y }, { x: 0, y: 0 }, 0, 5, 3, RoofShape.hipped), 0.1, 0.1);
  expect(at(1.9, 0)).toBe(RoofCode.ridge);
  expect(at(2.2, 0)).toBe(RoofCode.endPos);
  expect(at(-3, 0)).toBe(RoofCode.endNeg);
  expect(at(3, 1)).toBe(RoofCode.hipPos);
  expect(at(-3, -1)).toBe(RoofCode.hipPos);
  expect(at(3, -1)).toBe(RoofCode.hipNeg);
  expect(at(-3, 1)).toBe(RoofCode.hipNeg);
});
it('gables have no ends and rectangular pyramids reach every corner with no ridge', () => {
  expect(roofSurfaceCode([4.9, 0, 5, 0], 0.1, 0.1)).toBe(RoofCode.ridge);
  for (const x of [-5, 5])
    for (const y of [-3, 3]) {
      const sample = roofSurface({ x, y }, { x: 0, y: 0 }, 0, 5, 3, RoofShape.pyramidal);
      const code = roofSurfaceCode(sample, 0.01, 0.01);
      expect([RoofCode.hipPos, RoofCode.hipNeg]).toContain(code);
      const degrees = (roofLineAngle(code, 0, sample[3]) / 255) * 180;
      expect(Math.min(degrees, 180 - degrees)).toBeCloseTo((Math.atan(3 / 5) * 180) / Math.PI, 0);
    }
  expect(roofSurfaceCode([0, 0, 0, 0.6], 1, 1)).not.toBe(RoofCode.ridge);
  expect(roofSurfaceCode([0, 0, 0, 1], 1, 1)).not.toBe(RoofCode.ridge);
});
it('folds both hip directions at the byte wrap without negative glyph bins', () => {
  for (const angle of [0, 127, 255])
    for (const code of [RoofCode.hipPos, RoofCode.hipNeg]) {
      const byte = roofLineAngle(code, angle, 1);
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThanOrEqual(255);
    }
});
