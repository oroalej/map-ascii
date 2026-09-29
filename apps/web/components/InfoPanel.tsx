'use client';

import { CLASS_LABELS, type FeatureInfo } from '@atlas/renderer';
import type { Landmark, LandmarkArt, SearchEntry } from '@atlas/shared';
import { useEffect, useState } from 'react';
import { loadSearch } from '@/lib/search';
import { useAtlasInstance, useAtlasStore } from '@/state/store';
import { useUiStore } from '@/state/ui';
import { ArtView } from './ArtView';
import styles from './InfoPanel.module.css';

export type InfoPanelProps = {
  city: string;
  /** The city's local word for a subdivision, e.g. "barangay". */
  subdivisionLabel: string;
  landmarks: readonly Landmark[];
  art: readonly LandmarkArt[];
};

/** How long to wait for the selected feature's tile, when the selection came from a URL. */
const FEATURE_POLL_MS = 400;
const FEATURE_POLL_TRIES = 40;

/**
 * What is known about the selected feature, from the renderer (picked now, or once its tile
 * loads) and the search index. Either may be missing: a URL can select a feature whose tile
 * hasn't loaded yet, and most buildings aren't in the index.
 */
function useSelectedDetails(city: string, id: string | null) {
  const picked = useUiStore((s) => s.picked);
  const atlas = useAtlasInstance((s) => s.atlas);
  // Each result is kept with the id it is for, so a stale one is never shown.
  const [loaded, setLoaded] = useState<{ id: string; info: FeatureInfo } | null>(null);
  const [found, setFound] = useState<{ id: string; entry: SearchEntry | null } | null>(null);

  useEffect(() => {
    if (!id || !atlas || picked?.id === id) return;
    let tries = 0;
    const poll = () => {
      const info = atlas.getFeature(id);
      if (info) setLoaded({ id, info });
      else if (++tries < FEATURE_POLL_TRIES) timer = window.setTimeout(poll, FEATURE_POLL_MS);
    };
    let timer = window.setTimeout(poll, 0);
    return () => window.clearTimeout(timer);
  }, [id, atlas, picked]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    loadSearch(city)
      .then((s) => {
        if (!cancelled) setFound({ id, entry: s.entries.get(id) ?? null });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [city, id]);

  const feature = picked?.id === id ? picked : loaded?.id === id ? loaded.info : null;
  const entry = found?.id === id ? found.entry : null;
  return { feature, entry };
}

const osmUrl = (id: string) => {
  const match = /^osm:(node|way|relation)\/(\d+)$/.exec(id);
  return match ? `https://www.openstreetmap.org/${match[1]}/${match[2]}` : null;
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Built 1816", "Built c. 1816", "1816–1945", or null when undated. */
function yearsLine(landmark: Landmark | undefined): string | null {
  if (!landmark?.start_year && !landmark?.end_year) return null;
  const circa = landmark.certainty === 'circa' ? 'c. ' : '';
  const { start_year: start, end_year: end } = landmark;
  if (start && end) return `${circa}${start}–${end}`;
  if (start) return `Built ${circa}${start}`;
  return `Until ${circa}${end}`;
}

/**
 * The info panel (SPEC.md §5): real DOM beside the map, for the selected feature. It shows the
 * name, type, subdivision, story, dates with their certainty, sources, the landmark's drawing,
 * and a link to the feature on OpenStreetMap. Photos arrive in Phase 5 and "Show on timeline"
 * with the timeline in Phase 4.
 */
/** A downward swipe on the sheet's handle this long (CSS px) closes it. */
const SWIPE_CLOSE = 60;

export function InfoPanel({ city, subdivisionLabel, landmarks, art }: InfoPanelProps) {
  const id = useAtlasStore((s) => s.selectedId);
  const { feature, entry } = useSelectedDetails(city, id);
  // On phones the panel is a bottom sheet: peeking, or expanded (SPEC.md §8).
  const [expanded, setExpanded] = useState(false);
  const [swipeFrom, setSwipeFrom] = useState<number | null>(null);
  if (!id) return null;

  const landmark = landmarks.find(
    (l) => l.osm_id === id || (feature?.landmarkId !== undefined && l.id === feature.landmarkId),
  );
  const drawing = art.find((a) => a.osm_id === id);
  const name = landmark?.name.en ?? feature?.name ?? entry?.name;
  const type = landmark
    ? capitalize(landmark.type)
    : feature
      ? (CLASS_LABELS[feature.class as keyof typeof CLASS_LABELS] ?? 'Feature')
      : entry
        ? capitalize(entry.type)
        : 'Feature';
  const subdivision = feature?.subdivision ?? entry?.subdivision;
  const approximate = feature ? feature.subdivisionApprox : entry?.approximate;
  const years = yearsLine(landmark);
  const osm = osmUrl(id);
  const close = () => useAtlasStore.getState().setSelected(null);

  return (
    <aside
      className={styles.panel}
      data-expanded={expanded}
      aria-label="Selected place"
      aria-live="polite"
    >
      <button
        type="button"
        className={styles.handle}
        aria-label={expanded ? 'Collapse panel' : 'Expand panel'}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        onPointerDown={(e) => setSwipeFrom(e.clientY)}
        onPointerUp={(e) => {
          if (swipeFrom !== null && e.clientY - swipeFrom > SWIPE_CLOSE) close();
          setSwipeFrom(null);
        }}
      />
      <header className={styles.header}>
        <p className={styles.type}>{type}</p>
        <button type="button" className={styles.close} onClick={close} aria-label="Close panel">
          ×
        </button>
      </header>
      <h2 className={styles.name}>{name ?? `Unnamed ${type.toLowerCase()}`}</h2>
      {subdivision && (
        <p className={styles.meta}>
          {capitalize(subdivisionLabel)}{' '}
          <span title={approximate ? 'Approximate: this area has no mapped boundary' : undefined}>
            {approximate ? '≈ ' : ''}
            {subdivision}
          </span>
        </p>
      )}
      {years && (
        <p className={styles.meta}>
          {years}
          {landmark?.certainty === 'circa' && <span className={styles.badge}>circa</span>}
        </p>
      )}
      {drawing && <ArtView art={drawing} />}
      {landmark?.story && (
        <div className={styles.story}>
          {landmark.story.en.split(/\n\s*\n/).map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </div>
      )}
      {landmark && landmark.sources.length > 0 && (
        <section className={styles.sources}>
          <h3>Sources</h3>
          <ul>
            {landmark.sources.map((source, i) => (
              <li key={i}>
                {source.url ? (
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {source.title}
                  </a>
                ) : (
                  source.title
                )}
                {source.note && <span className={styles.note}> — {source.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {osm && (
        <p className={styles.links}>
          <a href={osm} target="_blank" rel="noreferrer">
            View on OpenStreetMap
          </a>
        </p>
      )}
    </aside>
  );
}
