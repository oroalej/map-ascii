import { describe, expect, it } from 'vitest';
import { LifeBuilder } from './geometry';
import {
  FixturePart,
  packFixtures,
  packSignalLights,
  tileFixtures,
  updateFixtureSignals,
  type FixtureGrid,
  type PackedFixtures,
  type StreetFixture,
} from './fixtures';
import { signalState } from './signals';

const grid: FixtureGrid = {
  cols: 50,
  rows: 50,
  cellWidth: 5,
  cellHeight: 9,
  toCell: (x, y) => [x, y],
};
const signal: StreetFixture = {
  kind: 'signal',
  base: [20.5, 20.5],
  tip: [21.5, 20.5],
  forward: [21.5, 20.5],
  right: [20.5, 21.5],
  seed: 7,
  group: 'a',
  midBlock: false,
};
const pack = (fixtures = [signal], zoom = 19, g = grid) =>
  packFixtures(new Uint8Array(g.cols * g.rows * 4), g, fixtures, zoom, () => 300, 0);
const light = (packed: PackedFixtures, g = grid, dpr = 1) => {
  const out = new Uint8Array(g.cols * g.rows * 4);
  packSignalLights(out, packed, { ...g, dpr });
  return out;
};
const sourceAt = (lookup: Uint8Array, col: number, row: number, cols = grid.cols) => {
  const at = (row * cols + col) * 4;
  if (!lookup[at + 3]) return -1;
  return ((row + lookup[at + 1]! - 128) * cols + col + lookup[at]! - 128) * 4;
};

describe('signal light lookup', () => {
  it('uses the approach axis rather than the support arm, for cardinal and diagonal bearings', () => {
    for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      const fixture: StreetFixture = {
        ...signal,
        right: [20.5 + Math.cos(angle) / grid.cellWidth, 20.5 + Math.sin(angle) / grid.cellHeight],
      };
      const packed = pack([fixture], 17);
      const direction = (packed.signals[0]!.direction * 2 * Math.PI) / 256;
      expect(Math.cos(direction)).toBeCloseTo(Math.cos(angle), 2);
      expect(Math.sin(direction)).toBeCloseTo(Math.sin(angle), 2);
      const lookup = light(packed);
      const emit = packed.signals[0]!.emitters[0]!;
      for (let at = 0; at < lookup.length; at += 4) {
        if (!lookup[at + 3]) continue;
        expect(sourceAt(lookup, (at / 4) % grid.cols, Math.floor(at / 4 / grid.cols))).toBe(emit);
        expect(lookup[at + 2]).toBe(packed.signals[0]!.direction);
      }
    }
  });

  it('points mapped curb fixtures outward along each road approach', () => {
    const b = new LifeBuilder();
    b.signal({ x: 2000, y: 2000 }, 8, 45, 135, true);
    const fixtures = tileFixtures({ z: 16, x: 33000, y: 32000 }, b.finish());
    for (const [i, fixture] of fixtures.entries()) {
      const bearing = i < 2 ? 45 : 135;
      const sign = i % 2 === 0 ? -1 : 1;
      const dx = (fixture.right[0] - fixture.base[0]) * Math.cos((fixture.base[1] * Math.PI) / 180);
      const dy = -(fixture.right[1] - fixture.base[1]);
      const length = Math.hypot(dx, dy);
      expect(dx / length).toBeCloseTo(sign * Math.sin((bearing * Math.PI) / 180), 4);
      expect(dy / length).toBeCloseTo(-sign * Math.cos((bearing * Math.PI) / 180), 4);
    }
  });

  it('names only the current lens, moves to the new lens on phase changes, and stays frozen', () => {
    const packed = pack();
    const positions = packed.signals[0]!.emitters.slice();
    const fields: Uint8Array[] = [];
    for (const color of ['red', 'amber', 'green'] as const) {
      const clock = Array.from({ length: 100 }, (_, i) => i).find(
        (t) => signalState(7, t).a === color,
      )!;
      updateFixtureSignals(packed, clock);
      const lookup = light(packed);
      expect(lookup.some((b) => b !== 0)).toBe(true);
      const part = FixturePart.red + { red: 0, amber: 1, green: 2 }[color];
      for (let at = 0; at < lookup.length; at += 4) {
        if (!lookup[at + 3]) continue;
        const source = sourceAt(lookup, (at / 4) % grid.cols, Math.floor(at / 4 / grid.cols));
        expect(packed.texels[source + 1]! & 63).toBe(part);
      }
      expect(updateFixtureSignals(packed, clock)).toBe(0);
      expect(light(packed)).toEqual(lookup);
      expect(packed.signals[0]!.emitters).toEqual(positions);
      fields.push(lookup);
    }
    expect(fields[0]).not.toEqual(fields[1]);
    expect(fields[1]).not.toEqual(fields[2]);
  });

  it('keeps identical CSS-sized footprints at DPR 1 and 2', () => {
    const doubled = { ...grid, cellWidth: grid.cellWidth * 2, cellHeight: grid.cellHeight * 2 };
    expect(light(pack(), grid, 1)).toEqual(light(pack([signal], 19, doubled), doubled, 2));
  });

  it('resolves overlaps to the stronger nearby emitter without stacking their light', () => {
    const other: StreetFixture = {
      ...signal,
      base: [22.5, 20.5],
      tip: [23.5, 20.5],
      forward: [23.5, 20.5],
      right: [22.5, 21.5],
    };
    for (const fixtures of [
      [signal, other],
      [other, signal],
    ]) {
      const lookup = light(pack(fixtures, 17));
      expect(sourceAt(lookup, 20, 20)).toBe((20 * grid.cols + 20) * 4);
      expect(sourceAt(lookup, 22, 20)).toBe((20 * grid.cols + 22) * 4);
    }
  });

  it('clips lookup sources to the grid and clears stale footprints when signals disappear', () => {
    const edge: StreetFixture = {
      ...signal,
      base: [0.5, 0.5],
      tip: [1.5, 0.5],
      forward: [1.5, 0.5],
      right: [0.5, 1.5],
    };
    const small = { ...grid, cols: 2, rows: 2 };
    const lookup = light(pack([edge], 17, small), small);
    expect(lookup.some((b) => b !== 0)).toBe(true);
    for (let at = 0; at < lookup.length; at += 4) {
      if (lookup[at + 3]) expect(sourceAt(lookup, (at / 4) % 2, Math.floor(at / 4 / 2), 2)).toBe(0);
    }
    packSignalLights(lookup, pack([], 17, small), { ...small, dpr: 1 });
    expect(lookup.every((b) => b === 0)).toBe(true);
  });
});
