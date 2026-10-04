import * as shared from '@atlas/shared';
import { describe, expect, it, vi } from 'vitest';
import { classId, crownSurfaces, MAX_CLASSES, renderClasses, variantCode } from './classes';
import { wallStyle } from './glyphs/select';
import { CellBit, cellBits } from './life/config';
import { WalkingGraph } from './life/navigation';
import {
  buildTileGeometry,
  createIdRegistry,
  EXTENT,
  type TileFeatureLike,
} from './raster/geometry';

const rectangle = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  overhead: boolean,
): TileFeatureLike => ({
  type: 3,
  properties: {
    id,
    class: 'building_woodwork',
    height: 3,
    detail_overhead: overhead,
    variant: 'flat',
  },
  loadGeometry: () => [
    [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
      { x, y },
    ],
  ],
});

describe('outdoor structure rendering', () => {
  it('decodes disconnected burial markers as one row without joining geometry or obstacles', () => {
    const target = { id: 'osm:way/7', class: 'grass', name: 'Cemetery' };
    const markers = [
      rectangle('north-1', 100, 100, 40, 80, false),
      rectangle('north-2', 900, 100, 40, 80, false),
    ];
    for (const marker of markers)
      marker.properties = {
        id: marker.properties.id!,
        class: 'building_part',
        height: 0.3,
        variant: 'flat',
        kind: 'burial=slab',
        detail_blocked: true,
        detail_parent: target.id,
        detail_selection: JSON.stringify(target),
      };
    const row: TileFeatureLike = {
      ...markers[0]!,
      properties: { ...markers[0]!.properties, id: 'cemetery:fixture/north' },
      loadGeometry: () => markers.flatMap((marker) => marker.loadGeometry()),
    };
    const decode = (features: TileFeatureLike[], registry = createIdRegistry()) => ({
      registry,
      geometry: buildTileGeometry(
        { buildings: { extent: EXTENT, length: features.length, feature: (i) => features[i]! } },
        registry,
        { z: 16, x: 55209, y: 30264 },
      ),
    });
    const separate = decode(markers);
    const grouped = decode([row]);
    expect(grouped.geometry.fills.positions).toEqual(separate.geometry.fills.positions);
    expect(grouped.geometry.fills.indices).toEqual(separate.geometry.fills.indices);
    expect(grouped.geometry.life).toEqual(separate.geometry.life);
    expect(grouped.geometry.life.obstacleClosed).toHaveLength(2);
    expect(new Set(grouped.geometry.fills.ids).size).toBe(1);
    expect(grouped.registry.takeNew()).toEqual([
      target,
      {
        id: 'cemetery:fixture/north',
        class: 'building_part',
        height: 0.3,
        kind: 'burial=slab',
        parentId: target.id,
      },
    ]);
    expect(separate.registry.takeNew()).toHaveLength(3);
  });
  it('parses each descriptor once per tile, caches invalid input and still checks each parent', () => {
    const target = { id: 'osm:way/7', class: 'building_religious', name: 'Church' };
    const descriptor = JSON.stringify(target);
    const features = [descriptor, descriptor, '{broken', '{broken', descriptor].map((text, i) => {
      const ground = rectangle(`ground-${i}`, 100 + i * 100, 100, 50, 50, false);
      ground.properties = {
        id: `ground-${i}`,
        class: 'paving',
        detail_parent: i === 4 ? 'osm:way/8' : target.id,
        detail_selection: text,
      };
      return ground;
    });
    const parser = vi.spyOn(shared, 'parseDetailSelection');
    try {
      const registry = createIdRegistry();
      const decode = () =>
        buildTileGeometry(
          {
            landuse: {
              extent: EXTENT,
              length: features.length,
              feature: (i) => features[i]!,
            },
          },
          registry,
        );
      decode();
      expect(parser).toHaveBeenCalledTimes(2);
      expect(registry.takeNew().filter((f) => f.id.startsWith('osm:'))).toEqual([target]);
      decode();
      expect(parser).toHaveBeenCalledTimes(4); // Cache lifetime is one decode.
    } finally {
      parser.mockRestore();
    }
  });
  it('registers a linked landmark from grounds on a cold load before its own tile arrives', () => {
    const ground = rectangle('detail:church/grounds', 100, 100, 600, 600, false);
    const target = {
      id: 'osm:way/7',
      class: 'building_religious',
      landmarkId: 'landmark/church',
      name: 'Church',
      height: 15,
    };
    ground.properties = {
      id: 'detail:church/grounds',
      class: 'paving',
      detail_parent: target.id,
      detail_selection: JSON.stringify(target),
    };
    const registry = createIdRegistry();
    const result = buildTileGeometry(
      { landuse: { extent: EXTENT, length: 1, feature: () => ground } },
      registry,
      { z: 16, x: 55209, y: 30264 },
    );
    expect(registry.takeNew()).toEqual([
      target,
      { id: 'detail:church/grounds', class: 'paving', parentId: target.id },
    ]);
    expect(result.fills.ids).not.toContain(1); // The ground retains its own outline identity.
    const church = rectangle(target.id, 200, 200, 100, 100, false);
    church.properties = {
      id: target.id,
      class: target.class,
      landmark_id: target.landmarkId,
      name: target.name,
      height: 15,
    };
    buildTileGeometry(
      { buildings: { extent: EXTENT, length: 1, feature: () => church } },
      registry,
      { z: 16, x: 55209, y: 30264 },
    );
    expect(registry.takeNew()).toEqual([]);
  });
  it('does not register mismatched canonical selection metadata', () => {
    const ground = rectangle('ground', 100, 100, 600, 600, false);
    ground.properties = {
      id: 'ground',
      class: 'paving',
      detail_parent: 'osm:way/7',
      detail_selection: JSON.stringify({ id: 'osm:way/8', class: 'building' }),
    };
    const registry = createIdRegistry();
    buildTileGeometry({ landuse: { extent: EXTENT, length: 1, feature: () => ground } }, registry, {
      z: 16,
      x: 55209,
      y: 30264,
    });
    expect(registry.takeNew()).toHaveLength(1);
  });
  it('keeps sub-meter terraces visible, outlined and walkable with parent selection metadata', () => {
    const terrace = rectangle('terrace', 100, 200, 500, 20, false);
    terrace.properties = {
      id: 'terrace',
      class: 'paving',
      height: 0.15,
      variant: 'terrace',
      detail_parent: 'osm:way/1',
    };
    const registry = createIdRegistry();
    const result = buildTileGeometry(
      { landuse: { extent: EXTENT, length: 1, feature: () => terrace } },
      registry,
      { z: 16, x: 55209, y: 30264 },
    );
    expect(result.life.obstacleClosed).toHaveLength(0);
    expect(result.life.areas?.filter((a) => a.kind === 'blocked')).toHaveLength(0);
    expect(result.fills.meta[1]).toBe(1);
    expect(result.fills.meta[3]).toBe(variantCode('paving', 'terrace'));
    expect(registry.takeNew()[0]).toMatchObject({ height: 0.15, parentId: 'osm:way/1' });
    expect(cellBits()[classId('paving')]! & CellBit.person).toBe(CellBit.person);
    expect(wallStyle('scatter', false, 0, 18, true)).toBe('single');
    expect(wallStyle('scatter', false, 0, 17.9, true)).toBeNull();
  });
  it('renders overhead beams without blocking walking beneath them; supports still block full bodies', () => {
    const features = [
      rectangle('beam', 100, 200, 500, 20, true),
      rectangle('post', 100, 200, 20, 20, false),
    ];
    const result = buildTileGeometry(
      { buildings: { extent: EXTENT, length: features.length, feature: (i) => features[i]! } },
      createIdRegistry(),
      { z: 16, x: 55209, y: 30264 },
    );
    expect(result.fills.indices.length).toBeGreaterThan(0);
    expect(result.life.areas?.filter((a) => a.kind === 'blocked')).toHaveLength(1);
    expect(result.life.obstacleClosed).toHaveLength(1);
    const graph = new WalkingGraph(result.life, 1);
    expect(graph.clear({ x: 300, y: 100 }, { x: 300, y: 300 })).toBe(true);
    expect(graph.clear({ x: 110, y: 100 }, { x: 110, y: 300 })).toBe(false);
  });

  it('fits class tables, permits canopy occlusion and hides ground figures beneath timber without glowing windows', () => {
    const id = classId('building_woodwork');
    expect(renderClasses.length).toBeLessThan(MAX_CLASSES - 5);
    expect(crownSurfaces()[id]).toBe(2);
    expect(cellBits()[id]! & CellBit.person).toBe(0);
    expect(cellBits()[id]! & CellBit.window).toBe(0);
    expect(cellBits()[id]! & CellBit.bird).toBe(CellBit.bird);
  });
});
