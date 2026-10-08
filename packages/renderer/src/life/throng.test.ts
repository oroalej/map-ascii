import { expect, it, vi } from 'vitest';
import {
  localMetricProjection,
  type StreetRoute,
  type MassRoute,
  type FluvialRoute,
} from '@atlas/shared';
import { throng, MAX_THRONG_CELLS, MAX_COLD_THRONG_CELLS } from './throng';
import { CrowdMaskRaster } from './crowd-mask';
import { packLife } from './draw';
import { groundForRoute, eventGroundAllows } from './ground-events';
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
function settledThrong(...args: Parameters<typeof throng>) {
  let payload = throng(...args);
  while (payload.pending) payload = throng(...args);
  return payload;
}
const glyphs = mapGlyphs(theme),
  glyphIndex = (g: string) => Math.max(0, glyphs.indexOf(g));
it('reuses coarse permissions across progress and overlapping world cells after a pan', () => {
  const original = grid(12, 25),
    terrainKey = {},
    hardTerrainKey = {};
  let queries = 0;
  const guard = Object.assign(
    () => {
      queries++;
      return true;
    },
    { terrainKey, hardTerrainKey },
  );
  original.world = [1, 1, original.grid.originCol, original.grid.originRow];
  const first = settledThrong(street, 0.4, original, 100, 40, 15, 1, guard);
  const cold = queries;
  expect(cold).toBeGreaterThan(0);
  throng(street, 0.5, original, 100, 40, 15, 1, guard);
  expect(queries).toBe(cold);
  const moved: GridPlacement = {
    ...original,
    grid: { ...original.grid, originCol: original.grid.originCol + 1 },
    world: [1, 1, original.grid.originCol + 1, original.grid.originRow],
    fromCell: (c, r) => original.fromCell!(c + 1, r),
    toCell: (lng, lat) => {
      const [c, r] = original.toCell(lng, lat);
      return [c - 1, r];
    },
  };
  const panned = settledThrong(street, 0.4, moved, 100, 40, 15, 1, guard);
  expect(queries).toBe(cold);
  expect(panned.cells.map((c) => [c.col + 1, c.row, [...c.mask!]])).toEqual(
    first.cells.map((c) => [c.col, c.row, [...c.mask!]]),
  );
  const freshGuard = Object.assign(
    () => {
      queries++;
      return true;
    },
    { terrainKey: {}, hardTerrainKey: {} },
  );
  throng(street, 0.4, moved, 100, 40, 15, 1, freshGuard);
  expect(queries).toBeGreaterThan(cold);
});
it('uses the wider sidewalk and keeps distant authored grounds static', () => {
  const event = {
    ...street,
    segments: [{ ...street.segments[0]!, sidewalk_m: 3, verge_m: { left: 1, right: 1 } }],
    crowd_grounds: [box(-40, 150, 40, 160)],
  };
  const placement = grid(1, 1, 200, 400);
  const positions = (p: number) => throng(event, p, placement, 200, 400, 18).cells;
  expect(
    positions(0.2).some(
      (c) =>
        Math.abs(frame.to([c.agent.lng, c.agent.lat])[1]) > 5 &&
        Math.abs(frame.to([c.agent.lng, c.agent.lat])[1]) < 7,
    ),
  ).toBe(true);
  const distant = (p: number) =>
    positions(p)
      .filter((c) => frame.to([c.agent.lng, c.agent.lat])[1] > 140)
      .map((c) => [c.col, c.row, c.agent.paint]);
  expect(distant(0.2).length).toBeGreaterThan(0);
  expect(distant(0.2)).toEqual(distant(0.8));
});
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
    const payload = settledThrong(event, 0.45, placement, 100, 40, 15);
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
it('bounds cold work on fractional zoom frames and admits only current-grid permissions', () => {
  const event = { ...street, blocked: [box(-5, -8, 5, 8)] };
  const keys = { terrainKey: {}, hardTerrainKey: {} };
  for (let frameNumber = 0; frameNumber < 5; frameNumber++) {
    const placement = grid(12 + frameNumber / 100, 25 + frameNumber / 100);
    placement.world = [12 + frameNumber / 100, 25 + frameNumber / 100, -50, -20];
    let queries = 0;
    const guard = Object.assign(() => {
      queries++;
      return true;
    }, keys);
    const payload = throng(event, 0.4, placement, 100, 40, 15 + frameNumber / 100, 1, guard);
    expect(queries).toBeLessThanOrEqual(MAX_COLD_THRONG_CELLS * 256);
    expect(payload.pending).toBe(true);
    for (const cell of payload.cells)
      for (let bit = 0; bit < 256; bit++)
        if ((cell.mask![bit >>> 5]! >>> (bit & 31)) & 1)
          expect(
            eventGroundAllows(groundForRoute(event), [
              placement.fromCell!(
                cell.col + ((bit % 16) + 0.5) / 16,
                cell.row + (Math.floor(bit / 16) + 0.5) / 16,
              ),
            ]),
          ).toBe(true);
    const saved = payload.cells.map((c) => [c.col, c.row, ...c.mask!]);
    const complete = settledThrong(event, 0.4, placement, 100, 40, 15, 1, guard);
    expect(complete.pending).not.toBe(true);
    expect(complete.cells.length).toBeGreaterThan(payload.cells.length);
    expect(payload.cells.map((c) => [c.col, c.row, ...c.mask!])).toEqual(saved);
  }
});

