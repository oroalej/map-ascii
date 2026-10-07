import { expect, it } from 'vitest';
import { localMetricProjection, type StreetRoute } from '@atlas/shared';
import { formationLayout } from './formation-layout';
import { throng } from './throng';
import { packLife } from './draw';
import { themes, mapGlyphs } from '../theme';
import type { GridPlacement } from '../grid';
it.each([
  [18, 0],
  [16, 0],
  [16, 0.3],
])('packs all 72 contingent blocks at zoom %s and row offset %s', (zoom, offset) => {
  const frame = localMetricProjection([0, 0]),
    q = (x: number, y: number) => frame.from([x, y]),
    cols = 1400,
    rows = 12;
  const route: StreetRoute = {
    id: 'parade',
    kind: 'parade',
    title: { en: 'Parade' },
    status: 'draft',
    schedule: {
      month: 9,
      weekday: 6,
      nth: 3,
      offset_days: 0,
      start: '07:00',
      duration_min: 180,
      timezone: 'UTC',
    },
    route: [q(-6000, 0), q(6000, 0)],
    length_m: 12000,
    segments: [{ id: 'osm:way/1', width_m: 8, clear_m: 8, sidewalk_m: 0 }],
    blocked: [],
    formation: {
      contingents: 72,
      ranks: 8,
      columns: 6,
      bands: 6,
      band: 24,
      color_guard: 8,
      vehicles: [],
    },
  };
  const grid: GridPlacement = {
    grid: { originCol: -cols / 2, originRow: -rows / 2, shiftX: 0, shiftY: 0 },
    toCell: (lng, lat) => {
      const [x, y] = frame.to([lng, lat]);
      return [x / 8 + cols / 2, -y / 2 + rows / 2 + offset];
    },
    fromCell: (c, r) => q((c - cols / 2) * 8, -(r - rows / 2 - offset) * 2),
    tileMatrix: () => [],
  };
  const layout = formationLayout(route),
    payload = throng(route, 0.7, grid, cols, rows, zoom),
    out = new Uint8Array(cols * rows * 4),
    cells: number[] = [],
    glyphs = mapGlyphs(themes.dark);
  packLife(
    out,
    { cols, rows, cellWidth: 10, cellHeight: 18, toCell: grid.toCell },
    [],
    themes.dark,
    (g) => Math.max(0, glyphs.indexOf(g)),
    undefined,
    undefined,
    { throng: payload, throngCells: cells },
  );
  for (const block of layout.blocks) {
    const hits = cells.filter((cell) => {
      const [x] = frame.to(grid.fromCell!((cell % cols) + 0.5, Math.floor(cell / cols) + 0.5));
      const back = layout.head(0.7) - (x + 6000);
      return back >= block.back && back <= block.back + block.length;
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((cell) => out[cell * 4 + 3]! & 15))).toEqual(new Set([block.paint]));
  }
});
