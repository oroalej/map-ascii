import { describe, expect, it } from 'vitest';
import { classId } from '../classes';
import { sextantGlyphs, themes } from '../theme';
import { agentBit, CellBit } from './config';
import { packLife, vehicleByte, type LifeGrid } from './draw';
import {
  CANDLE_BIT,
  figureGlyph,
  PAINT_NONE,
  PersonPart,
  personByte,
  personGlyphs,
  type PersonLook,
} from './people';
import type { VisibleAgent } from './simulate';
import { Paint, STALL_GLYPH, VehiclePart } from './vehicles';

const glyphs = [
  '',
  '▬',
  '▮',
  '☺',
  '◊',
  'v',
  '-',
  '█',
  '▓',
  '▒',
  '•',
  '▪',
  '·',
  ...personGlyphs(),
  STALL_GLYPH,
  ...sextantGlyphs.slice(1),
];
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
      glyphIndex(figureGlyph('adult', false, 0)),
      classId('life_person'),
      agentBit.person,
      personByte(PAINT_NONE, PersonPart.figure),
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

describe('packLife trains', () => {
  it('draws a far-off car as one glyph in its paint, and a near one from its plan', () => {
    const big: LifeGrid = { ...grid, cols: 60, rows: 30 };
    const car = (scale: number): VisibleAgent => ({
      kind: 'train',
      lng: 30,
      lat: 15,
      ahead: [30 + scale, 15],
      side: [30, 15 + scale],
      vehicle: 'coach',
      paint: Paint.orange,
      flap: 0,
    });
    const texel = (out: Uint8Array, c: number, r: number) =>
      Array.from(out.subarray((r * big.cols + c) * 4, (r * big.cols + c) * 4 + 4));
    const far = new Uint8Array(big.cols * big.rows * 4);
    packLife(far, big, [car(0.05)], themes.dark, glyphIndex);
    expect(texel(far, 30, 15)).toEqual([
      glyphIndex('▬'),
      classId('life_train'),
      agentBit.train,
      vehicleByte(Paint.orange, VehiclePart.mini),
    ]);

    const near = new Uint8Array(big.cols * big.rows * 4);
    packLife(near, big, [car(1)], themes.dark, glyphIndex);
    const at = (c: number, r: number) => texel(near, c, r)[1];
    // 18 m long: it spans the cells along its length, and may stand over the ground beside
    // its 1-cell track.
    expect(at(22, 15)).toBe(classId('life_train'));
    expect(at(38, 15)).toBe(classId('life_train'));
    expect(texel(near, 30, 15)[2]).toBe(CellBit.train | CellBit.person);
  });
});

describe('packLife lines', () => {
  const big: LifeGrid = { ...grid, cols: 40, rows: 30 };
  const lineGlyphs = [...glyphs, '─', '│', '╱', '╲', '¶'];
  const index = (g: string) => Math.max(0, lineGlyphs.indexOf(g));
  const draw = (points: [number, number][], tip?: { glyph: string; paint: number }) => {
    const out = new Uint8Array(big.cols * big.rows * 4);
    const agent: VisibleAgent = {
      kind: 'boat',
      lng: points[0]![0],
      lat: points[0]![1],
      flap: 0,
      line: { points, paints: [Paint.yellow, Paint.graphite], ...(tip ? { tip } : {}) },
    };
    packLife(out, big, [agent], themes.dark, index);
    const cells: { col: number; row: number; texel: number[] }[] = [];
    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 2]) {
        const cell = i / 4;
        cells.push({
          col: cell % big.cols,
          row: Math.floor(cell / big.cols),
          texel: Array.from(out.subarray(i, i + 4)),
        });
      }
    }
    return cells;
  };

  it('draws a run of line glyphs across, painted in turn, with its tip', () => {
    const cells = draw(
      [
        [5.5, 10.5],
        [12.5, 10.5],
      ],
      { glyph: '¶', paint: Paint.white },
    );
    expect(cells.map((c) => c.col)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(cells.slice(0, -1).every((c) => c.texel[0] === index('─'))).toBe(true);
    expect(cells.at(-1)!.texel[0]).toBe(index('¶'));
    expect(cells.at(-1)!.texel[3]).toBe(vehicleByte(Paint.white, VehiclePart.body));
    expect(cells[0]!.texel[3]).toBe(vehicleByte(Paint.yellow, VehiclePart.body));
    expect(cells[1]!.texel[3]).toBe(vehicleByte(Paint.graphite, VehiclePart.body));
    // Over the water only.
    for (const { texel } of cells) {
      expect(texel[1]).toBe(classId('life_boat'));
      expect(texel[2]).toBe(CellBit.boat);
    }
  });

  it('turns with its direction on screen, and skips lines under a cell', () => {
    const glyphs = (points: [number, number][]) => new Set(draw(points).map((c) => c.texel[0]));
    expect(
      glyphs([
        [5.5, 5.5],
        [5.5, 12.5],
      ]),
    ).toEqual(new Set([index('│')]));
    // Rising to the right on screen (rows count down): runs across, stepping up with ╱.
    expect(
      glyphs([
        [5.5, 12.5],
        [12.5, 8.6],
      ]),
    ).toEqual(new Set([index('─'), index('╱')]));
    expect(
      glyphs([
        [5.5, 5.5],
        [12.5, 9.4],
      ]),
    ).toEqual(new Set([index('─'), index('╲')]));
    expect(
      draw([
        [5.2, 5.5],
        [5.6, 5.5],
      ]),
    ).toHaveLength(0);
  });

  it('is one cell thick: one cell per column along a shallow slant, one per row along a steep one', () => {
    const shallow = draw([
      [3.5, 20.5],
      [30.5, 9.5],
    ]);
    const columns = shallow.map((c) => c.col);
    expect(new Set(columns).size).toBe(columns.length);
    expect(Math.max(...columns) - Math.min(...columns) + 1).toBe(columns.length);
    const steep = draw([
      [10.5, 25.5],
      [16.5, 3.5],
    ]);
    const rowsOf = steep.map((c) => c.row);
    expect(new Set(rowsOf).size).toBe(rowsOf.length);
  });
});

