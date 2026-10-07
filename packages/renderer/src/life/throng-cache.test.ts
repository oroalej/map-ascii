import { expect, it, vi } from 'vitest';
import { localMetricProjection, type MassRoute } from '@atlas/shared';
import { throng, MAX_COLD_FINE_THRONG_CELLS } from './throng';
import { CrowdMaskRaster } from './crowd-mask';
import { makeCellGuard } from './cell-guard';
import { groundForRoute } from './ground-events';
import { packLife, buildLifeGlyphs, MAX_COLD_THRONG_STAMPS } from './draw';
import { mapGlyphs, themes } from '../theme';
import type { GridPlacement } from '../grid';
const frame = localMetricProjection([0, 0]),
  q = (x: number, y: number) => frame.from([x, y]);
const box = (w: number, s: number, e: number, n: number) => [
  q(w, s),
  q(e, s),
  q(e, n),
  q(w, n),
  q(w, s),
];
const event: MassRoute = {
  id: 'mass/cache',
  kind: 'mass',
  status: 'draft',
  title: { en: 'Test' },
  schedule: {
    month: 9,
    weekday: 6,
    nth: 3,
    offset_days: 0,
    start: '12:00',
    duration_min: 90,
    timezone: 'UTC',
  },
  site: {
    id: 'osm:way/1',
    location: q(0, 0),
    anchor: q(0, 0),
    radius_m: 100,
    grounds: [box(-100, -100, 100, 100)],
    blocked: [],
    approaches: [],
    roads: [],
  },
};
const cols = 64,
  rows = 32;
function grid(pan = 0): GridPlacement {
  return {
    grid: { originCol: pan, originRow: 0, shiftX: 0, shiftY: 0 },
    world: [1, 1, pan, 0],
    tileMatrix: () => [],
    fromCell: (c, r) => q((c + pan - cols / 2) * 0.35, -(r - rows / 2) * 0.35),
    toCell: (lng, lat) => {
      const [x, y] = frame.to([lng, lat]);
      return [x / 0.35 + cols / 2 - pan, -y / 0.35 + rows / 2];
    },
  };
}
function settled(placement: GridPlacement) {
  let payload = throng(event, 0.4, placement, cols, rows, 21);
  while (payload.pending) payload = throng(event, 0.4, placement, cols, rows, 21);
  return payload;
}
const glyphs = mapGlyphs(themes.dark),
  lookup = (g: string) => Math.max(0, glyphs.indexOf(g)),
  lifeGlyphs = buildLifeGlyphs(lookup);
