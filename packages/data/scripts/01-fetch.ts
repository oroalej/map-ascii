import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { BBox, City } from '@atlas/shared';
import { downloadDem } from './lib/dem';
import {
  bufferBbox,
  fromOverpassBounds,
  intersectBbox,
  toOverpassBbox,
  configuredRegionBounds,
  includesBoundary,
} from './lib/geo';
import { writeJson } from './lib/io';
import {
  onlyRelation,
  cacheAnswers,
  overpass,
  quote,
  type FetchOptions,
  type OsmElement,
  type OverpassResponse,
} from './lib/overpass';
import { files, type Step } from './step';

const boundaryQuery = ({ boundary }: City) => {
  const parent = boundary.within
    ? `area["boundary"="administrative"]["name"=${quote(boundary.within)}]->.parent;\n`
    : '';
  return `[out:json][timeout:180];
${parent}rel["boundary"="administrative"]["name"=${quote(boundary.name)}]["admin_level"="${boundary.admin_level}"]${parent ? '(area.parent)' : ''};
out body bb;
>;
out skel qt;`;
};

/** Everything the detail layers need, inside the buffered city bbox. */
const detailQuery = (
  city: City,
  bbox: string,
) => `[out:json][timeout:300][maxsize:536870912][bbox:${bbox}];
(
  way["highway"];
  way["building"];
  relation["building"];
  way["waterway"~"^(river|stream|canal|riverbank)$"];
  nwr["natural"~"^(water|wood)$"];
  nwr["water"];
  nwr["landuse"~"^(forest|farmland|paddy)$"];
  way["crop"="rice"];
  nwr["leisure"~"^(park|garden|playground|recreation_ground)$"];
  nwr["landuse"~"^(grass|meadow|village_green)$"];
  nwr["natural"="grassland"];
  way["place"="square"];
  nwr["amenity"~"^(place_of_worship|school|university|college|marketplace)$"];
  nwr["shop"~"^(mall|supermarket)$"];
  nwr["landuse"="religious"];
  nwr["historic"~"^(monument|memorial)$"];
  nwr["memorial"~"^(statue|bust)$"];
  node["tourism"="artwork"];
  nwr["natural"~"^(tree|tree_row)$"];
  nwr["barrier"~"^(fence|wall|hedge|gate)$"];
  node["entrance"];
  nwr["amenity"~"^(bench|fountain|parking)$"];
  node["man_made"="flagpole"];
  node["highway"="street_lamp"];
  nwr["leisure"="pitch"];
  node["place"];
  relation["boundary"="administrative"]["admin_level"="${city.subdivision.admin_level}"];
);
out body;
>;
out skel qt;`;

/**
 * Railway track and stations in the detail bbox. Asked for on its own, not as part of
 * `detailQuery`: it is small, so the servers answer it when the big query times out, and adding
 * it left the saved detail download valid.
 */
export const railQuery = (bbox: string) => `[out:json][timeout:120][bbox:${bbox}];
(
  way["railway"~"^(rail|narrow_gauge|light_rail)$"];
  nwr["railway"~"^(station|halt)$"];
  nwr["building"="train_station"];
);
out body;
>;
out skel qt;`;

/**
 * Transit stops, terminals, and covered shelters in the detail bbox, asked for on its own like
 * `railQuery` so adding it left the saved detail download valid (`--offline` needs it saved too).
 * Covered entrances repeat part of `detailQuery` so this download stands alone.
 */
export const lifeQuery = (bbox: string) => `[out:json][timeout:120][bbox:${bbox}];
(
  nwr["highway"="bus_stop"];
  nwr["public_transport"~"^(platform|stop_position)$"];
  nwr["amenity"~"^(bus_station|taxi|shelter)$"];
  node["entrance"]["covered"="yes"];
);
out body;
>;
out skel qt;`;

/** Tagged traffic nodes, queried separately to preserve the detail download cache. */
export const trafficQuery = (bbox: string) => `[out:json][timeout:120][bbox:${bbox}];
(node["highway"~"^(traffic_signals|crossing)$"]; node["highway"="stop"]; node["crossing"]; node["crossing:markings"];);
out body;`;
export const neighborhoodQuery = (bbox: string) => `[out:json][timeout:120][bbox:${bbox}];
(nwr["shop"]; nwr["amenity"~"^(restaurant|fast_food|cafe|bar|pub|food_court|ice_cream|pharmacy|bank|clinic|dentist|internet_cafe)$"];
nwr["craft"]; nwr["natural"~"^(scrub|heath)$"]; nwr["landuse"~"^(orchard|plant_nursery|cemetery)$"]; nwr["amenity"="grave_yard"];);
out body; >; out skel qt;`;

