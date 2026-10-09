import { labelCandidate } from './label-candidates';
import { gridContains, shiftGrid, windowCells, windowMargin } from './grid';
import { project, unproject } from './camera';
import { expect, it, vi } from 'vitest';
import { buntingWindResponse } from './life/bunting-motion';
import {
  glyphPass,
  fixturePass,
  overlayPass,
  labelObstacles,
  cellPass,
  crownPass,
  placeGrid,
  prepareCrowns,
  selectPass,
  type TileDraw,
  type View,
  type Weather,
} from './passes';
import * as twgl from 'twgl.js';
import { classId, classVisibility, groundFlags } from './classes';
import type { CellTargets, GL } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';
import * as gpuContext from './gpu-context';
import type { TileLabel } from './raster/geometry';
import { LabelRank } from './labels';
import { themes } from './theme';
import { themeUniforms } from './theme-uniforms';
import { LampState } from './life/lights';
import { normalizeFocus } from './focus';

it('dims map cells for folklore-only focus and restores the ordinary glyph program on clear', () => {
  const setters = {
    u_focus: vi.fn(),
    u_focusClasses: vi.fn(),
    u_focusLife: vi.fn(),
  };
  const ordinary = { program: {} as WebGLProgram, uniformSetters: setters };
  const focused = { program: {} as WebGLProgram, uniformSetters: setters };
  const programs = {
    glyph: ordinary,
    glyphVariants: new Map([
      [0, ordinary],
      [1, focused],
    ]),
    emptyVao: null,
  } as unknown as Programs;
  const useProgram = vi.fn();
  const gl = Object.fromEntries(
    ['bindFramebuffer', 'viewport', 'useProgram', 'bindVertexArray', 'drawArrays'].map((k) => [
      k,
      vi.fn(),
    ]),
  ) as unknown as GL;
  gl.useProgram = useProgram;
  const resources = {
    map: { atlas: { columns: 16, index: () => 1 }, tables: {} },
    label: { cellDev: view.labelDev, atlas: { columns: 16 } },
    uniforms: themeUniforms(themes.dark),
  } as unknown as ThemeResources;
  const grid = placeGrid(view, view.cellDev, 80, 34).grid;
  const draw = (focus: ReturnType<typeof normalizeFocus>) =>
    glyphPass(
      gl,
      programs,
      { sub: {} } as CellTargets,
      resources,
      themes.dark,
      view,
      grid,
      grid,
      0,
      false,
      1,
      undefined,
      0,
      0,
      null,
      focus,
    );
  draw(normalizeFocus({ classes: [], life: [], folklore: true }));
  expect(useProgram).toHaveBeenLastCalledWith(focused.program);
  expect(setters.u_focus).toHaveBeenLastCalledWith(true);
  expect(setters.u_focusClasses).toHaveBeenLastCalledWith(new Uint32Array(2));
  expect(setters.u_focusLife).toHaveBeenLastCalledWith(false);
  draw(normalizeFocus(null));
  expect(useProgram).toHaveBeenLastCalledWith(ordinary.program);
  expect(setters.u_focus).toHaveBeenLastCalledWith(false);
});

const view: View = {
  camera: { lat: 13, lng: 123, zoom: 18 },
  dpr: 1,
  cellDev: { w: 10, h: 18 },
  labelDev: { w: 10, h: 18 },
  detailZoom: 18,
  width: 800,
  height: 600,
};

