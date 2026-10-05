import { describe, expect, it } from 'vitest';
import { classId } from '../classes';
import { unpackGlyph } from '../glyphs/select';
import { sextantGlyphs, themes } from '../theme';
import { BirdHeading, BirdPose, birdByte, birdGlyph, birdGlyphs, BIRD_SPECIES } from './birds';
import { agentBit, CellBit, LIFE_SHADOW } from './config';
import { PackingOutcome } from './diagnostics';
import { lifeVisibleOnSurface } from './surface-visibility';
import { catGlyphs } from './cats';
import { DOG_LENGTH_M, dogGlyph, dogGlyphs } from './dogs';
import { Heading } from './masters';
import { LIFE_FOCUS_BIT } from '../focus';
import { LIFE_AGENT_MASK, TURN_SIGNAL_BIT } from './turn-signals';
import { buildLifeGlyphs, packLife, vehicleByte, type LifeGrid } from './draw';
import {
  CANDLE_BIT,
  figureGlyph,
  figureOf,
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
  ...birdGlyphs(),
  ...dogGlyphs(),
  ...catGlyphs(),
  STALL_GLYPH,
  ...sextantGlyphs.slice(1),
];
const glyphIndex = (g: string) => Math.max(0, glyphs.indexOf(g));
const packedGlyph = (texel: readonly number[]) => unpackGlyph(texel[0]!, texel[1]!).glyph;
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
  it('gives miniature cars the detailed road/open-ground mask while preserving surface occlusion', () => {
    const out = new Uint8Array(200);
    packLife(
      out,
      grid,
      [{ kind: 'vehicle', vehicle: 'car', lng: 2.5, lat: 1.5, flap: 0 }],
      themes.dark,
      glyphIndex,
    );
    const bits = out[12 * 4 + 2]!;
    expect(bits).toBe(CellBit.vehicle | CellBit.person);
    for (const cls of ['road_major', 'paving', 'grass'] as const)
      expect(
        lifeVisibleOnSurface(classId('life_vehicle'), bits, classId(cls), classId(cls), 0),
      ).toBe(true);
    for (const cls of ['building', 'water_area', 'tree', 'tree_crown', 'trees'] as const)
      expect(
        lifeVisibleOnSurface(
          classId('life_vehicle'),
          bits,
          classId(cls),
          classId(cls),
          cls === 'building' ? 5 : 0,
        ),
      ).toBe(false);
  });
  it('translates a small speaking group rigidly, retaining bytes, members, focus and candle clocks', () => {
    const a: VisibleAgent = {
      kind: 'person',
      lng: 2.5,
      lat: 2.5,
      flap: 0,
      candle: true,
      effectClock: 10,
      speech: { id: 'retry', exchangeId: 'retry', line: 0, member: 1 },
      people: [
        { figure: 'adult', paint: 1, lateral: 0, back: 0, flap: 0 },
        { figure: 'adult', paint: 2, lateral: 1, back: 0, flap: 1 },
      ],
    };
    const blocker = {
      kind: 'vehicle' as const,
      vehicle: 'car' as const,
      lng: 2.5,
      lat: 2.5,
      flap: 0,
    };
    const isolated = new Uint8Array(200),
      translated = isolated.slice();
    const speakers = { members: new Uint8Array(50), points: new Map<number, [number, number]>() };
    const owners = new Uint32Array(50),
      clocked: number[] = [];
    packLife(isolated, { ...grid, speakers }, [a], themes.dark, glyphIndex, null, undefined, {
      owners,
      focus: new Set(['people']),
      clockCells: clocked,
    });
    const originalCells = [...owners.entries()]
      .filter(([, owner]) => owner === 1)
      .map(([cell]) => cell);
    const point = speakers.points.get(1)!;
    const members = speakers.members.slice();
    const originalClocks = clocked.slice();
    expect(
      packLife(
        translated,
        {
          ...grid,
          speakers,
          allowsGroundCell: (agent, _col, row) => agent === blocker || row === 1,
        },
        [blocker, a],
        themes.dark,
        glyphIndex,
        null,
        undefined,
        { owners, focus: new Set(['people']), clockCells: clocked },
      ),
    ).toBe(3);
    for (const cell of originalCells) {
      const shifted = cell - grid.cols;
      expect(translated.slice(shifted * 4, shifted * 4 + 4)).toEqual(
        isolated.slice(cell * 4, cell * 4 + 4),
      );
      expect(owners[shifted]).toBe(2);
      expect(speakers.members[shifted]).toBe(members[cell]);
    }
    expect(speakers.points.get(2)).toEqual([point[0], point[1] - 1]);
    expect(clocked).toEqual(originalClocks.map((cell) => cell - grid.cols));
    // No room: every failed candidate leaves the original blocker and metadata intact.
    expect(
      packLife(
        translated,
        { ...grid, speakers, allowsGroundCell: (agent) => agent === blocker },
        [blocker, a],
        themes.dark,
        glyphIndex,
        null,
        undefined,
        { owners, clockCells: clocked },
      ),
    ).toBe(1);
    expect(speakers.points.has(2)).toBe(false);
    expect(speakers.members.every((member) => member === 0)).toBe(true);
    expect(clocked).toEqual([]);
    expect([...owners].filter(Boolean)).toEqual([1]);
  });
  it('draws two miniature cars sharing a cell when an adjacent cell is available', () => {
    const a: VisibleAgent = { kind: 'vehicle', vehicle: 'car', lng: 2.2, lat: 2.2, flap: 0 };
    const b = { ...a, lng: 2.4 };
    const out = new Uint8Array(200);
    expect(packLife(out, grid, [a, b], themes.dark, glyphIndex)).toBe(2);
  });
  it('moves a complete nine-cell family into diagonal clearance without changing its payload', () => {
    const g: LifeGrid = {
      ...grid,
      cols: 40,
      rows: 30,
      toCell: (lng, lat) => [20 + (lng - 20) * 3, 15 + (lat - 15) * 3],
    };
    const family: VisibleAgent = {
      kind: 'person',
      lng: 20.2,
      lat: 15.2,
      ahead: [21.2, 15.2],
      flap: 0,
      candle: true,
      effectClock: 12,
      speech: { id: 'family', exchangeId: 'family', line: 0, member: 2 },
      people: [
        { figure: 'adult', paint: 1, lateral: 0, back: 0, flap: 0 },
        { figure: 'adult', paint: 2, lateral: 1, back: 0, flap: 1 },
        { figure: 'child', paint: 3, lateral: 0, back: 1, flap: 0 },
      ],
    };
    const original = new Uint8Array(g.cols * g.rows * 4),
      out = original.slice();
    const owners = new Uint32Array(g.cols * g.rows);
    const speakers = {
      members: new Uint8Array(owners.length),
      points: new Map<number, [number, number]>(),
    };
    const clocks: number[] = [];
    const metadata = { owners, clockCells: clocks, focus: new Set(['people'] as const) };
    expect(
      packLife(
        original,
        { ...g, speakers },
        [family],
        themes.dark,
        glyphIndex,
        null,
        undefined,
        metadata,
      ),
    ).toBe(3);
    const cells = [...owners.entries()].filter(([, owner]) => owner).map(([cell]) => cell);
    expect(cells).toHaveLength(9);
    const members = speakers.members.slice(),
      point = speakers.points.get(1)!,
      beforeClocks = clocks.slice();
    const shift = g.cols + 1,
      permitted = new Set(cells.map((cell) => cell + shift));
    expect(
      packLife(
        out,
        { ...g, speakers, allowsGroundCell: (_a, c, r) => permitted.has(r * g.cols + c) },
        [family],
        themes.dark,
        glyphIndex,
        null,
        undefined,
        metadata,
      ),
    ).toBe(3);
    expect([...owners.entries()].filter(([, owner]) => owner).map(([cell]) => cell)).toEqual(
      [...permitted].sort((a, b) => a - b),
    );
    for (const cell of cells) {
      expect(out.slice((cell + shift) * 4, (cell + shift) * 4 + 4)).toEqual(
        original.slice(cell * 4, cell * 4 + 4),
      );
      expect(speakers.members[cell + shift]).toBe(members[cell]);
    }
    expect(speakers.points.get(1)).toEqual([point[0] + 1, point[1] + 1]);
    expect(clocks).toEqual(beforeClocks.map((cell) => cell + shift));
    expect(
      packLife(
        out,
        { ...g, speakers, allowsGroundCell: () => false },
        [family],
        themes.dark,
        glyphIndex,
        null,
        undefined,
        metadata,
      ),
    ).toBe(0);
    expect(out.every((byte) => byte === 0)).toBe(true);
    expect(owners.every((owner) => owner === 0)).toBe(true);
    expect(speakers.points.size).toBe(0);
    expect(clocks).toEqual([]);
  });
  it('reserves fixed cart cells before passing people in either input order', () => {
    const vendor: VisibleAgent = { kind: 'person', vehicle: 'cart', lng: 2.5, lat: 2.5, flap: 0 };
    const passer: VisibleAgent = { kind: 'person', lng: 2.5, lat: 2.5, flap: 0 };
    const out = new Uint8Array(200),
      owners = new Uint32Array(50);
    for (const agents of [
      [passer, vendor],
      [vendor, passer],
    ]) {
      expect(packLife(out, { ...grid, owners }, agents, themes.dark, glyphIndex)).toBe(2);
      expect(owners[22]).toBe(agents.indexOf(vendor) + 1);
      expect([...owners]).toContain(agents.indexOf(passer) + 1);
    }
  });
  it('draws a curbside walker when an adjacent permitted cell is available', () => {
    const out = new Uint8Array(200);
    const person: VisibleAgent = { kind: 'person', lng: 4.8, lat: 2, flap: 0 };
    expect(
      packLife(
        out,
        { ...grid, allowsGroundCell: (_agent, col) => col >= 5 },
        [person],
        themes.dark,
        glyphIndex,
      ),
    ).toBe(1);
  });
  it('reports exclusive packing outcomes without changing pixels, owners or counts', () => {
    const agents: VisibleAgent[] = [
      { kind: 'vehicle', vehicle: 'car', lng: 2, lat: 2, flap: 0 },
      { kind: 'vehicle', vehicle: 'car', lng: 2, lat: 2, flap: 0 },
      { kind: 'person', lng: 5, lat: 2, flap: 0 },
      { kind: 'person', lng: 15, lat: 2, flap: 0 },
    ];
    const outcomes = new Uint8Array(agents.length),
      a = new Uint8Array(200),
      b = a.slice();
    const ga = {
      ...grid,
      allowsGroundCell: (agent: VisibleAgent, col: number, row: number) =>
        agent === agents[2] ? false : agent === agents[1] ? col === 2 && row === 2 : col < 5,
      owners: new Uint32Array(50),
    };
    const gb = { ...ga, owners: new Uint32Array(50), outcomes };
    expect(packLife(a, ga, agents, themes.dark, glyphIndex)).toBe(
      packLife(b, gb, agents, themes.dark, glyphIndex),
    );
    expect(a).toEqual(b);
    expect(ga.owners).toEqual(gb.owners);
    expect([...outcomes]).toEqual([
      PackingOutcome.drawn,
      PackingOutcome.collision,
      PackingOutcome.cellGuard,
      PackingOutcome.outside,
    ]);
  });
  it('marks complete detailed stamps while preserving ownership, permissions and indicators', () => {
    const big = { ...grid, cols: 40, rows: 30 };
    const agents: VisibleAgent[] = [
      {
        kind: 'vehicle',
        vehicle: 'car',
        lng: 20,
        lat: 15,
        ahead: [22, 15],
        side: [20, 17],
        flap: 0,
        turnSignal: { side: 'left', on: true },
      },
    ];
    const ordinary = new Uint8Array(big.cols * big.rows * 4),
      focused = ordinary.slice();
    const owners = new Uint32Array(big.cols * big.rows);
    packLife(ordinary, big, agents, themes.dark, glyphIndex);
    packLife(focused, big, agents, themes.dark, glyphIndex, null, undefined, {
      owners,
      focus: new Set(['traffic']),
    });
    let count = 0,
      indicators = 0;
    for (let at = 0; at < ordinary.length; at += 4) {
      if ((ordinary[at + 2]! & LIFE_AGENT_MASK) === 0) {
        expect(owners[at / 4]).toBe(0);
        continue;
      }
      count++;
      expect(owners[at / 4]).toBe(1);
      expect(focused[at + 2]).toBe(ordinary[at + 2]! | LIFE_FOCUS_BIT);
      if (focused[at + 2]! & TURN_SIGNAL_BIT) indicators++;
      focused[at + 2]! &= ~LIFE_FOCUS_BIT;
    }
    expect(count).toBeGreaterThan(4);
    expect(indicators).toBeGreaterThan(0);
    expect(focused).toEqual(ordinary);
  });
  it('keeps original array ownership through parked-first writes and rollback', () => {
    const agents: VisibleAgent[] = [
      { kind: 'person', lng: 2.5, lat: 1.5, flap: 0 },
      { kind: 'vehicle', lng: 7.5, lat: 1.5, flap: 0, parked: true },
      { kind: 'person', lng: 2.5, lat: 1.5, flap: 0 },
    ];
    const out = new Uint8Array(200),
      owners = new Uint32Array(50);
    const plain = new Uint8Array(200);
    const confined = {
      ...grid,
      allowsGroundCell: (agent: VisibleAgent, col: number, row: number) =>
        agent !== agents[2] || (col === 2 && row === 1),
    };
    packLife(plain, confined, agents, themes.dark, glyphIndex);
    packLife(out, confined, agents, themes.dark, glyphIndex, null, undefined, { owners });
    expect(out).toEqual(plain);
    expect(owners[12]).toBe(1);
    expect(owners[17]).toBe(2);
    expect([...owners]).not.toContain(3);
    expect(out[12 * 4 + 4]).toBe(0); // rollback never writes a fifth byte into the next cell
    packLife(out, grid, [], themes.dark, glyphIndex, null, undefined, { owners });
    expect(owners.every((owner) => owner === 0)).toBe(true);
    expect(out.every((byte) => byte === 0)).toBe(true);
  });
  it('tracks pets, birds, lines and detailed stamps without leaking metadata between buffers', () => {
    const agents: VisibleAgent[] = [
      { kind: 'dog', lng: 1.5, lat: 1.5, flap: 0 },
      { kind: 'cat', lng: 3.5, lat: 1.5, flap: 0 },
      { kind: 'bird', lng: 5.5, lat: 1.5, flap: 0 },
      {
        kind: 'boat',
        lng: 7.5,
        lat: 1.5,
        flap: 0,
        line: {
          points: [
            [7, 1],
            [9, 1],
          ],
          paints: [0],
        },
      },
    ];
    const out = new Uint8Array(200),
      owners = new Uint32Array(50);
    packLife(
      out,
      grid,
      agents,
      themes.dark,
      (glyph) => Math.max(1, glyphIndex(glyph)),
      null,
      undefined,
      { owners },
    );
    for (const owner of [1, 2, 3, 4]) expect([...owners]).toContain(owner);
    const saved = owners.slice();
    packLife(new Uint8Array(200), grid, [], themes.dark, glyphIndex);
    expect(owners).toEqual(saved);
    expect(() =>
      packLife(out, grid, agents, themes.dark, glyphIndex, null, undefined, {
        owners: new Uint32Array(1),
      }),
    ).toThrow(RangeError);
  });
  it('packs high glyph indices with the class without changing agent attributes', () => {
    for (const glyph of [255, 256, 1023]) {
      const out = new Uint8Array(grid.cols * grid.rows * 4);
      expect(
        packLife(
          out,
          grid,
          [{ kind: 'vehicle', lng: 2.5, lat: 1.2, flap: 0 }],
          themes.dark,
          () => glyph,
        ),
      ).toBe(1);
      const [lo, packed, bits, byte] = cell(out, 2, 1);
      expect(unpackGlyph(lo!, packed!)).toEqual({ glyph, cls: classId('life_vehicle') });
      expect(bits).toBe(CellBit.vehicle | CellBit.person);
      expect(byte).toBe(255);
    }
  });
  it('reuses an atlas lookup without changing packed vehicles', () => {
    let lookups = 0;
    const lookup = (glyph: string) => {
      lookups++;
      return glyphIndex(glyph);
    };
    const cached = buildLifeGlyphs(lookup);
    const before = lookups;
    const agents: VisibleAgent[] = [
      {
        kind: 'vehicle',
        vehicle: 'car',
        paint: Paint.red,
        lng: 3,
        lat: 2,
        ahead: [4, 2],
        side: [3, 3],
        flap: 0,
      },
    ];
    const old = new Uint8Array(200),
      next = new Uint8Array(200);
    expect(packLife(next, grid, agents, themes.dark, lookup, undefined, cached)).toBe(
      packLife(old, grid, agents, themes.dark, glyphIndex),
    );
    expect(lookups).toBe(before);
    expect(next).toEqual(old);
    const other = buildLifeGlyphs(() => 123);
    expect(other.parts).not.toBe(cached.parts);
    expect(other.parts.every((glyph) => glyph === 123)).toBe(true);
  });

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

