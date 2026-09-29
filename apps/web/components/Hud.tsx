'use client';

import { legendEntries, type Atlas, type RenderClass } from '@atlas/renderer';
import { SubdivisionAreas, zoomLevel, type SubdivisionArea } from '@atlas/shared';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { areaAt, scaleBar } from '@/lib/geo';
import { useAtlasInstance, useAtlasStore } from '@/state/store';
import { useUiStore } from '@/state/ui';
import { Compass } from './Compass';
import styles from './Hud.module.css';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const WIDE = '(min-width: 640px)';
const isWide = () => window.matchMedia(WIDE).matches;
const subscribeWide = (onChange: () => void) => {
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/** Load `<city>.subdivisions.json` and keep the subdivision under the view's center current. */
function useSubdivisionTracking(city: string) {
  const [areas, setAreas] = useState<readonly SubdivisionArea[]>([]);
  const center = useAtlasStore((s) => (s.camera ? `${s.camera.lng},${s.camera.lat}` : null));

  useEffect(() => {
    let cancelled = false;
    fetch(`/tiles/${city}.subdivisions.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then((json: unknown) => {
        const parsed = SubdivisionAreas.safeParse(json);
        if (!cancelled && parsed.success) setAreas(parsed.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [city]);

  useEffect(() => {
    if (!center) return;
    const [lng, lat] = center.split(',').map(Number) as [number, number];
    const area = areaAt(areas, lng, lat);
    const next = area ? { name: area.name, approximate: area.approximate } : null;
    const current = useUiStore.getState().subdivision;
    if (current?.name !== next?.name || current?.approximate !== next?.approximate) {
      useUiStore.setState({ subdivision: next });
    }
  }, [areas, center]);
}

function Legend({ subdivisionLabel }: { subdivisionLabel: string }) {
  const zoom = useAtlasStore((s) => s.camera?.zoom ?? 0);
  const theme = useAtlasStore((s) => s.theme);
  const atlas = useAtlasInstance((s) => s.atlas);
  // The classes on screen, as the renderer last reported them (none reported yet: zoom only).
  const [present, setPresent] = useState<{ atlas: Atlas; classes: RenderClass[] } | null>(null);
  useEffect(() => atlas?.on('classeschange', (classes) => setPresent({ atlas, classes })), [atlas]);
  const onScreen = present?.atlas === atlas ? present.classes : undefined;
  // The legend changes only at band edges; round so it isn't rebuilt every frame of a zoom.
  const rounded = Math.round(zoom * 20) / 20;
  const entries = useMemo(
    () => legendEntries(theme, rounded, onScreen),
    [theme, rounded, onScreen],
  );
  // Open on wide screens and collapsed on phones (SPEC.md §8), until the visitor toggles it.
  const wide = useSyncExternalStore(subscribeWide, isWide, () => true);
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? wide;

  return (
    <details
      className={styles.legend}
      open={open}
      onToggle={(e) => {
        const next = (e.target as HTMLDetailsElement).open;
        if (next !== open) setToggled(next);
      }}
    >
      <summary>Legend</summary>
      <ul aria-label="What the glyphs on screen mean">
        {entries.map((entry) => (
          <li key={entry.label}>
            <span className={styles.glyphs} style={{ color: entry.color }} aria-hidden="true">
              {entry.glyphs}
            </span>
            <span>
              {entry.label === 'Subdivision boundary'
                ? `${capitalize(subdivisionLabel)} boundary`
                : entry.label}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ShareButton() {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (status === 'idle') return;
    const timer = window.setTimeout(() => setStatus('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const share = () => {
    // The URL mirrors the view (debounced); write it now so the link is exact.
    const href = window.location.href;
    navigator.clipboard.writeText(href).then(
      () => setStatus('copied'),
      () => setStatus('failed'),
    );
  };
  return (
    <button type="button" className={styles.button} onClick={share}>
      {status === 'copied' ? 'Link copied' : status === 'failed' ? 'Copy failed' : 'Share'}
      <span className={styles.visuallyHidden} role="status">
        {status === 'copied' ? 'Link to this view copied' : ''}
      </span>
    </button>
  );
}

/**
 * The HUD (SPEC.md §5): the zoom and its level, the compass, and the legend top right; the
 * scale bar, the subdivision under the center, coordinates, and sharing bottom left.
 */
export function Hud({ city, subdivisionLabel }: { city: string; subdivisionLabel: string }) {
  useSubdivisionTracking(city);
  const camera = useAtlasStore((s) => s.camera);
  const panelOpen = useAtlasStore((s) => s.selectedId !== null);
  const touring = useAtlasStore((s) => s.tour !== null);
  const subdivision = useUiStore((s) => s.subdivision);
  const [showCoords, setShowCoords] = useState(false);
  if (!camera) return null;

  const bar = scaleBar(camera.lat, camera.zoom);
  const resetView = () =>
    useAtlasInstance.getState().atlas?.setCamera({ pitch: 0, bearing: 0 }, { animate: true });

  return (
    <>
      <div className={styles.topRight}>
        <div className={styles.row}>
          <p className={styles.zoom} aria-label="Zoom">
            z {camera.zoom.toFixed(1)} · {zoomLevel(camera.zoom)}
          </p>
          <Compass onReset={resetView} />
        </div>
        {!panelOpen && <Legend subdivisionLabel={subdivisionLabel} />}
      </div>
      <div className={styles.bottomLeft} data-touring={touring}>
        <div className={styles.scale} aria-label={`Scale: ${bar.label}`}>
          <span className={styles.bar} style={{ width: `${bar.pixels}px` }} />
          <span>{bar.label}</span>
        </div>
        {subdivision && (
          <p className={styles.line}>
            {capitalize(subdivisionLabel)}{' '}
            <span title={subdivision.approximate ? 'Approximate: no mapped boundary' : undefined}>
              {subdivision.approximate ? '≈ ' : ''}
              {subdivision.name}
            </span>
          </p>
        )}
        <div className={styles.row}>
          <button
            type="button"
            className={styles.button}
            aria-pressed={showCoords}
            onClick={() => setShowCoords((v) => !v)}
          >
            {showCoords ? `${camera.lat.toFixed(5)}, ${camera.lng.toFixed(5)}` : 'Coordinates'}
          </button>
          <ShareButton />
        </div>
      </div>
    </>
  );
}
