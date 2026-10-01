import { describe, expect, it } from 'vitest';
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
