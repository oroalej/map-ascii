import { join } from 'node:path';
import { CityProcessions, type ProcessionRoute } from '@atlas/shared';
import type { Feature, Geometry } from 'geojson';
import { readFeatures, readJson, writeJson } from './lib/io';
import { Territory, geometryOutsideVoid } from './lib/territory';
import { routeProcessions } from './lib/procession';
import { files, type Step } from './step';

/** Sub-metre coordinate precision for new event geography; legacy fluvial data stays exact. */
export function quantizeGroundRoutes(routes: readonly ProcessionRoute[]): ProcessionRoute[] {
  const point = (q: readonly [number, number]): [number, number] => [
    Math.round(q[0] * 1e6) / 1e6,
    Math.round(q[1] * 1e6) / 1e6,
  ];
  const line = (points: readonly [number, number][]) => points.map(point);
  const rings = (polygons: readonly [number, number][][]) => polygons.map(line);
  return routes.map((route): ProcessionRoute => {
    if (route.kind === 'fluvial') return route;
    if (route.kind === 'mass')
      return {
        ...route,
        site: {
          ...route.site,
          location: point(route.site.location),
          anchor: point(route.site.anchor),
          grounds: rings(route.site.grounds),
          blocked: rings(route.site.blocked),
          approaches: rings(route.site.approaches),
          roads: route.site.roads.map((road) => ({ ...road, line: line(road.line) })),
        },
      };
    return {
      ...route,
      route: line(route.route),
      blocked: rings(route.blocked),
      ...(route.water && { water: rings(route.water) }),
      ...(route.bridges && { bridges: rings(route.bridges) }),
    };
  });
}

// Build <city>.processions.json: river and street routes, and outdoor Mass permissions.
export function validateRouteTerritory(routes: readonly ProcessionRoute[], territory: Territory) {
  const point = (coordinates: number[]): Geometry => ({ type: 'Point', coordinates });
  const line = (coordinates: number[][]): Geometry => ({ type: 'LineString', coordinates });
  const polygons = (rings: number[][][]): Geometry[] =>
    rings.map((r) => ({ type: 'Polygon', coordinates: [r] }));
  for (const route of routes) {
    const geometries: Geometry[] =
      route.kind === 'mass'
        ? [
            point(route.site.location),
            point(route.site.anchor),
            ...polygons(route.site.grounds),
            ...polygons(route.site.blocked),
            ...polygons(route.site.approaches),
            ...route.site.roads.map((r) => line(r.line)),
          ]
        : [
            line(route.route),
            ...(route.kind === 'fluvial'
              ? []
              : [
                  ...polygons(route.blocked),
                  ...polygons(route.water ?? []),
                  ...polygons(route.bridges ?? []),
                ]),
          ];
    if (geometries.some((g) => !geometryOutsideVoid(g, territory)))
      throw new Error(`Procession ${route.id}: emitted geography crosses the territory void`);
  }
}

export const step: Step = {
  name: '07-processions',
  async run({ city, content, buildDir, outDir }) {
    if (content.processions.length === 0) {
      console.log('  no processions');
      return;
    }
    const features: Feature<Geometry, Record<string, unknown>>[] = [];
    for await (const f of readFeatures(join(buildDir, files.merged))) {
      features.push(f as Feature<Geometry, Record<string, unknown>>);
    }
    const { routes, warnings } = routeProcessions(features, content.processions);
    const emitted = quantizeGroundRoutes(routes);
    validateRouteTerritory(
      emitted,
      Territory.parse(await readJson(join(buildDir, files.territory))),
    );
    for (const warning of warnings) console.warn(`  warning: ${warning}`);
    await writeJson(
      join(outDir, `${city.slug}.processions.json`),
      CityProcessions.parse({ processions: emitted }),
    );
    for (const r of routes) {
      console.log(
        r.kind === 'mass'
          ? `  ${r.id}: gathering at ${r.site.id} (${r.status})`
          : `  ${r.id}: ${r.length_m} m ${r.kind}, ${r.route.length} points (${r.status})`,
      );
    }
  },
};
