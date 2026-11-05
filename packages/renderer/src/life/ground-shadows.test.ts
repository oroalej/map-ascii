import { describe, expect, it } from 'vitest';
import { glyphFragmentFor } from '../shaders/glyph';
import { unpackGlyph } from '../glyphs/select';
import { sextantGlyphs, themes } from '../theme';
import { GROUND_SHADOW, LIFE_GROUND_SHADOW, LIFE_SHADOW } from './config';
import { PackingOutcome } from './diagnostics';
import { buildLifeGlyphs, packLife, type LifeGrid } from './draw';
import { shadowLength } from './ground-shadows';
import { createLifeParts, PartsFlag } from './parts-layer';
import { personGlyphs } from './people';
import type { VisibleAgent } from './simulate';
import type { Sun } from './sun';
import { LIFE_AGENT_MASK } from './turn-signals';
import { Paint, PART_GLYPHS, VEHICLES } from './vehicles';

const glyphs = [
  ...new Set([' ', ...Object.values(PART_GLYPHS), ...sextantGlyphs, ...personGlyphs()]),
];
const glyphIndex = (g: string) => Math.max(0, glyphs.indexOf(g));
const lifeGlyphs = buildLifeGlyphs(glyphIndex);
const COLS = 80;
const ROWS = 60;
const grid: LifeGrid = {
  cols: COLS,
  rows: ROWS,
  cellWidth: 5,
  cellHeight: 9,
  toCell: (lng, lat) => [lng, lat],
};
/** Cells per meter across the screen; a meter down the screen is fewer rows, cells being tall. */
const SCALE = 3;
const down = (5 / 9) * SCALE;

const car = (x: number, y: number, extra: Partial<VisibleAgent> = {}) =>
  ({
    kind: 'vehicle',
    vehicle: 'car',
    lng: x,
    lat: y,
    paint: Paint.red,
    flap: 0,
    ahead: [x + SCALE, y],
    side: [x, y + down],
    ...extra,
  }) as VisibleAgent;

function pack(agents: VisibleAgent[], sun: Sun | null, withLayer = true) {
  const out = new Uint8Array(COLS * ROWS * 4);
  const owners = new Uint32Array(COLS * ROWS);
  const outcomes = new Uint8Array(agents.length);
  const parts = withLayer ? createLifeParts(COLS * ROWS, ROWS) : undefined;
  packLife(out, { ...grid, outcomes }, agents, themes.dark, glyphIndex, sun, lifeGlyphs, {
    owners,
    parts,
  });
  return { out, owners, outcomes, parts };
}
const shadowCells = (out: Uint8Array) => {
  const cells: [number, number][] = [];
  for (let i = 0; i < COLS * ROWS; i++)
    if (!(out[i * 4 + 2]! & LIFE_AGENT_MASK) && out[i * 4 + 3] === LIFE_GROUND_SHADOW)
      cells.push([i % COLS, Math.floor(i / COLS)]);
  return cells;
};

