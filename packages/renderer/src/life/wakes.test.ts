import { afterEach, describe, expect, it, vi } from 'vitest';
import { packAgents, unpackAgents } from './agent-frame';
import { LIFE_WAKE, WAKE } from './config';
import { packLife, type LifeGrid } from './draw';
import type { VisibleAgent } from './simulate';
import { LIFE_AGENT_MASK } from './turn-signals';
import { VEHICLES } from './vehicles';
import { drawWakes, forEachWakeCell } from './wakes';
import { unpackGlyph } from '../glyphs/select';
import { themes } from '../theme';

const COLS = 60;
const ROWS = 40;
/** Coordinates are cells, one meter to the cell, so a pose reads directly. */
const toCell: LifeGrid['toCell'] = (lng, lat) => [lng, lat];
const grid = { cols: COLS, rows: ROWS, toCell };
const glyphs = WAKE.glyphs.map(({ glyph }) => glyph as string);
const glyphIndex = (glyph: string) => glyphs.indexOf(glyph) + 1;

/** A boat at (40.5, 20.5) heading along `hx, hy`, with its right 90° clockwise on screen. */
const boat = (hx: number, hy: number, extra: Partial<VisibleAgent> = {}): VisibleAgent => ({
  kind: 'boat',
  vehicle: 'banca',
  lng: 40.5,
  lat: 20.5,
  ahead: [40.5 + hx, 20.5 + hy],
  side: [40.5 - hy, 20.5 + hx],
  flap: 0,
  wake: 1,
  ...extra,
});

const wakeCells = (agent: VisibleAgent, on: Parameters<typeof forEachWakeCell>[1] = grid) => {
  const cells: { col: number; row: number; foam: number }[] = [];
  forEachWakeCell(agent, on, (col, row, foam) => cells.push({ col, row, foam }));
  return cells;
};
/** Half a banca ahead of its center, one meter to the cell. */
const BOW = 40.5 + VEHICLES.banca.length / 2;

const blank = (cols = COLS, rows = ROWS) => new Uint8Array(cols * rows * 4);
const wakeTexels = (out: Uint8Array) => {
  let count = 0;
  for (let at = 0; at < out.length; at += 4) if (out[at + 3] === LIFE_WAKE) count++;
  return count;
};

afterEach(() => vi.restoreAllMocks());

