import { labelCandidate } from './label-candidates';
import { expect, it, vi } from 'vitest';
import {
  glyphPass,
  overlayPass,
  placeGrid,
  prepareCrowns,
  type TileDraw,
  type View,
} from './passes';
import type { CellTargets, GL } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';
import type { TileLabel } from './raster/geometry';
import { LabelRank } from './labels';
import { themes } from './theme';
import { themeUniforms } from './theme-uniforms';
import { buntingWindResponse } from './life/bunting-motion';

const view: View = {
  camera: { lat: 13, lng: 123, zoom: 18 },
  dpr: 1,
  cellDev: { w: 10, h: 18 },
  labelDev: { w: 10, h: 18 },
  detailZoom: 18,
  width: 800,
  height: 600,
};

it('supplies wind-driven bunting independently of Life and stills it for Calm or reduced motion', () => {
  const strength = vi.fn(),
    direction = vi.fn(),
    shimmer = vi.fn();
  const programs = {
    glyph: {
      program: {},
      uniformSetters: { u_buntingWind: strength, u_buntingWindDir: direction, u_shimmer: shimmer },
    },
    emptyVao: null,
  } as unknown as Programs;
  const gl = {
    bindFramebuffer: vi.fn(),
    viewport: vi.fn(),
    useProgram: vi.fn(),
    bindVertexArray: vi.fn(),
    drawArrays: vi.fn(),
  } as unknown as GL;
  const resources = {
    map: { atlas: { columns: 16, index: () => 1 }, tables: {} },
    label: { cellDev: view.labelDev, atlas: { columns: 16 } },
    uniforms: themeUniforms(themes.dark),
  } as unknown as ThemeResources;
  const grid = placeGrid(view, view.cellDev, 80, 34).grid;
  const draw = (
    wind: { strength: number; dir: [number, number]; from: number } | null,
    reduced = false,
  ) =>
    glyphPass(
      gl,
      programs,
      { sub: {} } as CellTargets,
      resources,
      themes.dark,
      view,
      grid,
      grid,
      7,
      reduced,
      1,
      { rain: 0, wind },
    );
  draw({ strength: 0.7, dir: [-1, 0], from: 90 });
  expect(strength).toHaveBeenLastCalledWith(buntingWindResponse(0.7));
  expect(direction).toHaveBeenLastCalledWith([-1, 0]);
  expect(shimmer).toHaveBeenLastCalledWith(true);
  draw({ strength: 1.5, dir: [0, 1], from: 0 });
  expect(strength).toHaveBeenLastCalledWith(1);
  expect(direction).toHaveBeenLastCalledWith([0, 1]);
  draw({ strength: 0.325, dir: [0, 1], from: 0 });
  expect(strength).toHaveBeenLastCalledWith(0);
  draw({ strength: 1.5, dir: [0, 1], from: 0 }, true);
  expect(strength).toHaveBeenLastCalledWith(0);
  expect(shimmer).toHaveBeenLastCalledWith(false);
  draw(null);
  expect(strength).toHaveBeenLastCalledWith(0);
  expect(direction).toHaveBeenLastCalledWith([0, 0]);
});

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
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
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
  const first = overlayPass(
    gl,
    targets,
    resources,
    view,
    placement,
    [labelCandidate(label, view, placement)!],
    programs,
  );
  expect(first).toHaveLength(1);
  const buffer = uploaded[0]!,
    snapshot = buffer.slice();
  overlayPass(gl, targets, resources, view, placement, [], programs);
  expect(uploaded[1]).toBe(buffer);
  expect(buffer.every((byte) => byte === 0)).toBe(true);
  expect(
    overlayPass(
      gl,
      targets,
      resources,
      view,
      placement,
      [labelCandidate(label, view, placement)!],
      programs,
    ),
  ).toEqual(first);
  expect(buffer).toEqual(snapshot);
  programs.streetText.count = 6;
  const hidden = { ...view, camera: { ...view.camera, zoom: 16 } };
  expect(
    overlayPass(
      gl,
      targets,
      resources,
      hidden,
      placement,
      [label].flatMap((label) => labelCandidate(label, hidden, placement) ?? []),
      programs,
    ),
  ).toEqual([]);
  expect(buffer.every((byte) => byte === 0)).toBe(true);
  expect(programs.streetText.count).toBe(0);
  expect(
    overlayPass(
      gl,
      targets,
      resources,
      view,
      placement,
      [labelCandidate(label, view, placement)!],
      programs,
    ),
  ).toEqual(first);
  overlayPass(
    gl,
    { ...targets },
    resources,
    view,
    placement,
    [labelCandidate(label, view, placement)!],
    programs,
  );
  expect(uploaded[5]).not.toBe(buffer);
  expect(uploaded[5]).toEqual(snapshot);
  const resized = { ...targets, labelCols: 10, labelRows: 10 };
  overlayPass(gl, resized, resources, view, placement, [], programs);
  expect(uploaded[6]).toHaveLength(400);
});
