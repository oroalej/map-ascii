import styles from './Attribution.module.css';

/** Always-visible source attribution (see docs/DATA.md §6). */
export function Attribution() {
  return (
    <footer className={styles.attribution}>
      ©{' '}
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
        OpenStreetMap contributors
      </a>
    </footer>
  );
}
