import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentBundle } from '@atlas/content';
import type { City, CityArt } from '@atlas/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { step as convert, type Geography } from './02-convert';
import { step as normalize, type AtlasFeature } from './03-normalize';
import { step as mergeContent } from './04-merge-content';
import { buildMeta } from './05-tiles';
import { readFeatures, readJson } from './lib/io';
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
  it('classifies features into layers and drops unmapped ones', () => {
    const summary = features
      .map((f) => [f.properties.id, f.properties.class, f.tippecanoe.layer])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    expect(summary).toEqual([
      ['osm:node/19', 'place_label', 'labels'],
      ['osm:node/90', 'monument', 'poi'],
      ['osm:relation/200', 'admin_city', 'admin'],
      ['osm:relation/201', 'admin_subdivision', 'admin'],
      ['osm:way/101', 'road_major', 'roads'],
      ['osm:way/102', 'road_minor', 'roads'],
      ['osm:way/104', 'building_religious', 'buildings'],
      ['osm:way/105', 'park', 'landuse'],
      ['osm:way/106', 'water_river', 'water'],
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
    expect(meta.defaultCamera).toMatchObject({ zoom: 16, pitch: 0, bearing: 0 });
  });
});
