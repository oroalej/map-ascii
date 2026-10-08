'use client';

import { cityTime, legendEntries, legendGroup } from '@atlas/renderer/hud';
import {
  type Atlas,
  type FixtureVisibility,
  type LegendIcon,
  type RenderClass,
  type WindChoice,
} from '@atlas/renderer';
import {
  seasonalWind,
  windArrow,
  zoomLevel,
  type ClimateConfig,
  type RuntimeDialogueCatalog,
  type SubdivisionArea,
} from '@atlas/shared';
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { areaAt, scaleBar } from '@/lib/geo';
import { prefersReducedMotion, subscribeReducedMotion } from '@/lib/motion';
import { afterFirstTileFrame } from '@/lib/startup';
import { isSubdivisionAreas } from '@/lib/guards';
import { useSmallScreen } from '@/lib/screen';
import { TIME_CHOICES, useLifeStore, WIND_CHOICES, type TimeChoice } from '@/state/life';
import { QUALITY_CHOICES, useQualityStore } from '@/state/quality';
import { useAtlasInstance, useAtlasStore } from '@/state/store';
import { useUiStore } from '@/state/ui';
import styles from './Hud.module.css';
import { SeasonControl, SeasonEvents, useSeasonState } from './SeasonControl';
import { useLifeShown } from './useProcessionPlayback';
import { ProcessionPlayButton } from './ProcessionPlayButton';
import type { RuntimeSeasonConfig } from '@atlas/shared';
import { SpeechControls } from './SpeechControls';
import { EmojiControls } from './EmojiControls';
import { useEmojiStore } from '@/state/emoji';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function QualityControl() {
  const choice = useQualityStore((s) => s.choice);
  const atlas = useAtlasInstance((s) => s.atlas);
  const name = useSyncExternalStore(
    (change) => atlas?.on('qualitychange', change) ?? (() => {}),
    () => atlas?.getStats().quality.name ?? 'high',
    () => 'high',
  );
  return (
    <button
      type="button"
      className={styles.button}
      title={
        choice === 'auto' ? `Automatic quality: ${name}` : `${capitalize(choice)} drawing quality`
      }
      onClick={() =>
        useQualityStore.setState({
          choice: QUALITY_CHOICES[(QUALITY_CHOICES.indexOf(choice) + 1) % QUALITY_CHOICES.length]!,
        })
      }
    >
      Quality: {capitalize(choice)}
    </button>
  );
}

/** A camera value rounded to `step`, so a component re-renders only when what it shows moves. */
const round = (value: number, step: number) => Math.round(value / step) * step;