describe('the wake shape', () => {
  it.each([
    ['east', 1, 0],
    ['west', -1, 0],
    ['south', 0, 1],
    ['north', 0, -1],
  ])('opens behind the bow of a boat heading %s', (_, hx, hy) => {
    const cells = wakeCells(boat(hx, hy), {
      ...grid,
      toCell: (lng, lat) => [lng - 40.5 + 30.5, lat],
    });
    expect(cells.length).toBeGreaterThan(WAKE.minCells);
    for (const { col, row } of cells) {
      // Measured along the heading from the boat's center: no farther ahead than its bow.
      const ahead = (col + 0.5 - 30.5) * hx + (row + 0.5 - 20.5) * hy;
      expect(ahead).toBeLessThanOrEqual(VEHICLES.banca.length / 2 + 0.5);
    }
  });

  it('widens with distance at the Kelvin angle, the same on both sides', () => {
    const cells = wakeCells(boat(1, 0), { cols: 60, rows: 60, toCell });
    // A column well behind the bow: its strongest cell off the keel line is on the crest.
    const behind = 20;
    const column = cells.filter((c) => c.col === Math.floor(BOW - behind));
    const above = column.filter((c) => c.row < 20).sort((a, b) => b.foam - a.foam)[0]!;
    const below = column.filter((c) => c.row > 20).sort((a, b) => b.foam - a.foam)[0]!;
    const crest = behind * Math.tan((WAKE.angle * Math.PI) / 180);
    expect(Math.abs(below.row + 0.5 - 20.5 - crest)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(20.5 - (above.row + 0.5) - crest)).toBeLessThanOrEqual(1.5);
    expect(below.foam).toBeCloseTo(above.foam, 5);
  });

  it('keeps foam between 0 and 1, and thins out with distance', () => {
    const cells = wakeCells(boat(1, 0));
    const mean = (from: number, to: number) => {
      const band = cells.filter((c) => BOW - c.col >= from && BOW - c.col < to);
      return band.reduce((sum, c) => sum + c.foam, 0) / band.length;
    };
    for (const { foam } of cells) {
      expect(foam).toBeGreaterThanOrEqual(WAKE.minFoam);
      expect(foam).toBeLessThanOrEqual(1);
    }
    expect(mean(8, 16)).toBeGreaterThan(mean(16, 24));
    expect(mean(16, 24)).toBeGreaterThan(mean(24, 32));
  });

  it('churns straight behind the stern, and calms between the arms farther back', () => {
    const cells = wakeCells(boat(1, 0));
    const on = (col: number) => cells.find((c) => c.col === col && c.row === 20)!.foam;
    const stern = Math.floor(40.5 - VEHICLES.banca.length / 2) - 1;
    expect(on(stern)).toBeGreaterThan(0.6);
    expect(on(stern - 16)).toBeLessThan(0.35);
  });

  it('is weaker on a slower boat', () => {
    const peak = (wake: number) => Math.max(...wakeCells(boat(1, 0, { wake })).map((c) => c.foam));
    expect(peak(0.2)).toBeLessThan(peak(1));
  });

  it('runs longer on a bigger, faster boat, and at least its minimum on a slow small one', () => {
    const extent = (agent: VisibleAgent, on: LifeGrid['toCell'] = toCell) => {
      const cells = wakeCells(agent, { cols: 400, rows: 40, toCell: on });
      return Math.max(...cells.map((c) => c.col)) - Math.min(...cells.map((c) => c.col));
    };
    const at: Partial<VisibleAgent> = { lng: 200.5, ahead: [201.5, 20.5], side: [200.5, 21.5] };
    const long = extent(boat(1, 0, { ...at, vehicle: 'motorboat', wake: 1 }));
    const short = extent(boat(1, 0, { ...at, vehicle: 'rowboat', wake: 0.15 }));
    expect(long).toBeGreaterThan(short);
    // Zoomed out, where a meter is a tenth of a cell, it still shows.
    const far: LifeGrid['toCell'] = (lng, lat) => [lng * 0.1, lat * 0.1];
    const small = boat(1, 0, { ...at, lng: 2000.5, ahead: [2001.5, 20.5], side: [2000.5, 21.5] });
    expect(extent({ ...small, vehicle: 'rowboat', wake: 0.15 }, far)).toBeGreaterThanOrEqual(
      WAKE.minCells - 1,
    );
  });

  it('never runs past its longest behind the stern, however close the zoom', () => {
    const scale = 40;
    const close: LifeGrid['toCell'] = (lng, lat) => [lng * scale, lat * scale];
    const motorboat = boat(1, 0, { vehicle: 'motorboat', lng: 30, lat: 5 });
    const pose = { ...motorboat, ahead: [31, 5], side: [30, 6] } as VisibleAgent;
    const cells = wakeCells(pose, { cols: 1400, rows: 600, toCell: close });
    const stern = (30 - VEHICLES.motorboat.length / 2) * scale;
    expect(cells.length).toBeGreaterThan(0);
    expect(Math.min(...cells.map((c) => c.col))).toBeGreaterThanOrEqual(stern - WAKE.maxCells - 1);
  });

  it('only visits cells on the grid', () => {
    for (const lng of [0.5, 59.5]) {
      const edge = boat(1, 0, { lng, ahead: [lng + 1, 20.5], side: [lng, 21.5] });
      for (const { col, row } of wakeCells(edge)) {
        expect(col).toBeGreaterThanOrEqual(0);
        expect(col).toBeLessThan(COLS);
        expect(row).toBeGreaterThanOrEqual(0);
        expect(row).toBeLessThan(ROWS);
      }
    }
  });

  it('draws nothing for a boat with no wake, or with no pose', () => {
    expect(wakeCells(boat(1, 0, { wake: undefined }))).toEqual([]);
    expect(wakeCells(boat(1, 0, { wake: 0 }))).toEqual([]);
    expect(wakeCells(boat(1, 0, { ahead: undefined }))).toEqual([]);
    expect(wakeCells(boat(1, 0, { vehicle: undefined }))).toEqual([]);
  });
});

