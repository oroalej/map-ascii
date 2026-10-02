import { readFileSync } from 'node:fs';
import {
  Cemetery,
  Landcover,
  Landmark,
  SiteDetail,
  DetailSelectionSchema,
  type LngLat,
} from '@atlas/shared';
import type { ContentBundle } from '@atlas/content';
import type { Polygon, MultiPolygon } from 'geojson';
import inside from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import { intersection } from 'polyclip-ts';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeContent } from '../04-merge-content';
import { mergeCemeteries } from './cemeteries';
import { mergeSiteDetails, seatingFootprint } from './site-detail';
import { applyLandcoverTreeOverrides, landcoverFeatures } from './landcover';
import { bboxesOverlap } from './geo';

// Declare disk-read content dependencies so targeted runs include this test on pack edits.
import.meta.glob(
  '../../../content/cities/naga/{details,landcover,landmarks}/{abcede-elementary-school,sta-cruz-elementary-school,naga-city-school-of-arts-and-trades,eternal-gardens}.json',
);
import.meta.glob(
  '../../../content/cities/naga/landcover/{naga-city-civic-center,naga-central-school-ii,bicol-state-campus,basilica-cemeteries}.json',
);
import.meta.glob('../../../content/cities/naga/details/bicol-state-campus.json');
import.meta.glob('../../../content/cities/naga/cemeteries/eternal-gardens.json');

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as unknown;
const pack = (folder: string, slug: string) =>
  read(`../../../content/cities/naga/${folder}/${slug}.json`);
const slugs = [
  'abcede-elementary-school',
  'sta-cruz-elementary-school',
  'naga-city-school-of-arts-and-trades',
];
const details = [...slugs, 'eternal-gardens'].map((slug) =>
  SiteDetail.parse(pack('details', slug)),
);
const covers = slugs.map((slug) => Landcover.parse(pack('landcover', slug)));
const source = read('../__fixtures__/memorial-school-parents.json') as AtlasFeature[];
const reference = read('../__fixtures__/memorial-school-reference.json') as {
  civic_before: Landcover;
  civic_masks: LngLat[][];
  grandstand_interior: LngLat[];
  memorial_centre: LngLat;
};
const coords = (g: Polygon | MultiPolygon) => g.coordinates as LngLat[][] | LngLat[][][];
const intersects = (a: Polygon | MultiPolygon, b: Polygon | MultiPolygon) =>
  bboxesOverlap(
    bbox(a) as [number, number, number, number],
    bbox(b) as [number, number, number, number],
  ) && intersection(coords(a), coords(b)).length > 0;
const obstacles = source.flatMap<Polygon | MultiPolygon>((f) => {
  const g = f.geometry,
    p = f.properties;
  if (
    ['Polygon', 'MultiPolygon'].includes(g.type) &&
    ((p.class.startsWith('building') && (p.height ?? 0) > 0) || p.class.startsWith('water'))
  )
    return [g as Polygon | MultiPolygon];
  if (g.type === 'LineString' && (p.class.startsWith('road') || p.class === 'path'))
    return [seatingFootprint(g.coordinates as LngLat[], p.width ?? (p.class === 'path' ? 2 : 6))];
  return [];
});

describe('owner memorial and school enhancements', () => {
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
      expect(cover.trees.length).toBeGreaterThanOrEqual(10);
      expect(cover.trees.length).toBeLessThanOrEqual(24);
      expect(cover.areas.some((a) => a.cover === 'grass')).toBe(true);
      expect(cover.areas.some((a) => a.cover === 'planting')).toBe(true);
      for (const tree of cover.trees) {
        expect(inside(tree.at, area)).toBe(true);
        for (const obstacle of obstacles) expect(inside(tree.at, obstacle)).toBe(false);
      }
      for (const patch of cover.areas)
        for (const obstacle of obstacles)
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
  }, 10000);

  it('enlarges only marked Civic crowns and adds three clear frontage trunks', () => {
    const civic = Landcover.parse(pack('landcover', 'naga-city-civic-center'));
    const before = reference.civic_before;
    const marked = (at: LngLat) =>
      reference.civic_masks.some((ring) => inside(at, { type: 'Polygon', coordinates: [ring] }));
    let enlarged = 0;
    for (const [i, old] of before.trees.entries()) {
      expect(civic.trees[i]!.at).toEqual(old.at);
      if (marked(old.at)) {
        expect(civic.trees[i]!.crown_m).toBeGreaterThan(old.crown_m!);
        enlarged++;
      } else expect(civic.trees[i]).toEqual(old);
    }
    // Mapped positions/heights remain independent of the new crown estimates.
    const mapped = read('../__fixtures__/seven-site-parents.json') as AtlasFeature[];
    const adjusted = applyLandcoverTreeOverrides(mapped, [civic]);
    for (const old of before.tree_overrides) {
      const original = mapped.find((f) => f.properties.id === old.osm_id)!;
      const at = (original.geometry as { type: 'Point'; coordinates: LngLat }).coordinates;
      const current = civic.tree_overrides.find((t) => t.osm_id === old.osm_id)!;
      if (marked(at)) {
        expect(current.crown_m).toBeGreaterThan(old.crown_m!);
        enlarged++;
      } else expect(current).toEqual(old);
      const out = adjusted.find((f) => f.properties.id === old.osm_id)!;
      expect(out.geometry).toEqual(original.geometry);
      expect(out.properties.height).toBe(original.properties.height);
    }
    expect(enlarged).toBe(11);
    expect(civic.trees).toHaveLength(before.trees.length + 3);
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
    const plots = result.features.filter((f) => f.properties.id.startsWith('cemetery:'));
    expect(plots.length).toBeGreaterThan(1600);
    for (const plot of plots)
      for (const part of memorial)
        expect(intersects(plot.geometry as Polygon, part.geometry as Polygon)).toBe(false);
    const ids = new Set(plots.map((f) => f.properties.id));
    for (const old of previous.features.filter((f) => f.properties.id.startsWith('cemetery:'))) {
      if (!ids.has(old.properties.id))
        expect(
          memorial.some((part) => intersects(old.geometry as Polygon, part.geometry as Polygon)),
        ).toBe(true);
      else
        expect(plots.find((f) => f.properties.id === old.properties.id)!.geometry).toEqual(
          old.geometry,
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
  }, 10000);
});
