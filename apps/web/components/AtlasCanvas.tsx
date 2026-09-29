'use client';

import { createAtlas } from '@atlas/renderer';
import { CityMeta } from '@atlas/shared';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAtlasStore } from '@/state/store';
import styles from './AtlasCanvas.module.css';

let webgl2Supported: boolean | undefined;
const detectWebGL2 = () =>
  (webgl2Supported ??= document.createElement('canvas').getContext('webgl2') !== null);
const subscribeNoop = () => () => {};
/** Cell height ÷ width (SPEC.md §2: 10×18 CSS px by default). */
const CELL_ASPECT = 1.8;

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
      const result = CityMeta.safeParse(await response.json());
      return result.success
        ? { status: 'ready', meta: result.data }
        : { status: 'invalid', message: result.error.message };
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

export function AtlasCanvas({ slug, name }: { slug: string; name: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Static export renders on the server, where we optimistically assume support.
  const supported = useSyncExternalStore(subscribeNoop, detectWebGL2, () => true);
  const metaState = useCityMeta(slug);
  const meta = metaState.status === 'ready' ? metaState.meta : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !supported || !meta) return;
    const store = useAtlasStore.getState();
    const camera = store.camera ?? meta.defaultCamera;
    store.initCamera(camera);
    const atlas = createAtlas(canvas, {
      tilesUrl: `/tiles/${slug}.pmtiles`,
      theme: store.theme,
      cell: { width: store.cellSize, height: Math.round(store.cellSize * CELL_ASPECT) },
      bounds: meta.regionBounds,
      initialCamera: camera,
      year: store.year,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    });
    const off = atlas.on('camerachange', (next) => useAtlasStore.getState().setCamera(next));
    return () => {
      off();
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
        aria-label={`Map of ${name}`}
        // Focusable so the map's keyboard controls (+/-, arrow keys) work.
        tabIndex={0}
      />
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
