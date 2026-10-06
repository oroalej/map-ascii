import { expect, it } from 'vitest';
import {
  FixturePart,
  packFixtures,
  tileFixtures,
  updateFixtureSignals,
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
  expect(updateFixtureSignals(p, flash)).toBe(true);
  expect(p.pedestrians![0]!.state).toBe(Math.floor(flash * 2) % 2 === 0 ? 2 : 3);
  expect(updateFixtureSignals(p, flash)).toBe(false);
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
  expect(entries.find((e) => e.id === 'info:pedestrian-signals')?.label).toBe(
    'Pedestrian signals (synced with traffic signals)',
  );
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
});
