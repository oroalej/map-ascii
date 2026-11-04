import { describe, expect, it } from 'vitest';
import { unpackGlyph } from '../glyphs/select';
import { glyphFragmentFor } from '../shaders/glyph';
import { sextantGlyphs } from '../theme';
import {
  FIXTURE_SHADOW,
  fixtureShadowKey,
  FixturePart,
  packFixtures,
  type FixtureGrid,
  type StreetFixture,
} from './fixtures';
import { LampState } from './lights';

const grid: FixtureGrid = {
  cols: 100,
  rows: 100,
  cellWidth: 5,
  cellHeight: 9,
  // One cell a meter: a degree of latitude is 111320 cells, and east about the same here.
  toCell: (lng, lat) => [50 + lng * 111_320, 50 - lat * 111_320],
};
const glyphIndex = (g: string) => g.charCodeAt(0) % 900 || 1;
const at = (x: number, y: number): [number, number] => [(x - 50) / 111_320, (50 - y) / 111_320];

const lamp: StreetFixture = {
  kind: 'streetlight',
  base: at(50.5, 50.5),
  tip: at(53.5, 50.5),
  forward: at(51.5, 50.5),
  right: at(50.5, 51.5),
  roadCenter: at(55.5, 50.5),
  state: LampState.flicker,
  seed: 1,
};

function pack(
  sun: { azimuth: number; altitude: number } | undefined,
  zoom = 20,
  fixtures = [lamp],
) {
  const out = new Uint8Array(100 * 100 * 4);
  packFixtures(
    out,
    grid,
    fixtures,
    zoom,
    glyphIndex,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    sun && { sun, sextants: sextantGlyphs },
  );
  const shadow: [number, number][] = [];
  for (let i = 0; i < 100 * 100; i++)
    if (out[i * 4 + 3] && unpackGlyph(out[i * 4]!, out[i * 4 + 1]!).cls === FixturePart.shadow)
      shadow.push([i % 100, Math.floor(i / 100)]);
  return { out, shadow };
}

describe('fixture shadows', () => {
  it('runs away from the sun, as long as its height says', () => {
    const west = pack({ azimuth: 90, altitude: 45 }).shadow;
    expect(west.length).toBeGreaterThan(0);
    expect(Math.max(...west.map((c) => c[0]))).toBeLessThanOrEqual(50);
    expect(Math.min(...west.map((c) => c[0]))).toBe(
      Math.floor(50.5 - FIXTURE_SHADOW.height.streetlight),
    );
    const north = pack({ azimuth: 180, altitude: 45 }).shadow;
    expect(Math.max(...north.map((c) => c[1]))).toBeLessThanOrEqual(50);
    const long = pack({ azimuth: 90, altitude: 3 }).shadow;
    expect(Math.min(...long.map((c) => c[0]))).toBe(Math.floor(50.5 - FIXTURE_SHADOW.reach));
  });

  it('is absent at night, below its zoom, or with shadows off', () => {
    expect(pack({ azimuth: 90, altitude: -2 }).shadow).toEqual([]);
    expect(pack({ azimuth: 90, altitude: 45 }, FIXTURE_SHADOW.minZoom - 0.5).shadow).toEqual([]);
    expect(pack(undefined).shadow).toEqual([]);
  });

  it('never covers hardware', () => {
    const plain = pack(undefined);
    const shaded = pack({ azimuth: 270, altitude: 30 });
    for (let i = 0; i < plain.out.length; i += 4)
      if (plain.out[i + 3])
        expect(shaded.out.subarray(i, i + 4)).toEqual(plain.out.subarray(i, i + 4));
  });

  it('joins crossing shadows into a single cell', () => {
    const other: StreetFixture = { ...lamp, base: at(50.5, 50.4), seed: 2 };
    const { shadow, out } = pack({ azimuth: 90, altitude: 45 }, 20, [lamp, other]);
    expect(new Set(shadow.map((c) => c.join())).size).toBe(shadow.length);
    expect(out.length).toBeGreaterThan(0);
  });

  it('repacks on a 2° step of the sun, not on every frame', () => {
    const key = (azimuth: number, altitude: number) => fixtureShadowKey({ azimuth, altitude }, 20);
    expect(key(90, 45)).toBe(key(90.4, 45.4));
    expect(key(90, 45)).not.toBe(key(94, 45));
    expect(key(90, 45)).not.toBe(key(90, 49));
    expect(fixtureShadowKey({ azimuth: 90, altitude: 45 }, 18)).toBe('');
    expect(fixtureShadowKey({ azimuth: 90, altitude: -1 }, 20)).toBe('');
    expect(fixtureShadowKey(null, 20)).toBe('');
  });

  it('darkens in the shader, drawing no ink', () => {
    expect(FixturePart.shadow).toBeLessThan(64);
    const parts = Object.entries(FixturePart).filter(([, value]) => value === FixturePart.shadow);
    expect(parts).toHaveLength(1);
    expect(glyphFragmentFor()).toContain(`part == ${FixturePart.shadow}`);
    expect(glyphFragmentFor({ seasonal: false })).toContain(`part == ${FixturePart.shadow}`);
  });
});
