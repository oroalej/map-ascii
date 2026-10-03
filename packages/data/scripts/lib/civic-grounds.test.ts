import { readFileSync } from 'node:fs';
import {
  Cemetery,
  Landmark,
  LandmarkPlan,
  Landcover,
  SiteDetail,
  type LngLat,
} from '@atlas/shared';
import type { ContentBundle } from '@atlas/content';
import inside from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import type { Polygon, MultiPolygon } from 'geojson';
import { difference, intersection } from 'polyclip-ts';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeContent } from '../04-merge-content';
import { mergeCemeteries } from './cemeteries';
import { polygonComponents } from './geometry-audit';
import { landcoverFeatures } from './landcover';
import { planParts } from './plan';
import { mergeSiteDetails } from './site-detail';
import { bboxesOverlap } from './geo';

// Declare disk-read content dependencies so targeted runs include this test on pack edits.
import.meta.glob(
  '../../../content/cities/naga/{details,landcover,landmarks}/{people-power-monument,padre-jorge-barlin-plaza,vincentian-heritage-park,panganiban-rotonda,naga-city-public-cemetery,naga-cemetery-southern-section,holy-rosary-major-seminary}.json',
);
import.meta.glob('../../../content/cities/naga/plans/holy-rosary-major-seminary.json');
import.meta.glob(
  '../../../content/cities/naga/cemeteries/{naga-city-public-cemetery,naga-cemetery-southern-section}.json',
);

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as unknown;
const source = read('../__fixtures__/civic-ground-parents.json') as AtlasFeature[];
const slugs = [
  'people-power-monument',
  'padre-jorge-barlin-plaza',
  'vincentian-heritage-park',
  'panganiban-rotonda',
  'naga-city-public-cemetery',
  'naga-cemetery-southern-section',
  'holy-rosary-major-seminary',
];
const content = (folder: string, slug: string) =>
  read(`../../../content/cities/naga/${folder}/${slug}.json`);
const details = slugs.map((s) => SiteDetail.parse(content('details', s)));
const covers = slugs.map((s) => Landcover.parse(content('landcover', s)));
const landmarks = slugs
  .filter((s) => s !== 'naga-cemetery-southern-section')
  .map((s) => Landmark.parse(content('landmarks', s)));
const plans = [LandmarkPlan.parse(content('plans', 'holy-rosary-major-seminary'))];
const cemeteries = ['naga-city-public-cemetery', 'naga-cemetery-southern-section'].map((s) =>
  Cemetery.parse(content('cemeteries', s)),
);
const named = mergeContent(structuredClone(source), { landmarks } as ContentBundle);
const roofs = planParts(named, plans);
const vegetation = landcoverFeatures(named, covers);
const sites = mergeSiteDetails([...named, ...roofs.parts, ...vegetation.features], details);
const result = mergeCemeteries(sites.features, cemeteries);
const coords = (g: Polygon | MultiPolygon) => g.coordinates as LngLat[][] | LngLat[][][];

