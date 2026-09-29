import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentRoot, loadContent } from './validate';

describe('loadContent', () => {
  it('passes on the repository content', async () => {
    const { errors } = await loadContent(contentRoot);
    expect(errors).toEqual([]);
  });

  it('reports schema errors with the file path', async () => {
    const root = fileURLToPath(new URL('./__fixtures__/bad', import.meta.url));
    const { errors, content } = await loadContent(root);
    expect(content.landmarks).toHaveLength(0);
    expect(errors).toEqual([
      { file: 'landmarks/no-sources.json', message: expect.stringMatching(/^sources: /) as string },
    ]);
  });
});
