'use client';

import type { AtlasStats } from '@atlas/renderer';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAtlasInstance } from '@/state/store';
import { isDebugRequested } from '@/lib/debug';
import styles from './DebugStats.module.css';

const REFRESH_MS = 500;

const subscribeNoop = () => () => {};

/**
 * Renderer performance counters (`?debug=1`), for checking the frame-rate and tile-decode
 * budgets (ARCHITECTURE.md §8) on real devices. Not part of the view, so share URLs leave it out.
 */
export function DebugStats() {
  const debug = useSyncExternalStore(subscribeNoop, isDebugRequested, () => false);
  const atlas = useAtlasInstance((s) => s.atlas);
  const [stats, setStats] = useState<AtlasStats | null>(null);

  useEffect(() => {
    if (!debug || !atlas) return;
    const timer = setInterval(() => setStats(atlas.getStats()), REFRESH_MS);
    return () => clearInterval(timer);
  }, [debug, atlas]);

  if (!debug || !stats) return null;
  const ms = (n: number) => n.toFixed(1).padStart(5);
  return (
    <pre className={styles.stats} aria-hidden="true">
      {[
        `fps    ${String(stats.fps).padStart(5)}`,
        `cpu    ${ms(stats.frameMs)} ms`,
        `gpu    ${stats.gpuFrameMs === null ? '  n/a' : ms(stats.gpuFrameMs)} ms`,
        `cells  ${ms(stats.cellPassMs)} ms`,
        `crowns ${ms(stats.crownPassMs)} ms`,
        `life   ${ms(stats.lifeMs)} ms`,
        `decode ${ms(stats.decodeMs)} ms`,
        `tiles  ${String(stats.tilesLoaded).padStart(5)} (+${stats.tilesPending})`,
        `agents ${String(stats.agents).padStart(5)}`,
      ].join('\n')}
    </pre>
  );
}
