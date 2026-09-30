import { describe, expect, it } from 'vitest';
import { classId, crownSurfaces, MAX_CLASSES, renderClasses } from './classes';
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
