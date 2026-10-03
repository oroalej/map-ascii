import type { BBox, LngLat } from '@atlas/shared';
import bbox from '@turf/bbox';
import { difference, intersection, union } from 'polyclip-ts';
import type { Polygon, MultiPolygon } from 'geojson';
import { bboxesOverlap, localFrame } from './geo';

type Area = Polygon | MultiPolygon;

/** Reuse immutable footprints and clip only overlapping shapes, in local meters. */
export function geometryAudit(area: Area) {
  const bounds = bbox(area) as BBox;
  const frame = localFrame([bounds[0], bounds[1]], (bounds[1] + bounds[3]) / 2);
  const prepared = new Map<Area, { bounds: BBox; coordinates: LngLat[][][] }>();
  const prepare = (shape: Area) => {
    let result = prepared.get(shape);
    if (!result) {
      result = {
        bounds: bbox(shape) as BBox,
        coordinates: (shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates).map((p) =>
          p.map((r) =>
            r.map((point) => {
              const [x, y] = frame.toMeters(point);
              return [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6] as LngLat;
            }),
          ),
        ),
      };
      prepared.set(shape, result);
    }
    return result;
  };
  return {
    union: (shapes: Area[]): MultiPolygon => {
      const [first, ...rest] = shapes.map((shape) => prepare(shape).coordinates);
      const coordinates = first ? union(first, ...rest) : [];
      const shape: MultiPolygon = {
        type: 'MultiPolygon',
        coordinates: coordinates.map((p) => p.map((r) => r.map((point) => frame.toLngLat(point)))),
      };
      prepared.set(shape, {
        bounds: bbox(shape) as BBox,
        coordinates,
      });
      return shape;
    },
    contains: (shape: Area) =>
      difference(prepare(shape).coordinates, prepare(area).coordinates).length === 0,
    overlaps: (shape: Area, obstacle: Area) => {
      const a = prepare(shape),
        b = prepare(obstacle);
      return (
        bboxesOverlap(a.bounds, b.bounds) && intersection(a.coordinates, b.coordinates).length > 0
      );
    },
  };
}
