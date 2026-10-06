'use client';

import type { CSSProperties } from 'react';
import type { TourRun } from '@/lib/tour';
import { useUiStore } from '@/state/ui';
import { useSmallScreen } from '@/lib/screen';
import { tourControls, useTourStore } from '@/state/tour';
import styles from './TourPlayer.module.css';

/**
 * The whole tour's progress: finished steps, plus the current step's dwell, which runs as a CSS
 * animation (paused runs sit still), so nothing re-renders per frame.
 */
function Progress({ run }: { run: TourRun }) {
  const count = run.durations.length;
  const total = run.durations[run.step] ?? 0;
  const done =
    run.phase === 'ended' ? 1 : run.phase === 'dwelling' && total > 0 ? run.elapsed / total : 0;
  const from = (run.step + done) / count;
  const to = run.phase === 'ended' ? 1 : (run.step + 1) / count;
  const running = run.since !== null;
  const style = {
    '--from': from,
    '--to': to,
    animationDuration: `${Math.max(0, total - run.elapsed)}ms`,
  } as CSSProperties;
  return (
    <div
      className={styles.track}
      role="progressbar"
      aria-label="Tour progress"
      aria-valuemin={0}
      aria-valuemax={count}
      aria-valuenow={run.phase === 'ended' ? count : run.step + 1}
    >
      <div
        // A new key restarts the animation from `--from`.
        key={`${run.step}:${run.phase}:${run.since}`}
        className={styles.fill}
        data-running={running}
        style={style}
      />
    </div>
  );
}

/**
 * The tour's caption card (SPEC.md §6): the step's narration, progress, and controls, plus a
 * "Resume tour" chip once the visitor has taken the camera. Draft narration is shown as
 * written, `TODO(verify)` and all, so unchecked text stays visibly unchecked.
 */
export function TourPlayer() {
  const active = useTourStore((s) => s.active);
  const factsVisible = useUiStore((s) => s.factsVisible);
  const small = useSmallScreen();
  if (!active || (small && factsVisible)) return null;

  const { tour, run } = active;
  const step = tour.steps[run.step];
  const count = tour.steps.length;
  const ended = run.phase === 'ended';

  return (
    <section className={styles.card} aria-label="Tour" data-speech-obstacle>
      {run.grabbed && !ended && (
        <button type="button" className={styles.chip} onClick={tourControls.resume}>
          ▶ Resume tour
        </button>
      )}
      <header className={styles.header}>
        <p className={styles.kicker}>
          Tour
          {tour.status === 'draft' && (
            <span className={styles.badge} title="Narration not yet checked against sources">
              draft
            </span>
          )}
        </p>
        <p className={styles.count} aria-label={`Step ${run.step + 1} of ${count}`}>
          {run.step + 1} / {count}
        </p>
        <button
          type="button"
          className={styles.close}
          onClick={tourControls.exit}
          aria-label="Exit tour"
        >
          ×
        </button>
      </header>
      <h2 className={styles.title}>{tour.title.en}</h2>
      <p className={styles.narration} aria-live="polite">
        {ended ? 'End of the tour.' : step?.narration.en}
      </p>
      {!ended && step?.sources && (
        <p className={styles.sources}>
          Sources:{' '}
          {step.sources.map((source, i) => (
            <span key={i}>
              {i > 0 && ' · '}
              {source.url ? (
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.title}
                </a>
              ) : (
                source.title
              )}
            </span>
          ))}
        </p>
      )}
      <Progress run={run} />
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.button}
          onClick={tourControls.prev}
          disabled={run.step === 0 && !ended}
          aria-label="Previous step"
        >
          ‹ Prev
        </button>
        <button type="button" className={styles.button} onClick={tourControls.toggle}>
          {ended ? 'Replay' : run.paused ? 'Play' : 'Pause'}
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={tourControls.next}
          disabled={ended}
          aria-label="Next step"
        >
          Next ›
        </button>
      </div>
    </section>
  );
}
