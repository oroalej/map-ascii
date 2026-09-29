import { loadCityPacks } from '@atlas/content';
import type { Step } from './step';

// Validate the city packs and join their content onto features
export const step: Step = {
  name: '04-merge-content',
  async run() {
    const { packs, errors } = await loadCityPacks();
    if (errors.length > 0) {
      const lines = errors.map(({ file, message }) => `  ${file}: ${message}`);
      throw new Error(`Content validation failed:\n${lines.join('\n')}`);
    }
    for (const { city, content } of packs) {
      console.log(
        `  ${city.slug}: ${content.landmarks.length} landmarks, ${content.tours.length} tours`,
      );
    }
    console.log('  merge not implemented yet (Phase 1)');
  },
};
