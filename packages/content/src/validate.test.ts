import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { contentRoot, loadCityPacks } from './validate';

const eventRoot = fileURLToPath(new URL('./__fixtures__/event-references', import.meta.url));
import.meta.glob('./__fixtures__/event-references/**/*.json');
const badRoot = fileURLToPath(new URL('./__fixtures__/bad', import.meta.url));
// loadCityPacks reads the packs from disk; this lets targeted runs select the test on pack edits.
import.meta.glob('../cities/**/*.json');
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe('loadCityPacks', () => {
  it('reports an invalid predecessor without a cascading missing-reference error', async () => {
    const original = (await vi.importActual<typeof fs>('node:fs/promises')).readFile;
    vi.mocked(fs.readFile).mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const text = await original(...args);
      if (
        typeof args[0] !== 'string' ||
        !args[0].replaceAll('\\', '/').endsWith('/processions/street.json')
      )
        return text;
      const value = JSON.parse(String(text)) as { schedule: Record<string, unknown> };
      value.schedule = { ...value.schedule, start: '25:00' };
      return JSON.stringify(value);
    });
    try {
      const { packs, errors } = await loadCityPacks(eventRoot, { only: 'fixture' });
      expect(packs).toEqual([]);
      expect(errors.some((error) => error.file.endsWith('/processions/street.json'))).toBe(true);
      expect(errors.some((error) => /missing predecessor/.test(error.message))).toBe(false);
    } finally {
      vi.mocked(fs.readFile).mockImplementation(original);
    }
  });
  it('reports inherited schedule overflow at the dependent event file', async () => {
    const original = (await vi.importActual<typeof fs>('node:fs/promises')).readFile;
    vi.mocked(fs.readFile).mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const text = await original(...args);
      if (
        typeof args[0] !== 'string' ||
        !args[0].replaceAll('\\', '/').endsWith('/processions/street.json')
      )
        return text;
      const value = JSON.parse(String(text)) as { schedule: Record<string, unknown> };
      value.schedule = { ...value.schedule, offset_days: 31, start: '23:30', duration_min: 90 };
      return JSON.stringify(value);
    });
    try {
      const { packs, errors } = await loadCityPacks(eventRoot, { only: 'fixture' });
      expect(packs).toEqual([]);
      expect(errors).toContainEqual({
        file: 'cities/fixture/processions/arrival.json',
        message: expect.stringContaining('resolved offset 32') as string,
      });
    } finally {
      vi.mocked(fs.readFile).mockImplementation(original);
    }
  });
  it.each(['season', 'missing', 'self', 'cycle'] as const)(
    'reports an invalid %s reference at its procession file',
    async (kind) => {
      const original = (await vi.importActual<typeof fs>('node:fs/promises')).readFile;
      vi.mocked(fs.readFile).mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
        const text = await original(...args);
        if (typeof args[0] !== 'string') return text;
        const path = args[0].replaceAll('\\', '/');
        if (
          !path.endsWith('/processions/arrival.json') &&
          !(kind === 'cycle' && path.endsWith('/processions/street.json'))
        )
          return text;
        const value = JSON.parse(String(text)) as {
          id: string;
          season?: string;
          schedule: unknown;
        };
        if (kind === 'season') value.season = 'missing-season';
        else
          value.schedule = {
            follows:
              kind === 'missing'
                ? 'procession/missing'
                : kind === 'self'
                  ? value.id
                  : value.id === 'procession/street'
                    ? 'procession/arrival'
                    : 'procession/street',
            duration_min: 90,
          };
        return JSON.stringify(value);
      });
      try {
        const { errors } = await loadCityPacks(eventRoot, { only: 'fixture' });
        expect(errors).toContainEqual({
          file: 'cities/fixture/processions/arrival.json',
          message: expect.stringMatching(
            kind === 'season'
              ? /unknown season/
              : kind === 'missing'
                ? /missing predecessor/
                : /cyclic follows/,
          ) as string,
        });
      } finally {
        vi.mocked(fs.readFile).mockImplementation(original);
      }
    },
  );
  it('passes on the repository city packs', async () => {
    const { packs, errors } = await loadCityPacks(contentRoot);
    expect(errors).toEqual([]);
    expect(packs.length).toBeGreaterThan(0);
    const speech = packs.find((pack) => pack.city.slug === 'naga')?.dialogue;
    expect(speech?.native.code).toBe('bcl');
    expect(speech?.translations.map((entry) => entry.code)).toEqual(['en', 'fil']);
    const legacy = speech!.exchanges.filter((e) => e.profile !== 'peddler-call');
    const peddlers = speech!.exchanges.filter((e) => e.profile === 'peddler-call');
    expect(legacy).toHaveLength(110);
    expect(legacy.filter((e) => e.delivery === 'utterance')).toHaveLength(48);
    expect(legacy.filter((e) => e.delivery === 'exchange')).toHaveLength(62);
    expect(peddlers).toHaveLength(21);
    expect(speech!.exchanges.length).toBeLessThanOrEqual(140);
    expect(peddlers.filter((e) => !e.conditions?.weather && !e.conditions?.event)).toHaveLength(14);
    expect(peddlers.filter((e) => e.conditions?.weather)).toHaveLength(4);
    expect(peddlers.filter((e) => e.conditions?.event === 'hover')).toHaveLength(2);
    expect(peddlers.filter((e) => e.conditions?.event === 'leaving')).toHaveLength(1);
    for (const goods of [
      'taho',
      'balut',
      'sorbetes',
      'bote-dyaryo',
      'fishball',
      'kakanin',
      'takatak',
    ])
      expect(
        peddlers.filter(
          (e) =>
            e.conditions?.goods?.includes(goods) && !e.conditions?.weather && !e.conditions?.event,
        ),
      ).toHaveLength(2);
    expect(legacy.filter((e) => e.kind === 'cheer')).toHaveLength(6);
    expect(speech!.exchanges).toHaveLength(131);
    expect(
      legacy
        .filter((e) => ['heat', 'clearing'].includes(e.conditions?.weather ?? ''))
        .map((e) => [e.id, e.conditions?.weather, e.delivery]),
    ).toEqual([
      ['weather-heat-rest', 'heat', 'exchange'],
      ['weather-heat-here', 'heat', 'utterance'],
      ['weather-clearing-leave', 'clearing', 'exchange'],
      ['weather-clearing-linger', 'clearing', 'utterance'],
    ]);
    const counts: Record<string, number> = {};
    const scripts = new Set<string>();
    for (const e of speech!.exchanges) {
      if (e.profile !== 'peddler-call' && e.kind !== 'cheer')
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
      weather: 12,
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
        file: 'cities/fixture/city.json',
        message: 'life.seasons.0.congregations.landmarks: no landmark "landmark/missing-church"',
      },
      {
        file: 'cities/fixture/city.json',
        message:
          'life.seasons.0.congregations.landmarks: landmark "landmark/fixture-school" is not a church',
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