describe('packLife birds', () => {
  const big: LifeGrid = { ...grid, cols: 40, rows: 30 };
  /** A bird at (20, 15) facing along (`dx`, `dy`), `scale` cells per meter across. */
  const bird = (
    species: keyof typeof BIRD_SPECIES,
    pose: BirdPose,
    scale: number,
    [dx, dy]: [number, number] = [0, -1],
  ): VisibleAgent => ({
    kind: 'bird',
    lng: 20,
    lat: 15,
    ahead: [20 + dx * scale, 15 + dy * scale],
    flap: 0,
    bird: { species, pose },
  });
  const inked = (out: Uint8Array) => {
    let n = 0;
    for (let i = 2; i < out.length; i += 4) if (out[i]) n++;
    return n;
  };
  const cell = (out: Uint8Array, col: number, row: number) =>
    Array.from(out.subarray((row * big.cols + col) * 4, (row * big.cols + col) * 4 + 4));
  const draw = (agent: VisibleAgent) => {
    const out = new Uint8Array(big.cols * big.rows * 4);
    const drawn = packLife(out, big, [agent], themes.dark, glyphIndex);
    return { out, drawn };
  };

  it('stays one font glyph far out, by its pose', () => {
    const { out, drawn } = draw(bird('maya', BirdPose.raised, 0.5));
    expect(drawn).toBe(1);
    expect(inked(out)).toBe(1);
    expect(cell(out, 20, 15)[0]).toBe(glyphIndex('-'));
    expect(cell(draw(bird('maya', BirdPose.perched, 0.5)).out, 20, 15)[0]).toBe(glyphIndex('·'));
  });

  it('fills its cell with a silhouette turned to its heading on screen', () => {
    // An egret about a cell across.
    const scale = 1 / BIRD_SPECIES.egret.wingspan;
    const { out } = draw(bird('egret', BirdPose.spread, scale, [-1, 0]));
    expect(inked(out)).toBe(1);
    expect(cell(out, 20, 15)).toEqual([
      glyphIndex(birdGlyph(BirdPose.spread, BirdHeading.left)),
      classId('life_bird'),
      agentBit.bird,
      birdByte('egret', false, true),
    ]);
  });

  it('is stamped at its real size up close, bigger for bigger species', () => {
    const scale = 8;
    const egret = draw(bird('egret', BirdPose.spread, scale));
    const maya = draw(bird('maya', BirdPose.spread, scale));
    expect(egret.drawn).toBe(1);
    expect(inked(egret.out)).toBeGreaterThan(inked(maya.out));
    expect(inked(maya.out)).toBeGreaterThan(1);
    // In sextants, some of them the egret's bill.
    const texels = [];
    for (let i = 0; i < egret.out.length; i += 4) {
      if (egret.out[i + 2]) texels.push(Array.from(egret.out.subarray(i, i + 4)));
    }
    expect(texels.every((t) => sextantGlyphs.includes(glyphs[packedGlyph(t)]!))).toBe(true);
    expect(texels.some(([, , , byte]) => byte === birdByte('egret', true))).toBe(true);
    expect(texels.some(([, , , byte]) => byte === birdByte('egret'))).toBe(true);
  });
});

