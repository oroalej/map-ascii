import { type LngLat } from '@atlas/shared';
import {
  Cemetery,
  Landcover,
  Landmark,
  SiteDetail,
  DetailSelectionSchema,
} from '@atlas/shared/schemas';
import type { ContentBundle } from '@atlas/content';
import type { Polygon, MultiPolygon } from 'geojson';
import inside from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeContent } from '../04-merge-content';
import { mergeCemeteries } from './cemeteries';
import { polygonComponents } from './geometry-audit';
import { mergeSiteDetails } from './site-detail';
import {
  assertPointClear,
  clearanceAssertions,
  effectiveTrees,
  pointObstacles,
  mappedFootprints,
  readFixture,
  readPack as pack,
} from './landmark-detail.geometry';
import { applyLandcoverTreeOverrides, landcoverFeatures } from './landcover';

// Declare disk-read content dependencies so targeted runs include this test on pack edits.
import.meta.glob(
  '../../../content/cities/naga/{details,landcover,landmarks}/{abcede-elementary-school,sta-cruz-elementary-school,naga-city-school-of-arts-and-trades,eternal-gardens}.json',
);
import.meta.glob(
  '../../../content/cities/naga/landcover/{naga-city-civic-center,naga-central-school-ii,bicol-state-campus,basilica-cemeteries}.json',
);
import.meta.glob('../../../content/cities/naga/details/bicol-state-campus.json');
import.meta.glob('../../../content/cities/naga/cemeteries/eternal-gardens.json');