it('bounds detailed preparation and reuses geographic classifications during progress and integer pans', () => {
  const placement = grid(),
    spy = vi.spyOn(CrowdMaskRaster.prototype, 'mask');
  try {
    const initial = throng(event, 0.4, placement, cols, rows, 21);
    expect(initial.pending).toBe(true);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2 * MAX_COLD_FINE_THRONG_CELLS);
    const complete = settled(placement),
      queries = spy.mock.calls.length;
    expect(complete.cells.length).toBeGreaterThan(initial.cells.length);
    expect(throng(event, 0.5, placement, cols, rows, 21).pending).toBeUndefined();
    expect(spy.mock.calls.length).toBe(queries);
    const panned = settled(grid(1));
    expect(spy.mock.calls.length - queries).toBeLessThanOrEqual(2 * rows);
    const before = complete.cells.find(
      (c) => c.col > 10 && c.col < 50 && c.row > 10 && c.row < 20,
    )!;
    expect(panned.cells.find((c) => c.col === before.col - 1 && c.row === before.row)?.stamp).toBe(
      before.stamp,
    );
  } finally {
    spy.mockRestore();
  }
});
it('reuses complete static ink while rechecking collision, permissions, caps and theme', () => {
  const placement = grid(),
    payload = settled(placement);
  payload.cells = payload.cells
    .filter((c) => c.col > 20 && c.col < 40 && c.row > 10 && c.row < 20)
    .slice(0, 1);
  expect(payload.cells).toHaveLength(1);
  const render = (allows = () => true, cap = 16000, theme = themes.dark) => {
    payload.cap = cap;
    const out = new Uint8Array(cols * rows * 4),
      cells: number[] = [],
      owners = new Uint32Array(cols * rows);
    packLife(
      out,
      {
        cols,
        rows,
        cellWidth: 10,
        cellHeight: 18,
        toCell: placement.toCell,
        allowsGroundCell: allows,
      },
      [],
      theme,
      lookup,
      undefined,
      lifeGlyphs,
      { throng: payload, throngCells: cells, owners },
    );
    return { out, cells, owners };
  };
  const first = render(),
    stamp = payload.cells[0]!.stamp!.cells;
  expect(first.cells.length).toBeGreaterThan(1);
  expect(stamp).toBeDefined();
  expect(render()).toEqual(first);
  expect(payload.cells[0]!.stamp!.cells).toBe(stamp);
  expect(render(() => false).cells).toHaveLength(0);
  expect(render(() => true, first.cells.length - 1).cells).toHaveLength(0);
  render(() => true, 16000, themes.light);
  expect(payload.cells[0]!.stamp!.theme).toBe(themes.light);
  render();
  let permitted = true;
  const dynamicGuard = () => permitted;
  expect(render(dynamicGuard).cells).toEqual(first.cells);
  permitted = false;
  expect(render(dynamicGuard).cells).toHaveLength(0);
  const pairedGuard = Object.assign(
    vi.fn(() => true),
    { terrainKey: {}, hardTerrainKey: {} },
  );
  render(pairedGuard);
  const checked = pairedGuard.mock.calls.length;
  render(pairedGuard);
  expect(pairedGuard.mock.calls.length).toBe(checked);
  const replacementGuard = Object.assign(() => false, { terrainKey: {}, hardTerrainKey: {} });
  expect(render(replacementGuard).cells).toHaveLength(0);
  const [lng, lat] = placement.fromCell!(
    (first.cells[0]! % cols) + 0.5,
    Math.floor(first.cells[0]! / cols) + 0.5,
  );
  const actor = {
    kind: 'person' as const,
    lng,
    lat,
    flap: 0,
    prop: 'event' as const,
    glyph: '@',
    eventGround: event.id,
  };
  const out = new Uint8Array(cols * rows * 4),
    owners = new Uint32Array(cols * rows),
    cells: number[] = [];
  packLife(
    out,
    { cols, rows, cellWidth: 10, cellHeight: 18, toCell: placement.toCell },
    [actor],
    themes.dark,
    lookup,
    undefined,
    lifeGlyphs,
    { throng: payload, throngCells: cells, owners },
  );
  expect(cells).toHaveLength(0);
  expect(owners[first.cells[0]!]).toBe(1);
  const panned = settled(grid(1));
  panned.cells = panned.cells.filter((c) => c.stamp === payload.cells[0]!.stamp);
  expect(panned.cells).toHaveLength(1);
  const shifted = new Uint8Array(cols * rows * 4),
    shiftedCells: number[] = [];
  packLife(
    shifted,
    { cols, rows, cellWidth: 10, cellHeight: 18, toCell: grid(1).toCell },
    [],
    themes.dark,
    lookup,
    undefined,
    lifeGlyphs,
    { throng: panned, throngCells: shiftedCells },
  );
  expect(shiftedCells).toEqual(first.cells.map((c) => c - 1));
});
it('retains a dense viewport of cell permissions instead of flushing on every frame', () => {
  const ground = groundForRoute(event),
    blocked = { hits: vi.fn(() => false) },
    empty = { hits: () => false };
  const tile = { z: 16, x: 32768, y: 32768 },
    perMeter = 1;
  const guard = makeCellGuard(
    { tile, perMeter },
    { roads: empty, forbidden: empty },
    empty,
    (lng, lat) => [lng * 1e5, -lat * 1e5],
    new Map([[event.id, ground]]),
    blocked,
  );
  const agent = { kind: 'person' as const, lng: 0, lat: 0, flap: 0, eventGround: event.id };
  for (let i = 0; i < 5000; i++) guard(agent, i % 100, Math.floor(i / 100));
  const cold = blocked.hits.mock.calls.length;
  for (let i = 0; i < 5000; i++) guard(agent, i % 100, Math.floor(i / 100));
  expect(blocked.hits.mock.calls.length).toBe(cold);
});
it('reuses compact single-cell ink with exact bytes, cap and permission checks', () => {
  const placement: GridPlacement = {
    ...grid(),
    world: [4, 4, 0, 0],
    fromCell: (c, r) => q((c - cols / 2) * 1.4, -(r - rows / 2) * 1.4),
    toCell: (lng, lat) => {
      const [x, y] = frame.to([lng, lat]);
      return [x / 1.4 + cols / 2, -y / 1.4 + rows / 2];
    },
  };
  const payload = settled(placement);
  payload.cells = payload.cells
    .filter((c) => c.col > 20 && c.col < 40 && c.row > 10 && c.row < 20)
    .slice(0, 1);
  const render = (cap = 16000, allowed = true) => {
    payload.cap = cap;
    const out = new Uint8Array(cols * rows * 4),
      cells: number[] = [];
    packLife(
      out,
      {
        cols,
        rows,
        cellWidth: 10,
        cellHeight: 18,
        toCell: placement.toCell,
        allowsGroundCell: () => allowed,
      },
      [],
      themes.dark,
      lookup,
      undefined,
      lifeGlyphs,
      { throng: payload, throngCells: cells },
    );
    return { out, cells };
  };
  const first = render();
  expect(first.cells).toHaveLength(1);
  expect(payload.cells[0]!.stamp?.single).toHaveLength(3);
  expect(payload.cells[0]!.stamp?.bytes).toBeUndefined();
  expect(render()).toEqual(first);
  expect(render(0).cells).toHaveLength(0);
  expect(render(16000, false).out.every((b) => b === 0)).toBe(true);
});
it('bounds new figure ink after a sudden arrival or theme change and eventually fills it', () => {
  const placement = grid(),
    payload = settled(placement),
    out = new Uint8Array(cols * rows * 4);
  // Classifications are already warm: ink still must not all materialize in one frame.
  for (const cell of payload.cells)
    if (cell.stamp)
      Object.assign(cell.stamp, {
        cells: undefined,
        bytes: undefined,
        single: undefined,
        complete: undefined,
      });
  const render = () =>
    packLife(
      out,
      { cols, rows, cellWidth: 10, cellHeight: 18, toCell: placement.toCell },
      [],
      themes.dark,
      lookup,
      undefined,
      lifeGlyphs,
      { throng: payload },
    );
  render();
  expect(payload.stampPending).toBe(true);
  expect(payload.cells.filter((c) => c.stamp?.complete !== undefined).length).toBeLessThanOrEqual(
    MAX_COLD_THRONG_STAMPS,
  );
  let frames = 0;
  while (payload.stampPending) {
    expect(++frames).toBeLessThan(100);
    render();
  }
  expect(payload.cells.every((c) => c.stamp?.complete !== undefined)).toBe(true);
  const complete = out.slice();
  render();
  expect(out).toEqual(complete);
});
