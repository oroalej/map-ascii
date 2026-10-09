import { describe, expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, TileLife } from './simulate';
import { PolygonIndex } from './occupancy';
import { worldTiles } from './testing/scenarios';
import { peddlerPM as pm, peddlerTile as tile } from './testing/peddlers';
import { EXTENT } from '../raster/geometry';

const rectangle = (x: number, y: number, width: number, height: number) => [
  { x, y },
  { x: x + width * pm, y },
  { x: x + width * pm, y: y + height * pm },
  { x, y: y + height * pm },
  { x, y },
];
const path = (kind: LifeLine = LifeLine.path) => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 1000, y: 1500 },
      { x: 1000 + 300 * pm, y: 1500 },
    ],
    kind,
    4,
  );
  b.place({ x: 1200, y: 1600 }, 'school', 20);
  return b;
};

describe('stationary street vendors outside campus grounds', () => {
  it.each([LifeLine.path, LifeLine.plaza])(
    'rejects carts on campus walking lines of kind %s without changing pedestrians',
    (kind) => {
      const ordinary = new TileLife(tile, path(kind).finish(), 3);
      expect(ordinary.stalls.length).toBeGreaterThan(0);
      const b = path(kind);
      b.area('peddler-exclusion', [rectangle(900, 1500 - 20 * pm, 350, 40)]);
      const campus = new TileLife(tile, b.finish(), 3);
      expect(campus.stalls).toHaveLength(0);
      expect(campus.movers).toEqual(ordinary.movers);
      expect(campus.gatherers).toEqual(ordinary.gatherers);
    },
  );

  it('rejects a vendor whose body enters grounds even when their cart remains outside', () => {
    const ordinary = new TileLife(tile, path(LifeLine.plaza).finish(), 3);
    const stall = ordinary.stalls[0]!;
    const [cart, person] = ordinary.groundBodies(stall);
    const center = {
      x: person!.x - stall.hy * stall.side * 0.4,
      y: person!.y + stall.hx * stall.side * 0.4,
    };
    const grounds = [rectangle((center.x - 0.025) * pm, (center.y - 0.025) * pm, 0.05, 0.05)];
    const index = new PolygonIndex();
    index.add(grounds.map((r) => r.map((p) => ({ x: p.x / pm, y: p.y / pm }))));
    expect(index.hits([cart!])).toBe(false);
    expect(index.hits([person!])).toBe(true);
    const b = path(LifeLine.plaza);
    b.area('peddler-exclusion', grounds);
    const campus = new TileLife(tile, b.finish(), 3);
    expect(campus.stalls).toEqual(
      ordinary.stalls.filter((s) => !index.hits(ordinary.groundBodies(s))),
    );
    expect(campus.stalls.length).toBeLessThan(ordinary.stalls.length);
  });

  it('prevents shopfront commerce from adding carts after initial campus generation', () => {
    const build = (grounds: boolean, shops: boolean) => {
      const b = path();
      if (shops)
        for (let meters = 0; meters <= 300; meters += 15)
          b.commerceAt({ x: 1000 + meters * pm, y: 1500 });
      if (grounds) b.area('peddler-exclusion', [rectangle(900, 1500 - 20 * pm, 350, 40)]);
      const world = new LifeWorld();
      world.sync([{ key: 'campus-commerce', tile, life: b.finish() }]);
      world.step(0.1);
      return worldTiles(world).get('campus-commerce')!;
    };
    expect(build(false, true).stalls.length).toBeGreaterThan(build(false, false).stalls.length);
    const campus = build(true, true);
    expect(campus.stalls).toHaveLength(0);
    expect(campus.movers.some((m) => m.kind === 'person')).toBe(true);
  });

  it.each(['cold', 'late', 'restored'] as const)(
    'removes carts when a neighboring campus arrives: %s',
    (arrival) => {
      const b = new LifeBuilder();
      b.line(
        [
          { x: 3800, y: 1500 },
          { x: 4090, y: 1500 },
        ],
        LifeLine.plaza,
        4,
      );
      b.market({ x: 3900, y: 1500 });
      const campus = new LifeBuilder();
      campus.area('peddler-exclusion', [
        rectangle(3800 - EXTENT - 10 * pm, 1500 - 20 * pm, 100, 40),
      ]);
      const street = { key: 'path', tile, life: b.finish() };
      const neighbor = {
        key: 'campus',
        tile: { ...tile, x: tile.x + 1 },
        life: campus.finish(),
      };
      const world = new LifeWorld();
      world.sync([street]);
      world.step(0.1);
      expect(worldTiles(world).get('path')!.stalls.length).toBeGreaterThan(0);
      if (arrival === 'cold') {
        const cold = new LifeWorld();
        cold.sync([street, neighbor]);
        cold.step(0.1);
        expect(worldTiles(cold).get('path')!.stalls).toHaveLength(0);
      } else {
        if (arrival === 'restored') {
          const life = worldTiles(world).get('path')!;
          life.reconcileSeasonalActors(
            (owner) => !('kind' in owner) && !('walker' in owner),
            () => false,
            true,
          );
          expect(life.stalls).toHaveLength(0);
        }
        world.sync([street, neighbor]);
        world.step(0.1);
        expect(worldTiles(world).get('path')!.stalls).toHaveLength(0);
      }
    },
  );
});
