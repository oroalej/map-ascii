import { describe, expect, it } from 'vitest';
import {
  createOverlay,
  placeLabels,
  rotatedLabelVertices,
  uprightStreetAngle,
  resetOverlay,
} from './labels';
import { crownShade, crownClumps } from './glyphs/select';
import { legendEntries } from './legend';

describe('rotated street names', () => {
  const candidate = {
    id: 1,
    text: 'General Luna Street',
    rank: 4,
    col: 30,
    row: 15,
    mode: 'rotated' as const,
    angle: Math.PI / 2,
    runCells: 30,
  };
  it('rotates whole glyphs, rather than stacking upright letters', () => {
    const overlay = createOverlay(60, 30);
    expect(placeLabels(overlay, [candidate], () => 2)).toHaveLength(1);
    expect(overlay.rotated).toHaveLength(1);
    expect(overlay.glyphs.every((c) => c === 0)).toBe(true);
    const vertices = rotatedLabelVertices(overlay.rotated, 10, 18);
    expect(vertices.length).toBeGreaterThan(0);
    const quad = vertices.slice(60, 90); // first glyph after padding and its halo
    expect(Math.abs(quad[0]! - quad[10]!)).toBeCloseTo(18); // rotated height spans screen x
    expect(quad[1]).toBeCloseTo(quad[11]!);
    expect(Math.abs(quad[6]! - quad[1]!)).toBeCloseTo(10); // baseline now runs along screen y
  });
  it('normalizes road directions to readable angles', () => {
    for (const a of [-7, -Math.PI, -Math.PI / 2, 0, 2, Math.PI, 7]) {
      const b = uprightStreetAngle(a);
      expect(b).toBeGreaterThanOrEqual(-Math.PI / 2);
      expect(b).toBeLessThan(Math.PI / 2);
      expect(Math.abs(Math.sin(a - b))).toBeLessThan(1e-12);
    }
  });
  it('falls back to horizontal text on short runs and respects label collisions', () => {
    const overlay = createOverlay(60, 30);
    placeLabels(overlay, [{ ...candidate, runCells: 5 }], () => 2);
    expect(overlay.rotated).toHaveLength(0);
    expect(overlay.glyphs.some((c) => c > 1)).toBe(true);
    resetOverlay(overlay);
    const placed = placeLabels(
      overlay,
      [candidate, { ...candidate, id: 2, text: 'A competing road' }],
      () => 2,
    );
    expect(overlay.rotated).toHaveLength(1);
    expect(placed[0]!.id).toBe(1);
  });
  it('clears rotated quads on reuse and dissolves glyphs deterministically', () => {
    const overlay = createOverlay(60, 30);
    placeLabels(overlay, [{ ...candidate, vis: 0.4 }], () => 2);
    const a = rotatedLabelVertices(overlay.rotated, 10, 18);
    expect(a).toEqual(rotatedLabelVertices(overlay.rotated, 10, 18));
    expect(a.length).toBeLessThan(
      rotatedLabelVertices([{ ...overlay.rotated[0]!, vis: 1 }], 10, 18).length,
    );
    resetOverlay(overlay);
    expect(overlay.rotated).toHaveLength(0);
  });
});

it('keeps crown illumination smooth within each seeded clump', () => {
  const shade = (x: number) => crownShade(x, 0, crownClumps(x, 0, 42), [0, 0, 1]).light;
  expect(Math.abs(shade(0.001) - shade(0))).toBeLessThan(0.01);
});

it('shows solid boat hulls and outriggers in the legend in both themes', () => {
  for (const theme of ['dark', 'light'] as const) {
    const boats = legendEntries(theme, 18, undefined, { life: true }).find((e) =>
      e.classes.includes('life_boat'),
    )!;
    expect(boats.icons).toHaveLength(2);
    for (const icon of boats.icons!) {
      expect(icon.pixels.join('')).toMatch(/^[#o.]+$/);
      expect(new Set(icon.pixels.map((r) => r.length)).size).toBe(1);
      expect(icon.pixels.join('')).toContain('#');
    }
  }
});
