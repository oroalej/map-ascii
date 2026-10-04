import { detailLayoutKey } from '@atlas/shared/detail-layout';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentBundle } from '@atlas/content';
import { SiteDetail, OSM_ATTRIBUTION, type City, type CityArt, type LngLat } from '@atlas/shared';
import type { Polygon } from 'geojson';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { step as convert, type Geography } from './02-convert';
import { step as normalize, type AtlasFeature } from './03-normalize';
import { checkTours, step as mergeContent } from './04-merge-content';
import { buildMeta, step as tileStep } from './05-tiles';
import { readFeatures, readJson } from './lib/io';
import { publishDetailLayouts, readDetailLayouts, writeDetailLayouts } from './lib/detail-layout';
import { files, type StepContext } from './step';

// A fixture city that is not tied to any real place (ARCHITECTURE.md §9).
const city: City = {
  slug: 'fixture',
  name: { en: 'Fixture City' },
  country: 'XX',
  boundary: { name: 'Fixture City', admin_level: 6 },
  detail_buffer_km: 1,
  region: { bbox: [-0.1, -0.1, 0.1, 0.1] },
  subdivision: { admin_level: 10, label: { en: 'ward' } },
  languages: [],
  smoke_landmark: 'Fixture Plaza',
  focus: { osm_id: 'osm:way/105', zoom: 16 },
};

const content: ContentBundle = {
  landmarks: [
    {
      id: 'landmark/fixture-plaza',
      osm_id: 'osm:way/105',
      name: { en: 'Fixture Plaza' },
      type: 'plaza',
      start_year: 1890,
      certainty: 'circa',
      sources: [{ title: 'Fixture source' }],
    },
  ],
  events: [],
  'name-history': [],
  tours: [],
  plans: [
    {
      id: 'plan/fixture-statue',
      osm_id: 'osm:node/90',
      title: 'Fixture Statue base',
      parts: [{ kind: 'tier', shape: 'circle', size_m: 6, height_m: 1, offset_m: [0, 0] }],
      status: 'draft',
      sources: [{ title: 'Fixture source' }],
    },
  ],
  landcover: [
    {
      id: 'landcover/fixture-grounds',
      title: 'Fixture grounds',
      trees: [{ at: [0.004, 0.004], crown_m: 10 }],
      tree_overrides: [],
      rows: [],
      areas: [],
      status: 'draft',
      credit: 'Fixture imagery',
      sources: [{ title: 'Fixture imagery' }],
    },
  ],
  art: [
    {
      id: 'art/fixture-statue',
      osm_id: 'osm:node/90',
      title: 'Fixture Statue',
      footprint_m: 4,
      variants: [{ rows: [' o ', '▐█▌'], colors: ['   ', '   '] }],
      palette: { w: 'wall' },
      status: 'draft',
      sources: [{ title: 'Fixture source' }],
    },
  ],
  processions: [],
  details: [],
  cemeteries: [],
};

let ctx: StepContext;
let features: AtlasFeature[];

beforeAll(async () => {
  const buildDir = await mkdtemp(join(tmpdir(), 'atlas-pipeline-'));
  ctx = {
    city,
    content,
    rawDir: fileURLToPath(new URL('./__fixtures__/raw/', import.meta.url)),
    buildDir,
    outDir: join(buildDir, 'out'),
    offline: true,
    refresh: false,
  };
  for (const step of [convert, normalize, mergeContent]) await step.run(ctx);
  features = [];
  for await (const f of readFeatures(join(ctx.buildDir, files.merged))) {
    features.push(f as AtlasFeature);
  }
});

afterAll(async () => {
  await rm(ctx.buildDir, { recursive: true, force: true });
});

