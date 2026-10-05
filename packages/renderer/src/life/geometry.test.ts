import { describe, expect, it } from 'vitest';
import { VEHICLE_TYPES } from '@atlas/shared';
import { LifeBuilder, LifeLine, lifeTransferables, type LifeGeometry } from './geometry';
import { JUNCTION, ROAD_SPLIT_CLEARANCE_M, SIGNAL } from './config';
import { VEHICLES } from './vehicles';

const clearance = ROAD_SPLIT_CLEARANCE_M;

it('deduplicates full marker identities without dropping compact-seed collisions', () => {
  const entries = [
    { x: 10, y: 30, feature: 'row/a', world: [100, 300] as const },
    { x: 20, y: 30, feature: 'row/a', world: [200, 300] as const },
    { x: 10, y: 30, feature: 'row/b', world: [100, 300] as const },
  ];
  const build = (values: typeof entries) => {
    const b = new LifeBuilder();
    for (const entry of values) b.grave(entry, entry.feature, 17, [...entry.world]);
    return b.finish().graves;
  };
  const expected = build(entries);
  expect(expected).toHaveLength(9);
  expect(build([...entries].reverse())).toEqual(expected);
  expect(build([...entries, entries[0]!])).toEqual(expected);
});

it('keeps exact grave seeds and structured-cloned sidecars, recording only admitted worship places', () => {
  const builder = new LifeBuilder();
  builder.grave({ x: 20, y: 30 }, 'marker', 0xffffff);
  builder.grave({ x: 4096, y: 30 }, 'unowned', 5);
  builder.cemetery({ x: 100, y: 200 }, 40);
  for (let i = 0; i < 40; i++)
    builder.place({ x: i, y: i }, 'worship', 0, false, NaN, `landmark/church-${i}`);
  builder.place({ x: 50, y: 50 }, 'worship', 0, false, NaN, 'landmark/dropped');
  const geo = builder.finish();
  expect(geo.graves).toEqual(Float32Array.from([20, 30, 0xffffff]));
  expect(geo.placeLandmarks).toHaveLength(40);
  expect(geo.placeLandmarks!.at(-1)).toEqual([39, 'landmark/church-39']);
  const buffers = lifeTransferables(geo);
  expect(buffers).toContain(geo.graves!.buffer);
  expect(buffers).toContain(geo.cemeteries!.buffer);
  expect(new Set(buffers).size).toBe(buffers.length);
  const copy = structuredClone(geo, { transfer: buffers });
  expect(copy.graves![2]).toBe(0xffffff);
  expect(copy.placeLandmarks).toEqual(geo.placeLandmarks);
});
const points = (geo: LifeGeometry, line: number) =>
  Array.from({ length: geo.starts[line + 1]! - geo.starts[line]! }, (_, i) => {
    const v = geo.starts[line]! + i;
    return [geo.coords[v * 2], geo.coords[v * 2 + 1]];
  });
function crossing(x = 100, y = 100) {
  const b = new LifeBuilder();
  b.line(
    [
      { x: x - 100, y },
      { x, y },
      { x: x + 100, y },
    ],
    LifeLine.roadMid,
    10,
    77,
    1,
  );
  b.line(
    [
      { x, y: y - 100 },
      { x, y },
      { x, y: y + 100 },
    ],
    LifeLine.roadMinor,
    8,
    88,
    -1,
  );
  return b;
}

