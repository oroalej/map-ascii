import { join } from 'node:path';
import { CityProcessions, type ProcessionRoute } from '@atlas/shared';
import type { Feature, Geometry } from 'geojson';
import { readFeatures, writeJson } from './lib/io';
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
    for (const warning of warnings) console.warn(`  warning: ${warning}`);
    await writeJson(
      join(outDir, `${city.slug}.processions.json`),
      CityProcessions.parse({ processions: quantizeGroundRoutes(routes) }),
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
