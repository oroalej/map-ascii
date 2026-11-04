import { uprightStreetAngle } from './label-layout';
import { describe, expect, it } from 'vitest';
import { createOverlay, placeLabels, rotatedLabelVertices, resetOverlay } from './labels';
import { CROWN_LIGHT, crownLight } from './glyphs/select';
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

it('lights a rounded tree crown through its interior, with a shaded far side', () => {
  const sun: [number, number, number] = [-1, 0, 1];
  expect(crownLight(-0.5, 0, sun)).toBeGreaterThan(crownLight(0.5, 0, sun));
  expect(crownLight(0, 0, sun)).toBeGreaterThan(crownLight(0.95, 0, sun));
  expect(crownLight(0.5, 0, [1, 0, 1])).toBeCloseTo(crownLight(-0.5, 0, sun));
});

it('lights a crown by its masses, dark in the crevices, and never above the map', () => {
  const sun: [number, number, number] = [-1, 0, 1];
  // A mass's top against the rim it overlaps.
  expect(crownLight(0, 0, sun, 3) / crownLight(0.98, 0, sun, 3)).toBeGreaterThan(1.4);
  // Lower tiers are darker at the same place on their mass.
  for (const tier of [1, 2, 3])
    expect(crownLight(0, 0, sun, tier)).toBeGreaterThan(crownLight(0, 0, sun, tier - 1));
  // Trees differ a little, in brightness and not in hue.
  expect(crownLight(0, 0, sun, 2, 0)).toBeLessThan(crownLight(0, 0, sun, 2, 2));
  for (let x = -1; x <= 1; x += 0.1)
    for (let y = -1; y <= 1; y += 0.1)
      for (const s of [sun, [1, 0, 1], [0, 0, 1], [0, 1, 0.1]])
        for (const tier of [0, 1, 2, 3])
          for (const tint of [0, 1, 2]) {
            const light = crownLight(x, y, s, tier, tint);
            expect(light).toBeLessThanOrEqual(CROWN_LIGHT.max);
            expect(light).toBeGreaterThan(0.1);
          }
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
