import { afterEach, describe, expect, it, vi } from 'vitest';
import { packAgents, unpackAgents } from './agent-frame';
import { LIFE_WAKE, WAKE } from './config';
import { packLife, type LifeGrid } from './draw';
import type { VisibleAgent } from './simulate';
import { LIFE_AGENT_MASK } from './turn-signals';
import { LINE_GLYPHS } from './vehicles';
import { drawWakes, forEachWakeCell } from './wakes';
import { themes } from '../theme';

const COLS = 60;
const ROWS = 40;
/** Coordinates are cells, one meter to the cell, so a pose reads directly. */
const toCell: LifeGrid['toCell'] = (lng, lat) => [lng, lat];
const grid = { cols: COLS, rows: ROWS, toCell };
const glyphs = Object.values(LINE_GLYPHS);
const glyphIndex = (glyph: string) => glyphs.indexOf(glyph as (typeof glyphs)[number]) + 1;

/** A boat at (30.5, 20.5) heading along `hx, hy`, with its right 90° clockwise on screen. */
const boat = (hx: number, hy: number, extra: Partial<VisibleAgent> = {}): VisibleAgent => ({
  kind: 'boat',
  vehicle: 'banca',
  lng: 30.5,
  lat: 20.5,
  ahead: [30.5 + hx, 20.5 + hy],
  side: [30.5 - hy, 20.5 + hx],
  flap: 0,
  wake: 1,
  ...extra,
});

const armCells = (agent: VisibleAgent) => {
  const cells: { col: number; row: number; glyph: string }[] = [];
  forEachWakeCell(agent, toCell, (col, row, glyph) => cells.push({ col, row, glyph }));
  return cells;
};

const blank = () => new Uint8Array(COLS * ROWS * 4);
const wakeTexels = (out: Uint8Array) => {
  let count = 0;
  for (let at = 0; at < out.length; at += 4) if (out[at + 3] === LIFE_WAKE) count++;
  return count;
};

afterEach(() => vi.restoreAllMocks());

describe('wake arms', () => {
  it.each([
    ['east', 1, 0, (c: number) => c < 30.5, () => true],
    ['west', -1, 0, (c: number) => c > 30.5, () => true],
    ['south', 0, 1, () => true, (r: number) => r < 20.5],
    ['north', 0, -1, () => true, (r: number) => r > 20.5],
  ])('trail behind a boat heading %s', (_, hx, hy, colBehind, rowBehind) => {
    const cells = armCells(boat(hx, hy));
    expect(cells.length).toBeGreaterThanOrEqual(WAKE.minCells);
    for (const { col, row } of cells) {
      expect(colBehind(col + 0.5)).toBe(true);
      expect(rowBehind(row + 0.5)).toBe(true);
    }
  });

  it('spreads into two arms either side of the line behind it', () => {
    const cells = armCells(boat(1, 0));
    expect(cells.some((c) => c.row < 20)).toBe(true);
    expect(cells.some((c) => c.row > 20)).toBe(true);
    // ±18° is shallow: the spread stays far smaller than the length.
    const rows = cells.map((c) => c.row);
    const columns = cells.map((c) => c.col);
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(
      Math.max(...columns) - Math.min(...columns),
    );
  });

  it('follows a diagonal heading with a diagonal glyph', () => {
    const r = Math.SQRT1_2;
    const glyphsSeen = new Set(armCells(boat(r, r)).map((c) => c.glyph));
    expect(glyphsSeen.has(LINE_GLYPHS.falling)).toBe(true);
    expect(new Set(armCells(boat(r, -r)).map((c) => c.glyph)).has(LINE_GLYPHS.rising)).toBe(true);
  });

  it('runs longer on a bigger, faster boat, and at least two cells on a slow small one', () => {
    const long = armCells(boat(1, 0, { vehicle: 'motorboat', wake: 1 })).length;
    const short = armCells(boat(1, 0, { vehicle: 'rowboat', wake: 0.15 })).length;
    expect(long).toBeGreaterThan(short);
    // Zoomed out, where a meter is a tenth of a cell, the arms still show.
    const far: LifeGrid['toCell'] = (lng, lat) => [lng * 0.1, lat * 0.1];
    const cells: unknown[] = [];
    forEachWakeCell(boat(1, 0, { vehicle: 'rowboat', wake: 0.15 }), far, (...c) => cells.push(c));
    expect(cells.length).toBeGreaterThanOrEqual(2);
  });

  it('never runs past its longest, however close the zoom', () => {
    const close: LifeGrid['toCell'] = (lng, lat) => [lng * 40, lat * 40];
    const cells: unknown[] = [];
    forEachWakeCell(boat(1, 0, { vehicle: 'motorboat' }), close, (...c) => cells.push(c));
    expect(cells.length).toBeLessThanOrEqual(WAKE.maxCells * 2);
  });

  it('draws nothing for a boat with no wake, or with no pose', () => {
    expect(armCells(boat(1, 0, { wake: undefined }))).toEqual([]);
    expect(armCells(boat(1, 0, { wake: 0 }))).toEqual([]);
    expect(armCells(boat(1, 0, { ahead: undefined }))).toEqual([]);
    expect(armCells(boat(1, 0, { vehicle: undefined }))).toEqual([]);
  });
});

describe('drawWakes', () => {
  it('writes a glyph and the wake byte, with no agent bit', () => {
    const out = blank();
    drawWakes(out, grid, [boat(1, 0)], glyphIndex);
    expect(wakeTexels(out)).toBeGreaterThan(0);
    for (let at = 0; at < out.length; at += 4) {
      if (out[at + 3] !== LIFE_WAKE) continue;
      expect(out[at + 2]! & LIFE_AGENT_MASK).toBe(0);
      expect(out[at]! + out[at + 1]!).toBeGreaterThan(0);
    }
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

  it('stops at the cap, counting boats in frame order', () => {
    // One boat per row, so none shares a cell with another.
    const fleet = Array.from({ length: WAKE.maxPerFrame + 10 }, (_, i) => {
      const row = i % ROWS;
      const col = 10 + ((i - row) / ROWS) * 20;
      return boat(1, 0, {
        vehicle: 'rowboat',
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
      [boat(1, 0, { lng: 0.5, ahead: [1.5, 20.5], side: [0.5, 21.5] })],
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
