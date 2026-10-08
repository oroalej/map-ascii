import { expect, it, vi } from 'vitest';
import {
  localMetricProjection,
  type StreetRoute,
  type MassRoute,
  type FluvialRoute,
} from '@atlas/shared';
import { throng as budgeted, MAX_THRONG_CELLS, THRONG_MASK_SIDE } from './throng';
import { CrowdMaskRaster } from './crowd-mask';
import { packLife } from './draw';
import { groundForRoute, eventGroundAllows } from './ground-events';
import { formationLayout } from './formation-layout';
import { themes, mapGlyphs } from '../theme';
import type { GridPlacement } from '../grid';
import { TIERS } from '../quality';
import { ProcessionGlyph } from './procession-glyphs';
import { FOLKLORE_GLYPHS } from './folklore-glyphs';
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
function grid(w: number, h: number, cols = 100, rows = 40, pan = 0): GridPlacement {
  return {
    grid: { originCol: -cols / 2 + pan, originRow: -rows / 2, shiftX: 0, shiftY: 0 },
    toCell: (lng, lat) => {
      const [x, y] = frame.to([lng, lat]);
      return [x / w + cols / 2 - pan, -y / h + rows / 2];
    },
    fromCell: (c, r) => q((c - cols / 2 + pan) * w, -(r - rows / 2) * h),
    tileMatrix: () => [],
  };
}
/** The crowd once its whole field is prepared (no per-frame budget). */
const throng = (
  event: Parameters<typeof budgeted>[0],
  progress: number,
  placement: GridPlacement,
  cols: number,
  rows: number,
  zoom: number,
  quality = 1,
  guardFor?: Parameters<typeof budgeted>[7],
) => budgeted(event, progress, placement, cols, rows, zoom, quality, guardFor, Infinity);
const theme = themes.dark;
const glyphs = mapGlyphs(theme),
  glyphIndex = (g: string) => Math.max(0, glyphs.indexOf(g));
