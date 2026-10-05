import { expect, it } from 'vitest';
import { classId } from '../classes';
import { unpackGlyph } from '../glyphs/select';
import { mapGlyphs, sextantGlyphs, themes } from '../theme';
import { CellBit } from './config';
import { packLife, type LifeGrid } from './draw';
import {
  CANDLE_BIT,
  figureOf,
  PAINT_NONE,
  PersonPart,
  personByte,
  personGlyphs,
  type PersonLook,
} from './people';
import type { VisibleAgent } from './simulate';
import { ACCESS_GLYPHS, SEASONAL_GLYPHS } from './seasonal-glyphs';

const glyphs = ['', ...mapGlyphs(themes.dark)];
const index = (glyph: string) => glyphs.indexOf(glyph);
const grid: LifeGrid = {
  cols: 80,
  rows: 80,
  cellWidth: 10,
  cellHeight: 18,
  toCell: (lng, lat) => [lng, lat],
};
const cells = (out: Uint8Array) =>
  Array.from({ length: out.length / 4 }, (_, i) =>
    Array.from(out.subarray(i * 4, i * 4 + 4)),
  ).filter((t) => t[2]);
it('records emoji driver, pet and human anchors without changing packed bytes', () => {
  for (const scale of [1, 4]) {
    const agents: VisibleAgent[] = [
      {
        kind: 'vehicle',
        vehicle: 'car',
        lng: 20,
        lat: 20,
        ahead: [20 + scale, 20],
        side: [20, 20 + scale],
        flap: 0,
        emoji: { id: 'car', subject: 'driver', mood: 'cool' },
      },
      {
        kind: 'dog',
        lng: 50,
        lat: 20,
        ahead: [50 + scale, 20],
        flap: 0,
        emoji: { id: 'dog', subject: 'dog', mood: 'happy' },
      },
      {
        kind: 'cat',
        lng: 50,
        lat: 50,
        ahead: [50 + scale, 50],
        flap: 0,
        emoji: { id: 'cat', subject: 'cat', mood: 'sleeping' },
      },
      {
        kind: 'person',
        vehicle: 'cart',
        lng: 20,
        lat: 50,
        ahead: [20 + scale, 50],
        side: [20, 50 + scale],
        flap: 0,
        people: [{ figure: 'adult', paint: 2, lateral: 1, back: 0, flap: 0 }],
        emoji: { id: 'vendor', subject: 'person', mood: 'happy' },
      },
    ];
    const out = new Uint8Array(grid.cols * grid.rows * 4),
      plain = new Uint8Array(out.length);
    const owners = new Uint32Array(out.length / 4),
      speakers = {
        members: new Uint8Array(owners.length),
        points: new Map<number, [number, number]>(),
      };
    packLife(out, { ...grid, owners, speakers }, agents, themes.dark, index);
    packLife(
      plain,
      grid,
      agents.map(({ emoji: _emoji, ...agent }) => agent),
      themes.dark,
      index,
    );
    expect(out).toEqual(plain);
    expect(speakers.points.size).toBe(4);
    if (scale === 4) expect(speakers.points.get(1)![0]).toBeGreaterThan(20);
    expect(speakers.points.get(4)![1]).toBeGreaterThan(50);
    expect([...owners].some((owner, i) => owner === 4 && speakers.members[i] === 1)).toBe(true);
  }
});
it('tracks the actual speaking member and vendor separately from other people and cart cells', () => {
  const owners = new Uint32Array(grid.cols * grid.rows);
  const speakers = {
    members: new Uint8Array(owners.length),
    points: new Map<number, [number, number]>(),
  };
  const out = new Uint8Array(owners.length * 4);
  const person = { figure: 'adult' as const, paint: 2, lateral: 0, back: 0, flap: 0 };
  const agent: VisibleAgent = {
    kind: 'person',
    lng: 40,
    lat: 40,
    ahead: [44, 40],
    side: [40, 44],
    flap: 0,
    people: [person, { ...person, lateral: 1 }],
    speech: { id: 'group', exchangeId: 'call', line: 1, member: 1 },
  };
  packLife(out, { ...grid, owners, speakers }, [agent], themes.dark, index);
  expect(new Set([...speakers.members].filter(Boolean))).toEqual(new Set([1, 2]));
  expect(speakers.points.get(1)![1]).toBeGreaterThan(40);
  agent.vehicle = 'cart';
  agent.people = [{ ...person, lateral: 1 }];
  agent.speech!.member = 0;
  packLife(out, { ...grid, owners, speakers }, [agent], themes.dark, index);
  expect([...owners].some((owner, i) => owner === 1 && speakers.members[i] === 0)).toBe(true);
  expect([...owners].some((owner, i) => owner === 1 && speakers.members[i] === 1)).toBe(true);
  const legacy = new Uint8Array(out.length);
  packLife(legacy, grid, [agent], themes.dark, index);
  expect(out).toEqual(legacy);
  packLife(
    out,
    { ...grid, owners, speakers, allowsGroundCell: () => false },
    [agent],
    themes.dark,
    index,
  );
  expect(speakers.members.every((slot) => slot === 0)).toBe(true);
});
it('preserves packed bytes and restores final ownership when a complete speaker is rejected', () => {
  const agents: VisibleAgent[] = [
    { kind: 'person', lng: 40.35, lat: 40.45, flap: 0 },
    { kind: 'person', lng: 40.35, lat: 40.45, flap: 0 },
  ];
  const legacy = new Uint8Array(grid.cols * grid.rows * 4),
    owned = new Uint8Array(legacy.length);
  const owners = new Uint32Array(grid.cols * grid.rows);
  const n = packLife(legacy, grid, agents, themes.dark, index);
  expect(packLife(owned, { ...grid, owners }, agents, themes.dark, index)).toBe(n);
  expect(owned).toEqual(legacy);
  expect([...owners].filter(Boolean)).toEqual([1]);
  packLife(owned, { ...grid, owners, allowsGroundCell: () => false }, agents, themes.dark, index);
  expect(owners.every((owner) => owner === 0)).toBe(true);
  expect(owned.every((byte) => byte === 0)).toBe(true);
  expect(() =>
    packLife(
      owned,
      {
        ...grid,
        owners,
        allowsGroundCell: () => {
          throw new Error('guard');
        },
      },
      agents,
      themes.dark,
      index,
    ),
  ).toThrow('guard');
  expect(packLife(owned, grid, agents, themes.dark, index)).toBe(n);
  expect(owned).toEqual(legacy);
});
function draw(
  figure: PersonLook['figure'],
  pose: PersonLook['pose'],
  scale: number,
  direction: readonly [number, number] = [1, 0],
) {
  const agent: VisibleAgent = {
    kind: 'person',
    lng: 40.35,
    lat: 40.45,
    ahead: [40.35 + direction[0] * scale, 40.45 + (direction[1] * scale) / 1.8],
    flap: 0,
    people: [{ figure, paint: 2, lateral: 0, back: 0, flap: 0, pose }],
  };
  const out = new Uint8Array(grid.cols * grid.rows * 4);
  const drawn = packLife(out, grid, [agent], themes.dark, index);
  return { out, agent, drawn, cells: cells(out) };
}
it('keeps canopy stages after all existing map glyphs in both themes', () => {
  const stages = personGlyphs().filter((glyph) => figureOf(glyph)?.stage !== undefined);
  expect(stages).toHaveLength(14);
  for (const theme of Object.values(themes)) {
    const glyphs = mapGlyphs(theme),
      start = glyphs.indexOf(stages[0]!);
    expect(glyphs.slice(start, start + stages.length)).toEqual(stages);
    expect(start).toBeGreaterThan(Math.max(...ACCESS_GLYPHS.map((glyph) => glyphs.indexOf(glyph))));
  }
});

