import { expect, it } from 'vitest';
import {
  localMetricProjection,
  type StreetRoute,
  type MassRoute,
  type FluvialRoute,
} from '@atlas/shared';
import { crowdMask, throng, MAX_THRONG_CELLS } from './throng';
import { packLife } from './draw';
import { groundForRoute, eventGroundAllows } from './ground-events';
import { themes, mapGlyphs } from '../theme';
import type { GridPlacement } from '../grid';
import { TIERS } from '../quality';
import { ProcessionGlyph } from './procession-glyphs';
import { drawProcedural } from '../glyphs/atlas';
const frame = localMetricProjection([0, 0]),
  q = (x: number, y: number) => frame.from([x, y]);
const box = (w: number, s: number, e: number, n: number) => [
  q(w, s),
  q(e, s),
  q(e, n),
  q(w, n),
  q(w, s),
];
const common = {
  id: 'test',
  title: { en: 'Test' },
  status: 'draft' as const,
  schedule: {
    month: 9,
    weekday: 6,
    nth: 3,
    offset_days: 0,
    start: '12:00',
    duration_min: 10,
    timezone: 'Asia/Manila',
  },
};
const street: StreetRoute = {
  ...common,
  kind: 'procession',
  route: [q(-100, 0), q(100, 0)],
  length_m: 200,
  segments: [
    { id: 'osm:way/1', width_m: 8, clear_m: 8, sidewalk_m: 0, verge_m: { left: 5, right: 5 } },
  ],
  blocked: [],
};
function grid(w: number, h: number, cols = 100, rows = 40): GridPlacement {
  return {
    grid: { originCol: -cols / 2, originRow: -rows / 2, shiftX: 0, shiftY: 0 },
    toCell: (lng, lat) => {
      const [x, y] = frame.to([lng, lat]);
      return [x / w + cols / 2, -y / h + rows / 2];
    },
    fromCell: (c, r) => q((c - cols / 2) * w, -(r - rows / 2) * h),
    tileMatrix: () => [],
  };
}
const theme = themes.dark;
const glyphs = mapGlyphs(theme),
  glyphIndex = (g: string) => Math.max(0, glyphs.indexOf(g));
