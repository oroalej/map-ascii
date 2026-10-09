import { expect, it, vi } from 'vitest';
import * as twgl from 'twgl.js';
import { glyphPass, selectPass, placeGrid, type View } from './passes';
import { cropTint, CROP_STAGE } from './glyphs/select';
import { classId } from './classes';
import { themes } from './theme';
import { themeUniforms } from './theme-uniforms';
import type { GL, CellTargets } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';

it('sets crop uniforms every pass and clears stale state when the calendar is absent', () => {
  const uniforms = vi.spyOn(twgl, 'setUniforms').mockImplementation(() => {});
  const gl = Object.fromEntries(
    [
      'bindFramebuffer',
      'drawBuffers',
      'viewport',
      'useProgram',
      'bindVertexArray',
      'drawArrays',
      'enable',
      'disable',
      'scissor',
    ].map((name) => [name, vi.fn()]),
  ) as unknown as GL;
  const programs = {
    select: { program: {} },
    glyph: { program: {} },
    emptyVao: null,
  } as unknown as Programs;
  const targets = { cols: 10, rows: 10, base: {}, sub: {} } as CellTargets;
  const resources = {
    map: { atlas: { columns: 16, index: () => 0 }, tables: {} },
    label: { cellDev: { w: 10, h: 18 }, atlas: { columns: 16 } },
    uniforms: themeUniforms(themes.dark),
  } as unknown as ThemeResources;
  const view: View = {
    camera: { lat: 0, lng: 0, zoom: 18 },
    dpr: 1,
    cellDev: { w: 10, h: 18 },
    labelDev: { w: 10, h: 18 },
    detailZoom: 18,
    width: 100,
    height: 100,
  };
  const grid = placeGrid(view, view.cellDev, 10, 10).grid;
  const crop = { stage: CROP_STAGE.flooded, progress: 0.2, ...cropTint(CROP_STAGE.flooded) };
  try {
    for (const value of [crop, null]) {
      selectPass(
        gl,
        programs,
        targets,
        resources,
        view,
        grid,
        0,
        { hover: 0, selected: 0, highlight: new Uint32Array(64), highlightCount: 0 },
        { strength: 0, from: 90, dir: [1, 0] },
        null,
        true,
        true,
        value,
      );
      glyphPass(
        gl,
        programs,
        targets,
        resources,
        themes.dark,
        view,
        grid,
        grid,
        0,
        true,
        1,
        undefined,
        0,
        0,
        null,
        undefined,
        0,
        undefined,
        value,
      );
      for (const [, fields] of uniforms.mock.calls.slice(-2))
        expect(fields).toMatchObject({
          u_cropStage: value?.stage ?? -1,
          u_cropProgress: value?.progress ?? 0,
          u_cropTint: value?.tint ?? [1, 1, 1],
          u_cropWaterTint: value?.waterTint ?? [1, 1, 1],
          u_farmlandClass: classId('farmland'),
        });
    }
  } finally {
    uniforms.mockRestore();
  }
});
