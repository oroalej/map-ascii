'use client';

import { createAtlas, DEFAULT_CELLS, type CellSchedule } from '@atlas/renderer';
import {
  zoomLevel,
  type CityLifeConfig,
  type CityMeta,
  type ClimateConfig,
  type ProcessionRoute,
  type TrafficMix,
} from '@atlas/shared';
import { useEffect, useRef, useState } from 'react';
import { isCityMeta, isCityProcessions } from '@/lib/guards';
import { isDebugRequested } from '@/lib/debug';
import { listenReducedMotion, prefersReducedMotion } from '@/lib/motion';
import { lifeSettings, loadLifePrefs, saveLifePrefs, useLifeStore } from '@/state/life';
import { loadQualityPref, saveQualityPref, useQualityStore } from '@/state/quality';
import { useAtlasInstance, useAtlasStore } from '@/state/store';
import { isPickable, useUiStore } from '@/state/ui';
import { parseViewParams } from '@/state/url';
import styles from './AtlasCanvas.module.css';

/** Small screens keep map cells a little larger (SPEC.md §8), so glyphs stay legible. */
const SMALL_SCREEN = '(max-width: 640px)';
const SMALL_SCREEN_MIN_CELL = 6;

/** The map's cell sizes by zoom (SPEC.md §2 "Cell size"), with a floor on small screens. */
const cellSchedule = (small: boolean): CellSchedule =>
  small
    ? {
        ...DEFAULT_CELLS,
        steps: DEFAULT_CELLS.steps.map((s) => ({
          ...s,
          width: Math.max(s.width, SMALL_SCREEN_MIN_CELL),
        })),
      }
    : DEFAULT_CELLS;

type MetaState =
  | { status: 'loading' }
  | { status: 'ready'; meta: CityMeta; processions: readonly ProcessionRoute[] }
  | { status: 'missing' }
  | { status: 'invalid'; message: string };

/**
 * The city's river processions (`<slug>.processions.json`, step 07). A city without any has no
 * file, and a missing or stale file only means none are shown.
 */
async function loadProcessions(slug: string): Promise<readonly ProcessionRoute[]> {
  try {
    const response = await fetch(`/tiles/${slug}.processions.json`);
    if (!response.ok) return [];
    const json: unknown = await response.json();
    return isCityProcessions(json) ? json.processions : [];
  } catch {
    return [];
  }
}