it.each([6, 8])(
  'keeps partial coarse ink on a %s m road and excludes complete roof/water outlines',
  (width) => {
    const event = {
      ...street,
      segments: [{ ...street.segments[0]!, width_m: width, verge_m: { left: 0, right: 0 } }],
      blocked: [box(10, 1, 30, 5)],
      water: [box(-40, -8, -20, -1)],
    };
    const placement = grid(12, 25);
    const payload = throng(event, 0.45, placement, 100, 40, 15);
    expect(payload.cells.length).toBeGreaterThan(0);
    for (const cell of payload.cells)
      for (let bit = 0; bit < 256; bit++)
        if ((cell.mask![bit >>> 5]! >>> (bit & 31)) & 1) {
          const c = cell.col + ((bit % 16) + 0.5) / 16,
            r = cell.row + (Math.floor(bit / 16) + 0.5) / 16;
          expect(eventGroundAllows(groundForRoute(event), [placement.fromCell!(c, r)])).toBe(true);
        }
  },
);
it('detects a tiny exclusion enclosed by a mask subcell rather than trusting its centre', () => {
  const ground = { regions: [box(0, 0, 16, 16)], blocked: [box(0.1, 0.1, 0.2, 0.2)] };
  const mask = crowdMask(ground, 0, 0, (c, r) => q(c * 16, r * 16));
  expect(mask).toBeDefined();
  expect(mask![0]! & 1).toBe(0);
});
it('packs ownerless complete crowds between event actors and ordinary people, with all tier caps', () => {
  const placement = grid(1, 1),
    ground = groundForRoute(street);
  for (const tier of TIERS) {
    const payload = throng(street, 0.5, placement, 100, 40, 18, tier.knobs.throng);
    payload.cap = 19;
    const out = new Uint8Array(100 * 40 * 4),
      owners = new Uint32Array(4000),
      mask = new Uint32Array(4000 * 8),
      cells: number[] = [];
    const actors = [
      { kind: 'person' as const, lng: 0, lat: 0, flap: 0, eventGround: street.id },
      { kind: 'person' as const, lng: 0, lat: 0, flap: 0 },
    ];
    packLife(
      out,
      {
        cols: 100,
        rows: 40,
        cellWidth: 10,
        cellHeight: 18,
        toCell: placement.toCell,
        allowsGroundCell: (agent, c, r) =>
          eventGroundAllows(ground, [placement.fromCell!(c + 0.5, r + 0.5)]),
        owners,
      },
      actors,
      theme,
      glyphIndex,
      undefined,
      undefined,
      { throng: payload, throngMask: mask, throngCells: cells },
    );
    expect(cells.length).toBeLessThanOrEqual(19);
    expect(cells.every((i) => owners[i] === 0)).toBe(true);
    expect(owners.some((i) => i === 1)).toBe(true);
    expect(throng(street, 0.5, placement, 100, 40, 18, tier.knobs.throng).cap).toBe(
      Math.floor(MAX_THRONG_CELLS * tier.knobs.throng),
    );
  }
});
it('keeps static verge membership independent of moving progress and clears completion', () => {
  const placement = grid(2, 2);
  const positions = (progress: number) =>
    throng(street, progress, placement, 100, 40, 18)
      .cells.filter((c) => Math.abs(frame.to([c.agent.lng, c.agent.lat])[1]) > 4)
      .map((c) => [c.col, c.row, c.agent.paint]);
  expect(positions(0.3)).toEqual(positions(0.8));
  expect(positions(0.3).length).toBeGreaterThan(0);
  expect(throng(street, 1, placement, 100, 40, 18).cells).toHaveLength(0);
});
it('fills all safe Mass components during hold, preserving the altar apron and seated permission', () => {
  const event: MassRoute = {
    ...common,
    kind: 'mass',
    site: {
      id: 'osm:way/2',
      location: q(0, 0),
      anchor: q(0, -20),
      radius_m: 100,
      grounds: [box(-40, -40, -10, 40), box(10, -40, 40, 40)],
      seated_grounds: [box(-5, -5, 5, 5)],
      altar_ground: [box(-8, 15, 8, 30)],
      altar: { at: q(0, 20), radius_m: 5, images: 2 },
      blocked: [box(-9, -40, 9, -10)],
      approaches: [[q(-30, -30), q(-20, -20)]],
      roads: [],
    },
  };
  const placement = grid(2, 2);
  const payload = throng(event, 0.5, placement, 100, 40, 18);
  expect(payload.cells.some((c) => c.agent.eventRole === 'seated')).toBe(true);
  const standing = payload.cells.filter((c) => !c.agent.eventRole);
  expect(standing.some((c) => c.agent.lng < 0)).toBe(true);
  expect(standing.some((c) => c.agent.lng > 0)).toBe(true);
  expect(
    payload.cells.every(
      (c) => !eventGroundAllows(groundForRoute(event).altar!, [[c.agent.lng, c.agent.lat]]),
    ),
  ).toBe(true);
  expect(throng(event, 1, placement, 100, 40, 18).cells).toHaveLength(0);
});
it('rasterizes every new crowd/altar glyph without changing legacy map positions', () => {
  for (let code = 0xe404; code <= 0xe40b; code++) {
    const data = new Uint8Array(180);
    expect(
      drawProcedural({ data, stride: 10, x0: 0, y0: 0, w: 10, h: 18 }, String.fromCharCode(code)),
    ).toBe(true);
    expect(data.some((x) => x > 0)).toBe(true);
  }
  expect(glyphs.indexOf(ProcessionGlyph.crowd0)).toBe(glyphs.indexOf(ProcessionGlyph.bugle) + 1);
  expect(glyphs.indexOf(ProcessionGlyph.support)).toBe(glyphs.indexOf(ProcessionGlyph.crowd0) + 7);
});

