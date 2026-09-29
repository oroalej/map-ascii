import type { Step } from './step';

// OSM → GeoJSON, DEM → hillshade PNG tiles
export const step: Step = {
  name: '02-convert',
  run() {
    console.log('  not implemented yet (Phase 1)');
    return Promise.resolve();
  },
};