/** Outdoor recreation grounds, separately queried to retain all existing download caches. */
export const groundsQuery = (bbox: string) => `[out:json][timeout:120][bbox:${bbox}];
nwr["landuse"="recreation_ground"];
out body; >; out skel qt;`;

/** Pools are not necessarily tagged natural=water; keep the existing detail caches valid. */
export const poolsQuery = (bbox: string) => `[out:json][timeout:120][bbox:${bbox}];
nwr["leisure"="swimming_pool"];
out body; >; out skel qt;`;

/** Region-wide railway track, per quarter; asked for after the other layers (`regionQueries`). */
const regionRail = 'way["railway"~"^(rail|narrow_gauge)$"];';

/** Admin level of the province/state names at Region level, when the city doesn't say. */
export const DEFAULT_PROVINCE_LEVEL = 4;

/** Region-wide low-detail layers (DATA.md §2 step 01), each queried on its own. */
const regionLayers = [
  'way["natural"="coastline"];',
  'way["highway"~"^(motorway|trunk|primary)(_link)?$"];',
  'way["waterway"="river"];',
  'nwr["natural"="water"]["water"~"^(lake|reservoir|lagoon)$"];',
];

/** Split a bbox into `n × n` equal parts. */
export function splitBbox([west, south, east, north]: BBox, n: number): BBox[] {
  const parts: BBox[] = [];
  const [dx, dy] = [(east - west) / n, (north - south) / n];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      parts.push([west + i * dx, south + j * dy, west + (i + 1) * dx, south + (j + 1) * dy]);
    }
  }
  return parts;
}

/**
 * The region download (region-wide low-detail layers, place labels, and province label points),
 * split into queries the public Overpass servers can answer: each heavy layer on its own, in
 * each quarter of the region. A single request for all of it timed out on every server.
 */
export function regionQueries(city: City, bbox: BBox): string[] {
  const header = (b: BBox) => `[out:json][timeout:300][bbox:${toOverpassBbox(b)}];`;
  const queries = splitBbox(bbox, 2).flatMap((part) =>
    regionLayers.map((layer) => `${header(part)}\n${layer}\nout body;\n>;\nout skel qt;`),
  );
  queries.push(`${header(bbox)}\nnode["place"~"^(city|town)$"];\nout body;`);
  queries.push(
    `${header(bbox)}\nrel["boundary"="administrative"]["admin_level"="${city.province_admin_level ?? DEFAULT_PROVINCE_LEVEL}"];\nout tags center;`,
  );
  // Last, so the parts before keep their numbers (and their saved downloads).
  for (const part of splitBbox(bbox, 2)) {
    queries.push(`${header(part)}\n${regionRail}\nout body;\n>;\nout skel qt;`);
  }
  return queries;
}

/**
 * Merge Overpass responses, keeping each element once. An element can arrive more than once
 * (a way crossing two quarters, or a node both as a way's geometry and as a place); the copy
 * with the most data wins.
 */
export function mergeResponses(responses: readonly OverpassResponse[]): OverpassResponse {
  const byKey = new Map<string, OsmElement>();
  for (const { elements } of responses) {
    for (const element of elements) {
      const key = `${element.type}/${element.id}`;
      const seen = byKey.get(key);
      if (!seen || Object.keys(element).length > Object.keys(seen).length) byKey.set(key, element);
    }
  }
  return { elements: [...byKey.values()] };
}

/** The region's bounds: its relation's bbox, or the configured bbox. */
export async function regionBounds(
  city: City,
  rawDir: string,
  cache: FetchOptions,
  boundary: BBox,
): Promise<BBox> {
  if ('bbox' in city.region) return configuredRegionBounds(city.region, boundary);
  const { name, osm_relation } = city.region;
  const selector = osm_relation
    ? `rel(${osm_relation})`
    : `rel["boundary"="administrative"]["name"=${quote(name)}]`;
  const region = await overpass(
    `[out:json][timeout:120];
${selector};
out tags bb;`,
    join(rawDir, files.rawRegionRelation),
    cache,
  );
  const match = osm_relation
    ? onlyRelation(region, 'Region', {})
    : onlyRelation(region, 'Region', { name });
  if (!match.bounds) throw new Error('Region relation came back without bounds');
  console.log(`  region: relation/${match.id}`);
  return fromOverpassBounds(match.bounds);
}

/** Stable part identities allow an ordinary retry to retain completed downloads. */
export const detailParts = (city: City, bbox: BBox) =>
  splitBbox(bbox, 2).map((part, i) => ({
    query: detailQuery(city, toOverpassBbox(part)),
    file: files.rawDetail.replace('.osm.json', `-part-${i + 1}.osm.json`),
  }));