it.each(['procession', 'mass', 'fluvial'] as const)(
  'meets the final packed %s coverage floor below the cap',
  (kind) => {
    const placement = grid(2, 2, 140, 80),
      region = box(-100, -30, 100, 30);
    const mass: MassRoute = {
      ...common,
      kind: 'mass',
      site: {
        id: 'osm:way/2',
        location: q(0, 0),
        anchor: q(0, -10),
        radius_m: 150,
        grounds: [region],
        blocked: [],
        approaches: [[q(-20, 0), q(0, 0)]],
        roads: [],
      },
    };
    const river: FluvialRoute = {
      ...common,
      kind: 'fluvial',
      route: [q(-100, 0), q(100, 0)],
      length_m: 200,
      banks: [
        [5, 5],
        [5, 5],
      ],
      crowd_ground: {
        grounds: [box(-100, -30, 100, -6), box(-100, 6, 100, 30)],
        blocked: [],
        water: [box(-100, -5, 100, 5)],
        bridges: [],
      },
    };
    const event = kind === 'mass' ? mass : kind === 'fluvial' ? river : street,
      ground = groundForRoute(event);
    const payload = throng(event, 0.5, placement, 140, 80, 18),
      out = new Uint8Array(140 * 80 * 4),
      cells: number[] = [];
    packLife(
      out,
      {
        cols: 140,
        rows: 80,
        cellWidth: 10,
        cellHeight: 18,
        toCell: placement.toCell,
        allowsGroundCell: (_, c, r) =>
          eventGroundAllows(ground, [placement.fromCell!(c + 0.5, r + 0.5)]),
      },
      [],
      theme,
      glyphIndex,
      undefined,
      undefined,
      { throng: payload, throngCells: cells },
    );
    const packed = new Set(cells);
    const counts: Record<'stream' | 'verge' | 'ground', [number, number]> = {
      stream: [0, 0],
      verge: [0, 0],
      ground: [0, 0],
    };
    for (let r = 0; r < 80; r++)
      for (let c = 0; c < 140; c++) {
        const point = placement.fromCell!(c + 0.5, r + 0.5),
          [x, y] = frame.to(point);
        if (Math.abs(x) >= 98 || !eventGroundAllows(ground, [point])) continue;
        const key = kind === 'procession' ? (Math.abs(y) < 4 ? 'stream' : 'verge') : 'ground';
        if (kind === 'procession' && Math.abs(y) > 8) continue;
        counts[key][1]++;
        if (packed.has(r * 140 + c)) counts[key][0]++;
      }
    if (kind === 'procession') {
      expect(counts.stream[0] / counts.stream[1]).toBeGreaterThanOrEqual(0.8);
      expect(counts.verge[0] / counts.verge[1]).toBeGreaterThanOrEqual(0.6);
    } else
      expect(counts.ground[0] / counts.ground[1]).toBeGreaterThanOrEqual(
        kind === 'mass' ? 0.9 : 0.6,
      );
    expect(cells.length).toBeLessThan(payload.cap);
  },
);

it.each([0.35, 0.15])(
  'rolls back an entire close figure at %s m cells when its final texels exceed the cap',
  (size) => {
    const placement = grid(size, size, 100, 80),
      payload = throng(street, 0.5, placement, 100, 80, 21);
    payload.cells = payload.cells
      .filter((c) => c.col > 20 && c.col < 70 && c.row > 20 && c.row < 60)
      .slice(0, 1);
    expect(payload.cells).toHaveLength(1);
    const pack = (cap: number) => {
      payload.cap = cap;
      const out = new Uint8Array(100 * 80 * 4),
        cells: number[] = [];
      packLife(
        out,
        { cols: 100, rows: 80, cellWidth: 10, cellHeight: 18, toCell: placement.toCell },
        [],
        theme,
        glyphIndex,
        undefined,
        undefined,
        { throng: payload, throngCells: cells },
      );
      return { out, cells };
    };
    const complete = pack(100);
    expect(complete.cells.length).toBeGreaterThan(1);
    const rejected = pack(complete.cells.length - 1);
    expect(rejected.cells).toHaveLength(0);
    expect(rejected.out.every((v) => v === 0)).toBe(true);
  },
);
