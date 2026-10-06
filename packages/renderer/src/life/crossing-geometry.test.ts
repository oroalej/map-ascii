import { expect, it } from 'vitest';
import { finalizeControlledCrossings, controlledCrossingConnectors } from './crossing-geometry';
import { LifeBuilder, LifeLine, type ControlledCrossingAnchor } from './geometry';
import { bodyInside, bodiesOverlap, type Body } from './occupancy';
import { RoadAccess, stripRing } from './terrain';
import { WalkingGraph } from './navigation';
import { hashString, metersPerUnit } from '../raster/geometry';
import { TileLife } from './simulate';

const anchor = (bearing = 90): ControlledCrossingAnchor => ({
  id: 'cross',
  controller: { id: 'signal', at: [0, 0], seed: 0xffffffff, midBlock: false, walk: 'a' },
  anchor: { x: 1000, y: 1000 },
  bearing,
  width: 10,
  lineId: 42,
});

it('finds rotated physical curbs and retains only complete, mutually clear off-road slots', () => {
  for (const bearing of [0, 31, 90, 143])
    for (const pm of [0.8, 7]) {
      const c = anchor(bearing),
        theta = (bearing * Math.PI) / 180;
      const road = [
        stripRing(
          { x: 1000 - Math.sin(theta) * 100 * pm, y: 1000 + Math.cos(theta) * 100 * pm },
          { x: 1000 + Math.sin(theta) * 100 * pm, y: 1000 - Math.cos(theta) * 100 * pm },
          5 * pm,
        ),
      ];
      finalizeControlledCrossings([c], [road], pm);
      for (const side of c.sides!) {
        expect(Math.hypot(side.centre.x - 1000, side.centre.y - 1000) / pm).toBeCloseTo(5);
        expect(side.slots).toHaveLength(4);
        const bodies: Body[] = side.slots.map((p) => ({
          ...p,
          hx: side.inward.x,
          hy: side.inward.y,
          length: 0.9 * pm,
          width: pm,
        }));
        for (const body of bodies) {
          expect(side.pads.some((pad) => bodyInside(body, [pad]))).toBe(true);
          expect(new RoadAccess([road], []).allows([body], false)).toBe(true);
        }
        for (let i = 0; i < bodies.length; i++)
          for (let j = i + 1; j < bodies.length; j++)
            expect(bodiesOverlap(bodies[i]!, bodies[j]!, 0.15 * pm)).toBe(false);
        // Coarse guarded sprites can exceed nominal physical bodies; no such slot is usable.
        expect(
          side.slots.filter((p) =>
            side.pads.some((pad) =>
              bodyInside(
                { ...p, hx: side.inward.x, hy: side.inward.y, length: 3 * pm, width: 3 * pm },
                [pad],
              ),
            ),
          ),
        ).toHaveLength(0);
      }
    }
});

it('clips against other carriageways and retains active gates when a pad is unusable', () => {
  const c = anchor();
  const main = [stripRing({ x: 900, y: 1000 }, { x: 1100, y: 1000 }, 5)];
  // A nearby parallel carriageway consumes the entire south pad, without touching its curb.
  const extra = [stripRing({ x: 900, y: 1006.05 }, { x: 1100, y: 1006.05 }, 0.95)];
  finalizeControlledCrossings([c], [main, extra], 1);
  expect(c.sides![1].pads).toHaveLength(0);
  expect(c.sides![1].slots).toHaveLength(0);
  expect(c.sides![1].gate).toHaveLength(2);
  expect(c.quad).toHaveLength(5);
});

it('preserves rotated curb and pad geometry among distant roads and carriageway holes', () => {
  const distant = Array.from({ length: 100 }, (_, i) => [
    stripRing({ x: 5000 + i * 20, y: 5000 }, { x: 5000 + i * 20, y: 5100 }, 5),
  ]);
  for (const bearing of [0, 31, 90, 143]) {
    const theta = (bearing * Math.PI) / 180;
    const p = (along: number) => ({
      x: 1000 + Math.sin(theta) * along,
      y: 1000 - Math.cos(theta) * along,
    });
    const local = [stripRing(p(-100), p(100), 5), stripRing(p(40), p(60), 1)];
    const expected = anchor(bearing),
      cluttered = anchor(bearing);
    finalizeControlledCrossings([expected], [local], 1);
    finalizeControlledCrossings([cluttered], [local, ...distant], 1);
    expect(cluttered.sides).toEqual(expected.sides);
    expect(cluttered.quad).toEqual(expected.quad);
    for (const side of cluttered.sides!) {
      expect(Math.hypot(side.centre.x - 1000, side.centre.y - 1000)).toBeCloseTo(5);
      expect(side.slots).toHaveLength(4);
    }
  }
});

