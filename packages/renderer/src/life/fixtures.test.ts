import { describe, expect, it } from 'vitest';
import { unpackGlyph } from '../glyphs/select';
import { tileToLngLat } from '../raster/geometry';
import { mapGlyphs, themes } from '../theme';
import { LifeBuilder } from './geometry';
import { lightByte, LampState } from './lights';
import {
  FixturePart,
  packFixtures,
  tileFixtures,
  updateFixtureSignals,
  type FixtureGrid,
  type StreetFixture,
} from './fixtures';
import { signalState } from './signals';
import { LifeWorld } from './simulate';

const grid: FixtureGrid = {
  cols: 100,
  rows: 100,
  cellWidth: 5,
  cellHeight: 9,
  toCell: (x, y) => [x, y],
};
const glyphs = mapGlyphs(themes.dark);
// Exercise indices above 255, as the live atlas now contains them.
const glyph = (s: string) => 256 + glyphs.indexOf(s);
const lamp: StreetFixture = {
  kind: 'streetlight',
  base: [40.5, 40.5],
  tip: [43.5, 40.5],
  forward: [41.5, 40.5],
  right: [40.5, 41.5],
  roadCenter: [45.5, 40.5],
  state: LampState.flicker,
  seed: 17,
};
const signal: StreetFixture = {
  kind: 'signal',
  base: [60.5, 60.5],
  tip: [61.5, 60.5],
  forward: [61.5, 60.5],
  right: [60.5, 61.5],
  seed: 7,
  group: 'a',
  midBlock: false,
};
const pack = (fixtures: StreetFixture[], zoom = 19, g = grid, clock = 0) =>
  packFixtures(new Uint8Array(g.cols * g.rows * 4), g, fixtures, zoom, glyph, clock);
const cells = (out: Uint8Array) => {
  const result: { at: number; glyph: number; part: number; info: number }[] = [];
  for (let at = 0; at < out.length; at += 4) {
    if (!out[at + 3]) continue;
    const decoded = unpackGlyph(out[at]!, out[at + 1]!);
    result.push({ at, glyph: decoded.glyph, part: decoded.cls, info: out[at + 2]! });
  }
  return result;
};

