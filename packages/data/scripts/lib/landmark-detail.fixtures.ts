import { readFileSync, readdirSync } from 'node:fs';
import { SiteDetail, Landcover, LandmarkPlan, Landmark } from '@atlas/shared/schemas';
import type { AtlasFeature } from '../03-normalize';
import { mergeContent } from '../04-merge-content';
import bbox from '@turf/bbox';
import { planParts } from './plan';
import { landcoverFeatures } from './landcover';
import { bboxesOverlap } from './geo';
import { areaFor as detailArea, readFixture } from './landmark-detail.geometry';
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
const fixtureNames = [
  'landmark-parents.json',
  'seven-site-parents.json',
  'additional-site-parents.json',
  'memorial-school-parents.json',
  'roadside-campus-parents.json',
  'five-landscaped-grounds.json',
  'civic-ground-parents.json',
  'concepcion-science-parents.json',
  'shrine-concepcion-sabang-parents.json',
  'lcc-terminal-church-parents.json',
  'bridge-floodworks-parents.json',
  'school-hospital-parents.json',
  'san-roque-mabolo-parents.json',
  'tarosanan-parents.json',
  'balatas-school-parents.json',
  'tacolod-st-john-parents.json',
  'east-school-parents.json',
  'malabsay-falls-parents.json',
];
export const source = [
  ...new Map(
    fixtureNames
      .flatMap((name) => readFixture(name) as AtlasFeature[])
      .map((feature) => [feature.properties.id, feature]),
  ).values(),
];
// These geometry fixtures cover curated grounds, not the whole city's POIs.
const sourceIds = new Set(source.map((feature) => feature.properties.id));
mergeContent(source, {
  landmarks: landmarks.filter((landmark) => landmark.osm_id && sourceIds.has(landmark.osm_id)),
} as ContentBundle);
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
export const areaFor = (detail: SiteDetail) => detailArea(detail, source);
export { coordinates } from './landmark-detail.geometry';
export const newDetails = details.filter(
  (d) => !['detail/plaza-rizal', 'detail/plaza-quince-martires'].includes(d.id),
);