describe('owner-reference civic grounds', () => {
  it('retains every source geometry, road width and distinct site identity', () => {
    expect(roofs.warnings).toEqual([]);
    expect(vegetation.warnings).toEqual([]);
    expect(sites.warnings).toEqual([]);
    for (const original of source) {
      const final = result.features.find((f) => f.properties.id === original.properties.id)!;
      expect(final.geometry, original.properties.id).toEqual(original.geometry);
      expect(final.properties.width, original.properties.id).toBe(original.properties.width);
    }
    const barlin = details.find((d) => d.id === 'detail/padre-jorge-barlin-plaza')!;
    expect(barlin.osm_id).toBe('osm:way/602763181');
    expect(barlin.selection_osm_id).toBe('osm:node/2502669548');
    const island = details.find((d) => d.id === 'detail/people-power-monument')!;
    const anchor = source.find((f) => f.properties.id === island.osm_id)!;
    expect(anchor.geometry.type).toBe('Point');
    if (anchor.geometry.type !== 'Point') throw Error('expected fixed monument point');
    expect(
      inside(anchor.geometry.coordinates, { type: 'Polygon', coordinates: [island.grounds!] }),
    ).toBe(true);
    // This photographed raised island overlaps coarse OSM road buffers. Its local raised
    // floor and planters never erase or narrow a mapped carriageway.
    expect(island.structures.every((p) => !p.ground_override)).toBe(true);
    expect(island.parked_vehicles).toEqual([]);
    expect(new Set(result.features.map((f) => f.properties.id)).size).toBe(result.features.length);
  });

  it('details the full Major Seminary while preserving its circular standing roof and open lawn', () => {
    const seminary = details.find((d) => d.id === 'detail/holy-rosary-major-seminary')!;
    expect(seminary.osm_id).toBe('osm:way/886573227');
    expect(seminary.grounds).toBeUndefined();
    expect(seminary.extent).toBeUndefined();
    const parent = source.find((f) => f.properties.id === seminary.osm_id)!.geometry as Polygon;
    const roof = source.find((f) => f.properties.id === 'osm:way/959623307')!.geometry as Polygon;
    expect(roofs.parts.length).toBeGreaterThan(0);
    for (const part of roofs.parts)
      expect(difference(coords(part.geometry as Polygon), coords(roof))).toEqual([]);
    const planting = covers.find((c) => c.id === 'landcover/holy-rosary-major-seminary')!;
    // Coverage reaches the northern forecourt, southern grounds and eastern garden.
    const [west, south, east, north] = bbox(parent);
    for (const [u, v] of [
      [0.48, 0.33],
      [0.24, 0.18],
      [0.64, 0.85],
    ]) {
      const at: LngLat = [west + (east - west) * u!, south + (north - south) * v!];
      expect(
        planting.areas.some(
          (a) => a.cover === 'grass' && inside(at, { type: 'Polygon', coordinates: [a.ring] }),
        ),
      ).toBe(true);
    }
    expect(planting.rows).toEqual([]);
    expect(seminary.parked_vehicles).toEqual([]);
  });

  it('keeps northern vaults and southern slabs distinct and clears complete markers from roofs, aisles and planting', () => {
    expect(cemeteries.map((c) => c.osm_id)).toEqual(['osm:way/179078354', 'osm:relation/16196458']);
    for (const [i, pack] of cemeteries.entries()) {
      const stat = result.stats.find((s) => s.id === pack.id)!;
      expect(stat.outside).toBe(0);
      expect(stat.blocked).toBe(0);
      expect(stat.added).toBeGreaterThan(500);
      const parent = source.find((f) => f.properties.id === pack.osm_id)!.geometry as
        Polygon | MultiPolygon;
      const plots = result.features
        .filter((f) => f.properties.id.startsWith(`${pack.id.replace('cemetery/', 'cemetery:')}/`))
        .flatMap((f) =>
          polygonComponents(f.geometry as Polygon | MultiPolygon).map((geometry) => ({
            ...f,
            geometry,
          })),
        );
      expect(plots.some((f) => f.properties.kind === 'burial=vault')).toBe(i === 0);
      const patches = covers
        .find((c) => c.id === `landcover/${pack.id.slice(9)}`)!
        .areas.map((a) => ({
          shape: { type: 'Polygon' as const, coordinates: [a.ring] },
          bounds: bbox({ type: 'Polygon', coordinates: [a.ring] }) as [
            number,
            number,
            number,
            number,
          ],
        }));
      for (const [index, plot] of plots.entries()) {
        const shape = plot.geometry;
        expect(
          shape.coordinates[0]!.every((p) => inside(p, parent)),
          plot.properties.id,
        ).toBe(true);
        const bounds = bbox(shape) as [number, number, number, number];
        for (const patch of patches.filter((p) => bboxesOverlap(bounds, p.bounds)))
          expect(intersection(coords(shape), coords(patch.shape)), plot.properties.id).toEqual([]);
        if (index % 100 === 0)
          expect(difference(coords(shape), coords(parent)), plot.properties.id).toEqual([]);
      }
    }
  });
});
