import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentRoot, loadCityPacks } from './validate';

const badRoot = fileURLToPath(new URL('./__fixtures__/bad', import.meta.url));

describe('loadCityPacks', () => {
  it('passes on the repository city packs', async () => {
    const { packs, errors } = await loadCityPacks(contentRoot);
    expect(errors).toEqual([]);
    expect(packs.length).toBeGreaterThan(0);
    const speech = packs.find((pack) => pack.city.slug === 'naga')?.dialogue;
    expect(speech?.native.code).toBe('bcl');
    expect(speech?.translations.map((entry) => entry.code)).toEqual(['en', 'fil']);
    expect(speech?.exchanges).toHaveLength(100);
    expect(speech?.exchanges.filter((e) => e.delivery === 'utterance')).toHaveLength(40);
    expect(speech?.exchanges.filter((e) => e.delivery === 'exchange')).toHaveLength(60);
    const counts: Record<string, number> = {};
    const scripts = new Set<string>();
    for (const e of speech!.exchanges) {
      counts[e.profile!] = (counts[e.profile!] ?? 0) + 1;
      const script = e.lines
        .map((line) =>
          line
            .bcl!.normalize('NFKC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' '),
        )
        .join('|');
      expect(scripts.has(script), e.id).toBe(false);
      scripts.add(script);
      expect(e.speakers).toHaveLength(e.lines.length);
      expect(e.lines.length === 1).toBe(e.delivery === 'utterance');
      for (const line of e.lines)
        for (const code of ['bcl', 'en', 'fil']) expect(line[code], e.id).toMatch(/\p{L}/u);
    }
    expect(counts).toEqual({
      greeting: 12,
      reunion: 6,
      farewell: 6,
      directions: 6,
      courtesy: 6,
      weather: 8,
      food: 8,
      school: 6,
      'daily-plans': 6,
      'vendor-order': 8,
      'vendor-thanks': 4,
      transit: 8,
      companion: 6,
      play: 6,
      'place-reaction': 4,
    });
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
      {
        file: 'cities/fixture/tours/verified-placeholder.json',
        message: 'steps.0.narration: a verified tour cannot contain TODO(verify)',
      },
      {
        file: 'cities/fixture/tiles.lock.json',
        message: 'files.fixture.pmtiles: expected a hex sha256',
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