describe('ground shadows', () => {
  it('falls away from the sun', () => {
    const at = (azimuth: number) => {
      const cells = shadowCells(pack([car(40, 30)], { azimuth, altitude: 30 }).out);
      expect(cells.length).toBeGreaterThan(0);
      return {
        x: cells.reduce((sum, c) => sum + c[0], 0) / cells.length,
        y: cells.reduce((sum, c) => sum + c[1], 0) / cells.length,
      };
    };
    expect(at(90).x).toBeLessThan(40);
    expect(at(270).x).toBeGreaterThan(40);
    // The sun in the north throws it south, which is down the grid.
    expect(at(0).y).toBeGreaterThan(30);
    expect(at(180).y).toBeLessThan(30);
  });

  it('grows as the sun sinks, up to its reach', () => {
    const count = (altitude: number) =>
      shadowCells(pack([car(40, 30)], { azimuth: 90, altitude }).out).length;
    expect(count(20)).toBeGreaterThan(count(70));
    expect(shadowLength(1.5, 45)).toBeCloseTo(1.5);
    expect(shadowLength(3.2, 2)).toBe(GROUND_SHADOW.reach);
    // At the longest it still ends where the reach says: the car's half length plus the reach.
    const cells = shadowCells(pack([car(40, 30)], { azimuth: 90, altitude: 2 }).out);
    const furthest = Math.min(...cells.map((c) => c[0]));
    const reach = (VEHICLES.car.length / 2 + GROUND_SHADOW.reach) * SCALE;
    expect(furthest).toBeGreaterThanOrEqual(Math.floor(40 - reach));
  });

  it('is gone at night, without the sun, and without the layer', () => {
    expect(shadowCells(pack([car(40, 30)], { azimuth: 90, altitude: -3 }).out)).toEqual([]);
    expect(shadowCells(pack([car(40, 30)], null).out)).toEqual([]);
    const plain = pack([car(40, 30)], { azimuth: 90, altitude: 30 }, false);
    expect(shadowCells(plain.out)).toEqual([]);
  });

  it('leaves no shadow behind a rejected agent', () => {
    const sun = { azimuth: 90, altitude: 20 };
    const first = car(40, 30, { parked: true });
    const rejected = car(41, 30.5);
    const both = pack([first, rejected], sun);
    expect(both.outcomes[1]).toBe(PackingOutcome.collision);
    const alone = pack([first], sun);
    expect([...both.out]).toEqual([...alone.out]);
    expect([...both.parts!.texels]).toEqual([...alone.parts!.texels]);
  });

  it('notes the shadow under another agent instead of covering it', () => {
    const sun = { azimuth: 90, altitude: 20 };
    const near = car(40, 30);
    // A second car right in the first's shadow, to the west.
    const west = car(40 - (VEHICLES.car.length + 1) * SCALE, 30);
    const alone = pack([west], sun);
    const together = pack([west, near], sun);
    let flagged = 0;
    for (let cell = 0; cell < COLS * ROWS; cell++) {
      if (!(alone.out[cell * 4 + 2]! & LIFE_AGENT_MASK)) continue;
      expect(unpackGlyph(together.out[cell * 4]!, together.out[cell * 4 + 1]!).glyph).toBe(
        unpackGlyph(alone.out[cell * 4]!, alone.out[cell * 4 + 1]!).glyph,
      );
      if (together.parts!.texels[cell * 4 + 3]! & PartsFlag.shadowUnder) flagged++;
    }
    expect(flagged).toBeGreaterThan(0);
  });

  it('owns nothing, so taps and hover pass through', () => {
    const { out, owners } = pack([car(40, 30)], { azimuth: 90, altitude: 20 });
    for (const [c, r] of shadowCells(out)) expect(owners[r * COLS + c]).toBe(0);
  });

  it('starts only once a vehicle is big enough to show one', () => {
    const tiny = (x: number, y: number) => car(x, y, { ahead: [x + 1, y], side: [x, y + 5 / 9] });
    expect(shadowCells(pack([tiny(40, 30)], { azimuth: 90, altitude: 20 }).out)).toEqual([]);
  });

  it('casts large figures, never people aboard a boat', () => {
    const walker = (extra: Partial<VisibleAgent> = {}) =>
      ({
        kind: 'person',
        lng: 40,
        lat: 30,
        paint: Paint.red,
        flap: 0,
        ahead: [40 + SCALE, 30],
        ...extra,
      }) as VisibleAgent;
    const sun = { azimuth: 90, altitude: 20 };
    expect(shadowCells(pack([walker()], sun).out).length).toBeGreaterThan(0);
    expect(shadowCells(pack([walker({ aboard: true })], sun).out)).toEqual([]);
    const small = walker({ ahead: [41, 30] });
    expect(shadowCells(pack([small], sun).out)).toEqual([]);
  });

  it('keeps bird shadows and joins overlapping ground shadows into one mask', () => {
    const sun = { azimuth: 90, altitude: 20 };
    const { out } = pack([car(40, 30), car(40, 30 + 1.6 * down)], sun);
    for (const [c, r] of shadowCells(out)) {
      const glyph = unpackGlyph(out[(r * COLS + c) * 4]!, out[(r * COLS + c) * 4 + 1]!).glyph;
      expect(sextantGlyphs).toContain(glyphs[glyph]);
    }
    const shader = glyphFragmentFor();
    expect(shader).toContain(`shadowByte == ${LIFE_SHADOW}`);
  });

  it('falls only on open ground, darkening by its strength', () => {
    const shader = glyphFragmentFor();
    expect(shader).toContain('bool shadowFalls(int cls, ivec2 subAt)');
    // Not over the occluders, nor a building's height on grounds.
    expect(shader).toMatch(
      /surface == u_vehicleOccluders\.y \|\| surface == u_vehicleOccluders\.z/,
    );
    expect(shader).toContain(`1.0 - ${GROUND_SHADOW.dark} * directSun()`);
    expect(shader).toContain('else if (shadowFalls(cls, subAt))');
  });
});