describe('pipeline (02–04) on the fixture extract', () => {
  it('writes aliases using the canonical parent final surface class', async () => {
    const parent = features.find((f) => f.properties.id === 'osm:way/105')!;
    const detail = SiteDetail.parse({
      id: 'detail/finalized',
      osm_id: parent.properties.id,
      selection_osm_id: parent.properties.id,
      title: 'Fixture court',
      surface: 'paving',
      structures: [
        {
          id: 'terrace',
          ring: (parent.geometry as Polygon).coordinates[0] as LngLat[],
          height_m: 0.15,
          material: 'paving',
          overhead: false,
        },
      ],
      status: 'draft',
      credit: 'Fixture survey',
      sources: [{ title: 'Fixture survey' }],
    });
    try {
      await mergeContent.run({ ...ctx, content: { ...content, details: [detail] } });
      let aliases = 0;
      for await (const feature of readFeatures(join(ctx.buildDir, files.merged))) {
        const p = (feature as AtlasFeature).properties;
        if (p.id === 'detail:finalized/structure-terrace') {
          aliases++;
          expect(JSON.parse(p.detail_selection!)).toMatchObject({
            id: parent.properties.id,
            class: 'paving',
          });
        }
      }
      expect(aliases).toBe(1);
    } finally {
      await mergeContent.run(ctx);
    }
  });
  it('classifies features into layers and drops unmapped ones', () => {
    const summary = features
      .map((f) => [f.properties.id, f.properties.class, f.tippecanoe.layer])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    expect(summary).toEqual([
      ['cover:fixture-grounds/tree-1', 'tree', 'poi'],
      ['osm:node/19', 'place_label', 'labels'],
      ['osm:node/24', 'building_station', 'poi'],
      ['osm:node/90', 'monument', 'poi'],
      ['osm:relation/200', 'admin_city', 'admin'],
      ['osm:relation/201', 'admin_subdivision', 'admin'],
      ['osm:way/101', 'road_major', 'roads'],
      ['osm:way/102', 'road_minor', 'roads'],
      ['osm:way/104', 'building_religious', 'buildings'],
      ['osm:way/105', 'park', 'landuse'],
      ['osm:way/106', 'water_river', 'water'],
      ['osm:way/109', 'rail', 'roads'],
      ['plan:fixture-statue/1', 'building_part', 'buildings'],
    ]);
  });

  it('writes heights, dates, and subdivisions', () => {
    const byId = new Map(features.map((f) => [f.properties.id, f.properties]));
    expect(byId.get('osm:way/104')).toMatchObject({
      name: 'Fixture Church',
      height: 12,
      subdivision: 'West Ward',
    });
    expect(byId.get('osm:way/102')).toMatchObject({ start_year: 1950, certainty: 'circa' });
    expect(byId.get('osm:way/102')).not.toHaveProperty('subdivision');
    expect(byId.get('osm:node/19')).toMatchObject({ subdivision: 'West Ward' });
  });

  it('joins landmarks, with curated names and dates winning', () => {
    const plaza = features.find((f) => f.properties.id === 'osm:way/105')!.properties;
    expect(plaza).toMatchObject({
      landmark: true,
      landmark_id: 'landmark/fixture-plaza',
      name: 'Fixture Plaza',
      start_year: 1890,
      certainty: 'circa',
    });
  });

  it('gives roads a carriageway width, and nothing else one', () => {
    const byId = new Map(features.map((f) => [f.properties.id, f.properties]));
    expect(byId.get('osm:way/101')?.width).toEqual(expect.any(Number));
    expect(byId.get('osm:way/102')?.width).toEqual(expect.any(Number));
    expect(byId.get('osm:way/104')).not.toHaveProperty('width');
  });

  it('anchors labels for named landmarks and monuments only', () => {
    const byId = new Map(features.map((f) => [f.properties.id, f.properties]));
    expect(byId.get('osm:node/90')).toMatchObject({ label_lng: 0.0035, label_lat: 0.0065 });
    const plaza = byId.get('osm:way/105')!;
    expect(plaza.label_lng).toEqual(expect.any(Number));
    expect(plaza.label_lat).toEqual(expect.any(Number));
    expect(byId.get('osm:way/104')).not.toHaveProperty('label_lng');
  });

  it('writes the city landmark art, placed on its features', async () => {
    const art = await readJson<CityArt>(join(ctx.outDir, 'fixture.art.json'));
    expect(art.pieces).toHaveLength(1);
    const [statue] = art.pieces;
    expect(statue).toMatchObject({ id: 'art/fixture-statue', anchor: [0.0035, 0.0065] });
    const [w, s, e, n] = statue!.bbox;
    expect(w).toBeLessThan(0.0035);
    expect(e).toBeGreaterThan(0.0035);
    expect((n - s) * 111_320).toBeCloseTo(4, 1);
  });

  it('derives bounds and the default camera from OSM and the focus feature', async () => {
    const geography = await readJson<Geography>(join(ctx.buildDir, files.geography));
    expect(geography.bounds).toEqual([0, 0, 0.01, 0.01]);
    const meta = buildMeta(city, geography, [1890, 2026]);
    expect(meta.regionBounds).toEqual([-0.1, -0.1, 0.1, 0.1]);
    expect(meta.defaultCamera.lat).toBeCloseTo(0.007, 6);
    expect(meta.defaultCamera.lng).toBeCloseTo(0.007, 6);
    expect(Object.keys(meta.defaultCamera).sort()).toEqual(['lat', 'lng', 'zoom']);
    expect(meta.defaultCamera.zoom).toBe(16);
    const credited = buildMeta(
      city,
      { ...geography, attribution: ['DEM'] },
      [1890, 2026],
      ['Imagery', 'DEM'],
    );
    expect(credited.attribution).toEqual([OSM_ATTRIBUTION, 'DEM', 'Imagery']);
    const normalized = buildMeta(
      city,
      geography,
      [1890, 2026],
      [
        'Survey. Geometry: © OpenStreetMap contributors (ODbL). Draft, undated estimates.',
        'Survey. Draft, undated estimates.',
        '© OpenStreetMap contributors',
        'Imagery © Provider; CC BY-SA 3.0, Contributor (https://example.test/source).',
        'Unfamiliar source format.',
      ],
    );
    expect(normalized.attribution).toEqual([
      OSM_ATTRIBUTION,
      'Survey. Draft, undated estimates.',
      'Imagery © Provider; CC BY-SA 3.0, Contributor (https://example.test/source).',
      'Unfamiliar source format.',
    ]);
  });

  it('publishes validated detail fingerprints separately from startup metadata', async () => {
    const geography = await readJson<Geography>(join(ctx.buildDir, files.geography));
    const detail = SiteDetail.parse({
      id: 'detail/fixture',
      osm_id: 'osm:way/105',
      title: 'Fixture plaza',
      surface: 'paving',
      status: 'draft',
      credit: 'Fixture survey',
      sources: [{ title: 'Fixture survey' }],
    });
    expect(buildMeta(city, geography, [1890, 2026])).not.toHaveProperty('detail_layouts');
    const layouts = { [detail.id]: detailLayoutKey(detail) };
    await publishDetailLayouts(ctx, layouts);
    const output = join(ctx.outDir, `${city.slug}.detail-layouts.json`);
    expect(await readJson(output)).toEqual(layouts);
    await expect(publishDetailLayouts(ctx, { [detail.id]: 'invalid' })).rejects.toThrow();
    expect(await readJson(output)).toEqual(layouts);
  });

  it('rejects changed-pack step-05 inputs before invoking the tile compiler', async () => {
    expect(await readDetailLayouts(ctx)).toEqual({});
    const detail = SiteDetail.parse({
      id: 'detail/fixture',
      osm_id: 'osm:way/105',
      title: 'Fixture plaza',
      surface: 'paving',
      status: 'draft',
      credit: 'Fixture survey',
      sources: [{ title: 'Fixture survey' }],
    });
    const changed = { ...ctx, content: { ...content, details: [detail] } };
    await expect(tileStep.run(changed)).rejects.toThrow('rerun from step 04');
    await mergeContent.run(changed);
    expect(await readDetailLayouts(changed)).toEqual({ [detail.id]: detailLayoutKey(detail) });
    await mergeContent.run(ctx);
  });

  it('rejects changed merge bytes even when the city pack is unchanged', async () => {
    await appendFile(join(ctx.buildDir, files.merged), '\n');
    await expect(readDetailLayouts(ctx)).rejects.toThrow('rerun from step 04');
    await writeDetailLayouts(ctx);
    expect(await readDetailLayouts(ctx)).toEqual({});
  });

  it('checks that tours point at features in the data and stay in the region', () => {
    const step = (camera: { lat: number; lng: number }, extra = {}) => ({
      camera: { ...camera, zoom: 16 },
      duration_ms: 4000,
      narration: { en: 'TODO(verify)' },
      ...extra,
    });
    const tour = {
      id: 'tour/fixture',
      title: { en: 'Fixture tour' },
      status: 'draft' as const,
      steps: [
        step({ lat: 0.005, lng: 0.005 }, { select: 'osm:way/104' }),
        step({ lat: 5, lng: 0.005 }, { highlight: ['osm:way/104', 'osm:way/999999'] }),
      ],
    };
    expect(checkTours(features, [tour], [-0.1, -0.1, 0.1, 0.1])).toEqual([
      'tour/fixture step 2: camera 5, 0.005 is outside the region',
      'tour/fixture step 2: osm:way/999999 is not in the data',
    ]);
  });
});
