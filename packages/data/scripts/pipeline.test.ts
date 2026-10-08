import { detailLayoutKey } from '@atlas/shared/detail-layout';
import { mkdtemp, rm, appendFile, mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentBundle } from '@atlas/content';
import {
  CityProcessions,
  Procession,
  SiteDetail,
  OSM_ATTRIBUTION,
  type City,
  type CityArt,
  type LngLat,
} from '@atlas/shared';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { step as convert, type Geography } from './02-convert';
import { step as normalize, type AtlasFeature } from './03-normalize';
import { checkTourCameras, checkTours, step as mergeContent } from './04-merge-content';
import { buildMeta, writeMetadata, tileRecords, step as tileStep } from './05-tiles';
import { step as searchStep } from './06-search-index';
import { step as processionStep } from './07-processions';
import { readFeatures, readJson, writeFeatures, writeJson } from './lib/io';
import {
  Territory,
  bboxPolygon,
  createTerritory,
  geometryOutsideVoid,
  inTerritory,
} from './lib/territory';
import { roofTileRecords } from './lib/roof-tiles';
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
  it('writes normal-step metadata without touching an existing archive', async () => {
    await mkdir(ctx.outDir, { recursive: true });
    const archive = join(ctx.outDir, `${city.slug}.pmtiles`);
    await writeFile(archive, 'archive sentinel');
    const creditedContent: ContentBundle = {
      ...content,
      plans: content.plans.map((plan) => ({ ...plan, credit: 'Fixture plan survey' })),
      details: [
        SiteDetail.parse({
          id: 'detail/fixture-credits',
          osm_id: 'osm:way/105',
          title: 'Fixture plaza',
          surface: 'paving',
          status: 'draft',
          credit: 'Fixture detail survey',
          sources: [{ title: 'Fixture detail survey' }],
        }),
      ],
      processions: [
        {
          id: 'procession/fixture-mass',
          title: { en: 'Fixture Mass' },
          story: { en: 'Illustrative fixture event.' },
          kind: 'mass',
          status: 'draft',
          site: 'osm:way/105',
          grounds: ['osm:way/105'],
          radius_m: 100,
          schedule: {
            month: 9,
            weekday: 6,
            nth: 3,
            offset_days: 0,
            start: '18:00',
            duration_min: 60,
            timezone: 'Asia/Manila',
          },
          sources: [{ title: 'Fixture festival account', url: 'https://example.test/festival' }],
        },
      ],
    };
    const creditedContext = { ...ctx, content: creditedContent };
    const metadata = await writeMetadata(creditedContext, 2026);
    expect(metadata).toMatchObject({ slug: 'fixture', yearRange: [1890, 2026] });
    expect(metadata.attribution).toEqual([
      OSM_ATTRIBUTION,
      'Fixture imagery',
      'Fixture detail survey',
      'Fixture plan survey',
    ]);
    expect(await readJson(join(ctx.outDir, `${city.slug}.meta.json`))).toEqual(metadata);
    await processionStep.run(creditedContext);
    const events = CityProcessions.parse(
      await readJson(join(ctx.outDir, `${city.slug}.processions.json`)),
    );
    expect(events.processions[0]?.sources).toEqual([
      { title: 'Fixture festival account', url: 'https://example.test/festival' },
    ]);
    expect(await readFile(archive, 'utf8')).toBe('archive sentinel');
  });
  it('derives metadata years from territory survivors instead of excluded older features', async () => {
    const buildDir = await mkdtemp(join(tmpdir(), 'atlas-metadata-territory-'));
    const local = { ...ctx, buildDir, outDir: join(buildDir, 'out') };
    try {
      await copyFile(join(ctx.buildDir, files.geography), join(buildDir, files.geography));
      await writeJson(
        join(buildDir, files.territory),
        createTerritory(
          [-0.1, -0.1, 0.1, 0.1],
          bboxPolygon([0, 0, 0.01, 0.01]),
          [-0.005, -0.005, 0.005, 0.005],
        ),
      );
      const records: AtlasFeature[] = [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-0.05, 0.005] },
          properties: { id: 'void', class: 'monument', start_year: 1800 },
          tippecanoe: { layer: 'poi', minzoom: 13, maxzoom: 16 },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0.005, 0.005] },
          properties: { id: 'survivor', class: 'monument', start_year: 1950 },
          tippecanoe: { layer: 'poi', minzoom: 13, maxzoom: 16 },
        },
      ];
      await writeFeatures(join(buildDir, files.merged), records);
      expect((await writeMetadata(local, 2026)).yearRange).toEqual([1950, 2026]);
    } finally {
      await rm(buildDir, { recursive: true, force: true });
    }
  });
  it('reports shortened routing before rejecting emitted procession geography', async () => {
    const buildDir = await mkdtemp(join(tmpdir(), 'atlas-procession-warning-'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = Procession.parse({
      id: 'procession/short',
      title: { en: 'Short' },
      story: { en: 'Synthetic' },
      status: 'draft',
      kind: 'fluvial',
      route: { to: 'osm:node/1', upstream_m: 200 },
      schedule: {
        month: 9,
        weekday: 6,
        nth: 3,
        offset_days: 0,
        start: '12:00',
        duration_min: 60,
        timezone: 'Etc/UTC',
      },
    });
    try {
      await writeFeatures(join(buildDir, files.merged), [
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [0.001, 0],
            ],
          },
          properties: { id: 'river', class: 'water_river' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0.001, 0] },
          properties: { id: 'osm:node/1', class: 'poi' },
        },
      ]);
      await writeJson(
        join(buildDir, files.territory),
        createTerritory(
          [0, -0.0001, 0.001, 0.0001],
          bboxPolygon([0.0005, -0.0001, 0.001, 0.0001]),
          [0.0008, -0.0001, 0.001, 0.0001],
        ),
      );
      await expect(
        processionStep.run({
          ...ctx,
          buildDir,
          outDir: join(buildDir, 'out'),
          content: { ...content, processions: [event] },
        }),
      ).rejects.toThrow('emitted geography crosses the territory void');
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('warning:'));
    } finally {
      warning.mockRestore();
      await rm(buildDir, { recursive: true, force: true });
    }
  });
  it('checks tour cameras before enrichment and selections after generated survivors', async () => {
    const buildDir = await mkdtemp(join(tmpdir(), 'atlas-tour-territory-'));
    const local = { ...ctx, buildDir, outDir: join(buildDir, 'out') };
    const territory = createTerritory(
      [-0.1, -0.1, 0.1, 0.1],
      bboxPolygon([0, 0, 0.01, 0.01]),
      [-0.005, -0.005, 0.005, 0.005],
    );
    const tour = (select: string, lng = 0.005): ContentBundle['tours'][number] => ({
      id: 'tour/survivors',
      title: { en: 'Survivors' },
      status: 'draft',
      steps: [
        {
          camera: { lng, lat: 0.005, zoom: 16 },
          select,
          duration_ms: 4000,
          narration: { en: 'Fixture' },
        },
      ],
    });
    try {
      await Promise.all(
        [files.normalized, files.geography, files.subdivisions].map((file) =>
          copyFile(join(ctx.buildDir, file), join(buildDir, file)),
        ),
      );
      await writeJson(join(buildDir, files.territory), territory);
      const normalized: AtlasFeature[] = [];
      for await (const f of readFeatures(join(buildDir, files.normalized)))
        normalized.push(f as AtlasFeature);
      normalized.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-0.05, 0.005] },
        properties: { id: 'removed', class: 'monument' },
        tippecanoe: { layer: 'poi', minzoom: 17, maxzoom: 16 },
      });
      await writeFeatures(join(buildDir, files.normalized), normalized);
      await expect(
        mergeContent.run({
          ...local,
          content: {
            ...content,
            landmarks: [{ ...content.landmarks[0]!, osm_id: 'missing' }],
            tours: [tour('missing', -0.05)],
          },
        }),
      ).rejects.toThrow('outside the territory');
      await mergeContent.run({
        ...local,
        content: { ...content, tours: [tour('plan:fixture-statue/1')] },
      });
      const ids: string[] = [];
      for await (const f of readFeatures(join(buildDir, files.merged)))
        ids.push((f as AtlasFeature).properties.id);
      expect(ids).toContain('plan:fixture-statue/1');
      await expect(
        mergeContent.run({ ...local, content: { ...content, tours: [tour('removed')] } }),
      ).rejects.toThrow('removed is not in the data');
    } finally {
      await rm(buildDir, { recursive: true, force: true });
    }
  });
  it('keeps diagonal-cut streets searchable with and without repaired display labels', async () => {
    const buildDir = await mkdtemp(join(tmpdir(), 'atlas-search-edge-'));
    const boundary: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [0, 2.0000008],
          [0, 0],
        ],
      ],
    };
    const territory = createTerritory([0, 0, 2, 3], boundary, [0, 0, 0.1, 0.1]);
    const local = { ...ctx, buildDir, outDir: join(buildDir, 'out') };
    try {
      await writeJson(join(buildDir, files.geography), { regionBounds: territory.regionBounds });
      await writeJson(join(buildDir, files.territory), territory);
      await writeJson(join(buildDir, files.subdivisions), []);
      for (const repaired of [false, true]) {
        const road: AtlasFeature = {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [0.5, 1],
              [0.5, 2.5],
            ],
          },
          properties: {
            id: 'osm:way/edge',
            class: 'road_minor',
            name: 'Edge Street',
            ...(repaired && { label_lng: 0.5, label_lat: 2.5 }),
          },
          tippecanoe: { layer: 'roads', minzoom: 13, maxzoom: 16 },
        };
        expect(tileRecords([road], territory)).not.toHaveLength(0);
        await writeFeatures(join(buildDir, files.merged), [road]);
        await searchStep.run(local);
        const search = await readJson<{ entries: { lng: number; lat: number; name: string }[] }>(
          join(local.outDir, 'fixture.search-index.json'),
        );
        expect(search.entries).toHaveLength(1);
        expect(search.entries[0]!.name).toBe('Edge Street');
        expect(inTerritory(search.entries[0]!.lng, search.entries[0]!.lat, territory)).toBe(true);
        expect(inTerritory(0.5, 1.500001, territory)).toBe(false);
      }
    } finally {
      await rm(buildDir, { recursive: true, force: true });
    }
  });
  it('publishes the opted-in territory only after full-source merging, with identical flagless behavior', async () => {
    for (const enabled of [false, true]) {
      const buildDir = await mkdtemp(join(tmpdir(), 'atlas-extent-'));
      const local: StepContext = {
        ...ctx,
        content: { ...content, landmarks: [], plans: [], landcover: [], art: [] },
        buildDir,
        outDir: join(buildDir, 'out'),
        city: {
          ...city,
          region: {
            bbox: [-0.005, -0.005, 0.005, 0.005],
            ...(enabled && { include_boundary: true as const }),
          },
        },
      };
      try {
        await convert.run(local);
        const converted = await readJson<FeatureCollection>(join(buildDir, files.osm));
        const extra: Feature[] = [
          {
            type: 'Feature',
            id: 'way/extension',
            properties: { highway: 'residential', name: 'Extension' },
            geometry: {
              type: 'LineString',
              coordinates: [
                [-0.004, 0.004],
                [-0.004, 0.008],
                [0.008, 0.008],
              ],
            },
          },
          {
            type: 'Feature',
            id: 'way/roof-edge',
            properties: { building: 'yes', height: '6' },
            geometry: bboxPolygon([-0.002, 0.007, 0.002, 0.009]),
          },
          {
            type: 'Feature',
            id: 'node/void',
            properties: { amenity: 'bench' },
            geometry: { type: 'Point', coordinates: [-0.004, 0.008] },
          },
          {
            type: 'Feature',
            id: 'way/downtown',
            properties: { highway: 'residential' },
            geometry: {
              type: 'LineString',
              coordinates: [
                [-0.006, 0.002],
                [-0.001, 0.002],
              ],
            },
          },
        ];
        await writeJson(join(buildDir, files.osm), {
          ...converted,
          features: [...converted.features, ...extra],
        });
        await normalize.run(local);
        if (enabled)
          await expect(
            mergeContent.run({
              ...local,
              city: {
                ...local.city,
                life: {
                  source: 'Fixture source',
                  sites: [
                    {
                      id: 'void',
                      kind: 'shelter',
                      position: [-0.004, 0.008],
                      source: 'Fixture source',
                    },
                  ],
                },
              },
            }),
          ).rejects.toThrow('outside the territory');
        await mergeContent.run(local);
        await searchStep.run(local);
        const t = Territory.parse(await readJson(join(buildDir, files.territory)));
        const merged: AtlasFeature[] = [];
        for await (const f of readFeatures(join(buildDir, files.merged)))
          merged.push(f as AtlasFeature);
        const tiled = tileRecords(merged, t);
        const road = merged.find((f) => f.properties.id === 'osm:way/extension')!;
        expect(road.geometry).toEqual(extra[0]!.geometry);
        const downtown = merged.find((f) => f.properties.id === 'osm:way/downtown')!;
        expect(tiled.find((f) => f.properties.id === downtown.properties.id)!.geometry).toBe(
          downtown.geometry,
        );
        const search = await readJson<{ entries: { lng: number; lat: number; name: string }[] }>(
          join(local.outDir, 'fixture.search-index.json'),
        );
        expect(search.entries.every((e) => inTerritory(e.lng, e.lat, t))).toBe(true);
        if (enabled) {
          expect(t.regionBounds).toEqual([-0.005, -0.005, 0.01, 0.01]);
          expect(tiled.every((f) => geometryOutsideVoid(f.geometry, t))).toBe(true);
          expect(tiled.some((f) => f.properties.id === 'osm:node/void')).toBe(false);
          expect(merged.find((f) => f.properties.id === 'osm:way/roof-edge')!.geometry).toEqual(
            extra[1]!.geometry,
          );
          expect(search.entries.some((e) => e.name === 'Extension')).toBe(true);
        } else {
          expect(t.territory).toBeNull();
          expect(t.void).toBeNull();
          expect(t.regionBounds).toEqual([-0.005, -0.005, 0.005, 0.005]);
          expect(tiled).toEqual(merged.flatMap(roofTileRecords));
        }
      } finally {
        await rm(buildDir, { recursive: true, force: true });
      }
    }
  });
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
    expect(
      checkTourCameras([tour], {
        regionBounds: [-0.1, -0.1, 0.1, 0.1],
        territory: null,
        void: null,
      }),
    ).toEqual(['tour/fixture step 2: camera 5, 0.005 is outside the region']);
    expect(checkTours(features, [tour])).toEqual([
      'tour/fixture step 2: osm:way/999999 is not in the data',
    ]);
  });
});
