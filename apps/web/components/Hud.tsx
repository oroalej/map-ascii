'use client';

import { legendEntries, type Atlas, type RenderClass, type WindChoice } from '@atlas/renderer';
import {
  seasonalWind,
  windArrow,
  zoomLevel,
  type ClimateConfig,
  type SubdivisionArea,
} from '@atlas/shared';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { areaAt, scaleBar } from '@/lib/geo';
import { isSubdivisionAreas } from '@/lib/guards';
import { TIME_CHOICES, useLifeStore, WIND_CHOICES, type TimeChoice } from '@/state/life';
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
        if (!cancelled && isSubdivisionAreas(json)) setAreas(json);
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
  const life = useLifeShown();
  // The classes on screen, as the renderer last reported them (none reported yet: zoom only).
  const [present, setPresent] = useState<{ atlas: Atlas; classes: RenderClass[] } | null>(null);
  useEffect(() => atlas?.on('classeschange', (classes) => setPresent({ atlas, classes })), [atlas]);
  const onScreen = present?.atlas === atlas ? present.classes : undefined;
  // The legend changes only at band edges; round so it isn't rebuilt every frame of a zoom.
  const rounded = Math.round(zoom * 20) / 20;
  const entries = useMemo(
    () => legendEntries(theme, rounded, onScreen, { life }),
    [theme, rounded, onScreen, life],
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

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const prefersReducedMotion = () => window.matchMedia(REDUCED_MOTION).matches;
const subscribeReducedMotion = (onChange: () => void) => {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/** Whether the life layer's agents are on screen (never with reduced motion). */
function useLifeShown() {
  const enabled = useLifeStore((s) => s.enabled);
  const reduced = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
  return enabled && !reduced;
}

const TIME_LABELS: Record<TimeChoice, string> = {
  live: 'Time: live',
  day: 'Time: day',
  dusk: 'Time: dusk',
  night: 'Time: night',
};

const WIND_TITLES: Record<WindChoice, string> = {
  live: "The season's wind in the city",
  calm: 'A calm day',
  breeze: 'A breeze',
  gusty: 'Gusty',
  storm: 'A storm',
};

const noSubscription = () => () => {};
/** This month (1–12) in the browser; none while rendering on the server (static export). */
const useMonth = () =>
  useSyncExternalStore(
    noSubscription,
    () => new Date().getMonth() + 1,
    () => null,
  );

/**
 * The life layer (SPEC.md §4 "Life layer"): simulated traffic, people, boats, and birds on or
 * off, the time of day the map is lit for (cycling live → day → dusk → night), and the wind
 * over grass, trees, and water (live → calm → breeze → gusty → storm), with an arrow the way
 * the season's wind blows.
 */
function LifeControls({ climate }: { climate?: ClimateConfig | undefined }) {
  const enabled = useLifeStore((s) => s.enabled);
  const time = useLifeStore((s) => s.time);
  const wind = useLifeStore((s) => s.wind);
  const month = useMonth();
  const reduced = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
  const nextTime = TIME_CHOICES[(TIME_CHOICES.indexOf(time) + 1) % TIME_CHOICES.length]!;
  const nextWind = WIND_CHOICES[(WIND_CHOICES.indexOf(wind) + 1) % WIND_CHOICES.length]!;
  const arrow = month === null ? '' : ` ${windArrow(seasonalWind(climate, month).from)}`;
  return (
    <>
      <button
        type="button"
        className={`${styles.button} ${styles.toggle}`}
        aria-pressed={enabled && !reduced}
        disabled={reduced}
        title={
          reduced
            ? 'Off while your system asks for reduced motion'
            : 'Simulated traffic, people, boats, and birds'
        }
        onClick={() => useLifeStore.setState({ enabled: !enabled })}
      >
        Life
      </button>
      <button
        type="button"
        className={styles.button}
        title={
          time === 'live' ? 'Lit for the real time of day in the city' : 'Lit for a fixed time'
        }
        onClick={() => useLifeStore.setState({ time: nextTime })}
      >
        {TIME_LABELS[time]}
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={reduced}
        title={reduced ? 'Still while your system asks for reduced motion' : WIND_TITLES[wind]}
        onClick={() => useLifeStore.setState({ wind: nextWind })}
      >
        Wind{arrow}: {wind}
      </button>
    </>
  );
}

/**
 * River processions (SPEC.md §4 "Processions"): a button to play each, and while one is under
 * way, what it is and whether it is live. A draft says its route and schedule aren't verified.
 */
function ProcessionControls() {
  const processions = useUiStore((s) => s.processions);
  const run = useUiStore((s) => s.procession);
  const atlas = useAtlasInstance((s) => s.atlas);
  const life = useLifeShown();
  if (processions.length === 0) return null;
  const current = run && processions.find((p) => p.id === run.id);
  const play = (id: string) => {
    const route = processions.find((p) => p.id === id);
    if (!atlas || !route || !atlas.playProcession(id)) return;
    const [lng, lat] = route.route[0]!;
    atlas.flyTo({ lng, lat, zoom: Math.max(17.5, atlas.getCamera().zoom) });
  };
  return (
    <>
      {processions.map((p) => (
        <div className={styles.row} key={p.id}>
          <button
            type="button"
            className={styles.button}
            disabled={!life}
            title={life ? 'Play it as a time-lapse' : 'Turn Life on to see it'}
            onClick={() => play(p.id)}
          >
            ▶ {p.title.en}
          </button>
        </div>
      ))}
      {current && (
        <div className={styles.row}>
          <p className={styles.line} role="status">
            {current.title.en} (simulated){run.live ? ' · happening now' : ''}
            {current.status === 'draft' ? ' · draft: route and schedule not yet verified' : ''}
          </p>
          {!run.live && (
            <button type="button" className={styles.button} onClick={() => atlas?.stopProcession()}>
              Stop
            </button>
          )}
        </div>
      )}
    </>
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
export function Hud({
  city,
  subdivisionLabel,
  climate,
}: {
  city: string;
  subdivisionLabel: string;
  climate?: ClimateConfig | undefined;
}) {
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
        <div className={styles.row}>
          <LifeControls climate={climate} />
        </div>
        <ProcessionControls />
      </div>
    </>
  );
}
