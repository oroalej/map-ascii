// @vitest-environment node
import type { ReactElement } from 'react';
import { loadCityPacks } from '@atlas/content';
import { dialogueChoices, runtimeCityLife } from '@atlas/shared';
import { describe, expect, it, vi } from 'vitest';
import { CityAtlas } from '@/components/CityAtlas';
import { loadCity } from '@/lib/cities';
import { decodeInlineRuntime } from '@/lib/inline-runtime';
import CityPage from './page';

vi.mock('@/lib/city-meta', () => ({
  readCityMeta: vi.fn().mockResolvedValue({ status: 'missing' }),
}));
vi.mock('@/components/CityAtlas', () => ({ CityAtlas: () => null }));
vi.mock('@/lib/cities', () => ({ loadCity: vi.fn(), loadRegistry: vi.fn() }));

type PageElement = ReactElement<{
  children: ReactElement<{ runtimeGzip: string }>;
}>;

const loadedPacks = await loadCityPacks();

describe('city page client boundary', () => {
  it('passes season admission and calendars without pipeline-only geometry', async () => {
    const { packs } = loadedPacks;
    for (const pack of packs) {
      vi.mocked(loadCity).mockResolvedValue(pack);
      const page = (await CityPage({
        params: Promise.resolve({ city: pack.city.slug }),
      })) as PageElement;
      const life = decodeInlineRuntime(page.props.children.props.runtimeGzip).cityLife;
      expect(life).toEqual(pack.city.life ? runtimeCityLife(pack.city.life) : undefined);
      for (const season of life?.seasons ?? []) {
        expect(season).not.toHaveProperty('grounds');
        expect(season).not.toHaveProperty('sources');
        for (const installation of season.installations ?? []) {
          expect(installation).not.toHaveProperty('components');
          expect(installation).not.toHaveProperty('sources');
        }
      }
    }
  });
  it('serializes every catalog without editorial sources while preserving speech', async () => {
    const { packs, errors } = loadedPacks;
    expect(errors).toEqual([]);
    expect(packs.some((pack) => pack.dialogue)).toBe(true);
    for (const pack of packs) {
      vi.mocked(loadCity).mockResolvedValue(pack);
      const page = (await CityPage({
        params: Promise.resolve({ city: pack.city.slug }),
      })) as PageElement;
      expect(page.props.children.type).toBe(CityAtlas);
      const runtime = decodeInlineRuntime(page.props.children.props.runtimeGzip).dialogue;
      if (!pack.dialogue) {
        expect(runtime).toBeUndefined();
        continue;
      }
      expect(runtime).toBeDefined();
      expect(runtime!.native).toEqual(pack.dialogue.native);
      expect(runtime!.translations).toEqual(pack.dialogue.translations);
      expect(runtime!.periods).toEqual(pack.dialogue.periods);
      expect(dialogueChoices(runtime!)).toEqual(dialogueChoices(pack.dialogue));
      expect(runtime!.exchanges).toEqual(
        pack.dialogue.exchanges.map(({ sources: _sources, ...exchange }) => exchange),
      );
      for (const exchange of runtime!.exchanges) expect(exchange).not.toHaveProperty('sources');
      expect(JSON.stringify(runtime)).not.toContain('"sources"');
    }
  });
  it('supports a city without a speech catalog', async () => {
    const { packs } = loadedPacks;
    const pack = packs[0]!;
    vi.mocked(loadCity).mockResolvedValue({ ...pack, dialogue: undefined });
    const page = (await CityPage({
      params: Promise.resolve({ city: pack.city.slug }),
    })) as PageElement;
    expect(decodeInlineRuntime(page.props.children.props.runtimeGzip).dialogue).toBeUndefined();
  });
});