describe('shared road junction splits', () => {
  it('covers linked route preparation plus the full front-bumper allowance', () => {
    for (const vehicle of VEHICLE_TYPES)
      expect(clearance).toBeGreaterThanOrEqual(
        JUNCTION.linkedLookaheadM + SIGNAL.gap + VEHICLES[vehicle].length / 2,
      );
  });

  it('splits both arms of an X while preserving vertices and road attributes', () => {
    const b = crossing();
    b.splitRoadJunctions(1, clearance);
    const g = b.finish();
    expect(Array.from(g.kinds)).toEqual([
      LifeLine.roadMid,
      LifeLine.roadMid,
      LifeLine.roadMinor,
      LifeLine.roadMinor,
    ]);
    expect(Array.from(g.lineIds!)).toEqual([77, 77, 88, 88]);
    expect(Array.from(g.spawnGroups!)).toEqual([0, 0, 1, 1]);
    expect(Array.from(g.widths)).toEqual([10, 10, 8, 8]);
    expect(Array.from(g.oneway!)).toEqual([1, 1, -1, -1]);
    expect(Array.from({ length: 4 }, (_, line) => points(g, line))).toEqual([
      [
        [0, 100],
        [100, 100],
      ],
      [
        [100, 100],
        [200, 100],
      ],
      [
        [100, 0],
        [100, 100],
      ],
      [
        [100, 100],
        [100, 200],
      ],
    ]);
  });

  it('splits the through road of a T without changing the side street', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 100 },
        { x: 100, y: 100 },
        { x: 200, y: 100 },
      ],
      LifeLine.roadMid,
      10,
      77,
    );
    b.line(
      [
        { x: 100, y: 100 },
        { x: 100, y: 200 },
      ],
      LifeLine.roadMinor,
      6,
      88,
    );
    b.splitRoadJunctions(1, clearance);
    const g = b.finish();
    expect(g.kinds).toHaveLength(3);
    expect([points(g, 0), points(g, 1)]).toEqual([
      [
        [0, 100],
        [100, 100],
      ],
      [
        [100, 100],
        [200, 100],
      ],
    ]);
    expect(Array.from(g.lineIds!)).toEqual([77, 77, 88]);
    expect(points(g, 2)).toEqual([
      [100, 100],
      [100, 200],
    ]);
  });

  it.each([
    {
      name: 'interior',
      road: [
        [0, 100],
        [100, 100],
        [100, 100],
        [200, 100],
      ],
      pieces: [
        [
          [0, 100],
          [100, 100],
          [100, 100],
        ],
        [
          [100, 100],
          [200, 100],
        ],
      ],
    },
    {
      name: 'leading',
      road: [
        [100, 100],
        [100, 100],
        [200, 100],
      ],
      pieces: [
        [
          [100, 100],
          [100, 100],
          [200, 100],
        ],
      ],
    },
    {
      name: 'trailing',
      road: [
        [0, 100],
        [100, 100],
        [100, 100],
      ],
      pieces: [
        [
          [0, 100],
          [100, 100],
          [100, 100],
        ],
      ],
    },
  ])('keeps $name duplicate shared vertices within nonzero routing pieces', ({ road, pieces }) => {
    const b = new LifeBuilder();
    b.line(
      road.map(([x, y]) => ({ x: x!, y: y! })),
      LifeLine.roadMid,
      10,
      77,
      1,
    );
    b.line(
      [
        { x: 100, y: 100 },
        { x: 100, y: 200 },
      ],
      LifeLine.roadMinor,
      8,
      88,
      -1,
    );
    b.splitRoadJunctions(1, clearance);
    const g = b.finish();
    expect(Array.from({ length: pieces.length }, (_, line) => points(g, line))).toEqual(pieces);
    expect(Array.from(g.kinds)).toEqual([
      ...pieces.map(() => LifeLine.roadMid),
      LifeLine.roadMinor,
    ]);
    expect(Array.from(g.lineIds!)).toEqual([...pieces.map(() => 77), 88]);
    expect(Array.from(g.widths)).toEqual([...pieces.map(() => 10), 8]);
    expect(Array.from(g.oneway!)).toEqual([...pieces.map(() => 1), -1]);
    expect(Array.from(g.spawnGroups!)).toEqual([...pieces.map(() => 0), 1]);
    for (let line = 0; line < g.kinds.length; line++) {
      const vertices = points(g, line);
      expect(vertices.some(([x, y]) => x !== vertices[0]![0] || y !== vertices[0]![1])).toBe(true);
    }
  });

  it('leaves geometric crossings, non-road meetings and repeated own vertices unchanged', () => {
    for (const kind of [LifeLine.roadMinor, LifeLine.path, LifeLine.rail, LifeLine.river]) {
      const b = new LifeBuilder();
      b.line(
        [
          { x: 0, y: 100 },
          { x: 100, y: 100 },
          { x: 200, y: 100 },
        ],
        LifeLine.roadMid,
      );
      b.line(
        kind === LifeLine.roadMinor
          ? [
              { x: 100, y: 0 },
              { x: 100, y: 200 },
            ]
          : [
              { x: 100, y: 0 },
              { x: 100, y: 100 },
              { x: 100, y: 200 },
            ],
        kind,
      );
      const before = b.finish();
      b.splitRoadJunctions(1, clearance);
      expect(b.finish()).toEqual(before);
    }
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 0 },
        { x: 200, y: 200 },
      ],
      LifeLine.roadMid,
    );
    const before = b.finish();
    b.splitRoadJunctions(1, clearance);
    expect(b.finish()).toEqual(before);
  });

  it('protects signal approaches beyond the original 40-metre lookahead clearance', () => {
    const b = crossing(62, 0);
    b.signal({ x: 0, y: 0 }, 6, 0, 90, true);
    const before = b.finish();
    b.splitRoadJunctions(1, clearance);
    expect(b.finish()).toEqual(before);
  });

  it('protects a linked controller member even when it has no local signal arms', () => {
    const b = crossing(262, 0);
    b.signal({ x: 0, y: 0 }, 6, 0, 90, true, {
      members: [
        [0, 0],
        [200, 0],
      ],
      arms: [],
    });
    b.splitSignalRoads(
      ([x, y]) => ({ x, y }),
      () => 0,
    );
    const before = b.finish();
    b.splitRoadJunctions(1, clearance);
    expect(b.finish()).toEqual(before);
  });

  for (const member of [false, true])
    it(`splits just outside ${member ? 'linked-member' : 'controller'} protection`, () => {
      const perMeter = 2;
      const radius = 6;
      const origin = member ? 400 : 0;
      const boundary = (clearance + radius) * perMeter + 2;
      for (const offset of [-1, 1]) {
        const b = crossing(origin + boundary + offset, 0);
        b.signal({ x: 0, y: 0 }, radius, 0, 90, true, {
          members: member
            ? [
                [0, 0],
                [origin, 0],
              ]
            : [[0, 0]],
          arms: [],
        });
        b.splitSignalRoads(
          ([x, y]) => ({ x, y }),
          () => 0,
        );
        b.splitRoadJunctions(perMeter, clearance);
        expect(b.finish().kinds).toHaveLength(offset < 0 ? 2 : 4);
      }
    });

  for (const x of [100.1, -511.9, 4608.1])
    it(`uses tile-unit rounding at buffered x=${x} without moving vertices`, () => {
      const b = new LifeBuilder();
      b.line(
        [
          { x: x - 100, y: 100.1 },
          { x, y: 100.1 },
          { x: x + 100, y: 100.1 },
        ],
        LifeLine.roadMid,
      );
      b.line(
        [
          { x: x + 0.1, y: 100.2 },
          { x: x + 0.1, y: 200 },
        ],
        LifeLine.roadMinor,
      );
      b.splitRoadJunctions(1, clearance);
      const g = b.finish();
      expect(g.kinds).toHaveLength(3);
      expect(points(g, 0).at(-1)![0]).toBeCloseTo(x);
      expect(points(g, 2)[0]![0]).toBeCloseTo(x + 0.1);
    });
});
