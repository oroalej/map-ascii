import type { Step } from './step';

// Download OSM (Naga detail + Region bboxes) and DEM into raw/
export const step: Step = {
  name: '01-fetch',
  run() {
    console.log('  not implemented yet (Phase 1)');
    return Promise.resolve();
  },
};