/** Load the city's generated `<slug>.meta.json`, and its processions. */
function useCityMeta(slug: string): MetaState {
  const [state, setState] = useState<MetaState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<MetaState> => {
      const [response, processions] = await Promise.all([
        fetch(`/tiles/${slug}.meta.json`),
        loadProcessions(slug),
      ]);
      if (!response.ok) return { status: 'missing' };
      const json: unknown = await response.json();
      return isCityMeta(json)
        ? { status: 'ready', meta: json, processions }
        : { status: 'invalid', message: 'not a city meta file' };
    };
    void load()
      .catch((err: unknown) => ({ status: 'invalid', message: String(err) }) as const)
      .then((next) => {
        if (!cancelled) setState(next);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);
  return state;
}

export function AtlasCanvas({
  slug,
  name,
  subdivisionLabel,
  traffic,
  climate,
  timezone,
  cityLife,
  utilitiesDerived = false,
}: {
  utilitiesDerived?: boolean;
  slug: string;
  name: string;
  subdivisionLabel: string;
  traffic?: TrafficMix | undefined;
  climate?: ClimateConfig | undefined;
  timezone?: string | undefined;
  cityLife?: CityLifeConfig | undefined;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [startupFailed, setStartupFailed] = useState(false);
  const metaState = useCityMeta(slug);
  const meta = metaState.status === 'ready' ? metaState.meta : null;
  const processions = metaState.status === 'ready' ? metaState.processions : null;
  const level = useAtlasStore((s) => (s.camera ? zoomLevel(s.camera.zoom) : null));
  const subdivision = useUiStore((s) => s.subdivision);
  const [contextLost, setContextLost] = useState(false);

  useEffect(() => {
    useUiStore.setState({ meta, processions: processions ?? [] });
  }, [meta, processions]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !meta) return;
    const store = useAtlasStore.getState();
    // A camera already in the store (e.g. after a remount) wins; else the URL's, over the
    // city's default view. Only lat, lng, and zoom are taken from the meta: meta files built
    // before the map went flat also carry pitch and bearing.
    const { lat, lng, zoom } = meta.defaultCamera;
    const camera = store.camera ?? {
      lat,
      lng,
      zoom,
      ...parseViewParams(window.location.search).camera,
    };
    store.initCamera(camera);
    // The life layer's settings are remembered in this browser, not in the URL.
    const lifePrefs = loadLifePrefs();
    useLifeStore.setState(lifePrefs);
    const quality = loadQualityPref();
    useQualityStore.setState({ choice: quality });
    let atlas: ReturnType<typeof createAtlas>;
    try {
      atlas = createAtlas(canvas, {
        quality,
        utilities: { derive: utilitiesDerived },
        tilesUrl: `/tiles/${slug}.pmtiles`,
        theme: store.theme,
        cells: cellSchedule(window.matchMedia(SMALL_SCREEN).matches),
        bounds: meta.regionBounds,
        initialCamera: camera,
        year: store.year,
        reducedMotion: prefersReducedMotion(),
        gpuTiming: isDebugRequested(),
        profiling: isDebugRequested(),
        interactive: isPickable,
        life: lifeSettings(lifePrefs),
        traffic,
        climate,
        timezone,
        cityLife,
        processions: processions ?? [],
      });
    } catch (error) {
      console.error('ASCII Atlas graphics initialization failed', error);
      // Synchronous GPU initialization must report its outcome to the React overlay.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStartupFailed(true);
      return;
    }
    setStartupFailed(false);
    // The atlas clamps the camera to the region; start the store from where it really is.
    store.initCamera(atlas.getCamera());
    useAtlasInstance.setState({ atlas });
    const offs = [
      useQualityStore.subscribe(({ choice }) => {
        atlas.setQuality(choice);
        saveQualityPref(choice);
      }),
      listenReducedMotion(atlas),
      atlas.on('camerachange', (next) => useAtlasStore.getState().setCamera(next)),
      atlas.on('contextlost', () => setContextLost(true)),
      atlas.on('contextrestored', () => setContextLost(false)),
      atlas.on('procession', (run) => useUiStore.setState({ procession: run })),
      useLifeStore.subscribe((prefs) => {
        atlas.setLife(lifeSettings(prefs));
        saveLifePrefs(prefs);
      }),
    ];
    return () => {
      for (const off of offs) off();
      setContextLost(false);
      useUiStore.setState({ procession: null });
      useAtlasInstance.setState({ atlas: null });
      atlas.destroy();
    };
  }, [attempt, meta, processions, slug, traffic, climate, timezone, cityLife, utilitiesDerived]);

  return (
    <>
      <canvas
        key={attempt}
        ref={canvasRef}
        className={styles.canvas}
        aria-label={[
          `Map of ${name}`,
          level && `${level} level`,
          subdivision &&
            `${subdivisionLabel} ${subdivision.approximate ? 'about ' : ''}${subdivision.name}`,
        ]
          .filter(Boolean)
          .join(', ')}
        // Focusable so the map's keyboard controls (+/-, arrow keys) work.
        tabIndex={0}
      />
      {startupFailed && (
        <div role="alert" className={styles.notice}>
          <p>Map graphics could not start.</p>
          <button
            type="button"
            onClick={() => {
              setStartupFailed(false);
              setContextLost(false);
              setAttempt((value) => value + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {!startupFailed && contextLost && (
        <p role="status" className={styles.notice}>
          The graphics context was lost. Restoring the map…
        </p>
      )}
      {metaState.status === 'missing' && (
        <p role="status" className={styles.notice}>
          No map data for {name} yet. Run <code>pnpm data:build -- --city {slug}</code>.
        </p>
      )}
      {metaState.status === 'invalid' && (
        <p role="alert" className={styles.notice}>
          The map data for {name} is invalid. Rebuild it with{' '}
          <code>pnpm data:build -- --city {slug}</code>.
        </p>
      )}
    </>
  );
}
