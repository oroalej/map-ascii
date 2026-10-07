import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CityEmergency, encodeEmergency } from '@atlas/shared';
import type { AtlasFeature } from './03-normalize';
import { buildEmergencyGraph } from './lib/emergency-graph';
import { readFeatures, writeJson } from './lib/io';
import { files, type Step } from './step';

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
    const network = buildEmergencyGraph(features, config),
      mandatory = network.targets.filter((t) => t.kind !== 'building');
    const buildings = network.targets
      .filter((t) => t.kind === 'building')
      .sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]);
    let data = encodeEmergency(network),
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
      data = encodeEmergency(network);
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