const metres = (c: { agent: { lng: number; lat: number } }) => frame.to([c.agent.lng, c.agent.lat]);
it('classifies the ground once: zoom, pans and progress only project the field', () => {
  const event = { ...street, route: [q(-120, 0), q(120, 0)], length_m: 240 };
  const has = vi.spyOn(CrowdMaskRaster.prototype, 'has');
  try {
    expect(throng(event, 0.4, grid(2, 2), 100, 40, 18).cells.length).toBeGreaterThan(0);
    const classified = has.mock.calls.length;
    expect(classified).toBeGreaterThan(0);
    for (const [w, h, zoom] of [
      [12, 25, 15],
      [6, 11, 16.2],
      [3, 5, 17],
      [1.4, 2.5, 18.5],
      [0.7, 1.3, 19.6],
    ] as const) {
      const cells = throng(event, 0.4, grid(w, h), 100, 40, zoom).cells;
      expect(cells.length).toBeGreaterThan(0);
      expect(
        throng(event, 0.6, grid(w, h, 100, 40, 3), 100, 40, zoom).cells.length,
      ).toBeGreaterThan(0);
    }
    expect(has).toHaveBeenCalledTimes(classified);
  } finally {
    has.mockRestore();
  }
});
it('rebases a pan inside the prepared window without moving any figure', () => {
  const first = throng(street, 0.4, grid(2, 2), 100, 40, 18);
  const still = throng(street, 0.4, grid(2, 2), 100, 40, 18);
  const settledFirst = still.cells.map((c) => [c.col, c.row, c.agent.paint]);
  const panned = throng(street, 0.4, grid(2, 2, 100, 40, 4), 100, 40, 18);
  expect(first.cells.length).toBeGreaterThan(0);
  const inside = (c: { col: number }) => c.col >= 4 && c.col < 96;
  expect(
    panned.cells
      .map((c) => [c.col + 4, c.row, c.agent.paint])
      .filter(([c]) => c! >= 8 && c! < 96)
      .sort(),
  ).toEqual(settledFirst.filter(([c]) => inside({ col: c! }) && c! >= 8).sort());
});
it('checks terrain once per snapshot, rechecking only for a new one', () => {
  let checks = 0;
  const snapshot = (allowed: boolean, keys = { terrainKey: {}, hardTerrainKey: {} }) =>
    Object.assign(() => {
      checks++;
      return allowed;
    }, keys);
  const keys = { terrainKey: {}, hardTerrainKey: {} };
  const event = { ...street, id: 'terrain' };
  const open = () => snapshot(true, keys);
  expect(throng(event, 0.4, grid(2, 2), 100, 40, 18, 1, open).cells.length).toBeGreaterThan(0);
  const cold = checks;
  expect(cold).toBeGreaterThan(0);
  throng(event, 0.6, grid(1, 2), 100, 40, 18.5, 1, open);
  throng(event, 0.4, grid(12, 25), 100, 40, 15, 1, open);
  expect(checks).toBe(cold);
  const closed = snapshot(false);
  expect(throng(event, 0.4, grid(2, 2), 100, 40, 18, 1, () => closed).cells).toHaveLength(0);
  expect(checks).toBeGreaterThan(cold);
});
it('prepares visible chunks first within the frame budget and keeps them', () => {
  const event = { ...street, id: 'budget', crowd_grounds: [box(-600, -600, 600, 600)] };
  const placement = grid(2, 2);
  let payload = budgeted(event, 0.4, placement, 100, 40, 18, 1, undefined, 0);
  expect(payload.pending).toBe(true);
  let frames = 0,
    previous = payload.cells.length;
  while (payload.pending) {
    expect(++frames).toBeLessThan(200);
    payload = budgeted(event, 0.4, placement, 100, 40, 18, 1, undefined, 0);
    expect(payload.cells.length).toBeGreaterThanOrEqual(previous);
    previous = payload.cells.length;
  }
  // The view and its pan margin finish long before the rest of the 1.2 km field.
  expect(frames).toBeLessThan(100);
  const complete = throng(event, 0.4, placement, 100, 40, 18).cells.map((c) => [c.col, c.row]);
  expect(payload.cells.map((c) => [c.col, c.row]).sort()).toEqual(complete.sort());
});
it('uses the wider sidewalk, and parade spectators on authored grounds stay put', () => {
  const event = {
    ...street,
    kind: 'parade',
    segments: [{ ...street.segments[0]!, sidewalk_m: 3, verge_m: { left: 1, right: 1 } }],
    crowd_grounds: [box(-40, 150, 40, 160)],
  } as StreetRoute;
  const placement = grid(1, 1, 200, 400);
  const positions = (p: number) => throng(event, p, placement, 200, 400, 18).cells;
  expect(positions(0.2).some((c) => Math.abs(metres(c)[1]) > 5 && Math.abs(metres(c)[1]) < 7)).toBe(
    true,
  );
  const distant = (p: number) =>
    positions(p)
      .filter((c) => metres(c)[1] > 140)
      .map((c) => [c.col, c.row, c.agent.paint]);
  expect(distant(0.2).length).toBeGreaterThan(0);
  expect(distant(0.2)).toEqual(distant(0.8));
});
it('gathers the procession crowd ahead of the images, walks with them and thins behind', () => {
  const event: StreetRoute = {
    ...street,
    route: [q(-1500, 0), q(1500, 0)],
    length_m: 3000,
  };
  const layout = formationLayout(event);
  const placement = grid(2, 2, 1600, 12);
  const spectators = (progress: number) => {
    const head = layout.head(progress) - 1500;
    const counts = { ahead: 0, beside: 0, passed: 0 };
    // Verge figures only; the stream fills the road behind the head.
    for (const c of throng(event, progress, placement, 1600, 12, 18).cells) {
      const [x, y] = metres(c);
      if (Math.abs(y) <= 4.5) continue;
      if (x > head + 400 && x < head + 700) counts.ahead++;
      else if (x < head - 50 && x > head - 350) counts.beside++;
      else if (x < head - layout.tail - 350 && x > head - layout.tail - 650) counts.passed++;
    }
    return counts;
  };
  const middle = spectators(0.5);
  expect(middle.beside).toBeGreaterThan(middle.ahead * 1.5);
  expect(middle.ahead).toBeGreaterThan(middle.passed * 1.5);
  // The dense crowd moves on with the head.
  const before = throng(event, 0.3, placement, 1600, 12, 18).cells.filter(
    (c) => Math.abs(metres(c)[1]) > 4.5,
  );
  const after = throng(event, 0.7, placement, 1600, 12, 18).cells.filter(
    (c) => Math.abs(metres(c)[1]) > 4.5,
  );
  const mean = (cells: typeof before) => cells.reduce((n, c) => n + metres(c)[0], 0) / cells.length;
  expect(mean(after)).toBeGreaterThan(mean(before) + 200);
});
it.each([6, 8])(
  'keeps partial coarse ink on a %s m road and excludes roof/water interiors',
  (width) => {
    const event = {
      ...street,
      segments: [{ ...street.segments[0]!, width_m: width, verge_m: { left: 0, right: 0 } }],
      blocked: [box(10, -5, 40, 5)],
      water: [box(-60, -8, -20, 8)],
    };
    const placement = grid(12, 25);
    const payload = throng(event, 0.45, placement, 100, 40, 15);
    expect(payload.cells.length).toBeGreaterThan(0);
    let bits = 0;
    for (const cell of payload.cells)
      for (let bit = 0; bit < 256; bit++)
        if ((cell.mask![bit >>> 5]! >>> (bit & 31)) & 1) {
          bits++;
          const [x, y] = frame.to(
            placement.fromCell!(
              cell.col + ((bit % THRONG_MASK_SIDE) + 0.5) / THRONG_MASK_SIDE,
              cell.row + (Math.floor(bit / THRONG_MASK_SIDE) + 0.5) / THRONG_MASK_SIDE,
            ),
          );
          // Sample blocks may reach a few metres past an edge, never into the interior.
          expect(x > 22 && x < 28).toBe(false);
          expect(x > -50 && x < -30).toBe(false);
          expect(Math.abs(y)).toBeLessThan(width / 2 + 3);
        }
    expect(bits).toBeGreaterThan(0);
  },
);
it('weights every coarse sample of a cell straddling the road and its verge', () => {
  // Far ahead of a parade, only the 2 m verges hold spectators (0.7); the road is clear.
  const event = {
    ...street,
    kind: 'parade',
    route: [q(-1000, 0), q(3000, 0)],
    length_m: 4000,
    segments: [{ ...street.segments[0]!, width_m: 12, verge_m: { left: 2, right: 2 } }],
  } as StreetRoute;
  const base = grid(16, 16, 250, 4);
  // One row of 16 m cells centred on the road: 12 m of road, 2 m of verge on each side.
  const placement: GridPlacement = {
    ...base,
    fromCell: (c, r) => q(c * 16, 8 - (r - 1) * 16),
    toCell: (lng, lat) => {
      const [x, y] = frame.to([lng, lat]);
      return [x / 16, (8 - y) / 16 + 1];
    },
  };
  const row = throng(event, 0.001, placement, 250, 4, 15).cells.filter(
    (c) => c.row === 1 && c.col >= 20 && c.col < 180,
  );
  const share = row.length / 160;
  expect(share).toBeGreaterThan(0.7 * (4 / 16) * 0.5);
  expect(share).toBeLessThan(0.7 * (4 / 16) * 1.6);
});
it('unions standing and seated ground in a mixed coarse cell', () => {
  const event: MassRoute = {
    ...common,
    id: 'mixed',
    kind: 'mass',
    site: {
      id: 'osm:way/2',
      location: q(0, 0),
      anchor: q(0, 0),
      radius_m: 100,
      grounds: [box(-32, -16, 0, 16)],
      seated_grounds: [box(0, -16, 32, 16)],
      blocked: [],
      approaches: [],
      roads: [],
    },
  };
  const placement = grid(16, 16, 4, 4);
  placement.fromCell = (c, r) => q((c - 2) * 16 - 8, 8 - (r - 2) * 16);
  placement.toCell = (lng, lat) => {
    const [x, y] = frame.to([lng, lat]);
    return [(x + 8) / 16 + 2, (8 - y) / 16 + 2];
  };
  const payload = throng(event, 0.5, placement, 4, 4, 15);
  const mixed = payload.cells.find((c) => c.col === 2 && c.row === 2)!;
  expect(mixed).toBeDefined();
  const bits = [...Array(256).keys()].filter((bit) => (mixed.mask![bit >>> 5]! >>> (bit & 31)) & 1);
  expect(bits.some((bit) => bit % 16 < 8)).toBe(true);
  expect(bits.some((bit) => bit % 16 >= 8)).toBe(true);
});
it('faces a distant multi-segment route exactly instead of its first segment', () => {
  const event = {
    ...street,
    route: [q(-100, 0), q(-100, 100), q(100, 100)],
    length_m: 300,
    segments: [street.segments[0]!, street.segments[0]!],
    crowd_grounds: [box(180, 180, 220, 220)],
  };
  const placement = grid(2, 2, 240, 240);
  const far = throng(event, 0.4, placement, 240, 240, 18).cells.filter((c) => metres(c)[0] > 175);
  expect(far.length).toBeGreaterThan(0);
  for (const cell of far) {
    const [x, y] = metres(cell);
    const [ax, ay] = frame.to(cell.agent.ahead!);
    expect(ax).toBeGreaterThan(x);
    expect(ay).toBeCloseTo(y, 1);
  }
});
it('detects a tiny exclusion enclosed by a mask subcell rather than trusting its centre', () => {
  const ground = { regions: [box(0, 0, 16, 16)], blocked: [box(0.1, 0.1, 0.2, 0.2)] };
  const mask = new CrowdMaskRaster(ground, (c, r) => q(c * 16, r * 16)).mask(0, 0);
  expect(mask).toBeDefined();
  expect(mask![0]! & 1).toBe(0);
  const lattice = new CrowdMaskRaster(ground, (c, r) => q(c, -r), 0, 0, 1);
  expect(lattice.has(0, -1)).toBe(false);
  expect(lattice.has(5, -6)).toBe(true);
});
it.each(['regions', 'bridges'] as const)(
  'rejects gaps within a subcell between separate %s, while joining touching pieces',
  (kind) => {
    const build = (gap: number) => {
      const pieces = [box(-1, -1, 5.1, 17), box(5.1 + gap, -1, 17, 17)];
      const ground =
        kind === 'regions'
          ? { regions: pieces, blocked: [] }
          : {
              regions: [box(-1, -1, 17, 17)],
              blocked: [],
              water: [box(-1, -1, 17, 17)],
              bridges: pieces,
            };
      return new CrowdMaskRaster(ground, (c, r) => q(c * 16, r * 16)).mask(0, 0)!;
    };
    const bit = 8 * 16 + 5;
    expect((build(0.2)[bit >>> 5]! >>> (bit & 31)) & 1).toBe(0);
    expect((build(0)[bit >>> 5]! >>> (bit & 31)) & 1).toBe(1);
  },
);
it('packs ownerless complete crowds between event actors and ordinary people, with all tier caps', () => {
  const placement = grid(1, 1),
    ground = groundForRoute(street);
  for (const tier of TIERS) {
    const payload = throng(street, 0.5, placement, 100, 40, 18, tier.knobs.throng);
    expect(payload.cap).toBe(Math.floor(MAX_THRONG_CELLS * tier.knobs.throng));
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
    // A cached payload is a fresh object: one caller's cap never leaks into the next frame.
    expect(throng(street, 0.5, placement, 100, 40, 18, tier.knobs.throng).cap).toBe(
      Math.floor(MAX_THRONG_CELLS * tier.knobs.throng),
    );
  }
});
it('clears only previously stamped crowd cells through movement and repeated empty frames', () => {
  const placement = grid(1, 1, 8, 8),
    out = new Uint8Array(256),
    mask = new Uint32Array(512),
    cells: number[] = [];
  const maskWords = new Uint32Array(8).fill(0xffffffff);
  const paint = (row: number | undefined) => {
    const candidates =
      row === undefined
        ? []
        : [
            {
              col: 2,
              row,
              hash: 1,
              mask: maskWords,
              agent: {
                kind: 'person' as const,
                flap: 0,
                lng: placement.fromCell!(2.5, row + 0.5)[0],
                lat: placement.fromCell!(2.5, row + 0.5)[1],
                prop: 'event' as const,
                glyph: ProcessionGlyph.crowd0,
                eventGround: street.id,
              },
            },
          ];
    packLife(
      out,
      { cols: 8, rows: 8, cellWidth: 10, cellHeight: 18, toCell: placement.toCell },
      [],
      theme,
      glyphIndex,
      undefined,
      undefined,
      { throng: { cells: candidates, cap: 100 }, throngMask: mask, throngCells: cells },
    );
  };
  paint(1);
  expect(mask.some((word) => word !== 0)).toBe(true);
  const previous = cells.slice();
  paint(5);
  for (const cell of previous)
    expect([...mask.slice(cell * 8, cell * 8 + 8)]).toEqual(Array(8).fill(0));
  expect(cells.every((cell) => Math.floor(cell / 8) === 5)).toBe(true);
  paint(undefined);
  expect(mask.every((word) => word === 0)).toBe(true);
  paint(undefined);
  expect(cells).toHaveLength(0);
  paint(2);
  expect(mask.some((word) => word !== 0)).toBe(true);
});
it('empties the street crowd once the procession completes', () => {
  const placement = grid(2, 2);
  expect(throng(street, 0.5, placement, 100, 40, 18).cells.length).toBeGreaterThan(0);
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
  // Already gathered when the Mass starts: no arrival wave.
  const at = (progress: number) =>
    throng(event, progress, placement, 100, 40, 18)
      .cells.map((c) => `${c.col}/${c.row}`)
      .sort();
  expect(at(0.001)).toEqual(at(0.5));
  // Leaving at the end, from the outside in.
  const leaving = throng(event, 0.95, placement, 100, 40, 18).cells;
  const distance = (c: { agent: { lng: number; lat: number } }) =>
    Math.hypot(...frame.to([c.agent.lng, c.agent.lat]));
  expect(leaving.length).toBeGreaterThan(0);
  expect(leaving.length).toBeLessThan(payload.cells.length);
  expect(Math.max(...leaving.map(distance))).toBeLessThan(Math.max(...payload.cells.map(distance)));
});
it('rasterizes every new crowd/altar glyph without changing legacy map positions', () => {
  for (let code = 0xe404; code <= 0xe40b; code++) {
    const data = new Uint8Array(180);
    expect(
      drawProcedural({ data, stride: 10, x0: 0, y0: 0, w: 10, h: 18 }, String.fromCharCode(code)),
    ).toBe(true);
    expect(data.some((x) => x > 0)).toBe(true);
  }
  expect(glyphs.indexOf(ProcessionGlyph.crowd0)).toBe(
    glyphs.indexOf(ProcessionGlyph.bugle) + 1 + FOLKLORE_GLYPHS.length,
  );
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
      { cols: 140, rows: 80, cellWidth: 10, cellHeight: 18, toCell: placement.toCell },
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
        // Whole cells inside the ground; edge cells may be partly outside it.
        if (
          Math.abs(x) >= 98 ||
          !eventGroundAllows(ground, [
            point,
            placement.fromCell!(c + 0.05, r + 0.05),
            placement.fromCell!(c + 0.95, r + 0.95),
          ])
        )
          continue;
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
        owners = new Uint32Array(100 * 80),
        cells: number[] = [];
      packLife(
        out,
        { cols: 100, rows: 80, cellWidth: 10, cellHeight: 18, toCell: placement.toCell },
        [],
        theme,
        glyphIndex,
        undefined,
        undefined,
        { throng: payload, throngCells: cells, owners },
      );
      return { out, cells, owners };
    };
    const complete = pack(100);
    expect(complete.cells.length).toBeGreaterThan(1);
    const [lng, lat] = placement.fromCell!(60.5, 40.5);
    payload.cells.push({
      ...payload.cells[0]!,
      look: undefined,
      col: 60,
      row: 40,
      agent: { ...payload.cells[0]!.agent, lng, lat, prop: 'event', glyph: ProcessionGlyph.crowd0 },
    });
    const rejected = pack(complete.cells.length - 1);
    expect(rejected.cells).toHaveLength(0);
    expect(rejected.out.every((v) => v === 0)).toBe(true);
    expect(rejected.owners.every((owner) => owner === 0)).toBe(true);
  },
);

