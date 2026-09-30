import { describe, expect, it } from 'vitest';
import { classDepths, classId } from './classes';
import { buildGlyphTables, plantingCell, PLANTING, wallStyle } from './glyphs/select';
import { themes } from './theme';

describe('raised garden rendering', () => {
  it('outlines sub-meter stone seating without treating it as a roof', () => {
    expect(wallStyle('seating', false, 0.45, 18)).toBe('single');
    expect(wallStyle('seating', false, 0, 18)).toBe('single');
    expect(wallStyle('seating', false, 0, 17.9)).toBeNull();
    expect(wallStyle('building', false, 0, 21)).toBeNull();
    const depth = classDepths();
    expect(depth[classId('seating')]).toBeLessThan(depth[classId('planting')]!);
    expect(depth[classId('shrubs')]).toBeLessThan(depth[classId('planting')]!);
  });

  it('retains broad bare soil patches during wind instead of growing grass everywhere', () => {
    let soil = 0,
      green = 0;
    for (let x = -35; x < 35; x++)
      for (let y = -35; y < 35; y++) {
        const still = plantingCell(x, y, 0);
        if (still.variant === PLANTING.bareGlyph) {
          soil++;
          expect(plantingCell(x, y, 1)).toEqual(still);
        } else green++;
      }
    expect(soil).toBeGreaterThan(1000);
    expect(green).toBeGreaterThan(1000);
  });

  it.each(['dark', 'light'] as const)('keeps soil and green pigments separate in %s', (name) => {
    const tables = buildGlyphTables(themes[name], () => 0);
    const pigment = (values: Float32Array, cls: string) =>
      Array.from(values.slice(classId(cls) * 3, classId(cls) * 3 + 3));
    expect(pigment(tables.fillColors, 'planting')).not.toEqual(pigment(tables.colors, 'planting'));
    expect(pigment(tables.fillColors, 'seating')).toEqual(pigment(tables.colors, 'seating'));
    expect(pigment(tables.fillColors, 'building')).toEqual(pigment(tables.colors, 'building'));
  });
});
