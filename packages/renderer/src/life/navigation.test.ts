import { describe, expect, it } from 'vitest';
import { LifeBuilder, LifeLine, lifeTransferables } from './geometry';
import { WalkingGraph } from './navigation';
import { stripRing } from './terrain';
import { complete } from './cooperate';

const line = (b: LifeBuilder, points: [number, number][]) =>
  b.line(
    points.map(([x, y]) => ({ x, y })),
    LifeLine.path,
  );
describe('local walking routes', () => {
  it('resets consecutive searches, grows scratch with the graph, and preserves returned arrays', () => {
    const b = new LifeBuilder();
    line(b, [
      [10, 10],
      [10, 40],
      [50, 40],
      [50, 10],
    ]);
    line(b, [
      [100, 10],
      [100, 40],
      [140, 40],
      [140, 10],
    ]);
    const graph = new WalkingGraph(b.finish(), 1);
    const start = { x: 10, y: 15 },
      end = { x: 50, y: 15 };
    const first = graph.route(start, end)!;
    expect(first).toBeDefined();
    const saved = structuredClone(first);
    expect(graph.route(start, { x: 140, y: 15 })).toBeUndefined();
    const back = graph.route(end, start)!;
    expect(back[0]).toEqual(end);
    expect(back.at(-1)).toEqual(start);
    expect(graph.route(start, end)).toEqual(saved);
    const growth = new LifeBuilder();
    line(growth, [
      [200, 10],
      [200, 40],
      [240, 40],
      [240, 10],
    ]);
    complete(graph.prepare(growth.finish()));
    expect(graph.route({ x: 200, y: 15 }, { x: 240, y: 15 })).toBeDefined();
    expect(first).toEqual(saved);
    expect(graph.route(start, end)).toEqual(saved);
  });

  it('does not invent roadside routes when a road has no mapped sidewalk', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 20 },
        { x: 100, y: 20 },
      ],
      LifeLine.roadMinor,
      6,
    );
    const graph = new WalkingGraph(b.finish(), 1);
    expect(graph.points).toHaveLength(0);
    expect(graph.route({ x: 10, y: 25 }, { x: 80, y: 25 })).toBeUndefined();
  });
  it('joins mapped sidewalks across a road only through an explicit crossing', () => {
    for (const marked of [false, true]) {
      const b = new LifeBuilder();
      b.line(
        [
          { x: 0, y: 20 },
          { x: 100, y: 20 },
        ],
        LifeLine.roadMinor,
        6,
      );
      line(b, [
        [0, 15],
        [100, 15],
      ]);
      line(b, [
        [0, 25],
        [100, 25],
      ]);
      if (marked) {
        b.area('crossing', [stripRing({ x: 48.5, y: 20 }, { x: 51.5, y: 20 }, 3)]);
        line(b, [
          [50, 15],
          [50, 25],
        ]);
      }
      const graph = new WalkingGraph(b.finish(), 1);
      expect(Boolean(graph.route({ x: 10, y: 15 }, { x: 80, y: 25 }))).toBe(marked);
    }
  });
  it('uses a connected bend instead of cutting across a building', () => {
    const b = new LifeBuilder();
    line(b, [
      [10, 10],
      [10, 40],
      [50, 40],
      [50, 10],
    ]);
    b.obstacle(
      [
        { x: 20, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 30 },
        { x: 20, y: 30 },
      ],
      true,
    );
    const graph = new WalkingGraph(b.finish(), 1);
    const path = graph.route({ x: 10, y: 15 }, { x: 50, y: 15 });
    expect(path).toBeDefined();
    expect(path!.some((p) => p.y === 40)).toBe(true);
    for (let i = 1; i < path!.length; i++) expect(graph.clear(path![i - 1]!, path![i]!)).toBe(true);
  });
  it('rejects blocked connectors and disconnected destinations', () => {
    const b = new LifeBuilder();
    line(b, [
      [0, 10],
      [100, 10],
    ]);
    line(b, [
      [0, 80],
      [100, 80],
    ]);
    b.obstacle(
      [
        { x: 40, y: 12 },
        { x: 60, y: 12 },
        { x: 60, y: 20 },
        { x: 40, y: 20 },
      ],
      true,
    );
    const graph = new WalkingGraph(b.finish(), 1);
    expect(graph.route({ x: 10, y: 10 }, { x: 50, y: 18 })).toBeUndefined();
    expect(graph.route({ x: 10, y: 10 }, { x: 50, y: 80 })).toBeUndefined();
  });
  it('does not cross fences or river lines', () => {
    const b = new LifeBuilder();
    line(b, [
      [0, 10],
      [100, 10],
    ]);
    b.obstacle(
      [
        { x: 50, y: 0 },
        { x: 50, y: 20 },
      ],
      false,
    );
    expect(
      new WalkingGraph(b.finish(), 1).route({ x: 10, y: 10 }, { x: 90, y: 10 }),
    ).toBeUndefined();
  });
  it('approaches a roofed site from a safe exterior entrance', () => {
    const b = new LifeBuilder();
    line(b, [
      [0, 10],
      [100, 10],
    ]);
    b.obstacle(
      [
        { x: 40, y: 14 },
        { x: 60, y: 14 },
        { x: 60, y: 25 },
        { x: 40, y: 25 },
      ],
      true,
    );
    const graph = new WalkingGraph(b.finish(), 1);
    const p = graph.entrance({ x: 50, y: 18 });
    expect(p).toBeDefined();
    expect(graph.clear(p!, p!)).toBe(true);
    expect(graph.route({ x: 10, y: 10 }, p!)).toBeDefined();
  });
  it('owns sites in one tile and transfers all scene arrays', () => {
    const b = new LifeBuilder();
    b.site({ x: 4096, y: 20 }, 0);
    b.site({ x: 0, y: 20 }, 0, 3, true);
    const geo = b.finish();
    expect(geo.sites).toEqual(new Float32Array([0, 20, 0, 3, 1]));
    for (const key of ['sites', 'obstacles', 'obstacleStarts', 'obstacleClosed'] as const)
      expect(lifeTransferables(geo)).toContain(geo[key].buffer);
  });
  it('takes a short clear connection to a neighboring curb', () => {
    const b = new LifeBuilder();
    line(b, [
      [0, 30],
      [200, 30],
    ]);
    b.line(
      [
        { x: 0, y: 24 },
        { x: 200, y: 24 },
      ],
      LifeLine.roadMinor,
      6,
    );
    const route = new WalkingGraph(b.finish(), 1).route({ x: 50, y: 30 }, { x: 50, y: 27.75 });
    expect(route).toBeDefined();
    const length = route!
      .slice(1)
      .reduce((n, p, i) => n + Math.hypot(p.x - route![i]!.x, p.y - route![i]!.y), 0);
    expect(length).toBeLessThan(4);
  });
});