it('packs attentive and gesturing adults and children at one-cell, big and stamp sizes', () => {
  // Seasonal symbols, parking labels and fourteen canopy stages extend the original glyph set.
  expect(mapGlyphs(themes.dark)).toHaveLength(
    385 + SEASONAL_GLYPHS.length + ACCESS_GLYPHS.length + 14,
  );
  expect(mapGlyphs(themes.light)).toHaveLength(
    385 + SEASONAL_GLYPHS.length + ACCESS_GLYPHS.length + 14,
  );
  for (const figure of ['adult', 'child'] as const)
    for (const pose of ['attentive', 'gesture'] as const)
      for (const scale of [0.5, 3, 8])
        for (const direction of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const result = draw(figure, pose, scale, direction);
          expect(result.drawn).toBe(1);
          for (const texel of result.cells) {
            const decoded = unpackGlyph(texel[0]!, texel[1]!);
            expect(decoded.cls).toBe(classId('life_person'));
            expect(texel[2]).toBe(CellBit.person);
            expect(texel[3]! & CANDLE_BIT).toBe(0);
            const glyph = glyphs[decoded.glyph]!;
            if (scale === 8) expect(sextantGlyphs).toContain(glyph);
            else expect(figureOf(glyph)).toMatchObject({ figure, pose });
          }
          expect(result.out).not.toEqual(draw(figure, undefined, scale, direction).out);
        }
});
it('preserves umbrella canopies and rejects the entire figure when a footprint cell is denied', () => {
  for (const scale of [0.5, 2, 8]) {
    expect(draw('umbrella', 'gesture', scale).out).toEqual(draw('umbrella', undefined, scale).out);
    const { agent } = draw('adult', 'gesture', scale);
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    expect(
      packLife(out, { ...grid, allowsGroundCell: () => false }, [agent], themes.dark, index),
    ).toBe(0);
    expect(out.every((byte) => byte === 0)).toBe(true);
  }
});
it('dispatches balls before figures, uses the correct byte, and never displaces an actor', () => {
  const ball: VisibleAgent = { kind: 'person', prop: 'ball', lng: 40.35, lat: 40.45, flap: 0 };
  const out = new Uint8Array(grid.cols * grid.rows * 4);
  expect(packLife(out, grid, [ball], themes.dark, index)).toBe(1);
  const [texel] = cells(out);
  expect(glyphs[unpackGlyph(texel![0]!, texel![1]!).glyph]).toBe('•');
  expect(texel![3]).toBe(personByte(PAINT_NONE, PersonPart.figure));
  const { agent } = draw('child', 'attentive', 0.5);
  expect(packLife(out, grid, [agent, ball], themes.dark, index)).toBe(1);
  expect(
    figureOf(glyphs[unpackGlyph(cells(out)[0]![0]!, cells(out)[0]![1]!).glyph]!),
  ).toBeDefined();
  expect(
    packLife(out, { ...grid, allowsGroundCell: () => false }, [ball], themes.dark, index),
  ).toBe(0);
});