it('stops new row coverage scans after the cold mask budget is spent', () => {
  const event = { ...street, crowd_grounds: [box(-1000, -1000, 1000, 1000)] };
  const placement = grid(12, 25);
  placement.world = [12, 25, -50, -20];
  const covers = vi.spyOn(CrowdMaskRaster.prototype, 'covers');
  try {
    const payload = throng(event, 0.4, placement, 100, 40, 15);
    expect(payload.pending).toBe(true);
    // One coverage query admits each mask; mask() checks that coverage again.
    expect(covers).toHaveBeenCalledTimes(MAX_COLD_THRONG_CELLS * 2);
  } finally {
    covers.mockRestore();
  }
});
it('weights all allowed coarse subcells across the road and verge', () => {
  const event = {
    ...street,
    route: [q(-200, 0), q(200, 0)],
    length_m: 400,
    segments: [{ ...street.segments[0]!, width_m: 12, verge_m: { left: 2, right: 2 } }],
  };
  const base = grid(16, 16);
  const placement: GridPlacement = {
    ...base,
    fromCell: (c, r) => q((c - 50) * 16, 8 - (r - 20) * 16),
    toCell: (lng, lat) => {
      const [x, y] = frame.to([lng, lat]);
      return [x / 16 + 50, (8 - y) / 16 + 20];
    },
  };
  const cells = settledThrong(event, 0.4, placement, 100, 40, 15).cells;
  // These stable hashes select at 0.779 and 0.889: the mixed permission density is ~0.85.
  expect(cells.some((c) => c.col === 54 && c.row === 20)).toBe(true);
  expect(cells.some((c) => c.col === 52 && c.row === 20)).toBe(false);
});
it('unions independently guarded standing and seated bits in a mixed coarse cell', () => {
  const event: MassRoute = {
    ...common,
    kind: 'mass',
    site: {
      id: 'osm:way/2',
      location: q(0, 0),
      anchor: q(0, 0),
      radius_m: 100,
      grounds: [box(-32, -16, 32, 16)],
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
  let seatedQueries = 0;
  const guard = Object.assign(
    (agent: Parameters<NonNullable<Parameters<typeof throng>[7]>>[0], c: number) => {
      const seated = c >= 40;
      if (agent.eventRole === 'seated') seatedQueries++;
      return seated ? agent.eventRole === 'seated' : !agent.eventRole;
    },
    { terrainKey: {}, hardTerrainKey: {} },
  );
  const payload = settledThrong(event, 0.5, placement, 4, 4, 15, 1, guard);
  const mixed = payload.cells.find((c) => c.col === 2 && c.row === 2)!;
  expect(mixed).toBeDefined();
  const bits = [...Array(256).keys()].filter((bit) => (mixed.mask![bit >>> 5]! >>> (bit & 31)) & 1);
  expect(bits.some((bit) => bit % 16 < 8)).toBe(true);
  expect(bits.some((bit) => bit % 16 >= 8)).toBe(true);
  expect(seatedQueries).toBeGreaterThan(0);
});
it('finds a distant multi-segment route exactly instead of falling back to its first segment', () => {
  const event = {
    ...street,
    route: [q(-100, 0), q(-100, 100), q(100, 100)],
    length_m: 300,
    segments: [street.segments[0]!, street.segments[0]!],
    crowd_grounds: [box(180, 180, 220, 220)],
  };
  const placement = grid(2, 2, 240, 240);
  const far = throng(event, 0.4, placement, 240, 240, 18).cells.filter(
    (c) => frame.to([c.agent.lng, c.agent.lat])[0] > 175,
  );
  expect(far.length).toBeGreaterThan(0);
  for (const cell of far) {
    const [x, y] = frame.to([cell.agent.lng, cell.agent.lat]);
    const [ax, ay] = frame.to(cell.agent.ahead!);
    expect(ax).toBeGreaterThan(x);
    expect(ay).toBeCloseTo(y, 5);
  }
});
it('detects a tiny exclusion enclosed by a mask subcell rather than trusting its centre', () => {
  const ground = { regions: [box(0, 0, 16, 16)], blocked: [box(0.1, 0.1, 0.2, 0.2)] };
  const mask = new CrowdMaskRaster(ground, (c, r) => q(c * 16, r * 16)).mask(0, 0);
  expect(mask).toBeDefined();
  expect(mask![0]! & 1).toBe(0);
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
    const occupied = denial === 'collision' ? stamped.at(-1)! : 505;
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
    const pack = (withCrowd: boolean) => {
      const out = new Uint8Array(32000),
        owners = new Uint32Array(8000),
        cells: number[] = [];
      packLife(
        out,
        {
          cols: 100,
          rows: 80,
          cellWidth: 10,
          cellHeight: 18,
          toCell: placement.toCell,
          allowsGroundCell: (agent) => denial === 'collision' || agent.prop === 'event',
        },
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
  expect(cells.every((c) => frame.to([c.agent.lng, c.agent.lat])[0] > 400)).toBe(true);
});
