import { describe, expect, it } from 'vitest';
import { classDepths, classId, groundDepth, MAX_CLASSES, renderClasses } from './classes';
import { roadMask, seeThroughMask, subcellAreas } from './glyphs/select';
import { LifeBuilder, LifeLine, lifeTransferables } from './life/geometry';
import { packFixtures, tileFixtures, type FixtureGrid } from './life/fixtures';
import { TileLife } from './life/simulate';
import { WalkingGraph } from './life/navigation';
import { PolygonIndex } from './life/occupancy';
import {
  buildTileGeometry,
  createIdRegistry,
  EXTENT,
  type TileFeatureLike,
} from './raster/geometry';

const tile = { z: 16, x: 55209, y: 30264 };
const f = (
  type: 1 | 2 | 3,
  properties: TileFeatureLike['properties'],
  rings: number[][][],
): TileFeatureLike => ({
  type,
  properties,
  loadGeometry: () => rings.map((r) => r.map(([x, y]) => ({ x: x!, y: y! }))),
});

describe('outdoor site detail', () => {
  it('fits the class tables and draws paving below planted islands, furniture and crowns', () => {
    expect(renderClasses.length).toBeLessThan(MAX_CLASSES - 5);
    expect(classId('paving')).toBeGreaterThan(31);
    expect(() => [roadMask(), seeThroughMask()]).not.toThrow();
    expect(subcellAreas()[classId('paving')]).toBe(1);
    const depths = classDepths();
    for (const name of ['grass', 'building_part', 'tree_crown', 'furniture'])
      expect(depths[classId(name)]).toBeLessThan(depths[classId('paving')]!);
    expect(groundDepth()).toBeGreaterThan(depths[classId('paving')]!);
  });

  it('uses authored paths without drawing extra ink, and retains raised-bed obstacles', () => {
    const features = [
      f(2, { id: 'detail:test/walk-spine', class: 'path', width: 2, detail_route: true }, [
        [
          [100, 100],
          [800, 100],
        ],
      ]),
      f(3, { id: 'cover:test/area-1', class: 'grass', detail_blocked: true }, [
        [
          [300, 200],
          [600, 200],
          [600, 400],
          [300, 400],
          [300, 200],
        ],
      ]),
      f(3, { id: 'detail:test/seat', class: 'building_part', height: 0.45, detail_blocked: true }, [
        [
          [300, 400],
          [600, 400],
          [600, 410],
          [300, 410],
          [300, 400],
        ],
      ]),
    ];
    const result = buildTileGeometry(
      { landuse: { extent: EXTENT, length: features.length, feature: (i) => features[i]! } },
      createIdRegistry(),
      tile,
    );
    expect(Array.from(result.life.kinds)).toEqual([LifeLine.path]);
    expect(Array.from(result.life.widths)).toEqual([2]);
    expect(Array.from(result.lines.meta).filter((_, i) => i % 4 === 0)).not.toContain(
      classId('path'),
    );
    expect(result.life.areas?.filter((a) => a.kind === 'blocked')).toHaveLength(2);
    expect(result.life.obstacleClosed).toHaveLength(2);
    const graph = new WalkingGraph(result.life, 1);
    expect(graph.clear({ x: 100, y: 100 }, { x: 800, y: 100 })).toBe(true);
    expect(graph.clear({ x: 400, y: 100 }, { x: 400, y: 500 })).toBe(false);
    const blocked = new PolygonIndex();
    for (const area of result.life.areas ?? [])
      if (area.kind === 'blocked') blocked.add(area.rings);
    // A person's center is outside the bed, but its full figure crosses the raised edge.
    expect(blocked.hits([{ x: 290, y: 300, hx: 1, hy: 0, length: 40, width: 20 }])).toBe(true);
    expect(blocked.hits([{ x: 100, y: 100, hx: 1, hy: 0, length: 40, width: 20 }])).toBe(false);
    const seatHeights = Array.from(result.fills.meta).filter(
      (_, i) => i % 4 === 1 && result.fills.meta[i - 1] === classId('building_part'),
    );
    expect(seatHeights.every((h) => h === 1)).toBe(true);
  });

  it('owns each multi-head lamp in one tile and reveals its hardware at furniture zoom', () => {
    const lamp = f(
      1,
      {
        id: 'detail:test/lamp-one',
        class: 'furniture',
        variant: 'lamp',
        lamp_heads: 3,
        lamp_reach: 0.7,
      },
      [[[1000, 1000]]],
    );
    const build = (point: TileFeatureLike) =>
      buildTileGeometry(
        { poi: { extent: EXTENT, length: 1, feature: () => point } },
        createIdRegistry(),
        tile,
      );
    const geometry = build(lamp).life;
    expect(geometry.lamps).toHaveLength(24);
    expect(Array.from(geometry.lampSites!)).toEqual([1, 1, 1]);
    expect(lifeTransferables(geometry)).toContain(geometry.lampSites!.buffer);
    expect(tileFixtures(tile, geometry)).toHaveLength(3);
    const neighbor = build(f(1, lamp.properties, [[[-10, 1000]]])).life;
    expect(tileFixtures(tile, neighbor)).toHaveLength(0);
    const fixtures = tileFixtures(tile, geometry);
    const [lng, lat] = fixtures[0]!.base;
    const grid: FixtureGrid = {
      cols: 60,
      rows: 60,
      cellWidth: 5,
      cellHeight: 9,
      toCell: (x, y) => [30 + (x - lng) * 1e6, 30 - (y - lat) * 1e6],
    };
    expect(
      packFixtures(new Uint8Array(14400), grid, fixtures, 17.9, () => 1, 0).visibility.streetlights,
    ).toBe(false);
    expect(
      packFixtures(new Uint8Array(14400), grid, fixtures, 19, () => 1, 0).visibility.streetlights,
    ).toBe(true);
  });

  it('faces seated people toward the accessible side and preserves legacy seating without a bearing', () => {
    const make = (bearing?: number) => {
      const b = new LifeBuilder();
      b.place({ x: 1000, y: 1000 }, 'bench', 0, false, bearing);
      return new TileLife(tile, b.finish(), 42).gatherers;
    };
    const seated = make(180);
    expect(seated.length).toBeGreaterThan(0);
    expect(seated.every((g) => Math.abs(g.hx) < 1e-6 && Math.abs(g.hy - 1) < 1e-6)).toBe(true);
    const legacy = make();
    expect(legacy.every((g) => g.y === 1000)).toBe(true);
    expect(legacy.every((g) => g.hx === 1 && g.hy === 0)).toBe(true);
  });
});
