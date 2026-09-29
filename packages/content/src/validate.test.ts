import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentRoot, loadCityPacks } from './validate';

const badRoot = fileURLToPath(new URL('./__fixtures__/bad', import.meta.url));

describe('loadCityPacks', () => {
  it('passes on the repository city packs', async () => {
    const { packs, errors } = await loadCityPacks(contentRoot);
    expect(errors).toEqual([]);
    expect(packs.length).toBeGreaterThan(0);
  });

  it('reports every error with its file path', async () => {
    const { packs, errors } = await loadCityPacks(badRoot);
    expect(packs).toEqual([]);
    expect(errors).toEqual([
      {
        file: 'cities/fixture/landmarks/no-sources.json',
        message: expect.stringMatching(/^sources: /) as string,
      },
      {
        file: 'cities/fixture/landmarks/undeclared-language.json',
        message: expect.stringMatching(/^name\.de: language "de" is not declared/) as string,
      },
      { file: 'cities/no-config/city.json', message: 'missing' },
    ]);
  });

  it('loads a single city with `only`', async () => {
    const { errors } = await loadCityPacks(badRoot, { only: 'no-config' });
    expect(errors).toEqual([{ file: 'cities/no-config/city.json', message: 'missing' }]);
    const missing = await loadCityPacks(badRoot, { only: 'atlantis' });
    expect(missing.errors).toEqual([{ file: 'cities/atlantis', message: 'no such city pack' }]);
  });
});
