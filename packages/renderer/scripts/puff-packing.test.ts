import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { packLife, type LifeGrid } from '../src/life/draw';
import { themes } from '../src/theme';
import { adaptPuffPacking, type PuffPacking } from './puff-packing';

const grid: LifeGrid = {
  cols: 80,
  rows: 80,
  cellWidth: 6,
  cellHeight: 11,
  toCell: (x, y) => [x, y],
};
const puffs = new Float64Array([0, 5, 5, 0.2, 0]);
const agents: Parameters<typeof packLife>[2] = [
  { kind: 'vehicle', vehicle: 'bus', lng: 40, lat: 40, ahead: [43, 40], side: [40, 43], flap: 0 },
];
const glyph = () => 1;

it('retains current puff output while leaving metadata in its own argument', () => {
  const source = readFileSync(new URL('../src/life/draw.ts', import.meta.url), 'utf8');
  const pack = adaptPuffPacking(packLife, source);
  const out = new Uint8Array(grid.cols * grid.rows * 4),
    expected = new Uint8Array(out.length);
  pack(out, grid, agents, themes.dark, glyph, undefined, undefined, puffs);
  packLife(expected, grid, agents, themes.dark, glyph, undefined, undefined, {}, puffs);
  expect(out[(5 * grid.cols + 5) * 4 + 2]).toBe(3);
  expect(out).toEqual(expected);
});

it('retains puff output from a historical eighth-argument packer', () => {
  const historical: PuffPacking = (out, _grid, _agents, _theme, _glyph, _sun, _glyphs, packet) => {
    out[0] = packet!.length;
    return packet!.length;
  };
  // The dynamically imported historical graph is typed against today's draw module.
  const pack = adaptPuffPacking(
    historical as unknown as typeof packLife,
    'export function packLife(out: Uint8Array, puffs: Float64Array = EMPTY_PUFFS): number {',
  );
  const out = new Uint8Array(100);
  expect(pack(out, grid, [], themes.dark, glyph, undefined, undefined, puffs)).toBe(5);
  expect(out[0]).toBe(5);
});