function routes(connect = true) {
  const tile = { z: 16, x: 55194, y: 30264 },
    pm = 1 / metersPerUnit(tile);
  const b = new LifeBuilder(),
    c = anchor(),
    origin = { x: 2000, y: 2000 };
  c.anchor = origin;
  for (const side of [-1, 1])
    b.line(
      [
        { x: 100, y: 2000 + side * 6 * pm },
        { x: 3900, y: 2000 + side * 6 * pm },
      ],
      LifeLine.path,
      2,
      hashString(`sidewalk/${side}`),
    );
  b.line(
    [
      { x: 2000, y: 2000 - 8 * pm },
      { x: 2000, y: 2000 + 8 * pm },
    ],
    LifeLine.path,
    3,
    c.lineId,
  );
  b.area('carriageway', [stripRing({ x: 100, y: 2000 }, { x: 3900, y: 2000 }, 5 * pm)]);
  b.area('crossing', [
    stripRing({ x: 2000 - 1.5 * pm, y: 2000 }, { x: 2000 + 1.5 * pm, y: 2000 }, 6.5 * pm),
  ]);
  if (connect) {
    const access = new RoadAccess(b.roadPolygons, b.crossingCuts);
    finalizeControlledCrossings([c], b.roadPolygons, pm, access);
    const joins = controlledCrossingConnectors(
      [c],
      b.walkingLinesView,
      b.roadPolygons,
      b.crossingCuts,
      [],
      pm,
      hashString,
      access,
    );
    expect(joins.connectors).toHaveLength(2);
    expect(
      joins.connectors.every(
        (j) =>
          Math.hypot(j.points[0]!.x - j.points[1]!.x, j.points[0]!.y - j.points[1]!.y) / pm <= 4,
      ),
    ).toBe(true);
    b.joinWalking(joins.joins, joins.connectors);
  }
  return { tile, pm, b, c, geo: b.finish() };
}

it('makes middle attachments endpoints for ordinary and scene routes, without changing populations', () => {
  const before = routes(false),
    after = routes();
  const graph = new WalkingGraph(after.geo, after.pm);
  expect(
    graph.route({ x: 1900, y: 2000 - 6 * after.pm }, { x: 2100, y: 2000 + 6 * after.pm }),
  ).toBeDefined();
  expect(Array.from(after.geo.navigationOnly!).filter(Boolean)).toHaveLength(2);
  expect(after.geo.spawnGroups![0]).toBe(after.geo.spawnGroups![1]);
  for (const seed of [1, 42, 123]) {
    const a = new TileLife(before.tile, before.geo, seed),
      b = new TileLife(after.tile, after.geo, seed);
    const physical = (life: TileLife) =>
      life.movers.map(({ line: _line, from: _from, d: _distance, ...m }) => m);
    expect(physical(b)).toEqual(physical(a));
    expect(b.stalls).toEqual(a.stalls);
    expect(b.movers.every((m) => !after.geo.navigationOnly![m.line])).toBe(true);
  }
});

it('snaps exact and near-end joins to the original routing vertex without zero-length pieces', () => {
  for (const t of [1, 1 - 5e-9]) {
    const builder = new LifeBuilder();
    builder.line(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
      ],
      LifeLine.path,
      2,
      1,
    );
    builder.joinWalking(new Map([[0, [{ segment: 0, t, point: { x: 10 * t, y: 0 } }]]]), []);
    const geo = builder.finish();
    expect(Array.from(geo.coords)).toEqual([0, 0, 10, 0, 10, 0, 20, 0]);
    expect(Array.from(geo.starts)).toEqual([0, 2, 4]);
    expect(geo.spawnGroups![0]).toBe(geo.spawnGroups![1]);
    const graph = new WalkingGraph(geo, 1);
    expect(graph.route({ x: 0, y: 0 }, { x: 20, y: 0 })).toBeDefined();
  }
});

it('deduplicates joins in metres and connects both crossings to that exact shared point', () => {
  for (const pm of [0.2, 7]) {
    const builder = new LifeBuilder();
    builder.line(
      [
        { x: 0, y: 0 },
        { x: 100 * pm, y: 0 },
      ],
      LifeLine.path,
      2 * pm,
      1,
    );
    const anchors = [50, 50.005].map((x, i) => {
      const c = { ...anchor(), id: `cross-${i}`, lineId: 42 + i };
      builder.line(
        [
          { x: x * pm, y: (2 + i) * pm },
          { x: x * pm, y: (20 + i) * pm },
        ],
        LifeLine.path,
        2 * pm,
        c.lineId,
      );
      return c;
    });
    const result = controlledCrossingConnectors(
      anchors,
      builder.walkingLinesView,
      [],
      [],
      [],
      pm,
      hashString,
    );
    expect(result.joins.get(0)).toHaveLength(1);
    expect(result.connectors).toHaveLength(2);
    for (const connector of result.connectors)
      expect(connector.points[1]).toBe(result.joins.get(0)![0]!.point);
    builder.joinWalking(result.joins, result.connectors);
    const graph = new WalkingGraph(builder.finish(), pm);
    expect(graph.route({ x: 50 * pm, y: 2 * pm }, { x: 50.005 * pm, y: 3 * pm })).toBeDefined();
  }
});

it('does not add a connector through another road, obstacle, or beyond the four-metre reach', () => {
  const { b, c, pm } = routes(false);
  finalizeControlledCrossings([c], b.roadPolygons, pm);
  const blocked = [
    stripRing({ x: 1800, y: 2000 - 7 * pm }, { x: 2200, y: 2000 - 7 * pm }, 0.2 * pm),
  ];
  const result = controlledCrossingConnectors(
    [c],
    b.walkingLinesView,
    b.roadPolygons,
    b.crossingCuts,
    [blocked],
    pm,
    hashString,
  );
  expect(result.connectors).toHaveLength(1);
  expect(
    controlledCrossingConnectors(
      [c],
      b.walkingLinesView.map((l) =>
        l.id === c.lineId ? l : { ...l, points: l.points.map((p) => ({ ...p, y: p.y + 50 * pm })) },
      ),
      b.roadPolygons,
      b.crossingCuts,
      [],
      pm,
      hashString,
    ).connectors,
  ).toHaveLength(0);
});