it('sets cloud coordinates, seed and detail explicitly and resets to clear defaults', () => {
  const names = [
    'u_cloudCover',
    'u_cloudSeed',
    'u_cloudDetail',
    'u_meterOrigin',
    'u_meterStep',
    'u_cloudOffset',
  ];
  const setters = Object.fromEntries(names.map((name) => [name, vi.fn()]));
  const programs = {
    glyph: { program: {}, uniformSetters: setters },
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
  const draw = (weather?: Weather) =>
    glyphPass(
      gl,
      programs,
      { sub: {} } as CellTargets,
      resources,
      themes.dark,
      view,
      grid,
      grid,
      0,
      true,
      1,
      weather,
    );
  draw({
    rain: 0,
    wind: null,
    cloudCover: 0.6,
    cloudSeed: 0xf1234567,
    cloudDetail: true,
    meterOrigin: [8150, 123],
    meterStep: [1, 1.8],
    cloudOffset: [4, 5],
  });
  for (const [i, value] of [0.6, 0xf1234567, true, [8150, 123], [1, 1.8], [4, 5]].entries())
    expect(setters[names[i]!]!).toHaveBeenLastCalledWith(value);
  draw();
  for (const [i, value] of [0, 0, false, [0, 0], [0, 0], [0, 0]].entries())
    expect(setters[names[i]!]!).toHaveBeenLastCalledWith(value);
});

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

it('selects the seasonal shader from cached fixture inputs and returns to the ordinary shader', () => {
  const choose = vi.spyOn(gpuContext, 'glyphProgram');
  const gl = Object.fromEntries(
    [
      'bindFramebuffer',
      'viewport',
      'useProgram',
      'bindVertexArray',
      'drawArrays',
      'bindTexture',
      'pixelStorei',
      'texSubImage2D',
    ].map((key) => [key, vi.fn()]),
  ) as unknown as GL;
  const programs = {
    glyph: { program: {}, uniformSetters: {} },
    emptyVao: null,
  } as unknown as Programs;
  const resources = {
    map: { atlas: { columns: 16, index: () => 1 }, tables: {} },
    label: { cellDev: view.labelDev, atlas: { columns: 16 } },
    uniforms: themeUniforms(themes.dark),
  } as unknown as ThemeResources;
  const targets = {
    cols: 80,
    rows: 34,
    sub: {},
    fixtureTex: {},
    signalLightTex: {},
  } as CellTargets;
  const placement = placeGrid(view, view.cellDev, 80, 34);
  const draw = () =>
    glyphPass(
      gl,
      programs,
      targets,
      resources,
      themes.dark,
      view,
      placement.grid,
      placement.grid,
      0,
      true,
      1,
    );
  try {
    fixturePass(gl, targets, resources, view, placement, [], 0, true);
    draw();
    expect(choose.mock.calls.at(-1)![4]).toBe(false);
    fixturePass(
      gl,
      targets,
      resources,
      view,
      placement,
      [{ kind: 'season-bunting', id: 'row', from: [123, 13], to: [123.001, 13], seed: 1 }],
      0,
      true,
    );
    draw();
    expect(choose.mock.calls.at(-1)![4]).toBe(true);
    fixturePass(gl, targets, resources, view, placement, [], 0, true);
    draw();
    expect(choose.mock.calls.at(-1)![4]).toBe(false);
  } finally {
    choose.mockRestore();
  }
});
it.each([
  { zoom: 15, index: 1, margin: false, expected: false },
  { zoom: 16.5, index: 1, margin: false, expected: false },
  { zoom: 17, index: 0, margin: false, expected: false },
  { zoom: 17, index: 1, margin: false, expected: true },
  { zoom: 17, index: 1, margin: true, expected: true },
])('selects seasonal shaders from written ink: %j', ({ zoom, index, margin, expected }) => {
  const choose = vi.spyOn(gpuContext, 'glyphProgram');
  const gl = Object.fromEntries(
    [
      'bindFramebuffer',
      'viewport',
      'useProgram',
      'bindVertexArray',
      'drawArrays',
      'bindTexture',
      'pixelStorei',
      'texSubImage2D',
    ].map((key) => [key, vi.fn()]),
  ) as unknown as GL;
  const programs = {
    glyph: { program: {}, uniformSetters: {} },
    emptyVao: null,
  } as unknown as Programs;
  const resources = {
    map: { atlas: { columns: 16, index: () => index }, tables: {} },
    label: { cellDev: view.labelDev, atlas: { columns: 16 } },
    uniforms: themeUniforms(themes.dark),
  } as unknown as ThemeResources;
  const current = { ...view, height: margin ? 180 : view.height, camera: { ...view.camera, zoom } };
  const targets = {
    cols: 80,
    rows: 34,
    sub: {},
    fixtureTex: {},
    signalLightTex: {},
  } as CellTargets;
  const placement = {
    ...placeGrid(current, current.cellDev, 80, 34),
    toCell: (x: number, y: number): [number, number] => [x, y],
  };
  try {
    const visible = fixturePass(
      gl,
      targets,
      resources,
      current,
      placement,
      [
        {
          kind: 'season-lantern',
          lamp: {
            kind: 'streetlight',
            base: [20, 0],
            tip: [20, margin ? 32 : 20],
            forward: [20, 1],
            right: [21, 0],
            roadCenter: [20, 0],
            seed: 1,
            state: LampState.working,
          },
        },
      ],
      0,
      true,
    );
    if (margin) expect(visible.seasonal?.lanterns).toBe(false);
    glyphPass(
      gl,
      programs,
      targets,
      resources,
      themes.dark,
      current,
      placement.grid,
      placement.grid,
      0,
      true,
      1,
    );
    expect(choose.mock.calls.at(-1)![4]).toBe(expected);
  } finally {
    choose.mockRestore();
  }
});

it('uploads the complete ground array to both base and crown draws', () => {
  const uniforms = vi.spyOn(twgl, 'setUniforms').mockImplementation(() => {});
  const gl = Object.fromEntries(
    [
      'enable',
      'disable',
      'depthFunc',
      'useProgram',
      'bindFramebuffer',
      'viewport',
      'clearBufferfv',
      'clearBufferfi',
      'bindVertexArray',
      'readBuffer',
      'drawBuffers',
      'blitFramebuffer',
    ].map((name) => [name, vi.fn()]),
  ) as unknown as GL;
  const raster = { fbo: {}, width: 83, height: 37 };
  const targets = { cols: 83, rows: 37, base: raster, subBase: raster, sub: raster } as CellTargets;
  const programs = { cell: { program: {} } } as unknown as Programs;
  const placement = placeGrid(view, view.cellDev, 83, 37);
  try {
    cellPass(gl, programs, targets, view, placement, { region: [], tiles: [] });
    crownPass(gl, programs, targets, view, placement, [], 0, { from: 0, strength: 0, dir: [1, 0] });
    const groundUploads = uniforms.mock.calls
      .map(([, values]) => (values as Record<string, unknown>).u_ground)
      .filter((ground): ground is Int32Array => ground instanceof Int32Array);
    expect(groundUploads).toHaveLength(2);
    for (const ground of groundUploads) {
      expect(ground).toEqual(groundFlags());
      expect(ground[classId('building_hospital')]).toBe(1);
      expect(ground[classId('building_station')]).toBe(1);
      expect(ground[classId('road_major')]).toBe(0);
    }
  } finally {
    uniforms.mockRestore();
  }
});

it('allows paving edge sampling only where the cell pass can rasterize paving', () => {
  const uniforms = vi.spyOn(twgl, 'setUniforms').mockImplementation(() => {});
  const gl = {
    bindFramebuffer: vi.fn(),
    viewport: vi.fn(),
    useProgram: vi.fn(),
    bindVertexArray: vi.fn(),
    drawArrays: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    scissor: vi.fn(),
  } as unknown as GL;
  const targets = { cols: 83, rows: 37, base: {}, sub: {} } as CellTargets;
  const programs = { select: { program: {} } } as unknown as Programs;
  const resources = { map: { tables: {} } } as unknown as ThemeResources;
  try {
    for (const zoom of [10, 12, 12.25, 12.5, 18]) {
      // Quality changes glyph detail zoom; class admission follows the camera.
      const changed = { ...view, camera: { ...view.camera, zoom }, detailZoom: 18 };
      const { grid } = placeGrid(changed, changed.cellDev, 83, 37);
      selectPass(
        gl,
        programs,
        targets,
        resources,
        changed,
        grid,
        0,
        { hover: 0, selected: 0, highlight: new Uint32Array(64), highlightCount: 0 },
        { from: 0, strength: 0, dir: [1, 0] },
      );
      expect(uniforms.mock.calls.at(-1)![1]).toMatchObject({
        u_pavingVisible: classVisibility(zoom)[classId('paving')]! > 0,
      });
    }
  } finally {
    uniforms.mockRestore();
  }
});

it('selects only the cells on screen and one more around them in a margin window', () => {
  vi.spyOn(twgl, 'setUniforms').mockImplementation(() => {});
  const gl = {
    bindFramebuffer: vi.fn(),
    viewport: vi.fn(),
    useProgram: vi.fn(),
    bindVertexArray: vi.fn(),
    drawArrays: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    scissor: vi.fn<(x: number, y: number, width: number, height: number) => void>(),
    SCISSOR_TEST: 7,
  };
  const size = windowCells(view, view.cellDev);
  const grid = placeGrid(
    view,
    view.cellDev,
    size.cols,
    size.rows,
    windowMargin(view, view.cellDev),
  ).grid;
  const targets = { cols: size.cols, rows: size.rows, base: {}, sub: {} } as CellTargets;
  const programs = { select: { program: {} } } as unknown as Programs;
  const resources = { map: { tables: {} } } as unknown as ThemeResources;
  const highlights = { hover: 0, selected: 0, highlight: new Uint32Array(0), highlightCount: 0 };
  selectPass(gl as unknown as GL, programs, targets, resources, view, grid, 0, highlights, {
    strength: 0,
    dir: [1, 0],
    from: 90,
  });
  const area = grid.shiftX / view.cellDev.w;
  const [x, y, width, height] = gl.scissor.mock.calls[0]!;
  // From the partly visible cell left of the screen, less one, to one past the right edge.
  expect(x).toBe(Math.ceil(area) - 2);
  expect(y).toBe(Math.ceil(grid.shiftY / view.cellDev.h) - 2);
  expect(x + width).toBe(Math.floor((grid.shiftX + view.width) / view.cellDev.w) + 2);
  expect(y + height).toBe(Math.floor((grid.shiftY + view.height) / view.cellDev.h) + 2);
  expect(width).toBeLessThan(size.cols - 10);
  expect(gl.enable).toHaveBeenCalledWith(7);
  expect(gl.disable).toHaveBeenCalledWith(7);
  vi.restoreAllMocks();
});

it('freezes a margin window and shifts only its offset within it', () => {
  const margin = windowMargin(view, view.cellDev);
  // 1/8 of 800 × 600 px in 10 × 18 px cells.
  expect(margin).toEqual({ cols: 10, rows: 5 });
  const size = windowCells(view, view.cellDev);
  expect(size).toEqual({ cols: 80 + 3 + 20, rows: 34 + 3 + 10 });
  const placement = placeGrid(view, view.cellDev, size.cols, size.rows, margin);
  const plain = placeGrid(view, view.cellDev, 83, 37);
  // The same world, `margin` more cells to the top left.
  expect(placement.grid.originCol).toBe(plain.grid.originCol - 10);
  expect(placement.grid.originRow).toBe(plain.grid.originRow - 5);
  expect(placement.grid.shiftX).toBe(plain.grid.shiftX + 100);
  expect(placement.toCell(123.001, 13.001)[0]).toBeCloseTo(plain.toCell(123.001, 13.001)[0] + 10);
  expect(gridContains(placement.grid, view.cellDev, view, size.cols, size.rows)).toBe(true);
  // Re-placing the same camera into the frozen window reproduces its offset exactly.
  expect(shiftGrid(view, view.cellDev, placement.grid)).toEqual(placement.grid);
  const move = (cells: number) => {
    const [x, y] = project(view.camera.lng, view.camera.lat, view.camera.zoom);
    const [lng, lat] = unproject(x + (cells * view.cellDev.w) / view.dpr, y, view.camera.zoom);
    return { ...view, camera: { ...view.camera, lng, lat } };
  };
  for (const cells of [-9, 9]) {
    const moved = shiftGrid(move(cells), view.cellDev, placement.grid);
    expect(moved.originCol).toBe(placement.grid.originCol);
    expect(
      Math.abs(moved.shiftX - placement.grid.shiftX - cells * view.cellDev.w),
    ).toBeLessThanOrEqual(1);
    expect(gridContains(moved, view.cellDev, view, size.cols, size.rows)).toBe(true);
  }
  for (const cells of [-12, 12])
    expect(
      gridContains(
        shiftGrid(move(cells), view.cellDev, placement.grid),
        view.cellDev,
        view,
        size.cols,
        size.rows,
      ),
    ).toBe(false);
  // Without a margin, the window is the original one-cell neighborhood.
  expect(gridContains(plain.grid, view.cellDev, view, 83, 37)).toBe(true);
  expect(
    gridContains(shiftGrid(move(2), view.cellDev, plain.grid), view.cellDev, view, 83, 37),
  ).toBe(false);
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
  const raw = labelObstacles(targets, { shiftX: 0, shiftY: 0 }, { w: 1, h: 1 }, 1);
  const converted = labelObstacles(targets, { shiftX: 2.5, shiftY: 7.25 }, { w: 10, h: 18 }, 1.5);
  expect(converted).toEqual(
    raw.map((b) => ({
      left: (b.left * 10 - 2.5) / 1.5,
      top: (b.top * 18 - 7.25) / 1.5,
      width: (b.width * 10) / 1.5,
      height: (b.height * 18) / 1.5,
    })),
  );
  converted[0]!.left = -999;
  expect(labelObstacles(targets, { shiftX: 0, shiftY: 0 }, { w: 1, h: 1 }, 1)).toEqual(raw);
  expect(labelObstacles(null, placement.grid, view.labelDev, 1)).toEqual([]);
  overlayPass(gl, targets, resources, view, placement, [], programs);
  expect(labelObstacles(targets, placement.grid, view.labelDev, 1)).toEqual([]);
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
