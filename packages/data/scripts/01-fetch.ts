import { join } from 'node:path';
import type { City } from '@atlas/shared';
import { bufferBbox, fromOverpassBounds, toOverpassBbox } from './lib/geo';
import { onlyRelation, overpass, quote } from './lib/overpass';
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
  node["place"];
  relation["boundary"="administrative"]["admin_level"="${city.subdivision.admin_level}"];
);
out body;
>;
out skel qt;`;

// Download OSM for the city boundary, the detail bbox, and the region bounds into raw/<city>/
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

    const detailBbox = bufferBbox(fromOverpassBounds(boundary.bounds), city.detail_buffer_km);
    const detail = await overpass(
      detailQuery(city, toOverpassBbox(detailBbox)),
      join(rawDir, files.rawDetail),
      { offline },
    );
    console.log(`  detail: ${detail.elements.length} elements`);

    if ('name' in city.region) {
      const { name, osm_relation } = city.region;
      const selector = osm_relation
        ? `rel(${osm_relation})`
        : `rel["boundary"="administrative"]["name"=${quote(name)}]`;
      const region = await overpass(
        `[out:json][timeout:120];\n${selector};\nout tags bb;`,
        join(rawDir, files.rawRegion),
        { offline },
      );
      const match = osm_relation
        ? onlyRelation(region, 'Region', {})
        : onlyRelation(region, 'Region', { name });
      console.log(`  region: relation/${match.id}`);
    }
  },
};
