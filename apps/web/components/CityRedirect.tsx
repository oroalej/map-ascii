'use client';

import { useEffect } from 'react';
import styles from './CityRedirect.module.css';

type CityLink = { slug: string; name: string };

/**
 * Sends `/` to the only city, keeping any view parameters, so `/?lat=…` links still work.
 * With several cities it lists them (Phase 6 replaces the list with the ASCII city picker).
 */
export function CityRedirect({ cities }: { cities: CityLink[] }) {
  const only = cities.length === 1 ? cities[0] : undefined;

  useEffect(() => {
    if (!only) return;
    const { search, hash } = window.location;
    window.location.replace(`/${only.slug}${search}${hash}`);
  }, [only]);

  if (only) {
    return (
      <p className={styles.notice}>
        Opening <a href={`/${only.slug}`}>{only.name}</a>…
      </p>
    );
  }
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