export async function fetchDetail(
  city: City,
  bbox: BBox,
  rawDir: string,
  cache: FetchOptions,
): Promise<OverpassResponse> {
  const aggregate = join(rawDir, files.rawDetail);
  const query = detailQuery(city, toOverpassBbox(bbox));
  if (!includesBoundary(city)) return overpass(query, aggregate, cache);
  const strict = { ...cache, requireCoverage: true };
  if (cache.offline || !cache.refresh) {
    const savedQuery = await readFile(`${aggregate}.query`, 'utf8').catch(() => undefined);
    if (cacheAnswers(savedQuery, query, { offline: false })) {
      const saved = await readFile(aggregate, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      });
      if (saved !== undefined) return JSON.parse(saved) as OverpassResponse;
    }
  }
  const parts: OverpassResponse[] = [];
  for (const part of detailParts(city, bbox))
    parts.push(await overpass(part.query, join(rawDir, part.file), strict));
  const detail = mergeResponses(parts);
  await writeJson(aggregate, detail);
  await writeFile(`${aggregate}.query`, query);
  return detail;
}

// Download OSM for the city boundary, the detail bbox, and the region, plus the region's DEM,
// into raw/<city>/
export const step: Step = {
  name: '01-fetch',
  async run({ city, rawDir, offline, refresh }) {
    const cache: FetchOptions = {
      offline,
      refresh,
      requireCoverage: includesBoundary(city),
    };
    const boundaryData = await overpass(
      boundaryQuery(city),
      join(rawDir, files.rawBoundary),
      cache,
    );
    const boundary = onlyRelation(boundaryData, 'Boundary', {
      boundary: 'administrative',
      name: city.boundary.name,
      admin_level: String(city.boundary.admin_level),
    });
    if (!boundary.bounds) throw new Error('Boundary relation came back without bounds');
    console.log(`  boundary: relation/${boundary.id}`);

    // Detail outside the region can't be seen (the camera is clamped to it), so don't fetch it.
    const regionBbox = await regionBounds(city, rawDir, cache, fromOverpassBounds(boundary.bounds));
    const detailBbox = intersectBbox(
      bufferBbox(fromOverpassBounds(boundary.bounds), city.detail_buffer_km),
      regionBbox,
    );
    const detail = await fetchDetail(city, detailBbox, rawDir, cache);
    console.log(`  detail: ${detail.elements.length} elements`);
    const rail = await overpass(
      railQuery(toOverpassBbox(detailBbox)),
      join(rawDir, files.rawDetailRail),
      cache,
    );
    console.log(`  railways: ${rail.elements.length} elements`);
    const sites = await overpass(
      lifeQuery(toOverpassBbox(detailBbox)),
      join(rawDir, files.rawDetailLife),
      cache,
    );
    console.log(`  life sites: ${sites.elements.length} elements`);
    const traffic = await overpass(
      trafficQuery(toOverpassBbox(detailBbox)),
      join(rawDir, files.rawDetailTraffic),
      cache,
    );
    console.log(`  traffic nodes: ${traffic.elements.length} elements`);
    const neighborhood = await overpass(
      neighborhoodQuery(toOverpassBbox(detailBbox)),
      join(rawDir, files.rawDetailNeighborhood),
      cache,
    );
    console.log(`  neighborhood: ${neighborhood.elements.length} elements`);

    const grounds = await overpass(
      groundsQuery(toOverpassBbox(detailBbox)),
      join(rawDir, files.rawDetailGrounds),
      cache,
    );
    console.log(`  recreation grounds: ${grounds.elements.length} elements`);

    const pools = await overpass(
      poolsQuery(toOverpassBbox(detailBbox)),
      join(rawDir, files.rawDetailPools),
      cache,
    );
    console.log(`  swimming pools: ${pools.elements.length} elements`);

    const parts: OverpassResponse[] = [];
    for (const [i, query] of regionQueries(city, regionBbox).entries()) {
      const cacheFile = join(
        rawDir,
        files.rawRegion.replace('.osm.json', `-part-${i + 1}.osm.json`),
      );
      parts.push(await overpass(query, cacheFile, cache));
    }
    const region = mergeResponses(parts);
    await writeJson(join(rawDir, files.rawRegion), region);
    console.log(`  region: ${region.elements.length} elements (${parts.length} queries)`);

    const dem = await downloadDem(regionBbox, join(rawDir, files.rawDem), { offline });
    console.log(`  DEM: ${dem.length} tiles`);
  },
};
