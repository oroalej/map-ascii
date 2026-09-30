import { join } from 'node:path';
import { CityProcessions } from '@atlas/shared';
import type { Feature, Geometry } from 'geojson';
import { readFeatures, writeJson } from './lib/io';
import { routeProcessions } from './lib/procession';
import { files, type Step } from './step';

// Build <city>.processions.json: each river procession's route, followed along the river.
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
      CityProcessions.parse({ processions: routes }),
    );
    for (const r of routes) {
      console.log(
        `  ${r.id}: ${r.length_m} m along the river, ${r.route.length} points (${r.status})`,
      );
    }
  },
};
