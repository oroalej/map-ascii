import { expect, it, vi } from 'vitest';
import { localMetricProjection, type MassRoute } from '@atlas/shared';
import { throng } from './throng';
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
/** `size` metres per cell; `pan` whole cells east. */
function grid(pan = 0, size = 0.35): GridPlacement {
  return {
    grid: { originCol: pan, originRow: 0, shiftX: 0, shiftY: 0 },
    tileMatrix: () => [],
    fromCell: (c, r) => q((c + pan - cols / 2) * size, -(r - rows / 2) * size),
    toCell: (lng, lat) => {
      const [x, y] = frame.to([lng, lat]);
      return [x / size + cols / 2 - pan, -y / size + rows / 2];
    },
  };
}
const crowd = (placement: GridPlacement, route = event) =>
  throng(route, 0.4, placement, cols, rows, 21, 1, undefined, Infinity);
const glyphs = mapGlyphs(themes.dark);
let lookups = 0;
const lookup = (g: string) => {
  lookups++;
  return Math.max(0, glyphs.indexOf(g));
};
const lifeGlyphs = buildLifeGlyphs(lookup);
function render(
  placement: GridPlacement,
  payload: ReturnType<typeof crowd>,
  options: { theme?: typeof themes.dark; actors?: Parameters<typeof packLife>[2] } = {},
) {
  const out = new Uint8Array(cols * rows * 4),
    cells: number[] = [],
    owners = new Uint32Array(cols * rows);
  packLife(
    out,
    { cols, rows, cellWidth: 10, cellHeight: 18, toCell: placement.toCell },
    options.actors ?? [],
    options.theme ?? themes.dark,
    lookup,
    undefined,
    lifeGlyphs,
    { throng: payload, throngCells: cells, owners },
  );
  return { out, cells, owners };
}
/** Pack until every look has ink. */
function settle(placement: GridPlacement, payload: ReturnType<typeof crowd>) {
  let result = render(placement, payload),
    frames = 0;
  while (payload.stampPending) {
    expect(++frames).toBeLessThan(100);
    result = render(placement, payload);
  }
  return result;
}
it('shares one ink per look across cells, pans and nearby zooms', () => {
  const event2 = { ...event, id: 'mass/share' };
  const placement = grid(0, 0.35),
    payload = crowd(placement, event2);
  const looks = new Set(payload.cells.map((c) => c.look));
  expect(looks.size).toBeLessThan(payload.cells.length / 4);
  const first = settle(placement, payload);
  expect(first.cells.length).toBeGreaterThan(payload.cells.length);
  lookups = 0;
  expect(render(placement, payload)).toEqual(first);
  // A pan rebases the same figures with the same ink.
  const known = new Set(payload.cells.map((c) => c.look));
  const panned = crowd(grid(4, 0.35), event2);
  panned.cells = panned.cells.filter((c) => known.has(c.look));
  const shifted = render(grid(4, 0.35), panned);
  expect(lookups).toBe(0);
  const moved = new Set(shifted.cells.map((c) => c + 4));
  expect(first.cells.filter((c) => c % cols >= 8 && c % cols < cols - 8 && !moved.has(c))).toEqual(
    [],
  );
  // A slightly different zoom quantizes to the same ink scale.
  const nearby = grid(0, 0.351),
    close = crowd(nearby, event2);
  close.cells = close.cells.filter((c) => known.has(c.look));
  render(nearby, close);
  expect(lookups).toBe(0);
});
it('bounds new looks per frame and stands in a recent scale meanwhile', () => {
  // Seated figures double the looks beyond one frame's preparation bound.
  const event2 = {
    ...event,
    id: 'mass/scales',
    site: { ...event.site, seated_grounds: [box(-100, -100, 100, 0)] },
  };
  const near = grid(0, 0.35),
    nearPayload = crowd(near, event2);
  settle(near, nearPayload);
  // Half the metres per cell: a new ink scale, every look prepared afresh.
  const far = grid(0, 0.7),
    payload = crowd(far, event2);
  const looks = new Set(payload.cells.map((c) => c.look)).size;
  expect(looks).toBeGreaterThan(MAX_COLD_THRONG_STAMPS);
  const firstFrame = render(far, payload);
  expect(payload.stampPending).toBe(true);
  // Unprepared looks still draw, with the previous scale's ink.
  const complete = settle(far, payload);
  expect(firstFrame.cells.length).toBeGreaterThan(complete.cells.length * 0.5);
  expect(render(far, payload)).toEqual(complete);
});
it('rechecks whole-figure permission per field version, and occupancy and caps per frame', () => {
  const placement = grid(),
    payload = crowd(placement);
  payload.cells = payload.cells
    .filter((c) => c.col > 20 && c.col < 40 && c.row > 10 && c.row < 20)
    .slice(0, 1);
  expect(payload.cells).toHaveLength(1);
  const first = settle(placement, payload);
  expect(first.cells.length).toBeGreaterThan(1);
  // The same version reuses its decision; a new one asks again.
  const allows = vi.fn(() => false);
  payload.allows = allows;
  expect(render(placement, payload)).toEqual(first);
  expect(allows).not.toHaveBeenCalled();
  payload.version = (payload.version ?? 0) + 1;
  expect(render(placement, payload).cells).toHaveLength(0);
  expect(allows).toHaveBeenCalled();
  payload.allows = () => true;
  payload.version++;
  expect(render(placement, payload)).toEqual(first);
  payload.cap = first.cells.length - 1;
  expect(render(placement, payload).cells).toHaveLength(0);
  payload.cap = 16000;
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
  const blocked = render(placement, payload, { actors: [actor] });
  expect(blocked.cells).toHaveLength(0);
  expect(blocked.owners[first.cells[0]!]).toBe(1);
});
it('prepares ink again for a new theme', () => {
  const placement = grid(),
    payload = crowd(placement);
  settle(placement, payload);
  lookups = 0;
  render(placement, payload, { theme: themes.light });
  expect(lookups).toBeGreaterThan(0);
});
it('keeps compact single-cell ink with exact bytes', () => {
  const placement = grid(0, 1.4),
    payload = crowd(placement);
  payload.cells = payload.cells
    .filter((c) => c.col > 20 && c.col < 40 && c.row > 10 && c.row < 20)
    .slice(0, 1);
  const first = settle(placement, payload);
  expect(first.cells).toHaveLength(1);
  expect(render(placement, payload)).toEqual(first);
  payload.cap = 0;
  expect(render(placement, payload).cells).toHaveLength(0);
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
