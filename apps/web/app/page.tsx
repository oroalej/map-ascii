import { CityRedirect } from '@/components/CityRedirect';
import { loadRegistry } from '@/lib/cities';

/**
 * `/`: while there is one city, it sends the visitor there (SPEC.md §9). A static export can't
 * redirect on the server, so the page does it on the client and links to the city meanwhile.
 */
export default async function HomePage() {
  const cities = (await loadRegistry()).map(({ city }) => ({
    slug: city.slug,
    name: city.name.en,
  }));
  return (
    <main>
      <CityRedirect cities={cities} />
    </main>
  );
}
