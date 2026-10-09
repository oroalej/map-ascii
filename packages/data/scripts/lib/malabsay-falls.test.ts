import type { ContentBundle } from '@atlas/content';
import { parseDetailSelection } from '@atlas/shared';
// Keep schema constructors compatible with main's type-only runtime barrel.
import { Landmark, SiteDetail, Landcover } from '../../../shared/src/schemas';
import { describe, expect, it } from 'vitest';
import type { Polygon } from 'geojson';
import type { AtlasFeature } from '../03-normalize';
import { mergeContent } from '../04-merge-content';
import { searchEntries } from '../06-search-index';
import {
  readFixture,
  readPack,
  areaFor,
  clearanceAssertions,
  mappedFootprints,
} from './landmark-detail.geometry';
import { landcoverFeatures } from './landcover';
import { mergeSiteDetails } from './site-detail';

import.meta.glob('../../../content/cities/naga/{details,landcover,landmarks}/malabsay-falls.json');
const landmark = Landmark.parse(readPack('landmarks', 'malabsay-falls'));
const detail = SiteDetail.parse(readPack('details', 'malabsay-falls'));
const cover = Landcover.parse(readPack('landcover', 'malabsay-falls'));
const source = readFixture('malabsay-falls-parents.json') as AtlasFeature[];
const content = {
  landmarks: [landmark],
  dishes: [],
  'name-history': [],
} as unknown as ContentBundle;
const joined = mergeContent(structuredClone(source), content);
const land = landcoverFeatures(joined, [cover]);
const result = mergeSiteDetails([...joined, ...land.features], [detail]);
const area = areaFor(detail, source);
const audit = clearanceAssertions(area);
const shape = (ring: number[][]): Polygon => ({ type: 'Polygon', coordinates: [ring] });

describe('Malabsay Falls source-backed plan detail', () => {
  it('retains the complete mapped forest and hiking routes while adding the real waterfall selection', () => {
    expect(land.warnings).toEqual([]);
    expect(result.warnings).toEqual([]);
    for (const f of source.filter((f) => f.properties.id !== landmark.osm_id))
      expect(result.features.find((out) => out.properties.id === f.properties.id)).toEqual(f);
    const anchor = result.features.find((f) => f.properties.id === landmark.osm_id)!;
    expect(anchor.geometry).toEqual(
      source.find((f) => f.properties.id === landmark.osm_id)!.geometry,
    );
    expect(anchor.properties).toMatchObject({
      class: 'water_stream',
      kind: 'waterway=waterfall',
      landmark_id: landmark.id,
    });
    const entry = searchEntries(result.features, [], content).find(
      (e) => e.id === landmark.osm_id,
    )!;
    expect(entry).toMatchObject({
      type: 'landmark',
      name: landmark.name.en,
      lng: 123.335767,
      lat: 13.661846,
    });
  });

  it('links visible water and rock to sourced facts even without the anchor tile', () => {
    const parts = result.features.filter((f) =>
      f.properties.id.startsWith('detail:malabsay-falls/'),
    );
    expect(parts.some((f) => f.properties.class === 'water_area')).toBe(true);
    expect(parts.some((f) => f.properties.class === 'building_part')).toBe(true);
    for (const part of parts) {
      expect(part.properties.detail_parent).toBe(landmark.osm_id);
      expect(parseDetailSelection(part.properties.detail_selection)).toMatchObject({
        id: landmark.osm_id,
        landmarkId: landmark.id,
        name: landmark.name.en,
        kind: 'waterway=waterfall',
      });
      if (part.properties.class === 'water_area')
        expect(part.properties.kind).not.toBe('leisure=swimming_pool');
    }
    expect(landmark.facts?.every((fact) => landmark.sources[fact.source]?.url)).toBe(true);
    expect(landmark.start_year).toBeUndefined();
    expect(landmark.facts?.every((fact) => fact.year === undefined)).toBe(true);
  });

  it('keeps natural surfaces out of complete mapped walking widths and the vegetation out of water', () => {
    const routes = mappedFootprints(source, { paths: true, water: true });
    const water = detail.structures
      .filter((part) => part.material === 'water')
      .map((part) => shape(part.ring));
    for (const part of detail.structures) {
      expect(audit.contains(shape(part.ring)), part.id).toBe(true);
      audit.clear(shape(part.ring), routes, part.id);
      if (part.material !== 'water') audit.clear(shape(part.ring), water, part.id);
    }
    for (const patch of cover.areas) {
      expect(audit.contains(shape(patch.ring))).toBe(true);
      audit.clear(shape(patch.ring), [...routes, ...water], patch.cover);
    }
    expect(cover.trees).toEqual([]);
    expect(detail.walks).toEqual([]);
    expect(detail.seating).toEqual([]);
    expect(detail.lamps).toEqual([]);
    expect(detail.structures.some((p) => p.material === 'paving')).toBe(false);
    expect(detail.status).toBe('draft');
    expect(
      detail.sources.some((s) => s.note?.includes('bearing') && s.note.includes('estimates')),
    ).toBe(true);
  });
});