describe('drawWakes', () => {
  it('writes the foam strength and the wake byte, with no agent bit', () => {
    const out = blank();
    drawWakes(out, grid, [boat(1, 0)], glyphIndex);
    expect(wakeTexels(out)).toBeGreaterThan(0);
    for (let at = 0; at < out.length; at += 4) {
      if (out[at + 3] !== LIFE_WAKE) continue;
      expect(out[at + 2]! & LIFE_AGENT_MASK).toBe(0);
      expect(unpackGlyph(out[at]!, out[at + 1]!).cls).toBeGreaterThan(0);
    }
  });

  it('gives strong foam a glyph and leaves weak foam as a tint over the water', () => {
    const out = blank();
    drawWakes(out, grid, [boat(1, 0)], glyphIndex);
    const levels = new Map<number, number[]>();
    for (let at = 0; at < out.length; at += 4) {
      if (out[at + 3] !== LIFE_WAKE) continue;
      const { glyph, cls } = unpackGlyph(out[at]!, out[at + 1]!);
      levels.set(glyph, [...(levels.get(glyph) ?? []), cls]);
    }
    // No glyph, then each foam glyph in turn, weakest to strongest.
    const mean = (glyph: number) => {
      const all = levels.get(glyph)!;
      return all.reduce((sum, level) => sum + level, 0) / all.length;
    };
    expect(mean(0)).toBeLessThan(mean(glyphIndex('·')));
    expect(mean(glyphIndex('·'))).toBeLessThan(mean(glyphIndex('~')));
    expect(mean(glyphIndex('~'))).toBeLessThan(mean(glyphIndex('≈')));
  });

  it('leaves an occupied cell exactly as it was', () => {
    const clear = blank();
    drawWakes(clear, grid, [boat(1, 0)], glyphIndex);
    const taken: number[] = [];
    for (let at = 0; at < clear.length; at += 4) if (clear[at + 3] === LIFE_WAKE) taken.push(at);
    const out = blank();
    for (const [i, at] of taken.entries()) {
      // An agent, a bird's shadow, a ground shadow: anything already there stays.
      out.set(i % 2 ? [9, 0, 2, 40] : [0, 0, 0, 1], at);
    }
    const before = out.slice();
    drawWakes(out, grid, [boat(1, 0)], glyphIndex);
    expect(out).toEqual(before);
  });

  it('keeps its speckle on the water when the map pans', () => {
    const at =
      (shift: number): LifeGrid['toCell'] =>
      (lng, lat) => [lng + shift, lat];
    const first = blank();
    const panned = blank();
    drawWakes(
      first,
      { ...grid, toCell: at(0) },
      [boat(1, 0, { lng: 30.5, ahead: [31.5, 20.5], side: [30.5, 21.5] })],
      glyphIndex,
    );
    drawWakes(
      panned,
      { ...grid, toCell: at(7) },
      [boat(1, 0, { lng: 30.5, ahead: [31.5, 20.5], side: [30.5, 21.5] })],
      glyphIndex,
    );
    let compared = 0;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS - 7; col++) {
        const from = (row * COLS + col) * 4;
        const to = (row * COLS + col + 7) * 4;
        // The first frame clips at the left edge and the second loses the columns past col 7's end.
        if (first[from + 3] !== LIFE_WAKE) continue;
        compared++;
        expect(Array.from(panned.subarray(to, to + 4))).toEqual(
          Array.from(first.subarray(from, from + 4)),
        );
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  it('stops at the cap, counting boats in frame order', () => {
    // A slow small boat on every row, so most of each wake is its own.
    const fleet = Array.from({ length: WAKE.maxPerFrame + 10 }, (_, i) => {
      const row = i % ROWS;
      const col = 20 + ((i - row) / ROWS) * 20;
      return boat(1, 0, {
        vehicle: 'rowboat',
        wake: 0.2,
        lng: col + 0.5,
        lat: row + 0.5,
        ahead: [col + 1.5, row + 0.5],
        side: [col + 0.5, row + 1.5],
      });
    });
    const capped = blank();
    drawWakes(capped, grid, fleet, glyphIndex);
    const exact = blank();
    drawWakes(exact, grid, fleet.slice(0, WAKE.maxPerFrame), glyphIndex);
    expect(capped).toEqual(exact);
  });

  it('stops once a frame has looked at its budget of cells', () => {
    // Close enough that each wake is a big box, far apart enough not to share cells.
    const big = {
      cols: 3000,
      rows: 200,
      toCell: ((lng, lat) => [lng * 3, lat * 3]) as LifeGrid['toCell'],
    };
    const fleet = Array.from({ length: 24 }, (_, i) => {
      const lng = 60 + i * 40;
      return boat(1, 0, {
        lng,
        lat: 30,
        ahead: [lng + 1, 30],
        side: [lng, 31],
        vehicle: 'motorboat',
      });
    });
    let spent = 0;
    let within = 0;
    while (within < fleet.length && spent < WAKE.maxVisits) {
      spent += forEachWakeCell(fleet[within]!, big, () => {});
      within++;
    }
    expect(within).toBeLessThan(fleet.length);
    const capped = new Uint8Array(big.cols * big.rows * 4);
    drawWakes(capped, big, fleet, glyphIndex);
    const exact = new Uint8Array(big.cols * big.rows * 4);
    drawWakes(exact, big, fleet.slice(0, within), glyphIndex);
    expect(Buffer.compare(capped, exact)).toBe(0);
  });

  it('skips boats with no wake without counting them', () => {
    const idle = Array.from({ length: WAKE.maxPerFrame + 1 }, () =>
      boat(1, 0, { wake: undefined }),
    );
    const out = blank();
    drawWakes(out, grid, [...idle, boat(1, 0)], glyphIndex);
    expect(wakeTexels(out)).toBeGreaterThan(0);
  });

  it('clips at the grid and draws no randomness', () => {
    const random = vi.spyOn(Math, 'random');
    const out = blank();
    drawWakes(
      out,
      grid,
      [boat(1, 0, { lng: -60, ahead: [-59, 20.5], side: [-60, 21.5] })],
      glyphIndex,
    );
    expect(wakeTexels(out)).toBe(0);
    expect(random).not.toHaveBeenCalled();
  });
});

describe('packLife wakes', () => {
  const lifeGrid: LifeGrid = { ...grid, cellWidth: 5, cellHeight: 9 };
  const pack = (agents: VisibleAgent[], wakes: boolean) => {
    const out = blank();
    const glyphLookup = (glyph: string) => glyph.codePointAt(0)! % 900 || 1;
    const drawn = packLife(out, lifeGrid, agents, themes.dark, glyphLookup, null, undefined, {
      wakes,
    });
    return { out, drawn };
  };

  it('needs the water detail, and never changes who is admitted', () => {
    const fleet = [boat(1, 0)];
    const off = pack(fleet, false);
    const on = pack(fleet, true);
    expect(wakeTexels(off.out)).toBe(0);
    expect(wakeTexels(on.out)).toBeGreaterThan(0);
    expect(on.drawn).toBe(off.drawn);
    // Every agent cell is the same; a wake only fills what was empty.
    for (let at = 0; at < off.out.length; at += 4) {
      if (off.out[at + 2]! & LIFE_AGENT_MASK) {
        expect(Array.from(on.out.subarray(at, at + 4))).toEqual(
          Array.from(off.out.subarray(at, at + 4)),
        );
      }
    }
  });
});

describe('the packed frame', () => {
  it('carries a wake, and no wake, losslessly', () => {
    const agents = [boat(1, 0, { wake: 0.42 }), boat(0, 1, { wake: undefined })];
    delete agents[1]!.wake;
    const [first, second] = unpackAgents(packAgents(agents));
    expect(first!.wake).toBe(0.42);
    expect('wake' in second!).toBe(false);
  });
});
