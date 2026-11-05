import { describe, expect, it, vi } from 'vitest';
import { lngLatToTile, metersPerUnit, tileToLngLat } from '@atlas/shared';
import { legendEntries } from '../legend';
import { fixturePass, placeGrid, type View } from '../passes';
import type { CellTargets, GL } from '../gpu';
import type { ThemeResources } from '../gpu-context';
import { glyphFragmentFor } from '../shaders/glyph';
import { PALAY_SHOW_SHARE } from './config';
import {
  FixturePart,
  packFixtures,
  palayFixtures,
  type FixtureGrid,
  type PalayFixture,
  type PalayState,
} from './fixtures';
import type { LifeGeometry } from './geometry';
import { DRYING_STRIDE } from './palay';

const COLS = 80,
  ROWS = 40;
const GLYPHS = ['▒', '░', '≡', "'", '▓'];
const glyphIndex = (glyph: string) => GLYPHS.indexOf(glyph) + 1;
const glyphAt = (texels: Uint8Array, at: number) => GLYPHS[texels[at]! - 1]!;
/** Cells per meter in x and y, with the map's 1:1.8 cell shape. */
const gridAt = (perMeterX: number, perMeterY = perMeterX * (5 / 9)): FixtureGrid => ({
  cols: COLS,
  rows: ROWS,
  cellWidth: 5,
  cellHeight: 9,
  toCell: (x, y) => [x * perMeterX, y * perMeterY],
});
/** A strip in meters, along x, starting 10 m in. */
const strip = (hash = 0.1, length = 40, y = 40): PalayFixture => ({
  kind: 'palay',
  from: [10, y],
  to: [10 + length, y],
  across: [10, y + 1],
  hash,
});
const OUT: PalayState = { drying: 1, covered: false, hour: 8 };
const pack = (
  fixtures: PalayFixture[],
  grid: FixtureGrid,
  zoom: number,
  palay: PalayState | null = OUT,
) =>
  packFixtures(
    new Uint8Array(COLS * ROWS * 4),
    grid,
    fixtures,
    zoom,
    glyphIndex,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    palay ?? undefined,
  );
const cells = (texels: Uint8Array) => {
  const out: { c: number; r: number; part: number; glyph: string }[] = [];
  for (let at = 0; at < texels.length; at += 4)
    if (texels[at + 3]! > 0)
      out.push({
        c: (at / 4) % COLS,
        r: Math.floor(at / 4 / COLS),
        part: texels[at + 1]! & 63,
        glyph: glyphAt(texels, at),
      });
  return out;
};

describe('palay strips', () => {
  // About z17: a cell is 2.9 m wide and 5.2 m tall.
  const z17 = gridAt(1 / 2.9, 1 / 5.2);
  // About z19: a quarter of that.
  const z19 = gridAt(4 / 2.9, 4 / 5.2);

  it('stays at least a cell thick with no gaps at z17, in coarse grain', () => {
    const { texels, visibility } = pack([strip()], z17, 17);
    const drawn = cells(texels);
    expect(visibility.palay).toBe(true);
    const columns = new Set(drawn.map((cell) => cell.c));
    const from = Math.floor(10 / 2.9),
      to = Math.floor(50 / 2.9);
    for (let c = from; c <= to; c++) expect(columns.has(c)).toBe(true);
    for (const cell of drawn) {
      expect(cell.part).toBe(FixturePart.palay);
      expect(['▒', '░']).toContain(cell.glyph);
    }
  });

  it('draws raked rows from z19, turning them with an hourly hash', () => {
    const glyphs = (hour: number) =>
      new Set(cells(pack([strip()], z19, 19, { ...OUT, hour }).texels).map((cell) => cell.glyph));
    const seen = new Set<string>();
    for (let hour = 0; hour < 24; hour++) {
      const one = glyphs(hour);
      expect(one.size).toBe(1);
      for (const glyph of one) seen.add(glyph);
    }
    expect([...seen].sort()).toEqual(["'", '≡']);
  });

  it('heaps into about a third of its length under a tarp when covered', () => {
    const open = cells(pack([strip()], z19, 19).texels);
    const heap = cells(pack([strip()], z19, 19, { ...OUT, covered: true }).texels);
    const span = (list: typeof open) =>
      Math.max(...list.map((cell) => cell.c)) - Math.min(...list.map((cell) => cell.c));
    expect(span(heap) / span(open)).toBeCloseTo(1 / 3, 1);
    for (const cell of heap) {
      expect(cell.part).toBe(FixturePart.palayCover);
      expect(cell.glyph).toBe('▓');
    }
  });

  it('shows a strip when its hash is below its share of the drying', () => {
    const shown = (hash: number, drying: number) =>
      cells(pack([strip(hash)], z17, 17, { ...OUT, drying }).texels).length > 0;
    expect(shown(PALAY_SHOW_SHARE - 0.01, 1)).toBe(true);
    expect(shown(PALAY_SHOW_SHARE + 0.01, 1)).toBe(false);
    expect(shown(0.1, 0.5)).toBe(true);
    expect(shown(0.2, 0.5)).toBe(false);
    expect(shown(0.1, 0)).toBe(false);
  });

  it('draws nothing with Life off or below its zoom band', () => {
    const off = pack([strip()], z17, 17, null);
    expect(cells(off.texels)).toEqual([]);
    expect(off.visibility.palay).toBeUndefined();
    const far = pack([strip()], z17, 16);
    expect(cells(far.texels)).toEqual([]);
    expect(far.visibility.palay).toBe(false);
  });

  it('reports palay only when a cell of it is in view', () => {
    const offscreen = { ...z17, visible: () => false };
    expect(pack([strip()], offscreen, 17).visibility.palay).toBe(false);
  });

  it('keeps its glyphs in place when the map pans', () => {
    const glyphs = (shift: number) => {
      const grid = {
        ...z19,
        toCell: (x: number, y: number): [number, number] => [(x * 4) / 2.9 + shift, (y * 4) / 5.2],
      };
      return cells(pack([strip()], grid, 18.5).texels)
        .map((cell) => `${cell.c - shift}/${cell.r}/${cell.glyph}`)
        .sort();
    };
    expect(glyphs(5)).toEqual(glyphs(0));
  });

  it('builds a fixture for every strip of a tile, on the world and a meter across', () => {
    const tile = { z: 16, x: 55_800, y: 30_200 };
    const drying = Float32Array.from([100, 200, 400, 200, 1, 0.25, 500, 600, 500, 900, -1, 0.75]);
    expect(drying.length).toBe(2 * DRYING_STRIDE);
    const fixtures = palayFixtures(tile, { drying } as unknown as LifeGeometry);
    expect(fixtures.map((f) => f.hash)).toEqual([0.25, 0.75]);
    const a = lngLatToTile(tile, ...fixtures[0]!.from);
    expect(a.x).toBeCloseTo(100, 3);
    expect(a.y).toBeCloseTo(200, 3);
    expect(fixtures[0]!.from).toEqual(tileToLngLat(tile, { x: 100, y: 200 }));
    const across = lngLatToTile(tile, ...fixtures[0]!.across);
    expect(Math.hypot(across.x - a.x, across.y - a.y) * metersPerUnit(tile)).toBeCloseTo(1, 2);
  });

  it('adds nothing to a tile with no strips', () => {
    expect(palayFixtures({ z: 16, x: 1, y: 1 }, {} as unknown as LifeGeometry)).toEqual([]);
  });
});

