// @vitest-environment node
import type { ReactElement } from 'react';
import { loadCityPacks } from '@atlas/content';
import { dialogueChoices, type RuntimeDialogueCatalog } from '@atlas/shared';
import { describe, expect, it, vi } from 'vitest';
import { CityAtlas } from '@/components/CityAtlas';
import { loadCity } from '@/lib/cities';
import CityPage from './page';

vi.mock('@/components/CityAtlas', () => ({ CityAtlas: () => null }));
vi.mock('@/lib/cities', () => ({ loadCity: vi.fn(), loadRegistry: vi.fn() }));

type PageElement = ReactElement<{
  children: ReactElement<{ dialogue?: RuntimeDialogueCatalog }>;
}>;

describe('city page client boundary', () => {
  it('serializes every catalog without editorial sources while preserving speech', async () => {
    const { packs, errors } = await loadCityPacks();
    expect(errors).toEqual([]);
    expect(packs.some((pack) => pack.dialogue)).toBe(true);
    for (const pack of packs) {
      vi.mocked(loadCity).mockResolvedValue(pack);
      const page = (await CityPage({
        params: Promise.resolve({ city: pack.city.slug }),
      })) as PageElement;
      expect(page.props.children.type).toBe(CityAtlas);
      const runtime = page.props.children.props.dialogue;
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
    const { packs } = await loadCityPacks();
    const pack = packs[0]!;
    vi.mocked(loadCity).mockResolvedValue({ ...pack, dialogue: undefined });
    const page = (await CityPage({
      params: Promise.resolve({ city: pack.city.slug }),
    })) as PageElement;
    expect(page.props.children.props.dialogue).toBeUndefined();
  });
});
