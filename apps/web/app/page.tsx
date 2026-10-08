import { CityRedirect } from '@/components/CityRedirect';
import { loadRegistry } from '@/lib/cities';
import styles from '@/components/CityRedirect.module.css';

/**
 * `/`: while there is one city, it sends the visitor there (SPEC.md §9). A static export can't
 * redirect on the server, so the page does it on the client and links to the city meanwhile.
 */
export default async function HomePage() {
  const cities = (await loadRegistry()).map(({ city }) => ({
    slug: city.slug,
    name: city.name.en,
  }));
  const only = cities.length === 1 ? cities[0] : undefined;
  if (only) {
    const path = `/${only.slug}`;
    return (
      <main>
        <meta httpEquiv="refresh" content={`0;url=${path}`} />
        <script
          dangerouslySetInnerHTML={{
            __html: `location.replace(${JSON.stringify(path).replace(/</g, '\\u003c')}+location.search+location.hash)`,
          }}
        />
        <p className={styles.notice}>
          Opening <a href={path}>{only.name}</a>…
        </p>
      </main>
    );
  }
  return (
    <main>
      <CityRedirect cities={cities} />
    </main>
  );
}
