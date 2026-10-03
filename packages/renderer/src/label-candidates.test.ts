import { expect, it } from 'vitest';
import { labelCandidate, labelScreenArea } from './label-candidates';
import { LabelRank } from './labels';
import { screenArea, type GridPlacement, type View } from './grid';
import type { TileLabel } from './raster/geometry';

const view: View = {
  camera: { lng: 0, lat: 0, zoom: 18 },
  dpr: 2,
  width: 800,
  height: 600,
  labelDev: { w: 20, h: 36 },
  cellDev: { w: 10, h: 18 },
  detailZoom: 19,
};
const placement: GridPlacement = {
  grid: { originCol: 0, originRow: 0, shiftX: 20, shiftY: 36 },
  toCell: (lng, lat) => [lng, lat],
  tileMatrix: () => [],
};
const label: TileLabel = {
  id: 1,
  text: 'ABC',
  rank: LabelRank.street,
  lng: 4.8,
  lat: 4.2,
  angle: 0,
  run: [
    [4, 4],
    [4, 14],
  ],
  band: { min: 18 },
};

it.each([
  [19.5, 1, 40],
  [20, 1, 41],
  [20.5, 2, 41],
  [-0.5, -0, 39],
])(
  'shares whole-cell admission while retaining fractional visibility at shift %s',
  (shiftX, left, right) => {
    const grid = { ...placement.grid, shiftX };
    expect(screenArea(view, grid, view.labelDev)).toMatchObject({ left, right });
    expect(labelScreenArea(view, grid)).toMatchObject({
      left: shiftX / 20,
      right: (shiftX + 800) / 20,
    });
    expect(screenArea(view, grid)).toEqual(screenArea(view, grid, view.cellDev));
  },
);

it('prepares fractional anchors and run lengths in horizontal cell widths', () => {
  expect(screenArea(view, placement.grid, view.labelDev)).toEqual({
    left: 1,
    top: 1,
    right: 41,
    bottom: 17,
  });
  expect(labelCandidate(label, view, placement)).toMatchObject({
    col: 4,
    row: 4,
    runCells: 18,
    mode: 'rotated',
    vis: 1,
  });
});
it('excludes labels outside their band, in the blackout, and beyond the retained reach', () => {
  expect(
    labelCandidate(label, { ...view, camera: { ...view.camera, zoom: 16 } }, placement),
  ).toBeUndefined();
  expect(labelCandidate({ ...label, band: { min: 20 } }, view, placement)).toBeUndefined();
  expect(labelCandidate({ ...label, lng: -20 }, view, placement)).toBeUndefined();
  expect(labelCandidate({ ...label, lng: -7 }, view, placement)).toBeDefined();
});
it('preserves the pixel-space run calculation at fractional fit boundaries', () => {
  // Rearranging this calculation can round below the seven-width fit for "ABCDE".
  const run = [
    [0, 0],
    [0.01, 3.8888849206328957],
  ] as const;
  const dx = run[1][0] - run[0][0],
    dy = run[1][1] - run[0][1];
  expect(labelCandidate({ ...label, text: 'ABCDE', run }, view, placement)?.runCells).toBe(
    Math.hypot(dx * view.labelDev.w, dy * view.labelDev.h) / view.labelDev.w,
  );
});