describe('street fixtures', () => {
  it('draws compact three-head lantern clusters with one shared post', () => {
    const lanterns: StreetFixture[] = [0, 1, 2].map((i) => {
      const angle = (i * Math.PI * 2) / 3;
      const dx = Math.sin(angle),
        dy = -Math.cos(angle);
      return {
        ...lamp,
        site: true,
        style: 'lantern',
        tip: [40.5 + 2 * dx, 40.5 + 2 * dy],
        forward: [40.5 + dx, 40.5 + dy],
        right: [40.5 - dy, 40.5 + dx],
      };
    });
    expect(cells(pack(lanterns, 17.9).texels)).toHaveLength(0);
    const result = cells(pack(lanterns).texels);
    expect(result.filter((c) => c.part === FixturePart.base)).toHaveLength(1);
    expect(result.filter((c) => c.part === FixturePart.lamp)).toHaveLength(3);
    expect(
      result.filter((c) => c.part === FixturePart.lamp).every((c) => c.glyph === glyph('*')),
    ).toBe(true);
    const cols = result.map((c) => (c.at / 4) % grid.cols);
    const rows = result.map((c) => Math.floor(c.at / 4 / grid.cols));
    expect(Math.max(...cols) - Math.min(...cols)).toBeLessThanOrEqual(6);
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(6);
    expect(result.every((c) => c.info === lightByte(lamp.state, lamp.seed))).toBe(true);
    expect(pack([{ ...lamp, style: 'streetlight' }]).texels).toEqual(pack([lamp]).texels);
  });

  it('keeps missing style bytes compatible with legacy worker geometry', () => {
    const builder = new LifeBuilder();
    builder.addLamps([1000, 1000, LampState.working, 3, 1001, 1000, 1000, 1000]);
    const geometry = builder.finish();
    geometry.lampStyles = undefined;
    const fixtures = tileFixtures({ z: 16, x: 55209, y: 30264 }, geometry);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatchObject({ kind: 'streetlight', style: 'streetlight', site: false });
  });

  it('keeps compact symbols, then reveals supports, housing, and separate lenses', () => {
    expect(cells(pack([lamp], 16).texels)).toHaveLength(1);
    expect(cells(pack([signal], 17).texels)).toHaveLength(1);
    const l = cells(pack([lamp]).texels),
      s = cells(pack([signal]).texels);
    expect(new Set(l.map((c) => c.part))).toEqual(
      new Set([FixturePart.base, FixturePart.arm, FixturePart.housing, FixturePart.lamp]),
    );
    expect(l.filter((c) => c.part === FixturePart.lamp).length).toBeGreaterThanOrEqual(2);
    expect(new Set(s.map((c) => c.part))).toEqual(
      new Set([
        FixturePart.base,
        FixturePart.arm,
        FixturePart.housing,
        FixturePart.red,
        FixturePart.amber,
        FixturePart.green,
      ]),
    );
    expect(s.every((c) => c.glyph > 255)).toBe(true);
  });

  it('scales world dimensions beyond the readable minimum and supports every bearing', () => {
    const count = (scale: number, angle: number, width = 5, height = 9) => {
      const a = Math.cos(angle),
        b = Math.sin(angle);
      const g: FixtureGrid = {
        ...grid,
        cellWidth: width,
        cellHeight: height,
        toCell: (x, y) => [
          50 + scale * ((x - 60.5) * a - (y - 60.5) * b),
          50 + scale * ((x - 60.5) * b + (y - 60.5) * a),
        ],
      };
      const c = cells(pack([signal], 21, g).texels);
      expect(
        new Set(
          c
            .filter((c) => c.part >= FixturePart.red && c.part <= FixturePart.green)
            .map((c) => c.part),
        ),
      ).toEqual(new Set([5, 6, 7]));
      return c.length;
    };
    for (const angle of [0, Math.PI / 4, Math.PI / 2, (Math.PI * 3) / 4, Math.PI]) {
      expect(count(8, angle)).toBeGreaterThan(count(1, angle));
      expect(count(1, angle, 6, 11)).toBeGreaterThan(3);
      expect(count(1, angle, 10, 18)).toBe(count(1, angle));
    }
  });

  it('dissolves whole fixtures into detail over z18–18.5 without changing anchors', () => {
    const start = cells(pack([lamp], 18).texels),
      end = cells(pack([lamp], 18.5).texels);
    expect(start).toHaveLength(1);
    expect(end.length).toBeGreaterThan(1);
    const middle = cells(pack([lamp], 18.25).texels);
    expect([start.length, end.length]).toContain(middle.length);
    expect(pack([lamp], 18.25).texels).toEqual(pack([lamp], 18.25).texels);
    expect(cells(pack([lamp, signal], 14).texels)).toHaveLength(0);
    expect(cells(pack([signal], 16).texels)).toHaveLength(0);
  });

  it('preserves dead/flickering lamp state independently of phase updates', () => {
    for (const state of [LampState.working, LampState.dead, LampState.flicker]) {
      const packed = pack([{ ...lamp, state }, signal]);
      const lamps = cells(packed.texels).filter((c) => c.part === FixturePart.lamp);
      expect(lamps.length).toBeGreaterThan(0);
      expect(lamps.every((c) => c.info === lightByte(state, lamp.seed))).toBe(true);
      updateFixtureSignals(packed, 40);
      expect(cells(packed.texels).filter((c) => c.part === FixturePart.lamp)).toEqual(lamps);
    }
  });

  it('uses the exact traffic clock, updates phase bytes only, and freezes when it stops', () => {
    const world = new LifeWorld();
    const packed = pack([signal], 19, grid, world.signalClock);
    expect(world.visible(19, 1, [0, 0], undefined, undefined, 0, 0)).toEqual([]);
    const geometry = cells(packed.texels).map(({ at, glyph, part }) => ({ at, glyph, part }));
    const colors = { red: 0, amber: 1, green: 2 };
    for (let i = 0; i < 700; i++) {
      world.step(0.1);
      updateFixtureSignals(packed, world.signalClock);
      expect(
        cells(packed.texels).every(
          (c) => c.info === colors[signalState(signal.seed, world.signalClock).a],
        ),
      ).toBe(true);
    }
    const frozen = packed.texels.slice();
    expect(updateFixtureSignals(packed, world.signalClock)).toBe(false);
    expect(packed.texels).toEqual(frozen);
    expect(cells(packed.texels).map(({ at, glyph, part }) => ({ at, glyph, part }))).toEqual(
      geometry,
    );
  });

  it('clips safely and reports viewport visibility rather than offscreen grid margins', () => {
    expect(pack([lamp, signal], 19, { ...grid, visible: () => false }).visibility).toEqual({
      streetlights: false,
      trafficSignals: false,
    });
    expect(pack([lamp, signal]).visibility).toEqual({ streetlights: true, trafficSignals: true });
    expect(cells(pack([signal], 19, { ...grid, cols: 2, rows: 2 }).texels)).toHaveLength(0);
    const clipped = {
      ...signal,
      base: [0.5, 0.5] as [number, number],
      tip: [1.5, 0.5] as [number, number],
      forward: [1.5, 0.5] as [number, number],
      right: [0.5, 1.5] as [number, number],
    };
    expect(cells(pack([clipped], 19, { ...grid, cols: 5, rows: 5 }).texels).length).toBeGreaterThan(
      0,
    );
  });

  it('keeps phase seeds across buffered tile seams and assigns centers to one tile', () => {
    const tile = { z: 16, x: 55192, y: 30266 };
    const b = new LifeBuilder();
    b.signal({ x: 100, y: 200 }, 8, 90, 0, true);
    const fixtures = tileFixtures(tile, b.finish());
    expect(fixtures).toHaveLength(4);
    const neighbor = new LifeBuilder();
    neighbor.signal({ x: 100 - 4096, y: 200 }, 8, 90, 0, true);
    expect(tileFixtures({ ...tile, x: tile.x + 1 }, neighbor.finish())).toHaveLength(0);
    const other = new LifeBuilder();
    other.signal({ x: 200, y: 400 }, 8, 90, 0, true);
    const deeper = tileFixtures({ z: 17, x: tile.x * 2, y: tile.y * 2 }, other.finish());
    expect(deeper.map((f) => f.seed)).toEqual(fixtures.map((f) => f.seed));
    expect(deeper[0]!.base[0]).toBeCloseTo(fixtures[0]!.base[0], 8);
    expect(fixtures[0]!.base[0]).not.toBe(tileToLngLat(tile, { x: 100, y: 200 })[0]);
  });
});