describe('packLife dogs and shadows', () => {
  const big: LifeGrid = { ...grid, cols: 40, rows: 30 };
  const cellOf = (out: Uint8Array, col: number, row: number) =>
    Array.from(out.subarray((row * big.cols + col) * 4, (row * big.cols + col) * 4 + 4));
  const inked = (out: Uint8Array) => {
    let n = 0;
    for (let i = 2; i < out.length; i += 4) if (out[i]) n++;
    return n;
  };
  /** A dog at (20, 15) heading along (`dx`, `dy`), `scale` cells per meter. */
  const dog = (scale: number, [dx, dy]: [number, number] = [1, 0]): VisibleAgent => ({
    kind: 'dog',
    lng: 20,
    lat: 15,
    ahead: [20 + dx * scale, 15 + dy * scale],
    paint: Paint.orange,
    flap: 1,
  });

  it('draws a dog in one cell turned to its heading, in its coat, as people are', () => {
    const out = new Uint8Array(big.cols * big.rows * 4);
    expect(packLife(out, big, [dog(0.5, [0, 1])], themes.dark, glyphIndex)).toBe(1);
    expect(cellOf(out, 20, 15)).toEqual([
      glyphIndex(dogGlyph(1, Heading.down)),
      classId('life_person'),
      CellBit.person,
      personByte(Paint.orange, PersonPart.canopy),
    ]);
  });

  it('reserves whole ground agents including dogs and cats in either drawing order', () => {
    const car = (lng: number): VisibleAgent => ({
      kind: 'vehicle',
      vehicle: 'car',
      lng,
      lat: 15,
      ahead: [lng + 0.5, 15],
      flap: 0,
    });
    const out = new Uint8Array(big.cols * big.rows * 4);
    for (const pet of [dog(0.5), { ...dog(0.5), kind: 'cat' as const }]) {
      expect(packLife(out, big, [pet, car(20)], themes.dark, glyphIndex)).toBe(2);
      expect(cellOf(out, 20, 15)[1]).toBe(classId('life_person'));
      expect(packLife(out, big, [car(20), pet], themes.dark, glyphIndex)).toBe(2);
      expect(cellOf(out, 20, 15)[1]).toBe(classId('life_vehicle'));
    }
    expect(packLife(out, big, [car(20), car(20.2)], themes.dark, glyphIndex)).toBe(2);
  });

  it('stamps a dog at its real size up close', () => {
    const out = new Uint8Array(big.cols * big.rows * 4);
    packLife(out, big, [dog(8 / DOG_LENGTH_M)], themes.dark, glyphIndex);
    expect(inked(out)).toBeGreaterThan(4);
  });

  /** One cell per 2 m (1 m of latitude or longitude near the equator is 1/111320°). */
  const metric: LifeGrid = {
    ...big,
    toCell: (lng, lat) => [20 + (lng * 111_320) / 2, 15 - (lat * 111_320) / 2],
  };
  const flying = (pose: BirdPose): VisibleAgent => ({
    kind: 'bird',
    lng: 0,
    lat: 0,
    ahead: [0, 1 / 111_320],
    flap: 0,
    bird: { species: 'pigeon', pose },
  });

  it('casts a flying bird’s shadow away from the sun, under whoever is there', () => {
    const out = new Uint8Array(big.cols * big.rows * 4);
    // The sun due south, 45° up: the shadow falls 8 m north (4 cells up the grid).
    const sun = { azimuth: 180, altitude: 45 };
    const owners = new Uint32Array(big.cols * big.rows);
    packLife(out, metric, [flying(BirdPose.spread)], themes.dark, glyphIndex, sun, undefined, {
      owners,
    });
    expect(owners[11 * big.cols + 20]).toBe(0);
    expect(owners[15 * big.cols + 20]).toBe(1);
    expect(cellOf(out, 20, 11)).toEqual([0, 0, 0, LIFE_SHADOW]);
    expect(cellOf(out, 20, 15)[2]).toBe(agentBit.bird);
    // A bird sitting, the sun down, or none given: no shadow.
    for (const [pose, s] of [
      [BirdPose.perched, sun],
      [BirdPose.spread, { azimuth: 180, altitude: -5 }],
      [BirdPose.spread, undefined],
    ] as const) {
      const none = new Uint8Array(big.cols * big.rows * 4);
      packLife(none, metric, [flying(pose)], themes.dark, glyphIndex, s);
      expect(none.some((v, i) => i % 4 === 3 && v === LIFE_SHADOW && none[i - 1] === 0)).toBe(
        false,
      );
    }
  });

  it('never casts a shadow over an agent', () => {
    const out = new Uint8Array(big.cols * big.rows * 4);
    const sun = { azimuth: 180, altitude: 45 };
    // A boat right where the shadow falls.
    const boat: VisibleAgent = { kind: 'boat', lng: 0, lat: 8 / 111_320, flap: 0 };
    packLife(out, metric, [flying(BirdPose.spread), boat], themes.dark, glyphIndex, sun);
    expect(cellOf(out, 20, 11)[2]).toBe(agentBit.boat);
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
          CellBit.vehicle | CellBit.person,
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
    expect(cells.slice(0, -1).every((c) => packedGlyph(c.texel) === index('─'))).toBe(true);
    expect(packedGlyph(cells.at(-1)!.texel)).toBe(index('¶'));
    expect(cells.at(-1)!.texel[3]).toBe(vehicleByte(Paint.white, VehiclePart.body));
    expect(cells[0]!.texel[3]).toBe(vehicleByte(Paint.yellow, VehiclePart.body));
    expect(cells[1]!.texel[3]).toBe(vehicleByte(Paint.graphite, VehiclePart.body));
    // Over the water only.
    for (const { texel } of cells) {
      expect(unpackGlyph(texel[0]!, texel[1]!).cls).toBe(classId('life_boat'));
      expect(texel[2]).toBe(CellBit.boat);
    }
  });

  it('turns with its direction on screen, and skips lines under a cell', () => {
    const glyphs = (points: [number, number][]) =>
      new Set(draw(points).map((c) => packedGlyph(c.texel)));
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

  it.each([0.2, 3])('packs a marked lone coarse figure with exact metadata (scale %s)', (scale) => {
    for (const explicit of [false, true]) {
      const [g, agent] = person(1, 0, scale, {
        lng: 20,
        lat: 15,
        ahead: [21, 15],
        mappedPersonMover: true,
        ...(explicit && { people: [look()] }),
        candle: true,
        effectClock: 12,
        speech: { id: 'lone', exchangeId: 'lone', line: 0, member: 0 },
      });
      const out = new Uint8Array(g.cols * g.rows * 4),
        original = out.slice(),
        plain = out.slice();
      const owners = new Uint32Array(g.cols * g.rows),
        members = new Uint8Array(owners.length),
        points = new Map<number, [number, number]>(),
        clocks: number[] = [];
      const focus = new Set(['people']);
      expect(
        packLife(
          original,
          { ...g, speakers: { members, points } },
          [agent],
          themes.dark,
          glyphIndex,
          null,
          undefined,
          { owners, focus, clockCells: clocks },
        ),
      ).toBe(1);
      const originalPoint = points.get(1)!;
      const expected = new Map(
        [...owners.entries()]
          .filter(([, owner]) => owner)
          .map(([cell]) => [cell - 2, original.slice(cell * 4, cell * 4 + 4)]),
      );
      const allowed = (_agent: VisibleAgent, col: number, row: number) =>
        expected.has(row * g.cols + col);
      let calls = 0;
      expect(
        packLife(
          out,
          { ...g, allowsGroundCell: allowed, speakers: { members, points } },
          [agent],
          themes.dark,
          glyphIndex,
          null,
          undefined,
          {
            owners,
            focus,
            clockCells: clocks,
            loneRetry: (result) => {
              calls++;
              expect(result.offset).toEqual([-2, 0]);
              expect(result.targetCellChecks).toBeLessThanOrEqual(64);
            },
          },
        ),
      ).toBe(1);
      expect(calls).toBe(1);
      expect([...owners].filter(Boolean)).toHaveLength(scale === 3 ? 4 : 1);
      expect(points.get(1)).toEqual([originalPoint[0] - 2, originalPoint[1]]);
      expect(new Set(clocks)).toEqual(new Set(expected.keys()));
      for (const [cell, bytes] of expected) {
        expect(out.slice(cell * 4, cell * 4 + 4)).toEqual(bytes);
        expect(owners[cell]).toBe(1);
        expect(members[cell]).toBe(1);
        const cls = unpackGlyph(bytes[0]!, bytes[1]!).cls;
        for (const surface of ['building', 'water_area', 'tree_crown'] as const)
          expect(
            lifeVisibleOnSurface(
              cls,
              bytes[2]!,
              classId(surface),
              classId(surface),
              surface === 'building' ? 5 : 0,
            ),
          ).toBe(false);
        expect(lifeVisibleOnSurface(cls, bytes[2]!, classId('paving'), classId('paving'), 0)).toBe(
          true,
        );
      }
      expect(
        packLife(
          plain,
          { ...g, allowsGroundCell: allowed },
          [agent],
          themes.dark,
          glyphIndex,
          null,
          undefined,
          { focus },
        ),
      ).toBe(1);
      expect(plain).toEqual(out);
      agent.mappedPersonMover = false;
      expect(
        packLife(
          out,
          { ...g, allowsGroundCell: allowed, speakers: { members, points } },
          [agent],
          themes.dark,
          glyphIndex,
          null,
          undefined,
          { owners, focus, clockCells: clocks },
        ),
      ).toBe(0);
      expect(out.every((byte) => byte === 0)).toBe(true);
      expect(owners.every((owner) => owner === 0)).toBe(true);
      expect(members.every((member) => member === 0)).toBe(true);
      expect(points.size).toBe(0);
      expect(clocks).toEqual([]);
      packLife(
        out,
        { ...g, speakers: { members, points } },
        [],
        themes.dark,
        glyphIndex,
        null,
        undefined,
        { owners, clockCells: clocks },
      );
      expect(out.every((byte) => byte === 0)).toBe(true);
      expect(points.size).toBe(0);
    }
  });

  it('does no lone-tier work for original and first-ring successes', () => {
    const [g, agent] = person(1, 0, 0.2, { mappedPersonMover: true });
    for (const allowsGroundCell of [undefined, (_agent: VisibleAgent, col: number) => col === 19]) {
      let calls = 0;
      expect(
        packLife(
          new Uint8Array(g.cols * g.rows * 4),
          { ...g, allowsGroundCell },
          [agent],
          themes.dark,
          glyphIndex,
          null,
          undefined,
          { loneRetry: () => calls++ },
        ),
      ).toBe(1);
      expect(calls).toBe(0);
    }
  });

  it('keeps excluded person presentations outside the lone tier even when marked', () => {
    for (const extra of [
      { mappedPersonMover: false },
      { mappedPersonMover: undefined },
      { parked: true },
      { aboard: true },
      { kind: 'dog' as const },
      { kind: 'vehicle' as const, vehicle: 'car' as const },
      { vehicle: 'cart' as const },
      { people: [] },
      { people: [look(), look({ lateral: 2 })] },
      { people: [look({ figure: 'seated' })] },
      { people: [look({ figure: 'rower' })] },
      { prop: 'ball' as const },
    ]) {
      const [g, agent] = person(1, 0, 0.2, { mappedPersonMover: true, ...extra });
      let calls = 0;
      packLife(
        new Uint8Array(g.cols * g.rows * 4),
        { ...g, allowsGroundCell: () => false },
        [agent],
        themes.dark,
        glyphIndex,
        null,
        undefined,
        { loneRetry: () => calls++ },
      );
      expect(calls).toBe(0);
    }
    for (const scale of [6]) {
      const [g, agent] = person(1, 0, scale, { mappedPersonMover: true });
      let calls = 0;
      packLife(
        new Uint8Array(g.cols * g.rows * 4),
        { ...g, allowsGroundCell: () => false },
        [agent],
        themes.dark,
        glyphIndex,
        null,
        undefined,
        { loneRetry: () => calls++ },
      );
      expect(calls).toBe(0);
    }
  });

  it('preserves earlier ground owners and exposes later-owner retry cascades', () => {
    const [g, agent] = person(1, 0, 0.2, { mappedPersonMover: true, people: [look()] });
    const other = { ...agent, people: [look({ paint: Paint.blue })] };
    for (const agents of [
      [agent, other],
      [other, agent],
    ]) {
      const owners = new Uint32Array(g.cols * g.rows),
        outcomes = new Uint8Array(2),
        out = new Uint8Array(owners.length * 4);
      const allowed = (_agent: VisibleAgent, col: number, row: number) => col === 18 && row === 15;
      expect(
        packLife(
          out,
          { ...g, outcomes, allowsGroundCell: allowed },
          agents,
          themes.dark,
          glyphIndex,
          null,
          undefined,
          { owners },
        ),
      ).toBe(1);
      expect([...owners].filter(Boolean)).toEqual([1]);
      expect([...outcomes]).toEqual([PackingOutcome.drawn, PackingOutcome.cellGuard]);
      expect(out[(15 * g.cols + 18) * 4 + 3]).toBe(
        personByte(agents[0]!.people![0]!.paint, PersonPart.figure),
      );
    }
  });

  it('retains nonground composition independently of optional ownership', () => {
    const [g, personAgent] = person(1, 0, 0.2, { mappedPersonMover: true, people: [look()] });
    const bird: VisibleAgent = { kind: 'bird', lng: 10, lat: 15, flap: 0 };
    const allowed = (_agent: VisibleAgent, col: number, row: number) => col === 18 && row === 15;
    for (const agents of [
      [bird, personAgent],
      [personAgent, bird],
    ]) {
      const owners = new Uint32Array(g.cols * g.rows),
        out = new Uint8Array(owners.length * 4),
        plain = out.slice();
      expect(
        packLife(
          out,
          { ...g, allowsGroundCell: allowed },
          agents,
          themes.dark,
          glyphIndex,
          null,
          undefined,
          { owners },
        ),
      ).toBe(2);
      expect(
        packLife(plain, { ...g, allowsGroundCell: allowed }, agents, themes.dark, glyphIndex),
      ).toBe(2);
      expect(out).toEqual(plain);
      expect(owners[15 * g.cols + 18]).toBe(2);
    }
  });

  it('retries valid boundary captures without widening off-grid base admission', () => {
    for (const outside of [false, true]) {
      const [g, agent] = person(1, 0, 3, {
        mappedPersonMover: true,
        people: [look()],
      });
      g.toCell = (lng, lat) => [lng * 3, lat * 3];
      agent.lng = (g.cols + Number(outside)) / 3;
      agent.lat = (g.rows + Number(outside)) / 3;
      agent.ahead = [agent.lng + 1, agent.lat];
      const owners = new Uint32Array(g.cols * g.rows),
        out = new Uint8Array(owners.length * 4);
      let calls = 0;
      const drawn = packLife(
        out,
        {
          ...g,
          allowsGroundCell: (_agent, col, row) =>
            col >= g.cols - 3 && col <= g.cols - 2 && row >= g.rows - 3 && row <= g.rows - 2,
        },
        [agent],
        themes.dark,
        glyphIndex,
        null,
        undefined,
        { owners, loneRetry: () => calls++ },
      );
      expect(drawn).toBe(outside ? 0 : 1);
      expect(calls).toBe(outside ? 0 : 1);
      expect([...owners].filter(Boolean)).toHaveLength(outside ? 0 : 4);
    }
  });

  it('places complete second-ring figures with original bytes, members, speech and clock cells', () => {
    const [g, agent] = person(1, 0, 3, {
      lng: 20,
      lat: 15,
      ahead: [21, 15],
      people: [look(), look({ lateral: 2, paint: 3 })],
      candle: true,
      effectClock: 12,
      speech: { id: 'second-ring', exchangeId: 'second-ring', line: 0, member: 1 },
    });
    const out = new Uint8Array(g.cols * g.rows * 4),
      plain = out.slice(),
      owners = new Uint32Array(g.cols * g.rows),
      members = new Uint8Array(owners.length),
      points = new Map<number, [number, number]>(),
      clocks: number[] = [];
    const allowsGroundCell = (_agent: VisibleAgent, col: number) => col === 17 || col === 18;
    let retries = 0;
    expect(
      packLife(
        out,
        { ...g, allowsGroundCell, speakers: { members, points } },
        [agent],
        themes.dark,
        glyphIndex,
        null,
        undefined,
        {
          owners,
          clockCells: clocks,
          focus: new Set(['people']),
          groupRetry: (result) => {
            retries++;
            expect(result.offsets).toEqual([
              [-2, 0],
              [-2, 0],
            ]);
          },
        },
      ),
    ).toBe(2);
    expect(
      packLife(
        plain,
        { ...g, allowsGroundCell },
        [agent],
        themes.dark,
        glyphIndex,
        null,
        undefined,
        { focus: new Set(['people']) },
      ),
    ).toBe(2);
    expect(plain).toEqual(out);
    expect(retries).toBe(1);
    expect([...members].filter((m) => m === 1)).toHaveLength(4);
    expect([...members].filter((m) => m === 2)).toHaveLength(4);
    expect([...owners].filter(Boolean)).toHaveLength(8);
    expect(new Set(clocks)).toEqual(
      new Set([...owners.entries()].filter(([, owner]) => owner).map(([at]) => at)),
    );
    expect(points.get(1)).toEqual([18, 19]);
    for (let i = 0; i < owners.length; i++)
      if (owners[i]) {
        expect(out[i * 4 + 2]! & LIFE_FOCUS_BIT).toBe(LIFE_FOCUS_BIT);
        expect(i % g.cols === 17 || i % g.cols === 18).toBe(true);
        expect(out[i * 4 + 3]).toBe(
          personByte(members[i] === 1 ? Paint.red : 3, PersonPart.figure, true),
        );
        const cls = unpackGlyph(out[i * 4]!, out[i * 4 + 1]!).cls,
          bits = out[i * 4 + 2]!;
        for (const surface of ['building', 'water_area', 'tree_crown'] as const)
          expect(
            lifeVisibleOnSurface(
              cls,
              bits,
              classId(surface),
              classId(surface),
              surface === 'building' ? 5 : 0,
            ),
          ).toBe(false);
        expect(lifeVisibleOnSurface(cls, bits, classId('paving'), classId('paving'), 0)).toBe(true);
      }
  });

  it('assigns a complete coherent group when no common second-ring translation fits', () => {
    const [g, agent] = person(1, 0, 0.2, { people: [look(), look({ lateral: 2, paint: 3 })] });
    const out = new Uint8Array(g.cols * g.rows * 4),
      owners = new Uint32Array(g.cols * g.rows),
      members = new Uint8Array(owners.length);
    const permits = (_agent: VisibleAgent, c: number, r: number) =>
      (c === 22 && r === 15) || (c === 21 && r === 17);
    expect(
      packLife(
        out,
        { ...g, allowsGroundCell: permits, speakers: { members, points: new Map() } },
        [agent],
        themes.dark,
        glyphIndex,
        null,
        undefined,
        { owners },
      ),
    ).toBe(2);
    expect(members[15 * g.cols + 22]).toBe(1);
    expect(members[17 * g.cols + 21]).toBe(2);
    expect([...owners].filter(Boolean)).toHaveLength(2);
  });

  it('preserves a first-ring member assignment without entering the new tier', () => {
    const [g, agent] = person(1, 0, 0.2, { people: [look(), look({ lateral: 0.2 })] });
    const out = new Uint8Array(g.cols * g.rows * 4);
    let work = 0;
    expect(
      packLife(out, g, [agent], themes.dark, glyphIndex, null, undefined, {
        groupRetry: () => work++,
      }),
    ).toBe(2);
    expect(work).toBe(0);
  });

  it('retains packing order and preserves earlier owners when the complete group cannot fit', () => {
    const [g, group] = person(1, 0, 0.2, { people: [look(), look({ lateral: 2 })] });
    const lone = { ...group, lng: 30, people: [look({ paint: 4 })] };
    const permits = (_agent: VisibleAgent, c: number, r: number) =>
      (c === 22 && r === 15) || (c === 21 && r === 17);
    const out = new Uint8Array(g.cols * g.rows * 4),
      owners = new Uint32Array(g.cols * g.rows),
      outcomes = new Uint8Array(2),
      isolated = out.slice();
    expect(
      packLife(
        out,
        { ...g, allowsGroundCell: permits, outcomes },
        [group, lone],
        themes.dark,
        glyphIndex,
        null,
        undefined,
        { owners },
      ),
    ).toBe(2);
    expect([...outcomes]).toEqual([PackingOutcome.drawn, PackingOutcome.collision]);
    expect([...owners].filter(Boolean)).toEqual([1, 1]);
    expect(
      packLife(isolated, { ...g, allowsGroundCell: permits }, [lone], themes.dark, glyphIndex),
    ).toBe(1);
    expect(
      packLife(
        out,
        { ...g, allowsGroundCell: permits, outcomes },
        [lone, group],
        themes.dark,
        glyphIndex,
        null,
        undefined,
        { owners },
      ),
    ).toBe(1);
    expect(out).toEqual(isolated);
    expect([...owners].filter(Boolean)).toEqual([1]);
    expect(outcomes[0]).toBe(PackingOutcome.drawn);
    expect(outcomes[1]).not.toBe(PackingOutcome.drawn);
  });

  it('keeps lone, stationary, detailed and oversized people at their existing retry bounds', () => {
    for (const [scale, extra] of [
      [0.2, { people: [look()] }],
      [0.2, { people: [look(), look({ lateral: 2 })], parked: true }],
      [0.2, { people: [look(), look({ lateral: 2 })], aboard: true }],
      [0.2, { people: [look({ figure: 'seated' }), look({ lateral: 2 })] }],
      [6, { people: [look(), look({ lateral: 2 })] }],
      [0.2, { people: Array.from({ length: 5 }, (_, lateral) => look({ lateral })) }],
    ] as const) {
      const [g, agent] = person(1, 0, scale, { ...extra, people: [...extra.people] });
      const out = new Uint8Array(g.cols * g.rows * 4);
      let work = 0;
      packLife(
        out,
        { ...g, allowsGroundCell: () => false },
        [agent],
        themes.dark,
        glyphIndex,
        null,
        undefined,
        { groupRetry: () => work++ },
      );
      expect(work).toBe(0);
      // Boats preserve their existing permissions and do not use a ground journal.
      if (!agent.aboard) expect(out.every((byte) => byte === 0)).toBe(true);
    }
  });

  it('packs fractional rotated slots as complete integer member rasters with metadata parity', () => {
    for (const people of [
      [
        look(),
        look({ lateral: 1 - Number.EPSILON, paint: 2 }),
        look({ back: 1 - Number.EPSILON, figure: 'child', paint: 3 }),
      ],
      [
        look(),
        look({ lateral: Math.SQRT1_2, back: Math.SQRT1_2, paint: 2 }),
        look({ lateral: -Math.SQRT1_2, back: Math.SQRT1_2, figure: 'child', paint: 3 }),
      ],
      // Quantization overlaps the adults: assignment must recover both full figures.
      [look(), look({ lateral: 0.5, paint: 2 }), look({ back: 1, figure: 'child', paint: 3 })],
    ]) {
      const [g, agent] = person(1, 1, 2, {
        people,
        candle: true,
        effectClock: 12,
        speech: { id: 'rotated', exchangeId: 'rotated', line: 0, member: 2 },
      });
      const out = new Uint8Array(g.cols * g.rows * 4),
        legacy = out.slice();
      const owners = new Uint32Array(g.cols * g.rows);
      const speakers = {
        members: new Uint8Array(owners.length),
        points: new Map<number, [number, number]>(),
      };
      const clocks: number[] = [];
      const valid = (_agent: VisibleAgent, c: number, r: number) => {
        expect(Number.isInteger(c) && Number.isInteger(r)).toBe(true);
        return true;
      };
      expect(
        packLife(
          out,
          { ...g, speakers, allowsGroundCell: valid },
          [agent],
          themes.dark,
          glyphIndex,
          null,
          undefined,
          { owners, clockCells: clocks },
        ),
      ).toBe(3);
      expect(
        packLife(legacy, { ...g, allowsGroundCell: valid }, [agent], themes.dark, glyphIndex),
      ).toBe(3);
      expect(legacy).toEqual(out);
      expect([...speakers.members].filter((m) => m === 1)).toHaveLength(4);
      expect([...speakers.members].filter((m) => m === 2)).toHaveLength(4);
      expect([...speakers.members].filter((m) => m === 3)).toHaveLength(1);
      expect([...owners].filter(Boolean)).toHaveLength(9);
      expect(new Set(clocks)).toEqual(
        new Set([...owners.entries()].filter(([, owner]) => owner).map(([cell]) => cell)),
      );
      const child = speakers.members.findIndex((member) => member === 3);
      expect(speakers.points.get(1)).toEqual([
        (child % g.cols) + 0.5,
        Math.floor(child / g.cols) + 0.5,
      ]);
      for (let member = 1; member <= 3; member++) {
        const cells = [...speakers.members.entries()]
          .filter(([, m]) => m === member)
          .map(([cell]) => cell);
        const glyphs = cells.map((cell) => out[cell * 4]!);
        const p = people[member - 1]!;
        expect(glyphs.sort()).toEqual(
          (member === 3
            ? [glyphIndex(figureGlyph('child', false, 0, { scale: 2 }))]
            : ([0, 1, 2, 3] as const).map((slice) =>
                glyphIndex(figureGlyph('adult', false, 0, { slice })),
              )
          ).sort(),
        );
        for (const cell of cells)
          expect(out[cell * 4 + 3]).toBe(personByte(p.paint, PersonPart.figure, true));
      }
      expect(
        packLife(
          out,
          { ...g, speakers, allowsGroundCell: () => false },
          [agent],
          themes.dark,
          glyphIndex,
          null,
          undefined,
          { owners, clockCells: clocks },
        ),
      ).toBe(0);
      expect(out.every((byte) => byte === 0)).toBe(true);
      expect(owners.every((owner) => owner === 0)).toBe(true);
      expect(speakers.members.every((member) => member === 0)).toBe(true);
      expect(speakers.points.size).toBe(0);
      expect(clocks).toEqual([]);
    }
  });

  it('rolls back a complete coarse member when one glyph of its figure is unavailable', () => {
    const [grid, agent] = person(1, 1, 2, { people: [look()], mappedPersonMover: true });
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    const missing = figureGlyph('adult', false, 0, { slice: 2 });
    expect(
      packLife(out, grid, [agent], themes.dark, (glyph) =>
        glyph === missing ? 0 : glyphIndex(glyph),
      ),
    ).toBe(0);
    expect(out.every((byte) => byte === 0)).toBe(true);
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

  it('draws static seated people at every size and heading, retaining whole-agent rollback', () => {
    for (const theme of Object.values(themes))
      for (const scale of [0.2, 3, 8])
        for (const [dx, dy, heading] of [
          [0, -1, 0],
          [1, 0, 1],
          [0, 1, 2],
          [-1, 0, 3],
        ] as const) {
          const [g, m] = person(dx, dy, scale, { people: [look({ figure: 'seated' })] });
          const out = new Uint8Array(g.cols * g.rows * 4);
          expect(packLife(out, g, [m], theme, glyphIndex)).toBe(1);
          const cells = Array.from({ length: g.cols * g.rows }, (_, i) => i).filter(
            (i) => out[i * 4 + 2],
          );
          expect(cells.length).toBeGreaterThan(0);
          if (scale * (dx === 0 ? 1.8 : 1) * 0.6 < 3) {
            for (const i of cells) {
              const { glyph } = unpackGlyph(out[i * 4]!, out[i * 4 + 1]!);
              expect(figureOf(glyphs[glyph]!)!).toMatchObject({
                figure: 'seated',
                heading,
                frame: 0,
              });
            }
          } else {
            expect(new Set(cells.map((i) => (out[i * 4 + 3]! >> 4) & 7))).toEqual(
              new Set([PersonPart.figure, PersonPart.skin]),
            );
          }
          const denied = cells[cells.length - 1]!;
          expect(
            packLife(
              out,
              { ...g, allowsGroundCell: (_a, c, r) => r * g.cols + c !== denied },
              [m],
              theme,
              glyphIndex,
            ),
          ).toBe(0);
          expect(out.every((v) => v === 0)).toBe(true);
        }
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
      expect(sextantGlyphs.map(glyphIndex)).toContain(packedGlyph(c.texel));
      expect(unpackGlyph(c.texel[0]!, c.texel[1]!).cls).toBe(classId('life_person'));
      expect(c.texel[2]).toBe(CellBit.person);
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