it.each(['collision', 'permission'] as const)(
  'restores complete bytes and full-width owners after crowd %s rejection',
  (denial) => {
    const placement = grid(0.35, 0.35, 100, 80);
    const payload = throng(street, 0.5, placement, 100, 80, 21);
    payload.cells = payload.cells
      .filter((c) => c.col > 30 && c.col < 60 && c.row > 25 && c.row < 50)
      .slice(0, 1);
    expect(payload.cells).toHaveLength(1);
    payload.cap = 100;
    const stamp = new Uint8Array(32000),
      stamped: number[] = [];
    packLife(
      stamp,
      { cols: 100, rows: 80, cellWidth: 10, cellHeight: 18, toCell: placement.toCell },
      [],
      theme,
      glyphIndex,
      undefined,
      undefined,
      { throng: payload, throngCells: stamped },
    );
    expect(stamped.length).toBeGreaterThan(1);
    const occupied = stamped.at(-1)!;
    const [lng, lat] = placement.fromCell!(
      (occupied % 100) + 0.5,
      Math.floor(occupied / 100) + 0.5,
    );
    const actor = {
      kind: 'person' as const,
      flap: 0,
      lng,
      lat,
      prop: 'event' as const,
      glyph: ProcessionGlyph.crowd1,
      eventGround: street.id,
    };
    const outside = { ...actor, lng: 1, lat: 1 };
    const actors = Array(65536).fill(outside).concat(actor);
    if (denial === 'permission') {
      // A new field version re-admits the figure against ground that now refuses one texel.
      payload.version = (payload.version ?? 0) + 1;
      payload.allows = (_, col, row) => row * 100 + col !== occupied;
    }
    const pack = (withCrowd: boolean) => {
      const out = new Uint8Array(32000),
        owners = new Uint32Array(8000),
        cells: number[] = [];
      packLife(
        out,
        { cols: 100, rows: 80, cellWidth: 10, cellHeight: 18, toCell: placement.toCell },
        actors,
        theme,
        glyphIndex,
        undefined,
        undefined,
        { owners, ...(withCrowd && { throng: payload, throngCells: cells }) },
      );
      return { out, owners, cells };
    };
    const before = pack(false),
      rejected = pack(true);
    expect(before.owners[occupied]).toBe(65537);
    expect(rejected.cells).toHaveLength(0);
    expect(rejected.out).toEqual(before.out);
    expect(rejected.owners).toEqual(before.owners);
  },
);

it('clears a short stream with its layout tail before completion', () => {
  const event = {
    ...street,
    route: [q(-500, 0), q(500, 0)],
    length_m: 1000,
    segments: [{ ...street.segments[0]!, verge_m: undefined }],
  };
  const placement = grid(2, 2, 550, 20);
  const cells = throng(event, 0.99, placement, 550, 20, 18).cells;
  expect(cells.length).toBeGreaterThan(0);
  expect(cells.every((c) => metres(c)[0] > 400)).toBe(true);
});
