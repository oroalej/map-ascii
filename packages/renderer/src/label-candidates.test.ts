import { expect, it } from 'vitest';
import { labelArea, labelCandidate } from './label-candidates';
import { LabelRank } from './labels';
import type { GridPlacement, View } from './grid';
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

it('prepares fractional anchors and run lengths in horizontal cell widths', () => {
  expect(labelArea(view, placement)).toEqual({ left: 1, top: 1, right: 41, bottom: 17 });
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
