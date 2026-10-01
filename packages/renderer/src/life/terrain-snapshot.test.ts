import { describe, expect, it } from 'vitest';
import { makeScenario } from './testing/scenarios';
import { makeCellGuard } from './cell-guard';
import {
  cellTerrainFrom,
  flattenPolygons,
  snapshotOf,
  unflattenPolygons,
} from './terrain-snapshot';
import type { Polygon } from './occupancy';
import type { VisibleAgent } from './simulate';

describe('cell terrain snapshots', () => {
  it('preserves holes, empty rings and exact float64 coordinates', () => {
    const polygons: Polygon[] = [
      [],
      [
        [],
        [
          { x: 1 / 3, y: -0 },
          { x: 1e-12, y: 1e12 },
        ],
      ],
      [[{ x: 0, y: 0 }], [{ x: 0.001, y: -0.001 }]],
    ];
    expect(unflattenPolygons(flattenPolygons(polygons))).toEqual(polygons);
    expect(unflattenPolygons(flattenPolygons([]))).toEqual([]);
  });

  it('keeps transferred cell guards identical to the world for walkers, carts and parked cars', () => {
    const scenario = makeScenario('crossroads', 4, false);
    const square = (lo: number, hi: number) => [
      { x: lo, y: lo },
      { x: hi, y: lo },
      { x: hi, y: hi },
      { x: lo, y: hi },
      { x: lo, y: lo },
    ];
    const tiles = scenario.tiles.map((tile, i) =>
      i
        ? tile
        : {
            ...tile,
            life: {
              ...tile.life,
              areas: [
                ...(tile.life.areas ?? []),
                {
                  kind: 'parking-exclusion' as const,
                  rings: [square(1800, 2300), square(1950, 2150)],
                },
              ],
            },
          },
    );
    // Replacing static geometry requires a hard reset; an ordinary pan revives its original clone.
    scenario.world.clearTiles();
    scenario.world.sync(tiles);
    const { snapshot, transferables } = snapshotOf(scenario.world.cellTerrain()!);
    const received = structuredClone(snapshot, { transfer: transferables });
    expect(snapshot.roads.polygons.coords.byteLength).toBe(0);
    const { ref, access, trees } = cellTerrainFrom(received);
    const guard = makeCellGuard(ref, access, trees, scenario.grid.toCell);
    const direct = scenario.world.groundCellGuard(scenario.grid.toCell)!;
    const base = scenario.world.visible(18, scenario.levels, scenario.center)[0]!;
    const agents: VisibleAgent[] = [
      { ...base, kind: 'person', vehicle: undefined },
      { ...base, kind: 'person', vehicle: 'cart' },
      { ...base, kind: 'vehicle', vehicle: 'car', parked: true },
      { ...base, kind: 'person', aboard: true },
    ];
    const rejected = agents.map(() => 0);
    for (let row = 0; row < scenario.grid.rows; row += 3)
      for (let col = 0; col < scenario.grid.cols; col += 3)
        for (const [i, agent] of agents.entries()) {
          const expected = direct(agent, col, row);
          rejected[i]! += Number(!expected);
          expect(guard(agent, col, row)).toBe(expected);
        }
    for (const count of rejected.slice(0, 3)) expect(count).toBeGreaterThan(0);
    expect(rejected[3]).toBe(0);
  });
});
