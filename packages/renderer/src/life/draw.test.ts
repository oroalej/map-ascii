import { describe, expect, it } from 'vitest';
import { classId } from '../classes';
import { themes } from '../theme';
import { agentBit, CellBit } from './config';
import { packLife, vehicleByte, type LifeGrid } from './draw';
import type { VisibleAgent } from './simulate';
import { Paint, VehiclePart } from './vehicles';

const glyphs = ['', '▬', '▮', '☺', '◊', 'v', '-', '█', '▓', '▒', '•', '▪', '·'];
const glyphIndex = (g: string) => Math.max(0, glyphs.indexOf(g));
/** lng → column and lat → row, one cell per degree. */
const grid: LifeGrid = {
  cols: 10,
  rows: 5,
  cellWidth: 10,
  cellHeight: 18,
  toCell: (lng, lat) => [lng, lat],
};
const cell = (out: Uint8Array, col: number, row: number) =>
  Array.from(out.subarray((row * grid.cols + col) * 4, (row * grid.cols + col) * 4 + 4));

describe('packLife', () => {
  it('writes the glyph, the life class, and the agent bit', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    const drawn = packLife(
      out,
      grid,
      [{ kind: 'person', lng: 2.5, lat: 1.2, flap: 0 }],
      themes.dark,
      glyphIndex,
    );
    expect(drawn).toBe(1);
    expect(cell(out, 2, 1)).toEqual([
      glyphIndex('☺'),
      classId('life_person'),
      agentBit.person,
      255,
    ]);
  });

  it('turns vehicles with their heading on screen', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    packLife(
      out,
      grid,
      [
        { kind: 'vehicle', lng: 1, lat: 1, ahead: [1.5, 1.1], flap: 0 },
        { kind: 'vehicle', lng: 4, lat: 1, ahead: [4.1, 1.5], flap: 0 },
      ],
      themes.dark,
      glyphIndex,
    );
    expect(cell(out, 1, 1)[0]).toBe(glyphIndex('▬'));
    expect(cell(out, 4, 1)[0]).toBe(glyphIndex('▮'));
  });

  it('beats birds’ wings, skips agents off the grid, and clears what was there', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4).fill(9);
    const drawn = packLife(
      out,
      grid,
      [
        { kind: 'bird', lng: 3, lat: 3, flap: 1 },
        { kind: 'boat', lng: -1, lat: 3, flap: 0 },
        { kind: 'boat', lng: 3, lat: 9, flap: 0 },
      ],
      themes.dark,
      glyphIndex,
    );
    expect(drawn).toBe(1);
    expect(cell(out, 3, 3)[0]).toBe(glyphIndex('-'));
    expect(cell(out, 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('packLife vehicles', () => {
  const big: LifeGrid = { ...grid, cols: 40, rows: 30 };
  /** A car at (20, 15) heading along (`dx`, `dy`), `scale` cells per meter. */
  const car = (dx: number, dy: number, scale: number): VisibleAgent => ({
    kind: 'vehicle',
    lng: 20,
    lat: 15,
    ahead: [20 + dx * scale, 15 + dy * scale],
    // The right of the heading, with rows counting down the screen.
    side: [20 - dy * scale, 15 + dx * scale],
    vehicle: 'car',
    paint: Paint.red,
    flap: 0,
  });
  const cells = (out: Uint8Array) => {
    const found: { col: number; row: number; texel: number[] }[] = [];
    for (let row = 0; row < big.rows; row++) {
      for (let col = 0; col < big.cols; col++) {
        const at = (row * big.cols + col) * 4;
        if (out[at + 2]) found.push({ col, row, texel: Array.from(out.subarray(at, at + 4)) });
      }
    }
    return found;
  };
  const pack = (agent: VisibleAgent) => {
    const out = new Uint8Array(big.cols * big.rows * 4);
    const drawn = packLife(out, big, [agent], themes.dark, glyphIndex);
    return { drawn, found: cells(out) };
  };
  const span = (values: number[]) => Math.max(...values) - Math.min(...values) + 1;

  it('is one glyph while it covers under a couple of cells, with its paint', () => {
    const { drawn, found } = pack(car(1, 0, 0.3));
    expect(drawn).toBe(1);
    expect(found).toEqual([
      {
        col: 20,
        row: 15,
        texel: [
          glyphIndex('▬'),
          classId('life_vehicle'),
          agentBit.vehicle,
          vehicleByte(Paint.red, VehiclePart.mini),
        ],
      },
    ]);
  });

  it('grows to its real size, long along its heading', () => {
    const east = pack(car(1, 0, 1)).found;
    expect(span(east.map((c) => c.col))).toBe(4);
    expect(span(east.map((c) => c.row))).toBe(2);
    const south = pack(car(0, 1, 1)).found;
    expect(span(south.map((c) => c.col))).toBe(2);
    expect(span(south.map((c) => c.row))).toBe(4);
    // A body may hang over open ground, never roofs or water.
    for (const { texel } of east) {
      expect(texel[1]).toBe(classId('life_vehicle'));
      expect(texel[2]).toBe(CellBit.vehicle | CellBit.person);
    }
  });

  it('puts headlights at the front and taillights at the back', () => {
    const part = (texel: number[]) => texel[3]! >> 4;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
    ] as const) {
      const found = pack(car(dx, dy, 3)).found;
      const forward = (c: { col: number; row: number }) =>
        (c.col + 0.5 - 20) * dx + (c.row + 0.5 - 15) * dy;
      const heads = found.filter((c) => part(c.texel) === VehiclePart.headlight);
      const tails = found.filter((c) => part(c.texel) === VehiclePart.taillight);
      expect(heads.length).toBeGreaterThan(0);
      expect(tails.length).toBeGreaterThan(0);
      expect(heads.every((c) => forward(c) > 5)).toBe(true);
      expect(tails.every((c) => forward(c) < -5)).toBe(true);
      expect(found.every((c) => (c.texel[3]! & 15) === Paint.red)).toBe(true);
    }
  });
});