describe('fixturePass with palay', () => {
  const upload = vi.fn();
  const gl = { bindTexture: vi.fn(), pixelStorei: vi.fn(), texSubImage2D: upload } as unknown as GL;
  const resources = { map: { atlas: { index: () => 300 } } } as unknown as ThemeResources;
  const view: View = {
    camera: { lng: 0, lat: 0, zoom: 17 },
    dpr: 1,
    width: 500,
    height: 500,
    cellDev: { w: 5, h: 9 },
    labelDev: { w: 10, h: 18 },
    detailZoom: 20,
  };
  const placement = {
    ...placeGrid(view, view.cellDev, 100, 100),
    toCell: (x: number, y: number): [number, number] => [x, y],
    fromCell: undefined,
  };

  it('packs on a change of state, not per frame, and clears with Life off', () => {
    const targets = { cols: 100, rows: 100, fixtureTex: {}, signalLightTex: {} } as CellTargets;
    const fixtures: PalayFixture[] = [
      { ...strip(), from: [40, 50], to: [60, 50], across: [40, 51] },
    ];
    const pass = (state?: PalayState, zoom = 17) =>
      fixturePass(
        gl,
        targets,
        resources,
        { ...view, camera: { ...view.camera, zoom } },
        placement,
        fixtures,
        0,
        false,
        undefined,
        undefined,
        null,
        state,
      );
    expect(pass(OUT).palay).toBe(true);
    upload.mockClear();
    pass(OUT);
    expect(upload).not.toHaveBeenCalled();
    // The hour only turns rows, which don't show at z17.
    pass({ ...OUT, hour: 9 });
    expect(upload).not.toHaveBeenCalled();
    pass({ ...OUT, covered: true });
    expect(upload).toHaveBeenCalled();
    upload.mockClear();
    expect(pass(undefined).palay).toBeUndefined();
    expect(upload).toHaveBeenCalled();
  });
});

describe('palay in the legend', () => {
  const entry = (palay?: boolean) =>
    legendEntries('dark', 18, [], {
      life: true,
      lights: false,
      fixtures: {
        streetlights: false,
        trafficSignals: false,
        ...(palay === undefined ? {} : { palay }),
      },
    }).find((e) => e.id === 'info:palay');

  it('lists it only while visible', () => {
    expect(entry(true)?.label).toBe('Drying palay (illustrative)');
    expect(entry(false)).toBeUndefined();
    expect(entry()).toBeUndefined();
  });
});

describe('palay shader', () => {
  it.each([
    ['full', {}],
    ['without seasonal ornaments', { seasonal: false }],
    ['with nothing optional', { seasonal: false, focus: false, effectClocks: false }],
  ])('draws both parts %s, under agents', (_, options) => {
    const source = glyphFragmentFor(options);
    expect(source).toContain(`part == ${FixturePart.palay} || part == ${FixturePart.palayCover}`);
    expect(source).toContain('bool groundFixture(vec4 fixture)');
    // The agent mixes over the palay here, where other hardware composes over the agent.
    expect(source).toMatch(
      /groundFixture\(fixture\)\) \{\s+vec3 ground = fixtureOver\(back, fixture[^\n]+\n\s+o_color = vec4\(mistOver\(rainOver\(mix\(ground, color, coverage\)/,
    );
  });

  it('keeps under crowns and off roofs, which a fixture is never allowed', () => {
    const source = glyphFragmentFor({ seasonal: false });
    expect(source).toContain('if (!allowed) return under + halo;');
    expect(source.indexOf('if (!allowed) return under + halo;')).toBeLessThan(
      source.indexOf(`part == ${FixturePart.palay} ||`),
    );
  });

  it('claims parts nothing else uses', () => {
    const parts = Object.entries(FixturePart).filter(([key]) => !['dayStrength'].includes(key));
    const numbers = parts.map(([, value]) => value);
    expect(numbers.filter((n) => n === FixturePart.palay)).toHaveLength(1);
    expect(numbers.filter((n) => n === FixturePart.palayCover)).toHaveLength(1);
  });
});
