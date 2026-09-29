import { loadContent } from '@atlas/content';
import type { Step } from './step';

// Validate packages/content and join it onto features
export const step: Step = {
  name: '04-merge-content',
  async run() {
    const { content, errors } = await loadContent();
    if (errors.length > 0) {
      const lines = errors.map(({ file, message }) => `  ${file}: ${message}`);
      throw new Error(`Content validation failed:\n${lines.join('\n')}`);
    }
    console.log(
      `  content valid: ${content.landmarks.length} landmarks, ${content.tours.length} tours`,
    );
    console.log('  merge not implemented yet (Phase 1)');
  },
};
