'use client';
import type { Landmark, LandmarkFact } from '@atlas/shared';
import styles from './LandmarkDetails.module.css';

type Sources = readonly Landmark['sources'][number][];
export function Citation({
  sources,
  source,
  prefix,
}: {
  sources: Sources;
  source: number;
  prefix: string;
}) {
  const url = sources[source]?.url;
  return (
    <sup>
      <a
        href={url ?? `#${prefix}-source-${source}`}
        target={url ? '_blank' : undefined}
        rel="noreferrer"
        aria-label={`Source ${source + 1}`}
        onClick={
          url
            ? undefined
            : (event) => {
                event.preventDefault();
                document
                  .getElementById(`${prefix}-source-${source}`)
                  ?.scrollIntoView({ block: 'nearest' });
              }
        }
      >
        [{source + 1}]
      </a>
    </sup>
  );
}
export function FactList({
  facts,
  sources,
  prefix,
}: {
  facts: readonly LandmarkFact[];
  sources: Sources;
  prefix: string;
}) {
  return (
    <ul className={styles.facts}>
      {facts.map((fact, index) => (
        <li key={index}>
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
          <Citation sources={sources} source={fact.source} prefix={prefix} />
        </li>
      ))}
    </ul>
  );
}
export function SourceList({ sources, prefix }: { sources: Sources; prefix: string }) {
  const ordered = sources
    .map((source, index) => ({ source, index }))
    .sort(
      (a, b) =>
        Number(a.source.title.startsWith('OpenStreetMap')) -
        Number(b.source.title.startsWith('OpenStreetMap')),
    );
  return (
    <section className={styles.sources}>
      <h3>Sources</h3>
      <ul>
        {ordered.map(({ source, index }) => (
          <li id={`${prefix}-source-${index}`} key={index}>
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
  );
}
