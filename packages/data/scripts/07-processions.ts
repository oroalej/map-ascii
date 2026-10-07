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
  const rings = (polygons: readonly [number, number][][]) =>
    polygons.map((points) => {
      const rounded = line(points);
      if (
        rounded.length < 4 ||
        rounded[0]![0] !== rounded.at(-1)![0] ||
        rounded[0]![1] !== rounded.at(-1)![1]
      )
        return rounded;
      const vertices = rounded
        .slice(0, -1)
        .filter((p, i) => i === 0 || p[0] !== rounded[i - 1]![0] || p[1] !== rounded[i - 1]![1]);
      for (let i = 0; i < vertices.length && vertices.length > 3;) {
        const a = vertices[(i + vertices.length - 1) % vertices.length]!,
          b = vertices[i]!,
          c = vertices[(i + 1) % vertices.length]!;
        const dx = Math.round(b[0] * 1e6) - Math.round(a[0] * 1e6),
          dy = Math.round(b[1] * 1e6) - Math.round(a[1] * 1e6),
          ex = Math.round(c[0] * 1e6) - Math.round(b[0] * 1e6),
          ey = Math.round(c[1] * 1e6) - Math.round(b[1] * 1e6);
        if (dx * ey - dy * ex === 0 && dx * ex + dy * ey >= 0) vertices.splice(i, 1);
        else i++;
      }
      return vertices.length >= 3 ? [...vertices, vertices[0]!] : rounded;
    });
  return routes.map((route): ProcessionRoute => {
    if (route.kind === 'fluvial')
      return {
        ...route,
        ...(route.crowd_ground && {
          crowd_ground: {
            grounds: rings(route.crowd_ground.grounds),
            blocked: rings(route.crowd_ground.blocked),
            water: rings(route.crowd_ground.water),
            bridges: rings(route.crowd_ground.bridges),
          },
        }),
      };
    if (route.kind === 'mass')
      return {
        ...route,
        site: {
          ...route.site,
          location: point(route.site.location),
          anchor: point(route.site.anchor),
          grounds: rings(route.site.grounds),
          ...(route.site.closure_zone && { closure_zone: rings(route.site.closure_zone) }),
          ...(route.site.seated_grounds && { seated_grounds: rings(route.site.seated_grounds) }),
          ...(route.site.altar_ground && { altar_ground: rings(route.site.altar_ground) }),
          ...(route.site.altar && {
            altar: { ...route.site.altar, at: point(route.site.altar.at) },
          }),
          blocked: rings(route.site.blocked),
          approaches: rings(route.site.approaches),
          roads: route.site.roads.map((road) => ({ ...road, line: line(road.line) })),
        },
      };
    return {
      ...route,
      route: line(route.route),
      blocked: rings(route.blocked),
      ...(route.crowd_grounds && { crowd_grounds: rings(route.crowd_grounds) }),
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
