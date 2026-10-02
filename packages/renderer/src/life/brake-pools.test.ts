import { describe, expect, it } from 'vitest';
import { packLife, type LifeGrid } from './draw';
import { BRAKE_POOL } from './lamps';
import {
  LampState,
  lightByte,
  packBrakePools,
  packBeams,
  createConePackingScratch,
  type LightGrid,
} from './lights';
import type { VisibleAgent } from './simulate';
import { SIGNAL_VEHICLES } from './turn-signals';
import { VEHICLES, type CraftType } from './vehicles';
import { themes } from '../theme';

const grid: LifeGrid & LightGrid = {
  cols: 128,
  rows: 96,
  cellWidth: 6,
  cellHeight: 12,
  toCell: (x, y) => [x * 2, y],
};
const braking = (vehicle: CraftType = 'car', heading = [1, 0]): VisibleAgent => ({
  kind: 'vehicle',
  vehicle,
  lng: 32,
  lat: 48,
  ahead: [32 + heading[0]!, 48 + heading[1]!],
  side: [32 - heading[1]!, 48 + heading[0]!],
  paint: 0,
  flap: 0,
  lamps: { kind: 'brake' },
});
const empty = () => new Uint8Array(grid.cols * grid.rows * 4);
const litCells = (out: Uint8Array) => {
  const cells: { col: number; row: number; value: number }[] = [];
  for (let i = 0; i < out.length; i += 4)
    if (out[i])
      cells.push({ col: (i / 4) % grid.cols, row: Math.floor(i / 4 / grid.cols), value: out[i]! });
  return cells;
};
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe('brake pools', () => {
  for (const vehicle of SIGNAL_VEHICLES)
    for (const heading of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
      [Math.SQRT1_2, Math.SQRT1_2],
    ])
      it(`casts ${vehicle} behind its tail at heading ${heading.join(',')}`, () => {
        const out = empty();
        expect(packBrakePools(out, grid, [braking(vehicle, heading)], new Uint8Array([1]))).toBe(1);
        const cells = litCells(out);
        expect(cells.length).toBeGreaterThan(0);
        const spec = VEHICLES[vehicle];
        for (const { col, row, value } of cells) {
          const dx = (col + 0.5) / 2 - 32;
          const dy = row + 0.5 - 48;
          const behind = -dx * heading[0]! - dy * heading[1]! - spec.length / 2;
          const right = -dx * heading[1]! + dy * heading[0]!;
          expect(behind).toBeGreaterThan(0);
          expect(behind).toBeLessThan(BRAKE_POOL.length);
          expect(Math.abs(right)).toBeLessThan(spec.width / 2 + behind * BRAKE_POOL.spread);
          expect(value).toBeLessThanOrEqual(Math.round(255 * BRAKE_POOL.strength));
          const at = (row * grid.cols + col) * 4;
          expect(out.subarray(at + 1, at + 4)).toEqual(
            new Uint8Array([lightByte(LampState.beam, BRAKE_POOL.seed), 0, 255]),
          );
        }
      });

  it('fades along and across the cone', () => {
    const out = empty();
    packBrakePools(out, grid, [braking()], new Uint8Array([1]));
    const cells = litCells(out);
    const near = cells.filter((c) => c.col >= 57);
    const far = cells.filter((c) => c.col <= 54);
    expect(Math.max(...near.map((c) => c.value))).toBeGreaterThan(
      Math.max(...far.map((c) => c.value)),
    );
    const row = (r: number) => out[(r * grid.cols + 55) * 4]!;
    expect(row(48)).toBeGreaterThan(row(49));
  });

  it('preserves lamp heads and stronger competing pools byte for byte', () => {
    const probe = empty();
    packBrakePools(probe, grid, [braking()], new Uint8Array([1]));
    const out = empty();
    for (const { col, row } of litCells(probe)) {
      const at = (row * grid.cols + col) * 4;
      out.set(row % 2 ? [255, lightByte(LampState.working, 9), 0, 255] : [0, 1, 255, 255], at);
    }
    const before = out.slice();
    packBrakePools(out, grid, [braking()], new Uint8Array([1]));
    expect(sameBytes(out, before)).toBe(true);
  });

  it('ignores parked, hazard, cruising, unsupported and unadmitted sources', () => {
    const sources: VisibleAgent[] = [
      { ...braking(), parked: true },
      { ...braking(), lamps: { kind: 'hazard', on: true } },
      { ...braking(), lamps: { kind: 'hazard', on: false } },
      { ...braking(), lamps: undefined },
      braking('bicycle'),
      { ...braking(), kind: 'boat' },
      { ...braking(), ahead: undefined },
      { ...braking(), side: [32, 48] },
      braking(),
    ];
    const admitted = new Uint8Array(sources.length).fill(1);
    admitted[admitted.length - 1] = 0;
    const out = empty();
    expect(packBrakePools(out, grid, sources, admitted)).toBe(0);
    expect(out.some(Boolean)).toBe(false);
  });

  it('clips to the viewport and skips sub-cell cones without inflating them', () => {
    const car = braking();
    const left = { ...car, lng: 4, ahead: [5, 48], side: [4, 49] } satisfies VisibleAgent;
    const out = empty();
    expect(packBrakePools(out, grid, [left], new Uint8Array([1]))).toBe(1);
    expect(litCells(out).length).toBeGreaterThan(0);
    expect(
      packBrakePools(
        out,
        { ...grid, toCell: (x, y) => [x / 10, y / 10] },
        [car],
        new Uint8Array([1]),
      ),
    ).toBe(0);
    const outside = {
      ...car,
      lng: -100,
      ahead: [-99, 48],
      side: [-100, 49],
    } satisfies VisibleAgent;
    expect(packBrakePools(out, grid, [outside], new Uint8Array([1]))).toBe(0);
  });
});

