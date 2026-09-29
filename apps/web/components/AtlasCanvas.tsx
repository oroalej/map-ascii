'use client';

import { createAtlas } from '@atlas/renderer';
import { zoomLevel, type CityMeta } from '@atlas/shared';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isCityMeta } from '@/lib/guards';
import { lifeSettings, loadLifePrefs, saveLifePrefs, useLifeStore } from '@/state/life';
import { useAtlasInstance, useAtlasStore } from '@/state/store';
import { useUiStore } from '@/state/ui';
import { parseViewParams } from '@/state/url';
import styles from './AtlasCanvas.module.css';

let webgl2Supported: boolean | undefined;
const detectWebGL2 = () =>
  (webgl2Supported ??= document.createElement('canvas').getContext('webgl2') !== null);
const subscribeNoop = () => () => {};
/** Cell height ÷ width (SPEC.md §2: 10×18 CSS px by default). */
const CELL_ASPECT = 1.8;
/** Small screens get larger cells (SPEC.md §8), so glyphs stay legible. */
const SMALL_SCREEN = '(max-width: 640px)';
const SMALL_SCREEN_CELL = 12;

type MetaState =
  | { status: 'loading' }
  | { status: 'ready'; meta: CityMeta }
  | { status: 'missing' }
  | { status: 'invalid'; message: string };

/** Load the city's generated `<slug>.meta.json`. */
function useCityMeta(slug: string): MetaState {
  const [state, setState] = useState<MetaState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<MetaState> => {
      const response = await fetch(`/tiles/${slug}.meta.json`);
      if (!response.ok) return { status: 'missing' };
      const json: unknown = await response.json();
      return isCityMeta(json)
        ? { status: 'ready', meta: json }
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
}: {
  slug: string;
  name: string;
  subdivisionLabel: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Static export renders on the server, where we optimistically assume support.
  const supported = useSyncExternalStore(subscribeNoop, detectWebGL2, () => true);
  const metaState = useCityMeta(slug);
  const meta = metaState.status === 'ready' ? metaState.meta : null;
  const level = useAtlasStore((s) => (s.camera ? zoomLevel(s.camera.zoom) : null));
  const subdivision = useUiStore((s) => s.subdivision);
  const [contextLost, setContextLost] = useState(false);

  useEffect(() => {
    useUiStore.setState({ meta });
  }, [meta]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !supported || !meta) return;
    const store = useAtlasStore.getState();
    // A camera already in the store (e.g. after a remount) wins; else the URL's, over the
    // city's default view.
    const camera = store.camera ?? {
      ...meta.defaultCamera,
      ...parseViewParams(window.location.search).camera,
    };
    store.initCamera(camera);
    const cellSize = window.matchMedia(SMALL_SCREEN).matches
      ? Math.max(store.cellSize, SMALL_SCREEN_CELL)
      : store.cellSize;
    // The life layer's settings are remembered in this browser, not in the URL.
    const lifePrefs = loadLifePrefs();
    useLifeStore.setState(lifePrefs);
    const atlas = createAtlas(canvas, {
      tilesUrl: `/tiles/${slug}.pmtiles`,
      theme: store.theme,
      cell: { width: cellSize, height: Math.round(cellSize * CELL_ASPECT) },
      bounds: meta.regionBounds,
      initialCamera: camera,
      year: store.year,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      life: lifeSettings(lifePrefs),
    });
    // The atlas clamps the camera to the region; start the store from where it really is.
    store.initCamera(atlas.getCamera());
    useAtlasInstance.setState({ atlas });
    const offs = [
      atlas.on('camerachange', (next) => useAtlasStore.getState().setCamera(next)),
      atlas.on('contextlost', () => setContextLost(true)),
      atlas.on('contextrestored', () => setContextLost(false)),
      useLifeStore.subscribe((prefs) => {
        atlas.setLife(lifeSettings(prefs));
        saveLifePrefs(prefs);
      }),
    ];
    return () => {
      for (const off of offs) off();
      setContextLost(false);
      useAtlasInstance.setState({ atlas: null });
      atlas.destroy();
    };
  }, [supported, meta, slug]);

  if (!supported) {
    return (
      <p role="alert" className={styles.notice}>
        ASCII Atlas needs WebGL2, which this browser does not support.
      </p>
    );
  }

  return (
    <>
      <canvas
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
      {contextLost && (
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
