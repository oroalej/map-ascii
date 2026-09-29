import { loadCityPacks } from '@atlas/content';
import { AtlasCanvas } from '@/components/AtlasCanvas';
import { Attribution } from '@/components/Attribution';

/** Runs at build time: read the city registry, failing the build on invalid packs. */
async function firstCity() {
  const { packs, errors } = await loadCityPacks();
  if (errors.length > 0) {
    const lines = errors.map(({ file, message }) => `  ${file}: ${message}`);
    throw new Error(`Invalid city packs:\n${lines.join('\n')}`);
  }
  // Phase 2 adds a route per city (`/<slug>`); until then `/` shows the first city.
  const city = packs[0]?.city;
  if (!city) throw new Error('No city packs found in packages/content/cities/');
  return city;
}

export default async function HomePage() {
  const city = await firstCity();
  return (
    <main>
      <AtlasCanvas slug={city.slug} name={city.name.en} />
      <Attribution />
    </main>
  );
}
