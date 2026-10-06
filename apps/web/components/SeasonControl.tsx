'use client';

import { eventOccurrence, type RuntimeSeasonConfig } from '@atlas/shared';
import { useSyncExternalStore } from 'react';
import { useAtlasInstance } from '@/state/store';
import { useLifeStore } from '@/state/life';
import { useUiStore } from '@/state/ui';
import { ProcessionPlayButton } from './ProcessionPlayButton';
import styles from './Hud.module.css';

export function useSeasonState() {
  const atlas = useAtlasInstance((s) => s.atlas);
  return useSyncExternalStore(
    (change) => atlas?.on('seasonchange', change) ?? (() => {}),
    () => atlas?.getSeason() ?? null,
    () => null,
  );
}

export function useShownSeason(seasons?: readonly RuntimeSeasonConfig[]) {
  const choice = useLifeStore((s) => s.season ?? 'auto');
  const active = useSeasonState();
  const selected = seasons?.find((s) => s.id === choice);
  const shown =
    selected ?? (choice === 'auto' ? seasons?.find((s) => s.id === active?.id) : undefined);
  return { choice, selected, shown };
}

/** Preview changes the decorative calendar only; time, timeline and URL remain independent. */
export function SeasonControl({
  seasons,
}: {
  seasons?: readonly RuntimeSeasonConfig[] | undefined;
}) {
  const { choice, selected, shown } = useShownSeason(seasons);
  if (!seasons?.length) return null;
  const label = selected ? selected.title.en : `Today${shown ? ` · ${shown.title.en}` : ''}`;
  const choices = ['auto', ...seasons.map((s) => s.id)];
  const next = choices[(Math.max(0, choices.indexOf(choice)) + 1) % choices.length]!;
  return (
    <div className={styles.seasonControl}>
      <button
        type="button"
        className={styles.button}
        aria-label={`Season: ${label}`}
        title="Preview seasonal decorations"
        onClick={() => useLifeStore.setState({ season: next })}
      >
        {label}
      </button>
    </div>
  );
}

/** A separate row below the controls, linked to the shown season through pack metadata. */
export function SeasonEvents({
  seasons,
}: {
  seasons?: readonly RuntimeSeasonConfig[] | undefined;
}) {
  const { shown } = useShownSeason(seasons);
  const processions = useUiStore((s) => s.processions);
  if (!shown) return null;
  const now = new Date();
  const events = processions
    .filter((p) => p.season === shown.id)
    .map((p) => ({ p, start: eventOccurrence(p.schedule, now).startMs }))
    .sort((a, b) => a.start - b.start || a.p.id.localeCompare(b.p.id))
    .map(({ p }) => p);
  if (!events.length) return null;
  return (
    <div className={styles.row}>
      {events.map((p) => (
        <ProcessionPlayButton key={p.id} id={p.id} label={p.label!.en} />
      ))}
    </div>
  );
}