describe('successful vehicle stamp mask', () => {
  it('tracks final array indices and excludes collision and terrain rollbacks', () => {
    const admitted = new Uint8Array(3);
    const out = empty();
    const car = braking();
    const offscreen = {
      ...car,
      lng: -100,
      ahead: [-99, 48],
      side: [-100, 49],
    } satisfies VisibleAgent;
    expect(
      packLife(
        out,
        { ...grid, stampedVehicles: admitted },
        [offscreen, car, car],
        themes.dark,
        () => 1,
      ),
    ).toBe(1);
    expect(admitted).toEqual(new Uint8Array([0, 1, 0]));
    packLife(
      out,
      { ...grid, stampedVehicles: admitted, allowsGroundCell: () => false },
      [car],
      themes.dark,
      () => 1,
    );
    expect(admitted.some(Boolean)).toBe(false);
    const lights = empty();
    expect(packBrakePools(lights, grid, [car], admitted)).toBe(0);
  });

  it('does not admit miniature glyphs and clears unused entries on smaller or empty frames', () => {
    const admitted = new Uint8Array(3).fill(1);
    const out = empty();
    const car = braking();
    packLife(
      out,
      { ...grid, toCell: (x, y) => [x / 10, y / 10], stampedVehicles: admitted },
      [car],
      themes.dark,
      () => 1,
    );
    expect(admitted.some(Boolean)).toBe(false);
    packLife(out, { ...grid, stampedVehicles: admitted }, [car], themes.dark, () => 1);
    expect(admitted).toEqual(new Uint8Array([1, 0, 0]));
    packLife(out, { ...grid, stampedVehicles: admitted }, [], themes.dark, () => 1);
    expect(admitted.some(Boolean)).toBe(false);
  });

  it('rejects a mask too small for the final agent array', () => {
    expect(() =>
      packLife(
        empty(),
        { ...grid, stampedVehicles: new Uint8Array(0) },
        [braking()],
        themes.dark,
        () => 1,
      ),
    ).toThrow('Wrong stamped vehicle mask size');
  });
});

describe('bounded cone reuse', () => {
  it('rechecks competition and source admission when reusing an unchanged pose', () => {
    const scratch = createConePackingScratch(),
      car = braking(),
      admitted = new Uint8Array([1]);
    const probe = empty();
    packBrakePools(probe, grid, [car], admitted, scratch);
    const blocked = empty();
    for (const { col, row } of litCells(probe)) blocked[(row * grid.cols + col) * 4 + 2] = 255;
    const before = blocked.slice();
    packBrakePools(blocked, grid, [car], admitted, scratch);
    expect(sameBytes(blocked, before)).toBe(true);
    const redrawn = empty();
    packBrakePools(redrawn, grid, [{ ...car }], admitted, scratch);
    expect(sameBytes(redrawn, probe)).toBe(true);
    expect(packBrakePools(empty(), grid, [car], new Uint8Array([0]), scratch)).toBe(0);
  });

  it('invalidates for pose, craft, projection, target size and cone direction', () => {
    const scratch = createConePackingScratch(),
      admitted = new Uint8Array([1]);
    packBrakePools(empty(), grid, [braking()], admitted, scratch);
    const cases: [LifeGrid, VisibleAgent][] = [
      [grid, { ...braking(), lng: 33, ahead: [34, 48], side: [33, 49] }],
      [grid, braking('bus', [0, 1])],
      [{ ...grid, toCell: (x: number, y: number): [number, number] => [x, y] }, braking()],
      [{ ...grid, cols: 120 }, braking()],
    ];
    for (const [g, car] of cases) {
      const cached = new Uint8Array(g.cols * g.rows * 4),
        fresh = cached.slice();
      packBrakePools(cached, g, [car], admitted, scratch);
      packBrakePools(fresh, g, [car], admitted);
      expect(sameBytes(cached, fresh)).toBe(true);
    }
    const cached = empty(),
      fresh = empty();
    packBeams(cached, grid, [braking()], scratch);
    packBeams(fresh, grid, [braking()]);
    expect(sameBytes(cached, fresh)).toBe(true);
    packBrakePools(empty(), grid, [], new Uint8Array(0), scratch);
    expect(scratch.entries.length).toBe(0);
  });
});