describe('packLife boats and parked vehicles', () => {
  const big: LifeGrid = { ...grid, cols: 40, rows: 30 };
  const craft = (agent: Partial<VisibleAgent>): VisibleAgent => ({
    kind: 'vehicle',
    lng: 20,
    lat: 15,
    ahead: [21, 15],
    side: [20, 16],
    vehicle: 'car',
    paint: Paint.blue,
    flap: 0,
    ...agent,
  });
  const texels = (agent: VisibleAgent) => {
    const out = new Uint8Array(big.cols * big.rows * 4);
    packLife(out, big, [agent], themes.dark, glyphIndex);
    const found: { col: number; row: number; texel: number[] }[] = [];
    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 2]) {
        const cell = i / 4;
        found.push({
          col: cell % big.cols,
          row: Math.floor(cell / big.cols),
          texel: Array.from(out.subarray(i, i + 4)),
        });
      }
    }
    return found;
  };

  it('keeps a boat’s hull on the water', () => {
    const found = texels(craft({ kind: 'boat', vehicle: 'banca' }));
    expect(found.length).toBeGreaterThan(4);
    for (const { texel } of found) {
      expect(texel[0]).toBe(glyphIndex('█'));
      expect(texel[1]).toBe(classId('life_boat'));
      expect(texel[2]).toBe(CellBit.boat);
    }
  });

  it('marks parked vehicles, lamps off', () => {
    const found = texels(craft({ parked: true }));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(({ texel }) => (texel[3]! & 128) !== 0)).toBe(true);
    expect(vehicleByte(Paint.blue, VehiclePart.body, true)).toBe(Paint.blue | 128);
  });

  it('draws a bicycle one cell wide', () => {
    const found = texels(
      craft({ vehicle: 'bicycle', lat: 15.5, ahead: [22, 15.5], side: [20, 17.5] }),
    );
    expect(found.length).toBeGreaterThan(1);
    expect(new Set(found.map((c) => c.row)).size).toBe(1);
  });
});
