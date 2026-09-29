import { loadCityPacks, type CityPack } from '@atlas/content';

/**
 * The city registry, read at build time. Invalid packs fail the build, and so does an empty
 * registry: the site needs at least one city.
 */
export async function loadRegistry(): Promise<CityPack[]> {
  const { packs, errors } = await loadCityPacks();
  if (errors.length > 0) {
    const lines = errors.map(({ file, message }) => `  ${file}: ${message}`);
    throw new Error(`Invalid city packs:\n${lines.join('\n')}`);
  }
  if (packs.length === 0) throw new Error('No city packs found in packages/content/cities/');
  return packs;
}

/** One city's pack, or undefined for a slug that isn't registered. */
export async function loadCity(slug: string): Promise<CityPack | undefined> {
  return (await loadRegistry()).find((pack) => pack.city.slug === slug);
}
