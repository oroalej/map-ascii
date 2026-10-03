import { SiteDetail, Landcover, LandmarkPlan } from '@atlas/shared';
import { intersection, difference } from 'polyclip-ts';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { landcoverFeatures } from './landcover';
import { planParts } from './plan';
import { mergeSiteDetails, seatingFootprint } from './site-detail';
import detailJson from '../../../content/cities/naga/details/plaza-rizal.json';
import coverJson from '../../../content/cities/naga/landcover/plaza-rizal.json';
import planJson from '../../../content/cities/naga/plans/rizal-monument.json';

// Imported rather than read from disk so targeted runs select this test when the content changes.
const detail = SiteDetail.parse(detailJson);
const cover = Landcover.parse(coverJson);
const plan = LandmarkPlan.parse(planJson);
// OSM's plaza boundary and two existing point identities, independent of cached downloads.
const parent: AtlasFeature = {
  type: 'Feature',
  properties: { id: detail.osm_id, class: 'park', landmark: true },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [123.1847699, 13.6237295],
        [123.1845757, 13.6230722],
        [123.1846081, 13.6230355],
        [123.1849399, 13.6229474],
        [123.1849999, 13.6229644],
        [123.1851847, 13.623651],
        [123.1851592, 13.6236922],
        [123.1848259, 13.6237688],
        [123.1847699, 13.6237295],
      ],
    ],
  },
  tippecanoe: { layer: 'landuse', minzoom: 12, maxzoom: 16 },
};
const monument: AtlasFeature = {
  type: 'Feature',
  properties: { id: plan.osm_id, class: 'monument' },
  geometry: { type: 'Point', coordinates: [123.1848614, 13.6233503] },
  tippecanoe: { layer: 'poi', minzoom: 16, maxzoom: 16 },
};
const pole: AtlasFeature = {
  ...monument,
  properties: { id: 'osm:node/7744637946', class: 'furniture', variant: 'flagpole' },
  geometry: { type: 'Point', coordinates: [123.1849508, 13.6233359] },
};

describe('Plaza Rizal authored circulation', () => {
  // Full authored geometry needs headroom while the other test files run in parallel.
  // eslint-disable-next-line no-restricted-syntax -- slow before the time-limit ban; tracked by the CI file budget
  it('keeps every route connected and clear of stonework and raised planting at its full width', () => {
    const input = [parent, monument, pole];
    const merged = mergeSiteDetails(
      [...input, ...planParts(input, [plan]).parts, ...landcoverFeatures(input, [cover]).features],
      [detail],
    ).features;
    const obstacles = merged.filter(
      (f) =>
        (f.properties.detail_blocked || f.properties.class === 'building_part') &&
        !f.properties.detail_overhead,
    );
    for (const walk of detail.walks) {
      const shape = seatingFootprint(walk.line, walk.width_m).coordinates as [number, number][][][];
      if (parent.geometry.type !== 'Polygon') throw Error('expected plaza polygon');
      expect(
        difference(shape, parent.geometry.coordinates as [number, number][][]),
        walk.id,
      ).toEqual([]);
      for (const obstacle of obstacles) {
        if (obstacle.geometry.type !== 'Polygon' && obstacle.geometry.type !== 'MultiPolygon')
          continue;
        expect(
          intersection(
            shape,
            obstacle.geometry.coordinates as [number, number][][] | [number, number][][][],
          ),
          `${walk.id} / ${obstacle.properties.id}`,
        ).toEqual([]);
      }
    }
    const visited = new Set([0]);
    for (let pass = 0; pass < detail.walks.length; pass++) {
      detail.walks.forEach((walk, i) => {
        if (
          [...visited].some((j) =>
            walk.line.some((p) =>
              detail.walks[j]!.line.some((q) => p[0] === q[0] && p[1] === q[1]),
            ),
          )
        )
          visited.add(i);
      });
    }
    expect(visited.size).toBe(detail.walks.length);
    expect(merged.find((f) => f.properties.id === pole.properties.id)?.geometry).toEqual(
      pole.geometry,
    );
  }, 60000);
});
