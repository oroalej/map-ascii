import { expect, it } from 'vitest';
import {
  GROUP_PLACEMENT_ATTEMPTS,
  placeCoarseGroup,
  placeCoarseLone,
  type GroupRaster,
} from './group-placement';

const grid = { cols: 20, rows: 20, cellWidth: 5, cellHeight: 9 };
const member = (col: number, row: number): GroupRaster => ({ expected: 1, cells: [{ col, row }] });
const permits = (cells: readonly (readonly [number, number])[]) => (col: number, row: number) =>
  cells.some(([c, r]) => c === col && r === row);

it('limits lone figures to sixteen rigid offsets and sixty-four translated cells', () => {
  const visited: string[] = [];
  const result = placeCoarseLone(member(5, 5), grid, (col, row) => {
    visited.push(`${col - 5}/${row - 5}`);
    return false;
  });
  expect(result).toEqual({ rigidAttempts: 16, targetCellChecks: 16 });
  expect(new Set(visited).size).toBe(16);
  expect(
    visited.every((offset) => Math.max(...offset.split('/').map(Number).map(Math.abs)) === 2),
  ).toBe(true);
  const four = {
    expected: 4,
    cells: [
      { col: 5, row: 5 },
      { col: 6, row: 5 },
      { col: 5, row: 6 },
      { col: 6, row: 6 },
    ],
  };
  const placed = placeCoarseLone(
    four,
    grid,
    permits([
      [7, 7],
      [8, 7],
      [7, 8],
      [8, 8],
    ]),
  );
  expect(placed.offset).toEqual([2, 2]);
  expect(placed.rigidAttempts).toBeLessThanOrEqual(16);
  expect(placed.targetCellChecks).toBeLessThanOrEqual(64);
});

it('orders lone rigid retries in device pixels with stable ties and DPR scaling', () => {
  const allowed = permits([
    [3, 5],
    [7, 5],
    [5, 3],
    [5, 7],
  ]);
  for (const dpr of [1, 2]) {
    expect(
      placeCoarseLone(member(5, 5), { ...grid, cellWidth: 5 * dpr, cellHeight: 9 * dpr }, allowed)
        .offset,
    ).toEqual([-2, 0]);
    expect(
      placeCoarseLone(member(5, 5), { ...grid, cellWidth: 9 * dpr, cellHeight: 5 * dpr }, allowed)
        .offset,
    ).toEqual([0, -2]);
  }
});

it('rejects invalid lone payloads without a search and keeps translated cells in bounds', () => {
  for (const invalid of [
    { expected: 0, cells: [] },
    { expected: 4, cells: [{ col: 5, row: 5 }] },
    { expected: 4, cells: Array.from({ length: 4 }, () => ({ col: 5, row: 5 })) },
    member(5.1, 5),
    member(NaN, 5),
    {
      expected: 2,
      cells: [
        { col: 5, row: 5 },
        { col: 6, row: 5 },
      ],
    },
  ])
    expect(placeCoarseLone(invalid, grid, () => true)).toEqual({
      rigidAttempts: 0,
      targetCellChecks: 0,
    });
  expect(placeCoarseLone(member(0, 0), grid, permits([[-2, 0]])).offset).toBeUndefined();
});

it('prefers a complete rigid second-ring translation using pixel distance and stable ties', () => {
  const members = [member(5, 5), member(5, 7)];
  const result = placeCoarseGroup(
    members,
    grid,
    permits([
      [3, 5],
      [3, 7],
      [7, 5],
      [7, 7],
    ]),
  );
  expect(result.offsets).toEqual([
    [-2, 0],
    [-2, 0],
  ]);
  expect(result.assignmentAttempts).toBe(0);
  expect(result.rigidAttempts).toBeLessThanOrEqual(16);
  expect(members).toEqual([member(5, 5), member(5, 7)]);
});

it('finds a coherent complete assignment and retains original member order', () => {
  const result = placeCoarseGroup(
    [member(5, 5), member(5, 7)],
    grid,
    permits([
      [7, 5],
      [6, 7],
    ]),
  );
  expect(result.offsets).toEqual([
    [2, 0],
    [1, 0],
  ]);
  expect(result.assignmentAttempts).toBeGreaterThan(0);
  expect(result.assignmentAttempts).toBeLessThanOrEqual(GROUP_PLACEMENT_ATTEMPTS);
  expect(result.exhausted).toBe(false);
});

it('omits the whole group rather than separating members or reversing their ordering', () => {
  expect(
    placeCoarseGroup(
      [member(5, 5), member(5, 7)],
      grid,
      permits([
        [7, 5],
        [3, 7],
      ]),
    ).offsets,
  ).toBeUndefined();
  expect(
    placeCoarseGroup(
      [member(5, 5), member(6, 5)],
      grid,
      permits([
        [6, 5],
        [5, 5],
      ]),
    ).offsets,
  ).toEqual([
    [0, 0],
    [0, 0],
  ]);
});

it('counts failed assignments against a deterministic budget without returning a partial result', () => {
  const members = [member(5, 5), member(5, 7)],
    allowed = permits([
      [7, 5],
      [6, 7],
    ]);
  const exhausted = placeCoarseGroup(members, grid, allowed, 1);
  expect(exhausted.offsets).toBeUndefined();
  expect(exhausted.assignmentAttempts).toBe(1);
  expect(exhausted.exhausted).toBe(true);
  expect(placeCoarseGroup(members, grid, allowed).offsets).toBeDefined();
});

it('retains bounds, complete glyph slices, small-group eligibility and the two-cell limit', () => {
  for (const members of [
    [member(5, 5)],
    [member(5, 5), { expected: 4, cells: [{ col: 5, row: 7 }] }],
    [
      member(5, 5),
      {
        expected: 2,
        cells: [
          { col: 5, row: 7 },
          { col: 6, row: 7 },
        ],
      },
    ],
    [member(5.5, 5), member(5, 7)],
  ])
    expect(placeCoarseGroup(members, grid, () => true).offsets).toBeUndefined();
  expect(
    placeCoarseGroup(
      [member(5, 5), member(5, 7)],
      grid,
      permits([
        [8, 5],
        [8, 7],
      ]),
    ).offsets,
  ).toBeUndefined();
  expect(
    placeCoarseGroup(
      [member(0, 0), member(0, 2)],
      grid,
      permits([
        [-2, 0],
        [-2, 2],
      ]),
    ).offsets,
  ).toBeUndefined();
});
