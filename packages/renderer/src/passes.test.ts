import { expect, it, vi } from 'vitest';
import { overlayPass, placeGrid, prepareCrowns, type TileDraw, type View } from './passes';
import type { CellTargets, GL } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';
import type { TileLabel } from './raster/geometry';
import { LabelRank } from './labels';
import { themes } from './theme';
import { themeUniforms } from './theme-uniforms';

const view: View = {
  camera: { lat: 13, lng: 123, zoom: 18 },
  dpr: 1,
  cellDev: { w: 10, h: 18 },
  labelDev: { w: 10, h: 18 },
  detailZoom: 18,
  width: 800,
  height: 600,
};

it('reuses crown matrices through sub-cell shifts and invalidates every matrix input', () => {
  const tiles = [
    { tile: { z: 16, x: 1, y: 1 }, mesh: { crowns: { count: 3 } } },
    { tile: { z: 16, x: 2, y: 1 }, mesh: { crowns: { count: 0 } } },
  ] as TileDraw[];
  const placement = placeGrid(view, view.cellDev, 83, 37);
  const matrix = vi.spyOn(placement, 'tileMatrix');
  const first = prepareCrowns(tiles, view, placement, 83, 37);
  expect(first).toHaveLength(1);
  const shifted = { ...placement, grid: { ...placement.grid, shiftX: placement.grid.shiftX + 1 } };
  expect(prepareCrowns(tiles, view, shifted, 83, 37)).toBe(first);
  expect(matrix).toHaveBeenCalledTimes(1);
  for (const changed of [
    { ...view, camera: { ...view.camera, zoom: 19 } },
    { ...view, dpr: 2 },
    { ...view, cellDev: { w: 8, h: 16 } },
  ]) {
    const next = placeGrid(changed, changed.cellDev, 83, 37);
    expect(prepareCrowns(tiles, changed, next, 83, 37)).not.toBe(first);
  }
  const restored = prepareCrowns(tiles, view, placement, 83, 37);
  expect(
    prepareCrowns(
      tiles,
      view,
      { ...placement, grid: { ...placement.grid, originCol: placement.grid.originCol + 1 } },
      83,
      37,
    ),
  ).not.toBe(restored);
  expect(prepareCrowns(tiles, view, placement, 84, 38)).not.toBe(restored);
  expect(prepareCrowns(tiles.slice(), view, placement, 83, 37)).not.toBe(restored);
});

it('keeps palette values identical and independent between themes and atlas instances', () => {
  const a = themeUniforms(themes.dark),
    b = themeUniforms(themes.dark);
  const rgb = (hex: number) => [
    ((hex >> 16) & 255) / 255,
    ((hex >> 8) & 255) / 255,
    (hex & 255) / 255,
  ];
  expect(a.paints).toEqual(themes.dark.vehiclePaints.flatMap(rgb));
  expect(a.birds).toEqual(themes.dark.birdPaints.flatMap((pair) => pair.flatMap(rgb)));
  expect(a.label).toEqual(rgb(themes.dark.label));
  expect(a).toEqual(b);
  expect(a.paints).not.toBe(b.paints);
  expect(themeUniforms(themes.light).label).not.toEqual(a.label);
});

it('reuses a label upload per target, clearing old glyphs and collisions without sharing maps', () => {
  const uploaded: Uint8Array[] = [];
  const gl = {
    bindTexture: vi.fn(),
    pixelStorei: vi.fn(),
    texSubImage2D: (...args: unknown[]) => uploaded.push(args.at(-1) as Uint8Array),
  } as unknown as GL;
  const targets = { labelCols: 83, labelRows: 37 } as CellTargets;
  const resources = { label: { atlas: { index: () => 2 } } } as unknown as ThemeResources;
  const placement = placeGrid(view, view.labelDev, 83, 37);
  // No rotated street names here, so the street text mesh is never uploaded.
  const programs = { streetText: { vao: null, buffer: null, count: 0 } } as unknown as Programs;
  const label: TileLabel = {
    id: 1,
    text: 'Example',
    lng: 123,
    lat: 13,
    rank: LabelRank.landmark,
    band: { min: 16 },
  };
  const first = overlayPass(gl, targets, resources, view, placement, [label], programs);
  expect(first).toHaveLength(1);
  const buffer = uploaded[0]!,
    snapshot = buffer.slice();
  overlayPass(gl, targets, resources, view, placement, [], programs);
  expect(uploaded[1]).toBe(buffer);
  expect(buffer.every((byte) => byte === 0)).toBe(true);
  expect(overlayPass(gl, targets, resources, view, placement, [label], programs)).toEqual(first);
  expect(buffer).toEqual(snapshot);
  overlayPass(gl, { ...targets }, resources, view, placement, [label], programs);
  expect(uploaded[3]).not.toBe(buffer);
  expect(uploaded[3]).toEqual(snapshot);
  const resized = { ...targets, labelCols: 10, labelRows: 10 };
  overlayPass(gl, resized, resources, view, placement, [], programs);
  expect(uploaded[4]).toHaveLength(400);
});
