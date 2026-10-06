import { expect, it } from 'vitest';
import {
  FixturePart,
  packFixtures,
  tileFixtures,
  updateFixtureSignals,
  FixtureSignalChange,
  updatePedestrianVisibility,
  packSignalLights,
  type StreetFixture,
  type FixtureGrid,
} from './fixtures';
import { pedestrianState } from './signals';
import { mapGlyphs, themes } from '../theme';
import { PED_STOP, PED_WALK } from './pedestrian-glyphs';
import { drawProcedural } from '../glyphs/atlas';
import { signalizedCrossingEntry } from './testing/signalized-crossing';
import { legendEntries } from '../legend';
import { lngLatToTile, tileToLngLat, metersPerUnit } from '../raster/geometry';
import { RoadAccess, stripRing } from './terrain';

const signal: StreetFixture = {
  kind: 'signal',
  base: [30, 30],
  tip: [31, 30],
  forward: [31, 30],
  right: [30, 31],
  seed: 7,
  group: 'b',
  midBlock: false,
};
const ped: StreetFixture = {
  ...signal,
  kind: 'pedestrian-signal',
  crossing: 'test',
  side: 0,
  group: 'a',
};
const grid: FixtureGrid = {
  cols: 80,
  rows: 80,
  cellWidth: 5,
  cellHeight: 9,
  toCell: (x, y) => [x, y],
};
const pack = (fixtures: StreetFixture[], zoom = 19, g = grid, clock = 0) =>
  packFixtures(
    new Uint8Array(g.cols * g.rows * 4),
    g,
    fixtures,
    zoom,
    (s) => mapGlyphs(themes.dark).indexOf(s),
    clock,
  );
it('retains complete vehicle plans while relocating both pedestrian lenses and their support on rotated coarse grids', () => {
  for (const zoom of [18.5, 19, 20])
    for (const angle of [0, 0.35, 1.1, 2.6])
      for (const aspect of [1, 1.8, 3]) {
        const g = {
          ...grid,
          cellHeight: grid.cellWidth * aspect,
          toCell: (x: number, y: number) =>
            [
              30 + (x - 30) * Math.cos(angle) - (y - 30) * Math.sin(angle),
              30 + ((x - 30) * Math.sin(angle) + (y - 30) * Math.cos(angle)) / aspect,
            ] as [number, number],
        };
        const base = pack([signal], zoom, g),
          both = pack([signal, ped], zoom, g);
        for (let at = 0; at < base.texels.length; at += 4)
          if (base.texels[at + 3])
            expect(both.texels.slice(at, at + 4)).toEqual(base.texels.slice(at, at + 4));
        expect(both.signals).toEqual(base.signals);
        expect(both.pedestrians).toHaveLength(1);
        expect(both.pedestrians![0]!.cells).toHaveLength(2);
        const parts = Array.from(both.texels)
          .filter((_, i) => i % 4 === 1)
          .map((v) => v & 63);
        expect(parts).toContain(FixturePart.pedestrianStop);
        expect(parts).toContain(FixturePart.pedestrianWalk);
        expect(parts.filter((p) => p === FixturePart.base).length).toBe(2);
      }
});
it('draws detailed heads only, updates the shared phase at 2 Hz, freezes unchanged clocks and emits no rays', () => {
  expect(pack([ped], 18).pedestrians).toHaveLength(0);
  const p = pack([ped]),
    before = p.texels.slice(),
    flash = Array.from({ length: 1000 }, (_, i) => i / 10).find(
      (t) => pedestrianState(7, t, false, 'a') === 'flash',
    )!;
  expect(updateFixtureSignals(p, flash)).toBe(FixtureSignalChange.pedestrian);
  expect(p.pedestrians![0]!.state).toBe(Math.floor(flash * 2) % 2 === 0 ? 2 : 3);
  expect(updateFixtureSignals(p, flash)).toBe(0);
  updateFixtureSignals(p, flash + 0.5);
  expect(p.pedestrians![0]!.state).toBe(Math.floor((flash + 0.5) * 2) % 2 === 0 ? 2 : 3);
  for (let i = 0; i < before.length; i++) if (i % 4 !== 2) expect(p.texels[i]).toBe(before[i]);
  const rays = new Uint8Array(grid.cols * grid.rows * 4);
  packSignalLights(rays, p, { ...grid, dpr: 1 });
  expect(rays.every((v) => v === 0)).toBe(true);
});
it('reports only visible lenses and gives them their own legend entry', () => {
  const p = pack([ped]);
  expect(p.visibility.pedestrianSignals).toBe(true);
  expect(p.visibility.trafficSignals).toBe(false);
  updatePedestrianVisibility(p, grid.cols, () => false);
  expect(p.visibility.pedestrianSignals).toBeUndefined();
  updatePedestrianVisibility(p, grid.cols, () => true);
  expect(p.visibility.pedestrianSignals).toBe(true);
  const entries = legendEntries('dark', 19, undefined, { fixtures: p.visibility });
  const entry = entries.find((e) => e.id === 'info:pedestrian-signals')!;
  expect(entry.label).toBe('Pedestrian signals (synced with traffic signals)');
  expect(entry.icons).toHaveLength(2);
  expect(entry.icons![0]!.pixels).not.toEqual(entry.icons![1]!.pixels);
  expect(entry.icons![0]!.paint).not.toBe(entry.icons![1]!.paint);
});

