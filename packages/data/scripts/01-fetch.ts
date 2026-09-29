import { join } from 'node:path';
import type { BBox, City } from '@atlas/shared';
import { downloadDem } from './lib/dem';
import { bufferBbox, fromOverpassBounds, intersectBbox, toOverpassBbox } from './lib/geo';
import { writeJson } from './lib/io';
import {
  onlyRelation,
  overpass,
  quote,
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
  nwr["leisure"~"^(park|garden|playground)$"];
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
  nwr["leisure"="pitch"];
  node["place"];
  relation["boundary"="administrative"]["admin_level"="${city.subdivision.admin_level}"];
);
out body;
>;
out skel qt;`;

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
async function regionBounds(city: City, rawDir: string, offline: boolean): Promise<BBox> {
  if ('bbox' in city.region) return city.region.bbox;
  const { name, osm_relation } = city.region;
  const selector = osm_relation
    ? `rel(${osm_relation})`
    : `rel["boundary"="administrative"]["name"=${quote(name)}]`;
  const region = await overpass(
    `[out:json][timeout:120];
${selector};
out tags bb;`,
    join(rawDir, files.rawRegionRelation),
    { offline },
  );
  const match = osm_relation
    ? onlyRelation(region, 'Region', {})
    : onlyRelation(region, 'Region', { name });
  if (!match.bounds) throw new Error('Region relation came back without bounds');
  console.log(`  region: relation/${match.id}`);
  return fromOverpassBounds(match.bounds);
}

// Download OSM for the city boundary, the detail bbox, and the region, plus the region's DEM,
// into raw/<city>/
export const step: Step = {
  name: '01-fetch',
  async run({ city, rawDir, offline }) {
    const boundaryData = await overpass(boundaryQuery(city), join(rawDir, files.rawBoundary), {
      offline,
    });
    const boundary = onlyRelation(boundaryData, 'Boundary', {
      boundary: 'administrative',
      name: city.boundary.name,
      admin_level: String(city.boundary.admin_level),
    });
    if (!boundary.bounds) throw new Error('Boundary relation came back without bounds');
    console.log(`  boundary: relation/${boundary.id}`);

    // Detail outside the region can't be seen (the camera is clamped to it), so don't fetch it.
    const regionBbox = await regionBounds(city, rawDir, offline);
    const detailBbox = intersectBbox(
      bufferBbox(fromOverpassBounds(boundary.bounds), city.detail_buffer_km),
      regionBbox,
    );
    const detail = await overpass(
      detailQuery(city, toOverpassBbox(detailBbox)),
      join(rawDir, files.rawDetail),
      { offline },
    );
    console.log(`  detail: ${detail.elements.length} elements`);

    const parts: OverpassResponse[] = [];
    for (const [i, query] of regionQueries(city, regionBbox).entries()) {
      const cacheFile = join(
        rawDir,
        files.rawRegion.replace('.osm.json', `-part-${i + 1}.osm.json`),
      );
      parts.push(await overpass(query, cacheFile, { offline }));
    }
    const region = mergeResponses(parts);
    await writeJson(join(rawDir, files.rawRegion), region);
    console.log(`  region: ${region.elements.length} elements (${parts.length} queries)`);

    const dem = await downloadDem(regionBbox, join(rawDir, files.rawDem), { offline });
    console.log(`  DEM: ${dem.length} tiles`);
  },
};
