import styles from './CityRedirect.module.css';

type CityLink = { slug: string; name: string };

/**
 * Sends `/` to the only city, keeping any view parameters, so `/?lat=…` links still work.
 * With several cities it lists them (Phase 6 replaces the list with the ASCII city picker).
 */
export function CityRedirect({ cities }: { cities: CityLink[] }) {
  return (
    <nav className={styles.notice} aria-label="Cities">
      <ul>
        {cities.map((city) => (
          <li key={city.slug}>
            <a href={`/${city.slug}`}>{city.name}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
