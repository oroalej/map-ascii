import { describe, expect, it } from 'vitest';
import { LifeBuilder, LifeLine, type LifeGeometry } from './geometry';
import { ROAD_SPLIT_CLEARANCE_M } from './config';

const clearance = ROAD_SPLIT_CLEARANCE_M;
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
