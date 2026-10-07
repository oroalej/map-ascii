'use client';
import type { Landmark, LandmarkArt } from '@atlas/shared';
import type { useSelectedDetails } from '@/state/useSelectedDetails';
import { selectPlace } from '@/state/selection';
import { ArtView } from './ArtView';
import styles from './LandmarkDetails.module.css';

export type LandmarkDetailsProps = {
  landmark: Landmark;
  drawing: LandmarkArt | undefined;
  details: ReturnType<typeof useSelectedDetails>;
  subdivisionLabel: string;
  headingId: string;
};
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export function LandmarkDetails({
  landmark,
  drawing,
  details: { feature, entry },
  subdivisionLabel,
  headingId,
}: LandmarkDetailsProps) {
  // Keep original source indices for citations while displaying OSM attribution last.
  const sources = landmark.sources
    .map((source, index) => ({ source, index }))
    .sort(
      (a, b) =>
        Number(a.source.title.startsWith('OpenStreetMap')) -
        Number(b.source.title.startsWith('OpenStreetMap')),
    );
  const subdivision = feature?.subdivision ?? entry?.subdivision;
  const approximate = feature ? feature.subdivisionApprox : entry?.approximate;
  const { start_year: start, end_year: end } = landmark;
  const circa = landmark.certainty === 'circa' ? 'c. ' : '';
  const years =
    start !== undefined
      ? end !== undefined
        ? `${circa}${start}–${end}`
        : `Built ${circa}${start}`
      : end !== undefined
        ? `Until ${circa}${end}`
        : null;
  return (
    <>
      <header className={styles.header}>
        <p className={styles.type}>{capitalize(landmark.type)}</p>
        <button
          type="button"
          className={styles.close}
          onClick={() => selectPlace(null)}
          aria-label="Close"
        >
          ×
        </button>
      </header>
      <h2 id={headingId} tabIndex={-1} className={styles.name}>
        {landmark.name.en}
      </h2>
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
          {landmark.certainty === 'circa' && <span className={styles.badge}>circa</span>}
        </p>
      )}
      <ul className={styles.facts}>
        {landmark.facts?.map((fact, i) => (
          <li key={i}>
            {fact.year !== undefined && (
              <>
                <span>
                  {fact.certainty === 'circa' ? 'c. ' : ''}
                  {fact.year}:{' '}
                </span>
                {fact.certainty === 'circa' && <span className={styles.badge}>circa</span>}{' '}
              </>
            )}
            {fact.text.en}
            <sup>
              <a
                href={landmark.sources[fact.source]?.url ?? `#${headingId}-source-${fact.source}`}
                target={landmark.sources[fact.source]?.url ? '_blank' : undefined}
                rel="noreferrer"
                aria-label={`Source ${fact.source + 1}`}
                onClick={
                  landmark.sources[fact.source]?.url
                    ? undefined
                    : (event) => {
                        event.preventDefault();
                        document
                          .getElementById(`${headingId}-source-${fact.source}`)
                          ?.scrollIntoView({ block: 'nearest' });
                      }
                }
              >
                [{fact.source + 1}]
              </a>
            </sup>
          </li>
        ))}
      </ul>
      {drawing && (
        <details className={styles.drawing}>
          <summary>Drawing</summary>
          <ArtView art={drawing} />
        </details>
      )}
      {landmark.story && (
        <div className={styles.story}>
          {landmark.story.en.split(/\n\s*\n/).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}
      <section className={styles.sources}>
        <h3>Sources</h3>
        <ul>
          {sources.map(({ source, index: i }) => (
            <li id={`${headingId}-source-${i}`} key={i}>
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
    </>
  );
}