const slugs = [
  'abcede-elementary-school',
  'sta-cruz-elementary-school',
  'naga-city-school-of-arts-and-trades',
];
const details = [...slugs, 'eternal-gardens'].map((slug) =>
  SiteDetail.parse(pack('details', slug)),
);
const covers = slugs.map((slug) => Landcover.parse(pack('landcover', slug)));
const source = readFixture('memorial-school-parents.json') as AtlasFeature[];
const reference = readFixture('memorial-school-reference.json') as {
  civic_masks: LngLat[][];
  grandstand_interior: LngLat[];
  memorial_centre: LngLat;
};
const audit = clearanceAssertions(
  source.find((f) => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')!
    .geometry as Polygon | MultiPolygon,
);
const intersects = audit.overlaps;
const obstacles = pointObstacles(source, { water: true });

describe('owner memorial and school enhancements', () => {
  it('retains effective tree coverage when an OSM point replaces a retired curated tree', () => {
    const cover = covers[0]!;
    const tree = cover.trees[0]!;
    const mapped: AtlasFeature = {
      type: 'Feature',
      tippecanoe: { layer: 'landuse', minzoom: 15, maxzoom: 16 },
      geometry: { type: 'Point', coordinates: tree.at },
      properties: {
        id: 'osm:node/retired-tree',
        class: 'tree',
        crown: tree.crown_m,
        height: tree.height_m,
      },
    };
    const retired = { ...cover, trees: cover.trees.slice(1) };
    const effective = effectiveTrees([...source, mapped], [retired]);
    expect(
      effective.filter((feature) =>
        feature.geometry.coordinates.every((value, i) => value === tree.at[i]),
      ),
    ).toHaveLength(1);
    expect(effective.find((feature) => feature.properties.id === mapped.properties.id)).toEqual(
      mapped,
    );
    expect(cover.trees[0]).toEqual(tree);
  });
  it('keeps distinct school identities, complete source geometry and clear open yards', () => {
    const landmarks = [...slugs, 'eternal-gardens'].map((slug) =>
      Landmark.parse(pack('landmarks', slug)),
    );
    const input = mergeContent(structuredClone(source), { landmarks } as ContentBundle);
    const cover = landcoverFeatures(input, covers);
    const result = mergeSiteDetails([...input, ...cover.features], details);
    expect(result.warnings).toEqual([]);
    expect(new Set(details.map((d) => d.osm_id)).size).toBe(4);
    for (const f of source)
      expect(
        result.features.find((out) => out.properties.id === f.properties.id)!.geometry,
      ).toEqual(f.geometry);
    for (const [i, cover] of covers.entries()) {
      const area = source.find((f) => f.properties.id === details[i]!.osm_id)!.geometry as Polygon;
      const visible = effectiveTrees(source, [cover]).filter((tree) =>
        inside(tree.geometry.coordinates, area),
      );
      expect(visible.length).toBeGreaterThanOrEqual(10);
      expect(visible.length).toBeLessThanOrEqual(30);
      expect(cover.status).toBe('draft');
      expect(cover.areas.some((a) => a.cover === 'grass')).toBe(true);
      expect(cover.areas.some((a) => a.cover === 'planting')).toBe(true);
      for (const tree of cover.trees) {
        expect(inside(tree.at, area)).toBe(true);
        assertPointClear(tree.at, obstacles, cover.id);
      }
      for (const patch of cover.areas)
        for (const obstacle of mappedFootprints(source, {
          water: true,
          bounds: bbox(area) as [number, number, number, number],
        }))
          expect(
            intersects({ type: 'Polygon', coordinates: [patch.ring] }, obstacle),
            cover.id,
          ).toBe(false);
      const linked = result.features.filter((f) =>
        f.properties.id.startsWith(`detail:${slugs[i]}/`),
      );
      expect(linked.length).toBeGreaterThanOrEqual(4);
      for (const f of linked)
        expect(
          DetailSelectionSchema.parse(JSON.parse(f.properties.detail_selection!) as unknown)
            .landmarkId,
        ).toBe(`landmark/${slugs[i]}`);
    }
  });

  it('keeps effective Civic canopy in the marked groups and preserves mapped trunks and heights', () => {
    const civic = Landcover.parse(pack('landcover', 'naga-city-civic-center'));
    const mapped = readFixture('seven-site-parents.json') as AtlasFeature[];
    const adjusted = applyLandcoverTreeOverrides(mapped, [civic]);
    const trees = effectiveTrees(mapped, [civic]);
    for (const ring of reference.civic_masks) {
      const marked = trees.filter((tree) =>
        inside(tree.geometry.coordinates, { type: 'Polygon', coordinates: [ring] }),
      );
      expect(marked.length).toBeGreaterThan(0);
      expect(marked.some((tree) => (tree.properties.crown ?? 0) >= 17)).toBe(true);
    }
    for (const current of civic.tree_overrides) {
      const original = mapped.find((f) => f.properties.id === current.osm_id)!;
      const out = adjusted.find((f) => f.properties.id === current.osm_id)!;
      expect(out.geometry).toEqual(original.geometry);
      expect(out.properties.height).toBe(original.properties.height);
    }
    const civicObstacles = pointObstacles(mapped, { water: true });
    for (const tree of civic.trees) {
      expect(tree.crown_m).toBeGreaterThanOrEqual(7);
      expect(tree.crown_m).toBeLessThanOrEqual(18);
      assertPointClear(tree.at, civicObstacles, civic.id);
    }
    expect(civic.status).toBe('draft');
  });

  it('covers the annotated field interior with grass and leaves both basketball surfaces open', () => {
    const field = ['naga-central-school-ii', 'bicol-state-campus'].map((slug) =>
      Landcover.parse(pack('landcover', slug)),
    );
    const lawns = field.flatMap((c) => c.areas.filter((a) => a.cover === 'grass'));
    for (const at of reference.grandstand_interior)
      expect(
        lawns.some((a) => inside(at, { type: 'Polygon', coordinates: [a.ring] })),
        String(at),
      ).toBe(true);
    const bicol = SiteDetail.parse(pack('details', 'bicol-state-campus'));
    for (const court of bicol.structures.filter((p) => p.material === 'pitch'))
      for (const cover of field)
        for (const tree of cover.trees)
          expect(inside(tree.at, { type: 'Polygon', coordinates: [court.ring] })).toBe(false);
  });

  it('reserves only the memorial footprint from illustrative graves and preserves the separate monument', () => {
    const cemetery = Cemetery.parse(pack('cemeteries', 'eternal-gardens'));
    const cemeteryTrees = Landcover.parse(pack('landcover', 'basilica-cemeteries'));
    const landmarks = [Landmark.parse(pack('landmarks', 'eternal-gardens'))];
    const input = mergeContent(structuredClone(source), { landmarks } as ContentBundle);
    const original = [...input, ...landcoverFeatures(input, [cemeteryTrees]).features];
    const previous = mergeCemeteries(original, [cemetery]);
    const withMemorial = mergeSiteDetails(original, [details[3]!]).features;
    const result = mergeCemeteries(withMemorial, [cemetery]);
    const memorial = withMemorial.filter((f) =>
      f.properties.id.startsWith('detail:eternal-gardens/structure-'),
    );
    expect(memorial).toHaveLength(9);
    expect(details[3]!.structures.find((p) => p.id === 'marian-halo-plan')!.holes).toHaveLength(1);
    const plots = result.features
      .filter((f) => f.properties.id.startsWith('cemetery:'))
      .flatMap((f) =>
        polygonComponents(f.geometry as Polygon | MultiPolygon).map((geometry) => ({
          ...f,
          geometry,
        })),
      );
    expect(plots.length).toBeGreaterThan(1600);
    for (const plot of plots)
      for (const part of memorial)
        expect(intersects(plot.geometry, part.geometry as Polygon)).toBe(false);
    const shapes = new Set(plots.map((f) => JSON.stringify(f.geometry)));
    const oldPlots = previous.features
      .filter((f) => f.properties.id.startsWith('cemetery:'))
      .flatMap((f) =>
        polygonComponents(f.geometry as Polygon | MultiPolygon).map((geometry) => ({
          ...f,
          geometry,
        })),
      );
    for (const old of oldPlots) {
      if (!shapes.has(JSON.stringify(old.geometry)))
        expect(memorial.some((part) => intersects(old.geometry, part.geometry as Polygon))).toBe(
          true,
        );
    }
    const id = 'osm:node/13990479932';
    expect(result.features.find((f) => f.properties.id === id)).toEqual(
      input.find((f) => f.properties.id === id),
    );
    for (const part of memorial)
      expect(
        DetailSelectionSchema.parse(JSON.parse(part.properties.detail_selection!) as unknown)
          .landmarkId,
      ).toBe('landmark/eternal-gardens');
  });
});
