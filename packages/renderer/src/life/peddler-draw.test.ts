import { expect, it } from 'vitest';
import { mapGlyphs, themes } from '../theme';
import { packLife, type LifeGrid } from './draw';
import { describeAgent } from './describe';
import { CellBit } from './config';
import { VEHICLES } from './vehicles';
import type { VisibleAgent } from './simulate';

const glyphs = ['', ...mapGlyphs(themes.dark)];
const index = (glyph: string) => Math.max(0, glyphs.indexOf(glyph));
const agent: VisibleAgent = {
  kind: 'person',
  lng: 2,
  lat: 2,
  ahead: [3, 2],
  side: [2, 3],
  flap: 0,
  peddler: { id: 'generic', label: 'Sample vendor', prop: 'box-cart', parasol: 0, lamp: 0 },
  people: [{ figure: 'adult', paint: 3, lateral: 0, back: 0, flap: 0 }],
};
const grid = (scale = 5): LifeGrid => ({
  cols: 30,
  rows: 30,
  cellWidth: 10,
  cellHeight: 10,
  toCell: (lng, lat) => [lng * scale, lat * scale],
  owners: new Uint32Array(900),
  speakers: { members: new Uint8Array(900), points: new Map() },
});
it.each(['box-cart', 'fry-cart', 'flatbed-cart'] as const)(
  'admits a coarse %s and its pusher as one owner in shared or adjacent cells',
  (prop) => {
    for (const lng of [2, 3]) {
      const g = grid(0.5),
        out = new Uint8Array(3600),
        a = {
          ...agent,
          lng,
          ahead: [lng + 1, 2] as [number, number],
          side: [lng, 3] as [number, number],
          peddler: { ...agent.peddler!, prop },
          speech: { id: 'call', member: 0, exchangeId: 'sample', line: 0 },
        };
      expect(packLife(out, g, [a], themes.dark, index)).toBe(1);
      expect(g.owners!.some((owner) => owner === 1)).toBe(true);
      expect(g.speakers!.points.get(1)).toEqual([Math.floor(lng * 0.5) + 0.5, 1.5]);
      expect(g.speakers!.members[Math.floor(lng * 0.5) + 30]).toBe(1);
      g.allowsGroundCell = () => false;
      expect(packLife(out, g, [a], themes.dark, index)).toBe(0);
      expect(out.some((byte) => byte > 0)).toBe(false);
      expect(g.speakers!.points.size).toBe(0);
      g.allowsGroundCell = undefined;
      const ordinary = { ...a, peddler: undefined, speech: undefined };
      packLife(out, g, [ordinary, a], themes.dark, index);
      expect(g.owners!.some((owner) => owner === 2)).toBe(false);
      expect(g.speakers!.points.has(2)).toBe(false);
    }
  },
);
it.each([1, 1.5])(
  'retains a mini box-cart glyph beneath a positive parasol state at %s cells/m',
  (scale) => {
    const g = grid(scale),
      out = new Uint8Array(3600),
      a = { ...agent, peddler: { ...agent.peddler!, parasol: 1 } };
    expect(packLife(out, g, [a], themes.dark, index)).toBe(1);
    const mini = index(VEHICLES['box-cart'].mini[0]);
    expect(
      Array.from({ length: 900 }, (_, cell) => out[cell * 4]! | ((out[cell * 4 + 1]! >> 6) << 8)),
    ).toContain(mini);
  },
);
it('owns the cart ahead of its pusher as one person, with speech only on the pusher', () => {
  const g = grid(),
    out = new Uint8Array(3600);
  packLife(
    out,
    g,
    [{ ...agent, speech: { id: 'call', member: 0, exchangeId: 'sample', line: 0 } }],
    themes.dark,
    index,
  );
  expect(describeAgent(agent)).toBe('Sample vendor (simulated)');
  const cells = Array.from(g.owners!.entries())
    .filter(([, owner]) => owner > 0)
    .map(([cell]) => cell);
  expect(cells.some((cell) => cell % 30 > 14)).toBe(true);
  expect(cells.some((cell) => cell % 30 < 12)).toBe(true);
  for (const cell of cells) expect(out[cell * 4 + 2]! & CellBit.person).toBeTruthy();
  expect(g.speakers!.points.get(1)).toEqual([10, 10]);
  for (const cell of cells.filter((c) => c % 30 > 14)) expect(g.speakers!.members[cell]).toBe(0);
});
it('rejects the complete pair when any cart cell fails person ground clearance', () => {
  const g = grid(),
    out = new Uint8Array(3600);
  g.allowsGroundCell = (_agent, col) => col < 14;
  packLife(out, g, [agent], themes.dark, index);
  expect(out.some((byte) => byte > 0)).toBe(false);
  expect(g.owners!.some((owner) => owner > 0)).toBe(false);
  expect(g.speakers!.points.size).toBe(0);
});
it('allows a stop puff only after the full stamped fry-cart owner survives', () => {
  const g = grid(),
    out = new Uint8Array(3600);
  g.stampedVehicles = new Uint8Array(1);
  const a = { ...agent, peddler: { ...agent.peddler!, prop: 'fry-cart' as const } };
  packLife(out, g, [a], themes.dark, index);
  expect(g.stampedVehicles[0]).toBe(1);
  g.allowsGroundCell = () => false;
  packLife(out, g, [a], themes.dark, index);
  expect(g.stampedVehicles[0]).toBe(0);
});
it.each([0.1, 0.5, 1])('retains a stamped carrier underneath an open canopy (%s)', (open) => {
  const g = grid(),
    out = new Uint8Array(3600);
  const a: VisibleAgent = {
    ...agent,
    peddler: { ...agent.peddler!, prop: 'pole-buckets' },
    people: [
      {
        figure: 'umbrella',
        paint: 1,
        lateral: 0,
        back: 0,
        flap: 0,
        canopy: { open, figure: 'pole-buckets', paint: 3 },
      },
    ],
  };
  expect(packLife(out, g, [a], themes.dark, index)).toBeGreaterThan(0);
  expect(out.some((byte) => byte > 0)).toBe(true);
});
