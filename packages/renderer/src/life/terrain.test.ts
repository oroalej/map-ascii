import { describe, expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import {
  RoadAccess,
  WorldRoadCache,
  prepareRoadTerrain,
  carriageways,
  stripRing,
  subtractCrossing,
  transformPolygon,
} from './terrain';
import { metersPerUnit, sidewalkLine } from '../raster/geometry';
import type { Body } from './occupancy';

const road = stripRing({ x: 0, y: 0 }, { x: 100, y: 0 }, 5);
const crossing = stripRing({ x: 48.5, y: 0 }, { x: 51.5, y: 0 }, 5);
const body = (x: number, y: number, length = 0.9, width = 1): Body => ({
  x,
  y,
  hx: 1,
  hy: 0,
  length,
  width,
});

describe('carriageway access', () => {
  it('rejects a hairpin bevel that would cut back through the carriageway', () => {
    const way = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 0 },
    ];
    const points = sidewalkLine(way, 5);
    const access = new RoadAccess([[road]], []);
    expect(access.clear(points[1]!, points[2]!)).toBe(false);
  });

  it('shares metric preparation and gives the same access at different tile zooms', () => {
    for (const z of [14, 16, 18]) {
      const pm = 1 / metersPerUnit({ z, x: 0, y: 2 ** (z - 1) });
      const b = new LifeBuilder();
      b.area('carriageway', transformPolygon([road], 0, 0, pm));
      b.area('crossing', transformPolygon([crossing], 0, 0, pm));
      const geo = b.finish();
      const terrain = prepareRoadTerrain(geo, pm);
      expect(prepareRoadTerrain(geo, pm)).toBe(terrain);
      expect(terrain.access.allows([body(20, 0)])).toBe(false);
      expect(terrain.access.allows([body(50, 0)])).toBe(true);
      expect(terrain.access.clear({ x: 50, y: -10 }, { x: 50, y: 10 })).toBe(true);
    }
  });

  it('updates neighboring-only crossing cutouts on load and eviction, across scales', () => {
    const b = new LifeBuilder();
    b.area('carriageway', [road]);
    const terrain = prepareRoadTerrain(b.finish(), 1);
    const c = new LifeBuilder();
    c.area('crossing', transformPolygon([crossing], -25, 0, 0.5));
    const neighbor = prepareRoadTerrain(c.finish(), 1);
    const owner = {},
      crossingOwner = {},
      cache = new WorldRoadCache();
    const roadTile = { owner, terrain, x: 0, y: 0, scale: 1 };
    const crossingTile = { owner: crossingOwner, terrain: neighbor, x: 50, y: 0, scale: 2 };
    expect(cache.build([roadTile]).allows([body(50, 0)])).toBe(false);
    expect(cache.build([roadTile, crossingTile]).allows([body(50, 0)])).toBe(true);
    expect(cache.build([roadTile, crossingTile]).allows([body(50, 0)], false)).toBe(false);
    const shifted = cache.build([
      { ...roadTile, x: -200, y: 30, scale: 0.5 },
      { ...crossingTile, x: -175, y: 30, scale: 1 },
    ]);
    expect(shifted.allows([body(-175, 30)])).toBe(true);
    expect(shifted.allows([body(-175, 30)], false)).toBe(false);
    expect(cache.build([roadTile]).allows([body(50, 0)])).toBe(false);
  });

  it('reuses unaffected owner-local fragments when tiles or the world reference change', () => {
    const b = new LifeBuilder();
    b.area('carriageway', [road]);
    const terrain = prepareRoadTerrain(b.finish(), 1);
    const cache = new WorldRoadCache(),
      owner = {};
    const contribution = { owner, terrain, x: 0, y: 0, scale: 1 };
    const first = cache.build([contribution]);
    // Inspect identity only: world indices may be rebuilt, but clipping must be reused.
    const entries = (
      cache as unknown as { tiles: WeakMap<object, { roads: { pieces: unknown }[] }> }
    ).tiles;
    const fragments = entries.get(owner)!.roads[0]!.pieces;
    const c = new LifeBuilder();
    c.area('crossing', [crossing]);
    const far = { owner: {}, terrain: prepareRoadTerrain(c.finish(), 1), x: 10000, y: 0, scale: 1 };
    const again = cache.build([contribution, far]);
    expect(again.roads.polygons[0]).toBe(first.roads.polygons[0]);
    expect(again.forbidden.polygons[0]).toBe(first.forbidden.polygons[0]);
    expect(entries.get(owner)!.roads[0]!.pieces).toBe(fragments);
    const shifted = cache.build([{ ...contribution, x: 20, y: 30, scale: 2 }]);
    expect(shifted.roads.polygons[0]).not.toBe(first.roads.polygons[0]);
    expect(entries.get(owner)!.roads[0]!.pieces).toBe(fragments);
    expect(shifted.allows([body(60, 30)])).toBe(false);
  });

  it('cuts only crossing footprints out of the road, in either winding', () => {
    for (const ring of [crossing, [...crossing].reverse()]) {
      const access = new RoadAccess([[road]], [[ring]]);
      expect(subtractCrossing(road, ring)).toHaveLength(2);
      expect(access.allows([body(20, 0)])).toBe(false);
      expect(access.allows([body(50, 0)])).toBe(true);
      expect(access.allows([body(50, 0)], false)).toBe(false);
      expect(access.allows([body(20, 6)])).toBe(true);
    }
  });
  it('checks the complete group and rejects partial crossing footprints', () => {
    const access = new RoadAccess([[road]], [[crossing]]);
    expect(access.allows([body(50, 0), body(52, 0)])).toBe(false);
    expect(access.allows([body(51.3, 0)])).toBe(false);
    expect(access.allows([body(50, 0), body(50, 2)])).toBe(true);
  });
  it('rejects shortcuts and swept steps through roads, allowing the marked route', () => {
    const access = new RoadAccess([[road]], [[crossing]]);
    expect(access.clear({ x: 20, y: -10 }, { x: 20, y: 10 })).toBe(false);
    expect(access.clear({ x: 50, y: -10 }, { x: 50, y: 10 })).toBe(true);
    expect(access.clear({ x: 20, y: 6 }, { x: 80, y: 6 })).toBe(true);
  });
  it('supports adjacent crossing anchors without allowing the gap between them', () => {
    const access = new RoadAccess(
      [[road]],
      [[crossing], [stripRing({ x: 54, y: 0 }, { x: 57, y: 0 }, 5)]],
    );
    expect(access.allows([body(55, 0)])).toBe(true);
    expect(access.allows([body(52.5, 0)])).toBe(false);
  });
  it('handles a diagonal road and crossing using their real footprints', () => {
    const access = new RoadAccess(
      [[stripRing({ x: 0, y: 0 }, { x: 100, y: 100 }, 5)]],
      [[stripRing({ x: 49, y: 49 }, { x: 51, y: 51 }, 5)]],
    );
    expect(access.allows([body(50, 50)])).toBe(true);
    expect(access.allows([body(45, 45)])).toBe(false);
  });
  it('derives road widths without mistaking walking paths for carriageways', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      LifeLine.roadMinor,
      6,
    );
    b.line(
      [
        { x: 0, y: 20 },
        { x: 100, y: 20 },
      ],
      LifeLine.path,
    );
    expect(carriageways(b.finish(), 2)).toEqual([[stripRing({ x: 0, y: 0 }, { x: 100, y: 0 }, 6)]]);
  });
});
