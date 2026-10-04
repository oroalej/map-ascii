import { expect, it } from 'vitest';
import { packLife, type LifeGrid } from './draw';
import type { VisibleAgent } from './simulate';
import { themes } from '../theme';

const grid: LifeGrid = {
  cols: 40,
  rows: 30,
  cellWidth: 10,
  cellHeight: 18,
  toCell: (x, y) => [x, y],
};
const parked: VisibleAgent = {
  kind: 'vehicle',
  vehicle: 'car',
  parked: true,
  paint: 1,
  lng: 15,
  lat: 15,
  ahead: [17, 15],
  side: [15, 17],
  flap: 0,
};
const draw = (agents: VisibleAgent[]) => {
  const out = new Uint8Array(grid.cols * grid.rows * 4);
  return { out, count: packLife(out, grid, agents, themes.dark, () => 1) };
};

it('reserves parked cars first and omits a whole overlapping car, leaving no fragments', () => {
  const car = {
    ...parked,
    lng: 19,
    ahead: [21, 15] as [number, number],
    side: [19, 17] as [number, number],
    parked: false,
    paint: 2,
  };
  const alone = draw([parked]);
  const together = draw([car, parked]);
  expect(together.count).toBe(1);
  expect(together.out).toEqual(alone.out);
  expect(draw([car]).out).not.toEqual(alone.out);
});

it('keeps people and parked cars separate even when they collapse into one ASCII cell', () => {
  const car = {
    ...parked,
    ahead: [15.1, 15] as [number, number],
    side: [15, 15.1] as [number, number],
  };
  const person: VisibleAgent = { kind: 'person', lng: 15, lat: 15, flap: 0 };
  const together = draw([person, car]);
  expect(together.count).toBe(2);
  const at = (15 * grid.cols + 15) * 4;
  expect(together.out.slice(at, at + 4)).toEqual(draw([car]).out.slice(at, at + 4));
});

it('preserves separate people and cars that fit beside each other', () => {
  const person: VisibleAgent = { kind: 'person', lng: 30, lat: 20, flap: 0 };
  expect(draw([person, parked]).count).toBe(2);
});

it('rolls back a complete stamped vehicle when one cell overlaps forbidden tree cover', () => {
  const out = new Uint8Array(grid.cols * grid.rows * 4);
  const count = packLife(
    out,
    { ...grid, allowsGroundCell: (_agent, col) => col >= 15 },
    [parked],
    themes.dark,
    () => 1,
  );
  expect(count).toBe(0);
  expect(out.every((byte) => byte === 0)).toBe(true);
});

it('rejects the complete walking group when one member touches a forbidden road cell', () => {
  const person: VisibleAgent = {
    kind: 'person',
    lng: 20,
    lat: 15,
    ahead: [22, 15],
    side: [20, 17],
    flap: 0,
    people: [
      { figure: 'adult', paint: 0, lateral: 0, back: 0, flap: 0 },
      { figure: 'adult', paint: 1, lateral: 2, back: 0, flap: 0 },
    ],
  };
  const out = new Uint8Array(grid.cols * grid.rows * 4);
  expect(
    packLife(
      out,
      { ...grid, allowsGroundCell: (_agent, _col, row) => row < 16 },
      [person],
      themes.dark,
      () => 1,
    ),
  ).toBe(0);
  expect(out.every((byte) => byte === 0)).toBe(true);
});
