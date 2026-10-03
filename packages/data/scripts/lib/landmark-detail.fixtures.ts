import { readFileSync, readdirSync } from 'node:fs';
import { SiteDetail, Landcover, LandmarkPlan, Landmark, type LngLat } from '@atlas/shared';
import type { Polygon, MultiPolygon } from 'geojson';
import type { AtlasFeature } from '../03-normalize';
import { mergeContent } from '../04-merge-content';
import bbox from '@turf/bbox';
import { planParts } from './plan';
import { landcoverFeatures } from './landcover';
import { bboxesOverlap } from './geo';
import type { ContentBundle } from '@atlas/content';

// Declare disk-read content dependencies so every shard is selected on pack edits.
import.meta.glob('../../../content/cities/naga/{details,landcover,plans,landmarks}/*.json');

const root = new URL('../../../content/cities/naga/', import.meta.url);
const readCollection = (folder: string): unknown[] =>
  readdirSync(new URL(folder, root))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(new URL(`${folder}/${name}`, root), 'utf8')) as unknown);
export const details = readCollection('details').map((data) => SiteDetail.parse(data));
export const covers = readCollection('landcover').map((data) => Landcover.parse(data));
export const plans = readCollection('plans').map((data) => LandmarkPlan.parse(data));
const landmarks = readCollection('landmarks').map((data) => Landmark.parse(data));
const existingSource = JSON.parse(
  readFileSync(new URL('../__fixtures__/landmark-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
const campusSource = JSON.parse(
  readFileSync(new URL('../__fixtures__/seven-site-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
const additionalSource = JSON.parse(
  readFileSync(new URL('../__fixtures__/additional-site-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
const memorialSchoolSource = JSON.parse(
  readFileSync(new URL('../__fixtures__/memorial-school-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
const roadsideCampusSource = JSON.parse(
  readFileSync(new URL('../__fixtures__/roadside-campus-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
const landscapedGroundsSource = JSON.parse(
  readFileSync(new URL('../__fixtures__/five-landscaped-grounds.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
const civicGroundsSource = JSON.parse(
  readFileSync(new URL('../__fixtures__/civic-ground-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
const concepcionScienceSource = JSON.parse(
  readFileSync(new URL('../__fixtures__/concepcion-science-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
const shrineConcepcionSabangSource = JSON.parse(
  readFileSync(
    new URL('../__fixtures__/shrine-concepcion-sabang-parents.json', import.meta.url),
    'utf8',
  ),
) as AtlasFeature[];
const lccTerminalChurchSource = JSON.parse(
  readFileSync(
    new URL('../__fixtures__/lcc-terminal-church-parents.json', import.meta.url),
    'utf8',
  ),
) as AtlasFeature[];
const bridgeFloodworksSource = JSON.parse(
  readFileSync(new URL('../__fixtures__/bridge-floodworks-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
const schoolHospitalSource = JSON.parse(
  readFileSync(new URL('../__fixtures__/school-hospital-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
const sanRoqueMaboloSource = JSON.parse(
  readFileSync(new URL('../__fixtures__/san-roque-mabolo-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
const tarosananSource = JSON.parse(
  readFileSync(new URL('../__fixtures__/tarosanan-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
const balatasSchoolSource = JSON.parse(
  readFileSync(new URL('../__fixtures__/balatas-school-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
const tacolodHospitalSource = JSON.parse(
  readFileSync(new URL('../__fixtures__/tacolod-st-john-parents.json', import.meta.url), 'utf8'),
) as AtlasFeature[];
export const source = [
  ...new Map(
    [
      ...existingSource,
      ...campusSource,
      ...additionalSource,
      ...memorialSchoolSource,
      ...roadsideCampusSource,
      ...landscapedGroundsSource,
      ...civicGroundsSource,
      ...concepcionScienceSource,
      ...shrineConcepcionSabangSource,
      ...lccTerminalChurchSource,
      ...bridgeFloodworksSource,
      ...schoolHospitalSource,
      ...sanRoqueMaboloSource,
      ...tarosananSource,
      ...balatasSchoolSource,
      ...tacolodHospitalSource,
    ].map((f) => [f.properties.id, f]),
  ).values(),
];
mergeContent(source, { landmarks } as ContentBundle);
// Prepare immutable inputs and their bounds once, only when a geometry audit needs them.
let auditInput: { feature: AtlasFeature; bounds: [number, number, number, number] }[] | undefined;
export const nearby = (bounds: [number, number, number, number]) => {
  auditInput ??= [
    ...source,
    ...planParts(source, plans).parts,
    ...landcoverFeatures(source, covers).features,
  ].map((feature) => ({ feature, bounds: bbox(feature) as [number, number, number, number] }));
  return auditInput.filter((f) => bboxesOverlap(bounds, f.bounds)).map((f) => f.feature);
};
export const areaFor = (detail: SiteDetail): Polygon | MultiPolygon => {
  if (detail.extent || detail.grounds)
    return { type: 'Polygon', coordinates: [detail.extent ?? detail.grounds!] };
  const geometry = source.find((f) => f.properties.id === detail.osm_id)?.geometry;
  if (geometry?.type !== 'Polygon' && geometry?.type !== 'MultiPolygon')
    throw Error(`missing area fixture: ${detail.id}`);
  return geometry;
};
export const coordinates = (geometry: Polygon | MultiPolygon) =>
  geometry.coordinates as LngLat[][] | LngLat[][][];
export const newDetails = details.filter(
  (d) => !['detail/plaza-rizal', 'detail/plaza-quince-martires'].includes(d.id),
);