/** Load `<city>.subdivisions.json` and keep the subdivision under the view's center current. */
const EMPTY_AREAS: readonly SubdivisionArea[] = [];
function useSubdivisionTracking(city: string) {
  const [loaded, setAreas] = useState<{ city: string; areas: readonly SubdivisionArea[] } | null>(
    null,
  );
  const areas = loaded?.city === city ? loaded.areas : EMPTY_AREAS;
  // To about 10 m: the name under the center doesn't need looking up every frame of a pan.
  const center = useAtlasStore((s) =>
    s.camera ? `${round(s.camera.lng, 1e-4)},${round(s.camera.lat, 1e-4)}` : null,
  );

  useEffect(() => {
    let cancelled = false;
    const off = afterFirstTileFrame(city, () => {
      void fetch(`/tiles/${city}.subdivisions.json`)
        .then((r) => (r.ok ? r.json() : []))
        .then((json: unknown) => {
          if (!cancelled && isSubdivisionAreas(json)) setAreas({ city, areas: json });
        })
        .catch(() => {});
    });
    return () => {
      off();
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

/** A legend picture drawn pixel by pixel, one run of same-colored pixels per rect. */
const PixelIcon = memo(function PixelIcon({ icon }: { icon: LegendIcon }) {
  const { pixels, paint, tone } = icon;
  const runs: { x: number; y: number; width: number; fill: string }[] = [];
  pixels.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const ink = row[x]!;
      let end = x + 1;
      while (row[end] === ink) end++;
      if (ink !== '.') runs.push({ x, y, width: end - x, fill: ink === '#' ? paint : tone });
      x = end;
    }
  });
  return (
    <svg
      className={styles.icon}
      viewBox={`0 0 ${pixels[0]?.length ?? 0} ${pixels.length}`}
      shapeRendering="crispEdges"
    >
      {runs.map(({ x, y, width, fill }) => (
        <rect key={`${x},${y}`} x={x} y={y} width={width} height={1} fill={fill} />
      ))}
    </svg>
  );
});

function LegendControls({
  subdivisionLabel,
  sidewalksDerived,
  hidden,
  climate,
}: {
  subdivisionLabel: string;
  sidewalksDerived: boolean;
  hidden: boolean;
  climate?: ClimateConfig | undefined;
}) {
  // The legend changes only at band edges; round so it isn't rebuilt every frame of a zoom.
  const rounded = useAtlasStore((s) => round(s.camera?.zoom ?? 0, 0.05));
  const theme = useAtlasStore((s) => s.theme);
  const atlas = useAtlasInstance((s) => s.atlas);
  const life = useLifeShown();
  const focused = useUiStore((s) => s.legendFocus);
  const summary = useRef<HTMLElement>(null);
  const header = useRef<HTMLDivElement>(null);
  // The classes on screen, as the renderer last reported them (none reported yet: zoom only).
  const [present, setPresent] = useState<{ atlas: Atlas; classes: RenderClass[] } | null>(null);
  useEffect(() => atlas?.on('classeschange', (classes) => setPresent({ atlas, classes })), [atlas]);
  const onScreen = present?.atlas === atlas ? present.classes : undefined;
  // Whether the streetlights are lit, as the renderer last reported (none reported yet: not).
  const [lit, setLit] = useState<{ atlas: Atlas; on: boolean } | null>(null);
  useEffect(() => atlas?.on('lightschange', (on) => setLit({ atlas, on })), [atlas]);
  const lights = lit?.atlas === atlas && lit.on;
  const [hardware, setHardware] = useState<{ atlas: Atlas; fixtures: FixtureVisibility } | null>(
    null,
  );
  useEffect(
    () => atlas?.on('fixtureschange', (fixtures) => setHardware({ atlas, fixtures })),
    [atlas],
  );
  const fixtures = hardware?.atlas === atlas ? hardware.fixtures : undefined;
  const [haunted, setHaunted] = useState<{ atlas: Atlas; on: boolean } | null>(null);
  useEffect(() => atlas?.on('folklorechange', (on) => setHaunted({ atlas, on })), [atlas]);
  const folklore = haunted?.atlas === atlas && haunted.on;
  const season = useSeasonState();
  const emoji = useEmojiStore((s) => s.enabled);
  const entries = useMemo(
    () =>
      legendEntries(theme, rounded, onScreen, {
        life,
        lights,
        sidewalksDerived,
        fixtures,
        season,
        emoji,
        folklore,
        riceCalendar: Boolean(climate?.crops?.rice),
      }),
    [
      theme,
      rounded,
      onScreen,
      life,
      lights,
      sidewalksDerived,
      fixtures,
      season,
      emoji,
      folklore,
      climate,
    ],
  );
  // Replacements start clean; cleanup touches only the instance it belongs to.
  useEffect(() => {
    useUiStore.setState({ legendFocus: null });
    return () => atlas?.setFocus(null);
  }, [atlas]);
  const selected = entries.find((entry) => entry.id === focused && entry.focus);
  useEffect(() => {
    atlas?.setFocus(selected?.focus ?? null);
    if (focused && !selected) useUiStore.setState({ legendFocus: null });
  }, [atlas, selected, focused]);
  const hasFocus = selected !== undefined;
  useLayoutEffect(() => {
    const element = header.current;
    if (!element) return;
    const style = document.documentElement.style;
    const publish = () => {
      const bottom = `${element.getBoundingClientRect().bottom}px`;
      style.setProperty('--hud-header-bottom', bottom);
      if (hasFocus) style.setProperty('--focus-header-bottom', bottom);
      else style.removeProperty('--focus-header-bottom');
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    window.addEventListener('resize', publish);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', publish);
      style.removeProperty('--hud-header-bottom');
      style.removeProperty('--focus-header-bottom');
    };
  }, [hasFocus]);
  const displayLabel = (entry: (typeof entries)[number]) =>
    entry.id === 'class:admin_subdivision'
      ? `${capitalize(subdivisionLabel)} boundary`
      : legendGroup(entry) === 'Simulated'
        ? entry.label.replace(/ \(simulated\)$/, '')
        : entry.label;
  const clearFocus = () => {
    useUiStore.setState({ legendFocus: null });
    const target = !hidden
      ? summary.current
      : document.querySelector<HTMLCanvasElement>('canvas[tabindex="0"]');
    target?.focus({ preventScroll: true });
  };
  // Open on wide screens and collapsed on phones (SPEC.md §8), until the visitor toggles it.
  const wide = !useSmallScreen();
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? wide;

  return (
    <>
      <div className={`${styles.row} ${styles.header}`} ref={header}>
        <ZoomReadout />
        {selected && (
          <button
            type="button"
            className={`${styles.button} ${styles.focusClear}`}
            aria-label={`Clear legend focus: ${displayLabel(selected)}`}
            title={`Clear legend focus: ${displayLabel(selected)}`}
            onClick={clearFocus}
          >
            <span className={styles.focusLabel}>Focus: {displayLabel(selected)}</span>
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      <details
        className={styles.legend}
        hidden={hidden}
        open={open}
        onToggle={(e) => {
          const next = (e.target as HTMLDetailsElement).open;
          if (next !== open) setToggled(next);
        }}
      >
        <summary ref={summary}>Legend</summary>
        {(['Map', 'Simulated'] as const).map((group) => {
          const grouped = entries.filter((entry) => legendGroup(entry) === group);
          if (!grouped.length) return null;
          return (
            <section key={group} className={styles.legendGroup} aria-label={group}>
              <h3>{group}</h3>
              <ul aria-label={`${group} glyphs on screen`}>
                {grouped.map((entry) => {
                  const content = (
                    <>
                      <span
                        className={`${styles.glyphs} ${entry.id === 'info:emoji' ? styles.emojiGlyphs : ''}`}
                        style={{ color: entry.color }}
                        aria-hidden="true"
                      >
                        {entry.icons
                          ? entry.icons.map((icon, i) => <PixelIcon key={i} icon={icon} />)
                          : entry.glyphs}
                      </span>
                      <span className={styles.legendLabel}>{displayLabel(entry)}</span>
                    </>
                  );
                  return (
                    <li key={entry.id}>
                      {entry.focus ? (
                        <button
                          type="button"
                          className={styles.legendEntry}
                          aria-pressed={focused === entry.id}
                          onClick={() =>
                            useUiStore.setState({
                              legendFocus: focused === entry.id ? null : entry.id,
                            })
                          }
                        >
                          {content}
                        </button>
                      ) : (
                        content
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </details>
    </>
  );
}

const TIME_LABELS: Record<TimeChoice, string> = {
  live: 'Time: live',
  dawn: 'Time: 05:30',
  morning: 'Time: 08:00',
  noon: 'Time: 12:00',
  dusk: 'Time: 18:00',
  night: 'Time: 22:00',
};

const WIND_TITLES: Record<WindChoice, string> = {
  live: "The season's wind in the city",
  calm: 'A calm day',
  breeze: 'A breeze',
  gusty: 'Gusty',
  storm: 'A storm',
};

const noSubscription = () => () => {};
/**
 * This month (1–12) in the city, by its time zone (else the sun's time at `lng`); none while
 * rendering on the server (static export).
 */
const useCityMonth = (timezone: string | undefined, lng: number) =>
  useSyncExternalStore(
    noSubscription,
    () => cityTime(new Date(), { timezone, lng }).month,
    () => null,
  );

/**
 * The life layer (SPEC.md §4 "Life layer"): simulated traffic, people, boats, and birds on or
 * off, the time of day in the city (cycling live → 05:30 → 08:00 → 12:00 → 18:00 → 22:00), and the wind
 * over grass, trees, and water (live → calm → breeze → gusty → storm), with an arrow the way
 * the season's wind blows.
 */
function LifeControls({
  climate,
  timezone,
}: {
  climate?: ClimateConfig | undefined;
  timezone?: string | undefined;
}) {
  const enabled = useLifeStore((s) => s.enabled);
  const time = useLifeStore((s) => s.time);
  const run = useUiStore((s) => s.procession);
  const eventTime = run && !run.live ? run.time : undefined;
  const wind = useLifeStore((s) => s.wind);
  // With no time zone, the sun's time at the view's longitude, to the degree (4 minutes).
  const month = useCityMonth(
    timezone,
    useAtlasStore((s) => (timezone ? 0 : Math.round(s.camera?.lng ?? 0))),
  );
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
        disabled={!!eventTime}
        title={
          time === 'live'
            ? 'The time of day in the city now'
            : 'A fixed time of day in the city: its light and its traffic'
        }
        onClick={() => useLifeStore.setState({ time: nextTime })}
      >
        {eventTime ? `${eventTime.time} · event` : TIME_LABELS[time]}
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
 * Event captions survive season changes; season-less records keep a generic play fallback.
 * Captions identify the event and live/play status; drafts disclose unverified arrangements.
 */
function ProcessionControls() {
  const processions = useUiStore((s) => s.processions);
  const run = useUiStore((s) => s.procession);
  const atlas = useAtlasInstance((s) => s.atlas);
  if (processions.length === 0) return null;
  const current = run && processions.find((p) => p.id === run.id);
  return (
    <>
      {processions
        .filter((p) => !p.season)
        .map((p) => (
          <div className={styles.row} key={p.id}>
            <ProcessionPlayButton id={p.id} label={p.title.en} />
          </div>
        ))}
      {current && (
        <div className={styles.row}>
          <p className={styles.line} role="status">
            {current.title.en} (simulated){run.live ? ' · happening now' : ''}
            {current.status === 'draft'
              ? ` · draft: ${current.kind === 'mass' ? 'gathering' : 'route'} and schedule not yet verified`
              : ''}
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

function ZoomReadout() {
  const zoom = useAtlasStore((s) => (s.camera?.zoom ?? 0).toFixed(1));
  const level = useAtlasStore((s) => zoomLevel(s.camera?.zoom ?? 0));
  return (
    <p className={styles.zoom} aria-label="Zoom">
      z {zoom} · {level}
    </p>
  );
}

function ScaleBar() {
  const lat = useAtlasStore((s) => round(s.camera?.lat ?? 0, 1e-3));
  const zoom = useAtlasStore((s) => round(s.camera?.zoom ?? 0, 0.01));
  const bar = scaleBar(lat, zoom);
  return (
    <div className={styles.scale} aria-label={`Scale: ${bar.label}`}>
      <span className={styles.bar} style={{ width: `${bar.pixels}px` }} />
      <span>{bar.label}</span>
    </div>
  );
}

/** The view center's coordinates, shown on demand (subscribed to only while shown). */
function CoordinatesButton() {
  const [show, setShow] = useState(false);
  return (
    <button
      type="button"
      className={styles.button}
      aria-pressed={show}
      onClick={() => setShow((v) => !v)}
    >
      {show ? <Coordinates /> : 'Coordinates'}
    </button>
  );
}

function Coordinates() {
  const lat = useAtlasStore((s) => s.camera?.lat ?? 0);
  const lng = useAtlasStore((s) => s.camera?.lng ?? 0);
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
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

function SubdivisionTracker({ city }: { city: string }) {
  useSubdivisionTracking(city);
  return null;
}

/**
 * The HUD (SPEC.md §5): the zoom and its level, and the legend top right; the
 * scale bar, the subdivision under the center, coordinates, and sharing bottom left.
 */
export function Hud({
  city,
  dialogue,
  subdivisionLabel,
  climate,
  timezone,
  sidewalksDerived = true,
  seasons,
}: {
  city: string;
  dialogue?: RuntimeDialogueCatalog | undefined;
  subdivisionLabel: string;
  climate?: ClimateConfig | undefined;
  /** The city's IANA time zone (its pack's `timezone`). */
  timezone?: string | undefined;
  sidewalksDerived?: boolean;
  seasons?: readonly RuntimeSeasonConfig[] | undefined;
}) {
  const hasCamera = useAtlasStore((s) => s.camera !== null);
  const factsVisible = useUiStore((s) => s.factsVisible);
  const touring = useAtlasStore((s) => s.tour !== null);
  const subdivision = useUiStore((s) => s.subdivision);
  if (!hasCamera) return <SubdivisionTracker city={city} />;

  return (
    <>
      <SubdivisionTracker city={city} />
      <div className={styles.topRight} data-speech-obstacle>
        <LegendControls
          subdivisionLabel={subdivisionLabel}
          sidewalksDerived={sidewalksDerived}
          hidden={factsVisible}
          climate={climate}
        />
      </div>
      <div
        className={styles.bottomLeft}
        data-touring={touring || factsVisible}
        data-speech-obstacle
      >
        <ScaleBar />
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
          <CoordinatesButton />
          <ShareButton />
        </div>
        <div className={styles.row}>
          <LifeControls climate={climate} timezone={timezone} />
          <SeasonControl seasons={seasons} />
          <QualityControl />
        </div>
        <SeasonEvents seasons={seasons} />
        <ProcessionControls />
        {dialogue && <SpeechControls catalog={dialogue} />}
        <EmojiControls />
      </div>
    </>
  );
}