describe('packLife people', () => {
  const big: LifeGrid = { ...grid, cols: 40, rows: 30 };
  /**
   * A person at (20, 15) heading along (`dx`, `dy`), `scale` cells per meter (a meter across is
   * `scale` cell widths; up or down, 1.8 times that, as cells are taller than wide).
   */
  const person = (
    dx: number,
    dy: number,
    scale: number,
    extra: Partial<VisibleAgent> = {},
  ): [LifeGrid, VisibleAgent] => [
    { ...big, toCell: (lng, lat) => [20 + (lng - 20) * scale, 15 + (lat - 15) * scale] },
    { kind: 'person', lng: 20.2, lat: 15.2, ahead: [20.2 + dx, 15.2 + dy], flap: 0, ...extra },
  ];
  const pack = ([g, agent]: [LifeGrid, VisibleAgent]) => {
    const out = new Uint8Array(g.cols * g.rows * 4);
    const drawn = packLife(out, g, [agent], themes.dark, glyphIndex);
    const cells: { col: number; row: number; texel: number[] }[] = [];
    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 2]) {
        const texel = Array.from(out.subarray(i, i + 4));
        cells.push({ col: (i / 4) % g.cols, row: Math.floor(i / 4 / g.cols), texel });
      }
    }
    return { drawn, cells };
  };
  const look = (over: Partial<PersonLook> = {}): PersonLook => ({
    figure: 'adult',
    paint: Paint.red,
    lateral: 0,
    back: 0,
    flap: 0,
    ...over,
  });

  it('turns a figure with its heading, steps with its stride, and lights its candle', () => {
    const across = pack(person(1, 0, 0.2, { flap: 1, paint: Paint.blue, candle: true }));
    expect(across.cells).toHaveLength(1);
    expect(across.cells[0]!.texel).toEqual([
      glyphIndex(figureGlyph('adult', true, 1, { scale: 0 })),
      classId('life_person'),
      CellBit.person,
      personByte(Paint.blue, PersonPart.figure, true),
    ]);
    expect(across.cells[0]!.texel[3]! & CANDLE_BIT).toBe(CANDLE_BIT);
    const upDown = pack(person(0, -1, 0.2));
    expect(upDown.cells[0]!.texel[0]).toBe(
      glyphIndex(figureGlyph('adult', false, 0, { scale: 0 })),
    );
  });

  it('draws an umbrella as its canopy', () => {
    const { cells } = pack(person(1, 0, 0.2, { people: [look({ figure: 'umbrella' })] }));
    expect(cells[0]!.texel[0]).toBe(glyphIndex(figureGlyph('umbrella', false, 0, { scale: 0 })));
    expect(cells[0]!.texel[3]).toBe(personByte(Paint.red, PersonPart.canopy));
  });

  it('draws a figure at its real size: part of a cell, a whole one, then 2×2 cells', () => {
    const glyphAt = (scale: number, figure: PersonLook['figure'] = 'adult') =>
      pack(person(1, 0, scale, { people: [look({ figure })] })).cells.map((c) => c.texel[0]);
    const one = (figure: PersonLook['figure'], s: 0 | 1 | 2) => [
      glyphIndex(figureGlyph(figure, figure !== 'umbrella', 0, { scale: s })),
    ];
    // An adult is 0.6 m across: a fifth of a cell, then four fifths, then a little over one.
    expect(glyphAt(0.2)).toEqual(one('adult', 0));
    expect(glyphAt(1.3)).toEqual(one('adult', 1));
    expect(glyphAt(2)).toEqual(one('adult', 2));
    // An umbrella (1 m) covers 2×2 cells before its bearer would.
    expect(glyphAt(2, 'umbrella')).toHaveLength(4);
    const adult = pack(person(1, 0, 3));
    expect(adult.cells.map((c) => [c.col, c.row])).toEqual([
      [20, 15],
      [21, 15],
      [20, 16],
      [21, 16],
    ]);
    expect(adult.cells.map((c) => c.texel[0])).toEqual(
      ([0, 1, 2, 3] as const).map((slice) => glyphIndex(figureGlyph('adult', true, 0, { slice }))),
    );
    // A child keeps to one cell.
    expect(glyphAt(3, 'child')).toEqual(one('child', 2));
  });

  it('stamps a figure at its real size once it covers 3 cells, growing as it gets closer', () => {
    const near = pack(person(1, 0, 6));
    expect(near.drawn).toBe(1);
    // 0.6 m at 6 cells per meter: over 3 columns, each cell a sextant of the figure.
    expect(new Set(near.cells.map((c) => c.col)).size).toBeGreaterThanOrEqual(3);
    for (const c of near.cells) {
      expect(sextantGlyphs.map(glyphIndex)).toContain(c.texel[0]);
      expect(c.texel.slice(1, 3)).toEqual([classId('life_person'), CellBit.person]);
    }
    // Shirt around, skin in its middle.
    const parts = new Set(near.cells.map((c) => (c.texel[3]! >> 4) & 7));
    expect(parts).toEqual(new Set([PersonPart.figure, PersonPart.skin]));
    const nearer = pack(person(1, 0, 12));
    expect(nearer.cells.length).toBeGreaterThan(near.cells.length);
    // An umbrella stamps its canopy and ribs.
    const umbrella = pack(person(1, 0, 6, { people: [look({ figure: 'umbrella' })] }));
    expect(new Set(umbrella.cells.map((c) => (c.texel[3]! >> 4) & 7))).toEqual(
      new Set([PersonPart.canopy, PersonPart.rib]),
    );
  });

  it('lays a group out beside and behind the first, without overlaps', () => {
    const people = [look(), look({ lateral: 1 }), look({ back: 1, figure: 'child' })];
    // Heading right: the right hand is down the screen, behind is to the left.
    const small = pack(person(1, 0, 0.2, { people }));
    expect(small.drawn).toBe(3);
    expect(small.cells.map((c) => [c.col, c.row]).sort()).toEqual([
      [19, 15],
      [20, 15],
      [20, 16],
    ]);
    const close = pack(person(1, 0, 3, { people }));
    expect(close.drawn).toBe(3);
    // Two 2×2 adults side by side and a child behind: 4 + 4 + 1 cells.
    expect(close.cells).toHaveLength(9);
  });

  it('draws a paddler over the water, turned round as the other side’s at the other stroke', () => {
    const rower = (dy: number, scale: number) =>
      pack(
        person(0, dy, scale, {
          aboard: true,
          stroke: 0,
          people: [look({ figure: 'rower', flap: 0 })],
        }),
      );
    const slices = (frame: 0 | 1, stroke: 0 | 1) =>
      ([0, 1, 2, 3] as const).map((slice) =>
        glyphIndex(figureGlyph('rower', false, frame, { slice }, stroke)),
      );
    // 1.2 m across, heading up at 1.8 cells per meter: 2×2 cells, over the water only.
    const up = rower(-1, 1);
    expect(up.cells.map((c) => c.texel[0])).toEqual(slices(0, 0));
    for (const c of up.cells) expect(c.texel[2]).toBe(CellBit.boat);
    expect(rower(1, 1).cells.map((c) => c.texel[0])).toEqual(slices(1, 1));
    // Closest up, stamped at its real size.
    const near = rower(-1, 5);
    expect(near.cells.length).toBeGreaterThan(8);
    for (const c of near.cells) expect(c.texel[2]).toBe(CellBit.boat);
  });

  it('draws a vendor’s cart as a vehicle standing where people walk, the vendor beside it', () => {
    const cart = (scale: number) =>
      pack(
        person(1, 0, scale, {
          side: [20.2, 16.2],
          vehicle: 'cart',
          paint: Paint.yellow,
          people: [look({ lateral: -1 })],
        }),
      );
    for (const scale of [0.2, 3]) {
      const { drawn, cells } = cart(scale);
      expect(drawn, `scale ${scale}`).toBe(2);
      const carts = cells.filter((c) => c.texel[1] === classId('life_vehicle'));
      const vendor = cells.filter((c) => c.texel[1] === classId('life_person'));
      expect(carts.length).toBeGreaterThan(0);
      expect(vendor.length).toBeGreaterThan(0);
      for (const c of carts) expect(c.texel[2]).toBe(CellBit.person);
      // The vendor stands on the cart's left (up the screen), clear of it.
      const cartTop = Math.min(...carts.map((c) => c.row));
      for (const c of vendor) expect(c.row).toBeLessThan(cartTop);
    }
    expect(cart(0.2).cells.find((c) => c.texel[1] === classId('life_vehicle'))!.texel[0]).toBe(
      glyphIndex(STALL_GLYPH),
    );
  });
});