it('retains reachable edge heads and rejects unreachable or nonfinite projected bases', () => {
  for (const base of [
    [-12, 20],
    [92, 20],
    [20, -8],
    [20, 92],
    [NaN, 20],
    [Infinity, 20],
  ])
    expect(pack([{ ...ped, base: base as [number, number] }]).pedestrians).toHaveLength(0);
  for (const base of [
    [-11, 20],
    [90, 20],
    [20, -7],
    [20, 91],
  ])
    expect(pack([{ ...ped, base: base as [number, number] }]).pedestrians).toHaveLength(1);
});
it('appends distinct procedural standing and walking symbols after candle slot 408 in both themes', () => {
  for (const theme of Object.values(themes)) {
    const chars = mapGlyphs(theme);
    expect(chars.indexOf(PED_STOP)).toBe(409);
    expect(chars.indexOf(PED_WALK)).toBe(410);
  }
  const bitmaps = [PED_STOP, PED_WALK].map((glyph) => {
    const data = new Uint8Array(11 * 17);
    expect(drawProcedural({ data, stride: 11, x0: 0, y0: 0, w: 11, h: 17 }, glyph)).toBe(true);
    expect(data.some((v) => v > 0)).toBe(true);
    return data;
  });
  expect(bitmaps[0]).not.toEqual(bitmaps[1]);
});
it('owns two synchronized curb heads even when the controller point is outside this tile', () => {
  const entry = signalizedCrossingEntry(),
    fixtures = tileFixtures(entry.tile, entry.life);
  const heads = fixtures.filter((f) => f.kind === 'pedestrian-signal');
  expect(heads).toHaveLength(2);
  expect(heads.every((f) => f.seed === 7 && f.group === 'a')).toBe(true);
  const dropped = structuredClone(entry.life);
  for (const side of dropped.controlledCrossings![0]!.sides!) {
    side.pads = [];
    side.slots = [];
    side.slotIds = [];
  }
  expect(
    tileFixtures(entry.tile, dropped).filter((f) => f.kind === 'pedestrian-signal'),
  ).toHaveLength(2);
  const buffered = structuredClone(dropped);
  for (const crossing of buffered.controlledCrossings!) {
    crossing.anchor.x -= 4096;
    for (const side of crossing.sides!) {
      side.centre.x -= 4096;
      for (const p of side.gate) p.x -= 4096;
    }
  }
  for (const area of buffered.areas ?? [])
    for (const ring of area.rings) for (const point of ring) point.x -= 4096;
  expect(
    tileFixtures({ ...entry.tile, x: entry.tile.x + 1 }, buffered).filter(
      (f) => f.kind === 'pedestrian-signal',
    ),
  ).toHaveLength(0);
});

for (const configuration of [
  'preferred',
  'vehicle-conflict',
  'road-conflict',
  'mid-block',
] as const)
  it(`keeps pedestrian head anchors clear of carriageways and vehicle heads: ${configuration}`, () => {
    const entry = signalizedCrossingEntry(),
      pm = 1 / metersPerUnit(entry.tile),
      crossing = entry.life.controlledCrossings![0]!,
      controller = {
        x: 2000 - (configuration === 'vehicle-conflict' ? 3.2 : 10) * pm,
        y: 2000 + (configuration === 'vehicle-conflict' ? 1.8 : 0) * pm,
      };
    crossing.controller.at = tileToLngLat(entry.tile, controller);
    crossing.controller.midBlock = configuration === 'mid-block';
    entry.life.signals = Float32Array.of(
      controller.x,
      controller.y,
      5,
      crossing.controller.midBlock ? -1 : 90,
      crossing.controller.midBlock ? 90 : 0,
      1,
    );
    entry.life.signalSeeds = [7];
    if (configuration === 'road-conflict')
      entry.life.areas!.push({
        kind: 'carriageway',
        rings: [
          stripRing(
            { x: 2000 + 1.8 * pm, y: 2000 - 12 * pm },
            { x: 2000 + 1.8 * pm, y: 2000 + 12 * pm },
            0.5 * pm,
          ),
        ],
      });
    const fixtures = tileFixtures(entry.tile, entry.life),
      vehicleBases = fixtures
        .filter((f) => f.kind === 'signal')
        .map((f) => lngLatToTile(entry.tile, ...f.base)),
      heads = fixtures.filter((f) => f.kind === 'pedestrian-signal'),
      access = RoadAccess.fromPrepared(
        entry.life.areas!.filter((area) => area.kind === 'carriageway').map((area) => area.rings),
        [],
      );
    expect(vehicleBases.length).toBeGreaterThan(0);
    expect(heads).toHaveLength(2);
    for (const head of heads) {
      const p = lngLatToTile(entry.tile, ...head.base),
        side = crossing.sides![head.side]!;
      expect(
        access.allows(
          [{ ...p, hx: side.inward.x, hy: side.inward.y, length: 0.2 * pm, width: 0.2 * pm }],
          false,
        ),
      ).toBe(true);
      const clearance = (point: { x: number; y: number }) =>
        Math.min(...vehicleBases.map((v) => Math.hypot(v.x - point.x, v.y - point.y) / pm));
      expect(clearance(p)).toBeGreaterThanOrEqual(1.5 - 1e-6);
      if (configuration === 'preferred') expect(p.x).toBeGreaterThan(crossing.anchor.x);
      if (configuration === 'mid-block')
        expect(clearance(p)).toBeGreaterThanOrEqual(
          clearance({ x: 2 * crossing.anchor.x - p.x, y: p.y }) - 1e-6,
        );
    }
    if (configuration === 'vehicle-conflict' || configuration === 'road-conflict')
      expect(
        heads.some((head) => lngLatToTile(entry.tile, ...head.base).x < crossing.anchor.x),
      ).toBe(true);
  });
