import bbox from '@turf/bbox';
import inside from '@turf/boolean-point-in-polygon';
import { Landcover, SiteDetail, type BBox, type LngLat } from '@atlas/shared';
import type { Polygon, MultiPolygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { bboxesOverlap } from './geo';
import { geometryAudit, polygonComponents } from './geometry-audit';
import { landcoverFeatures } from './landcover';
import {
  areaFor,
  assertPointClear,
  distanceMeters,
  lineDistance,
  mappedFootprints,
  pointObstacles,
  readFixture,
  readPack,
} from './landmark-detail.geometry';
import { isStandingBuilding, nearbyRoadFootprints } from './obstacles';
import { mergeSiteDetails, seatingFootprint } from './site-detail';
import fieldsMask from '../__fixtures__/fields-exclusions.json';
import imageCoverage from '../__fixtures__/east-school-image-coverage.json';

// Disk-read packs and the upstream field exclusion mask are targeted-test inputs.
const detailModules = import.meta.glob('../../../content/cities/naga/details/*.json');
const coverModules = import.meta.glob('../../../content/cities/naga/landcover/*.json');
const fieldModules = import.meta.glob('../../../content/cities/naga/landcover/east-*-fields.json', {
  eager: true,
  import: 'default',
});
const sites = [
  ['villa-grande-homes-elementary-school', 'osm:way/881073805'],
  ['concepcion-grande-elementary-school', 'osm:way/881073797'],
  ['san-rafael-elementary-school', 'osm:way/1395443846'],
  ['villa-corazon-elementary-school', 'osm:way/881094775'],
  ['pacol-elementary-school', 'osm:way/312531363'],
  ['ateneo-pacol', 'osm:way/871497903'],
  ['naga-city-sports-complex', 'osm:way/1208006588'],
  ['leon-q-mercado-high-school', 'osm:way/780476088'],
  ['teodora-moscoso-elementary-school', 'osm:way/1395444073'],
  ['del-rosario-elementary-school', 'osm:way/729766923'],
  ['del-rosario-high-school', 'osm:way/885899787'],
  ['cararayan-national-high-school', 'osm:way/881097068'],
  ['don-manuel-i-abella-central-school', 'osm:way/730948736'],
  ['san-isidro-national-high-school', 'osm:relation/14210960'],
  ['san-isidro-elementary-school', 'osm:relation/14210961'],
  ['carolina-elementary-school', 'osm:way/833125856'],
  ['carolina-national-high-school', 'osm:way/881084574'],
] as const;
const omissions = [
  {
    slug: 'american-school-of-english-math-and-science',
    parents: ['osm:node/644622000'],
    reason: 'No supplied image; a point anchor does not establish the campus grounds.',
  },
  {
    slug: 'grand-view-elementary-school',
    parents: ['osm:way/780476076'],
    reason: 'No supplied image establishes the outdoor surfaces or canopy layout.',
  },
  {
    slug: 'morada-ramos-elementary-school',
    parents: ['osm:way/1395444066'],
    reason: 'No supplied image; unsupported outdoor landscaping is omitted.',
  },
  {
    slug: 'don-bosco-training-center-of-naga',
    parents: ['osm:way/833125855'],
    reason: 'The adjoining Carolina Elementary image does not establish this campus layout.',
  },
  {
    slug: 'naga-view-adventist-college',
    parents: ['osm:node/13048818362', 'osm:node/13048818363'],
    reason: 'No supplied image establishes a grounds ring around the two point anchors.',
  },
  {
    slug: 'panicuason-elementary-school',
    parents: ['osm:way/881087491'],
    reason: 'No supplied image; unsupported outdoor detail is omitted.',
  },
];
const source = readFixture('east-school-parents.json') as AtlasFeature[];
const details = sites.map(([slug]) => SiteDetail.parse(readPack('details', slug)));
const covers = sites.map(([slug]) => Landcover.parse(readPack('landcover', slug)));
type Area = Polygon | MultiPolygon;
const territory = fieldsMask.territory as Area;
const farmland = Object.values(fieldModules)
  .flatMap((pack) => Landcover.parse(pack).areas)
  .map((patch) => {
    const geometry: Polygon = { type: 'Polygon', coordinates: [patch.ring] };
    return { geometry, bounds: bbox(geometry) as BBox };
  });
const mappedPitches = source
  .filter((f) => f.properties.class === 'pitch')
  .map((f) => f.geometry as Area);
const mappedTrees = source.filter(
  (f) => f.properties.class === 'tree' && f.geometry.type === 'Point',
);
const obstacles = pointObstacles(source, { paths: true, water: true });
const edgeDistance = (at: LngLat, area: Area) =>
  inside(at, area)
    ? 0
    : Math.min(
        ...polygonComponents(area).flatMap((p) => p.coordinates.map((r) => lineDistance(at, r))),
      );
const boundaryDistance = (at: LngLat, area: Area) =>
  Math.min(
    ...polygonComponents(area).flatMap((p) => p.coordinates.map((r) => lineDistance(at, r))),
  );

describe('eastern school grounds from the owner references', () => {
  it('covers 17 distinct parents and explicitly preserves the six unsupported sites', () => {
    expect(sites.length + omissions.length).toBe(23);
    expect(new Set(details.map((d) => d.osm_id)).size).toBe(17);
    for (const [i, [slug, parent]] of sites.entries()) {
      const detail = details[i]!;
      const cover = covers[i]!;
      expect(detail.id).toBe(`detail/${slug}`);
      expect(detail.osm_id).toBe(parent);
      expect(cover.id).toBe(`landcover/${slug}`);
      expect(source.some((f) => f.properties.id === parent)).toBe(true);
      expect(detail.surface).toBe('keep');
      for (const pack of [detail, cover]) {
        expect(pack.status).toBe('draft');
        expect(pack.credit).toBe(
          'Google Maps satellite reference, capture date unknown; draft geographic estimates. Geometry: © OpenStreetMap contributors (ODbL).',
        );
        expect(
          pack.sources.some((s) => s.url === `https://www.openstreetmap.org/${parent.slice(4)}`),
        ).toBe(true);
        expect(
          pack.sources.some(
            (s) =>
              s.url?.includes('google.com/maps') &&
              s.note?.includes('owner-supplied') &&
              s.note.includes('2026-10-08'),
          ),
        ).toBe(true);
      }
    }
    for (const omission of omissions) {
      expect(omission.reason.length).toBeGreaterThan(30);
      for (const modules of [detailModules, coverModules])
        expect(Object.keys(modules).some((path) => path.endsWith(`/${omission.slug}.json`))).toBe(
          false,
        );
      for (const parent of omission.parents)
        expect(source.some((f) => f.properties.id === parent)).toBe(true);
    }
  });

  it('merges all campuses together without changing complete source obstacles or omitted parents', () => {
    const coverResult = landcoverFeatures(source, covers);
    expect(coverResult.warnings).toEqual([]);
    const result = mergeSiteDetails([...structuredClone(source), ...coverResult.features], details);
    expect(result.warnings).toEqual([]);
    const output = new Map(result.features.map((f) => [f.properties.id, f]));
    for (const original of source)
      expect(output.get(original.properties.id)!.geometry).toEqual(original.geometry);
    for (const omission of omissions)
      for (const parent of omission.parents)
        expect(output.get(parent)).toEqual(source.find((f) => f.properties.id === parent));
  });

  for (const [i, [slug]] of sites.entries()) {
    const detail = details[i]!;
    const cover = covers[i]!;
    const area = areaFor(detail, source);
    const audit = geometryAudit(area);
    const bounds = bbox(area) as BBox;
    const footprints = [
      ...mappedFootprints(source, { paths: true, water: true, bounds }),
      ...mappedPitches,
    ];
    const fields = farmland.filter((f) => bboxesOverlap(bounds, f.bounds));
    const ground = [
      ...cover.areas.map((p): Area => ({ type: 'Polygon', coordinates: [p.ring] })),
      ...detail.structures.map((p): Area => ({
        type: 'Polygon',
        coordinates: [p.ring, ...(p.holes ?? [])],
      })),
    ];
    it(`${slug}: keeps ground surfaces and trunks clear of complete mapped geometry, territory and farmland`, () => {
      expect(cover.areas.every((p) => p.cover !== 'woods')).toBe(true);
      const territoryAudit = geometryAudit(territory);
      for (const [index, shape] of ground.entries()) {
        expect(audit.contains(shape)).toBe(true);
        expect(territoryAudit.contains(shape)).toBe(true);
        for (const obstacle of footprints)
          expect(
            audit.overlaps(shape, obstacle),
            `${slug} surface ${index} / ${source.find((f) => f.geometry === obstacle)?.properties.id ?? bbox(obstacle).join(',')}`,
          ).toBe(false);
        for (const field of fields) expect(audit.overlaps(shape, field.geometry)).toBe(false);
      }
      for (const tree of cover.trees) {
        expect(inside(tree.at, area)).toBe(true);
        expect(inside(tree.at, territory)).toBe(true);
        assertPointClear(tree.at, obstacles, slug);
        assertPointClear(tree.at, mappedPitches, slug);
        assertPointClear(
          tree.at,
          fields.map((f) => f.geometry),
          slug,
        );
        for (const mapped of mappedTrees)
          if (mapped.geometry.type === 'Point')
            expect(distanceMeters(tree.at, mapped.geometry.coordinates)).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${slug}: pairs supported paving with a complete source-clear frontage approach`, () => {
      const paving = detail.structures.filter((p) => p.material === 'paving' && p.ground_override);
      expect(paving.length).toBeGreaterThan(0);
      const surface = audit.union(
        paving.map((p) => ({ type: 'Polygon', coordinates: [p.ring, ...(p.holes ?? [])] })),
      );
      const pavingAudit = geometryAudit(surface);
      for (const walk of detail.walks)
        expect(pavingAudit.contains(seatingFootprint(walk.line, walk.width_m)), walk.id).toBe(true);
      expect(detail.walks.length).toBeGreaterThan(0);
      const approach = detail.walks.find((walk) => walk.id.startsWith('frontage-to-'));
      expect(approach).toBeDefined();
      const start = approach!.line[0]!;
      const end = approach!.line.at(-1)!;
      const roads = nearbyRoadFootprints(source, bounds);
      const frontage = Math.min(
        boundaryDistance(start, area),
        ...roads.map((road) => edgeDistance(start, road.geometry)),
      );
      expect(frontage).toBeLessThanOrEqual(2);
      const targets = source.filter((f) =>
        slug === 'naga-city-sports-complex'
          ? f.properties.class === 'pitch'
          : isStandingBuilding(f) &&
            inside(f.geometry.type === 'Polygon' ? f.geometry.coordinates[0]![0]! : [0, 0], area),
      );
      expect(
        Math.min(...targets.map((f) => edgeDistance(end, f.geometry as Area))),
      ).toBeLessThanOrEqual(2);
    });

    it(`${slug}: retains observed canopy groups and low planting without paving them over`, () => {
      const reference = imageCoverage.sites.find((s) => s.slug === slug)!;
      expect(reference).toBeDefined();
      expect(cover.trees.length).toBeGreaterThanOrEqual(reference.minimumTrees);
      for (const group of reference.canopyGroups) {
        const mask = group.geometry as Area;
        const crowns = cover.trees.filter(
          (tree) => edgeDistance(tree.at, mask) <= tree.crown_m! / 2,
        );
        expect(crowns.length, group.name).toBeGreaterThanOrEqual(group.minimumCrowns);
      }
      const planted = cover.areas.filter((p) => p.cover === 'planting' || p.cover === 'shrubs');
      if (reference.hasLowPlanting) expect(planted.length).toBeGreaterThan(0);
      else expect(reference.lowPlantingOmission.length).toBeGreaterThan(40);
      const paving = detail.structures.filter((p) => p.material === 'paving');
      for (const plant of planted) {
        const patch: Polygon = { type: 'Polygon', coordinates: [plant.ring] };
        for (const hardscape of paving)
          expect(
            audit.overlaps(patch, {
              type: 'Polygon',
              coordinates: [hardscape.ring, ...(hardscape.holes ?? [])],
            }),
          ).toBe(false);
      }
      for (const at of reference.bareYardChecks) {
        for (const patch of cover.areas.filter((p) => p.cover === 'grass'))
          expect(
            inside(at, { type: 'Polygon', coordinates: [patch.ring] }),
            'bare yard painted as lawn',
          ).toBe(false);
      }
    });
  }

  it('keeps adjoining campuses and the Ateneo/sports complex grounds separate', () => {
    for (const [a, b] of [
      ['del-rosario-elementary-school', 'del-rosario-high-school'],
      ['cararayan-national-high-school', 'don-manuel-i-abella-central-school'],
      ['san-isidro-national-high-school', 'san-isidro-elementary-school'],
      ['ateneo-pacol', 'naga-city-sports-complex'],
    ]) {
      const first = areaFor(
        details.find((d) => d.id === `detail/${a}`)!,
        source,
      );
      const second = areaFor(
        details.find((d) => d.id === `detail/${b}`)!,
        source,
      );
      expect(geometryAudit(first).overlaps(first, second), `${a} / ${b}`).toBe(false);
    }
    const carolina = areaFor(
      details.find((d) => d.id === 'detail/carolina-elementary-school')!,
      source,
    );
    const donBosco = source.find((f) => f.properties.id === 'osm:way/833125855')!.geometry as Area;
    expect(geometryAudit(carolina).overlaps(carolina, donBosco)).toBe(false);
  });
});
