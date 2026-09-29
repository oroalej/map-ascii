'use client';

import { createAtlas } from '@atlas/renderer';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useAtlasStore } from '@/state/store';
import styles from './AtlasCanvas.module.css';

let webgl2Supported: boolean | undefined;
const detectWebGL2 = () =>
  (webgl2Supported ??= document.createElement('canvas').getContext('webgl2') !== null);
const subscribeNoop = () => () => {};

export function AtlasCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Static export renders on the server, where we optimistically assume support.
  const supported = useSyncExternalStore(subscribeNoop, detectWebGL2, () => true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !supported) return;
    const { camera, year, theme } = useAtlasStore.getState();
    const atlas = createAtlas(canvas, {
      tilesUrl: '/tiles/naga.pmtiles',
      theme,
      initialCamera: camera,
      year,
    });
    return () => atlas.destroy();
  }, [supported]);

  if (!supported) {
    return (
      <p role="alert" className={styles.error}>
        ASCII Atlas needs WebGL2, which this browser does not support.
      </p>
    );
  }

  return <canvas ref={canvasRef} className={styles.canvas} aria-label="Map of Naga City" />;
}
