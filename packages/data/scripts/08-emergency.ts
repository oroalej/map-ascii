import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CityEmergency, type EmergencyConfig } from '@atlas/shared';
import type { Geom } from 'polyclip-ts';
import { intersection } from 'polyclip-ts';
import turfBbox from '@turf/bbox';
import type { AtlasFeature } from './03-normalize';
import { clipLine } from './lib/coastline';
import { displayFeatures } from './lib/display';
import { buildEmergencyGraph } from './lib/emergency-graph';
import { encodeEmergencyInTerritory } from './lib/emergency-territory';
import { readFeatures, readJson, writeJson } from './lib/io';
import {
  bboxPolygon,
  geometryOutsideVoid,
  inTerritory,
  Territory,
  type Territory as TerritoryType,
} from './lib/territory';
import { inBbox } from './lib/geo';
import { files, type Step } from './step';

/** Emergency routes use the geometry retained for display, after full-source derivation. */
export const emergencyNetwork = (
  features: readonly AtlasFeature[],
  config: EmergencyConfig,
  territory: TerritoryType,
) => {
  const used = features.filter(
    ({ properties: p }) =>
      ['road_major', 'road_mid', 'road_minor'].includes(p.class) ||
      p.class.startsWith('building') ||
      p.kind === 'amenity=police' ||
      p.kind === 'amenity=fire_station',
  );
  const displayed = displayFeatures(used, territory);
  const bounded = !territory.territory
    ? displayed
    : displayed.flatMap((feature): AtlasFeature[] => {
        const g = feature.geometry,
          bounds = territory.regionBounds;
        const [w, s, e, n] = turfBbox(g);
        if (inBbox(w, s, bounds) && inBbox(e, n, bounds)) return [feature];
        if (g.type === 'Point')
          return inTerritory(g.coordinates[0]!, g.coordinates[1]!, territory) ? [feature] : [];
        if (g.type === 'LineString' || g.type === 'MultiLineString') {
          const lines = (g.type === 'LineString' ? [g.coordinates] : g.coordinates).flatMap(
            (line) =>
              clipLine(
                line.map((p): [number, number] => [p[0]!, p[1]!]),
                bounds,
              ).map((p) => p.coords),
          );
          return lines.length
            ? [
                {
                  ...feature,
                  geometry:
                    lines.length === 1
                      ? { type: 'LineString', coordinates: lines[0]! }
                      : { type: 'MultiLineString', coordinates: lines },
                },
              ]
            : [];
        }
        if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
          const coordinates = intersection(
            g.coordinates as Geom,
            bboxPolygon(bounds).coordinates as Geom,
          );
          return coordinates.length
            ? [{ ...feature, geometry: { type: 'MultiPolygon', coordinates } }]
            : [];
        }
        return [];
      });
  return buildEmergencyGraph(
    bounded,
    config,
    territory.territory
      ? (shape) => geometryOutsideVoid({ type: 'LineString', coordinates: shape }, territory)
      : undefined,
  );
};

export const step: Step = {
  name: '08-emergency',
  async run({ city, buildDir, outDir }) {
    const config = city.life?.emergency;
    if (!config) {
      console.log('  no emergencies');
      return;
    }
    const features: AtlasFeature[] = [];
    for await (const feature of readFeatures(join(buildDir, files.merged)))
      features.push(feature as AtlasFeature);
    const territory = Territory.parse(await readJson(join(buildDir, files.territory)));
    const network = emergencyNetwork(features, config, territory),
      mandatory = network.targets.filter((t) => t.kind !== 'building');
    const buildings = network.targets
      .filter((t) => t.kind === 'building')
      .sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]);
    let data = encodeEmergencyInTerritory(network, territory),
      bytes = gzipSync(JSON.stringify(data) + '\n').length;
    for (
      let cap = Math.min(512, buildings.length);
      bytes > 32 * 1024 && cap >= 1;
      cap = Math.floor(cap * 0.8)
    ) {
      network.targets = [
        ...mandatory,
        ...Array.from(
          { length: cap },
          (_, i) => buildings[Math.floor((i * buildings.length) / cap)]!,
        ),
      ];
      data = encodeEmergencyInTerritory(network, territory);
      bytes = gzipSync(JSON.stringify(data) + '\n').length;
    }
    if (bytes > 32 * 1024)
      throw new Error(`emergency network exceeds 32 KiB gzip (${bytes} bytes)`);
    await writeJson(join(outDir, `${city.slug}.emergency.json`), CityEmergency.parse(data));
    console.log(
      `  ${network.nodes.length} nodes, ${network.edges.length} chains, ${network.targets.length} targets; ${bytes} bytes gzip`,
    );
  },
};
