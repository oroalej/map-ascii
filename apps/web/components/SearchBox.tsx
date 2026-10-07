'use client';

import type { SearchEntry } from '@atlas/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { typingInField } from '@/lib/dom';
import { loadSearch, search, TYPE_LABELS, type CitySearch } from '@/lib/search';
import { useAtlasInstance } from '@/state/store';
import { selectPlace } from '@/state/selection';
import type { SelectionOrigin } from '@/state/ui';
import styles from './SearchBox.module.css';

type LoadState = { status: 'idle' | 'loading' | 'error' } | { status: 'ready'; data: CitySearch };

/** Fly to a search result, select it, and highlight everything it stands for. */
export function goToEntry(entry: SearchEntry, origin: SelectionOrigin) {
  const atlas = useAtlasInstance.getState().atlas;
  selectPlace(entry.id, { origin });
  if (!atlas) return;
  atlas.setHighlighted(entry.featureIds ?? []);
  atlas.flyTo({ lat: entry.lat, lng: entry.lng, zoom: entry.zoomHint });
}

/**
 * Search (SPEC.md §5): `/` focuses it; results are grouped by type and show their subdivision;
 * arrow keys move through them, Enter flies to the active (or top) one, Esc clears or leaves.
 * The index loads on first focus.
 */
export function SearchBox({ city, subdivisionLabel }: { city: string; subdivisionLabel: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [load, setLoad] = useState<LoadState>({ status: 'idle' });
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  const ensureLoaded = () => {
    if (load.status === 'ready' || load.status === 'loading') return;
    setLoad({ status: 'loading' });
    loadSearch(city).then(
      (data) => setLoad({ status: 'ready', data }),
      () => setLoad({ status: 'error' }),
    );
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || typingInField()) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const groups = useMemo(
    () => (load.status === 'ready' ? search(load.data, query) : []),
    [load, query],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.entries), [groups]);
  const showList = open && query.trim().length > 0;

  const choose = (entry: SearchEntry | undefined, origin: SelectionOrigin) => {
    if (!entry) return;
    goToEntry(entry, origin);
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length === 0) return;
      setOpen(true);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + flat.length) % flat.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(flat[active] ?? flat[0], 'keyboard');
    } else if (e.key === 'Escape') {
      // Keep the global Esc (close the panel) out of it.
      e.preventDefault();
      if (query) {
        setQuery('');
      } else {
        inputRef.current?.blur();
      }
    }
  };

  const optionId = (i: number) => `${listId}-option-${i}`;

  return (
    <div className={styles.search} data-speech-obstacle>
      <input
        ref={inputRef}
        className={styles.input}
        type="search"
        role="combobox"
        aria-label="Search places"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && flat[active] ? optionId(active) : undefined}
        placeholder="Search  /"
        value={query}
        onFocus={() => {
          ensureLoaded();
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoComplete="off"
      />
      {showList && (
        <div id={listId} role="listbox" className={styles.results} aria-label="Search results">
          {load.status === 'loading' && <p className={styles.status}>Loading…</p>}
          {load.status === 'error' && <p className={styles.status}>Search is unavailable.</p>}
          {load.status === 'ready' && flat.length === 0 && (
            <p className={styles.status}>No places match “{query.trim()}”.</p>
          )}
          {groups.map((group) => (
            <div key={group.type} role="group" aria-label={TYPE_LABELS[group.type]}>
              <p className={styles.group} aria-hidden="true">
                {TYPE_LABELS[group.type]}
              </p>
              {group.entries.map((entry) => {
                const i = flat.indexOf(entry);
                return (
                  <div
                    key={entry.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    className={styles.option}
                    data-active={i === active}
                    // Keep focus in the input while clicking a result.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(entry, 'pointer')}
                  >
                    <span className={styles.name}>{entry.name}</span>
                    {entry.subdivision && (
                      <span className={styles.where}>
                        {entry.approximate ? '≈ ' : ''}
                        {entry.subdivision}
                        <span className={styles.visuallyHidden}> ({subdivisionLabel})</span>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
