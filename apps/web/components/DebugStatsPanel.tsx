'use client';

import type { AtlasProfile, AtlasStats } from '@atlas/renderer';
import { useEffect, useRef, useState } from 'react';
import { debugCaptureMs } from '@/lib/debug';
import { useAtlasInstance } from '@/state/store';
import { useLifeStore } from '@/state/life';
import styles from './DebugStats.module.css';

const REFRESH_MS = 500;

/**
 * Renderer performance counters (`?debug=1`), for checking the frame-rate and tile-decode
 * budgets (ARCHITECTURE.md §8) on real devices. Not part of the view, so share URLs leave it out.
 */
export default function DebugStatsPanel() {
  const atlas = useAtlasInstance((s) => s.atlas);
  const [stats, setStats] = useState<AtlasStats | null>(null);
  const [profile, setProfile] = useState<AtlasProfile | null>(null);
  const [capturing, setCapturing] = useState(false);
  const captureTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const captureInfo = useRef<Record<string, unknown>>({});

  useEffect(() => {
    if (!atlas) return;
    const timer = setInterval(() => setStats(atlas.getStats()), REFRESH_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(captureTimer.current);
      setCapturing(false);
    };
  }, [atlas]);

  if (!stats) return null;
  const duration = debugCaptureMs();
  const metadata = () => {
    const backend = atlas?.getProfile()?.gpuRenderer ?? null;
    return {
      at: new Date().toISOString(),
      city: window.location.pathname,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio,
      },
      camera: atlas?.getCamera(),
      life: { ...useLifeStore.getState() },
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      focused: document.hasFocus(),
      visibility: document.visibilityState,
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      gpuBackend: backend,
      gpuClassification:
        backend === null
          ? 'unidentified'
          : /swiftshader|llvmpipe|software/i.test(backend)
            ? 'software'
            : 'hardware-reported',
    };
  };
  const reset = () => {
    clearTimeout(captureTimer.current);
    setCapturing(false);
    setProfile(null);
    atlas?.resetProfile();
  };
  const capture = () => {
    reset();
    captureInfo.current = metadata();
    setCapturing(true);
    captureTimer.current = setTimeout(() => {
      setProfile(atlas?.getProfile() ?? null);
      captureInfo.current = {
        start: captureInfo.current,
        end: metadata(),
        stats: atlas?.getStats(),
      };
      setCapturing(false);
    }, duration);
  };
  const download = () => {
    const blob = new Blob(
      [JSON.stringify({ version: 1, ...captureInfo.current, profile }, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'atlas-profile.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const ms = (n: number) => n.toFixed(1).padStart(5);
  return (
    <div className={styles.stats}>
      <pre aria-hidden="true">
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
      <div className={styles.controls}>
        <button type="button" onClick={reset}>
          Reset profile
        </button>
        <button type="button" onClick={capture} disabled={capturing}>
          {capturing ? 'Capturing…' : `Capture ${Math.round(duration / 1000)} seconds`}
        </button>
        <button type="button" onClick={download} disabled={!profile}>
          Download profile
        </button>
      </div>
      {profile && (
        <pre aria-hidden="true">
          {[
            ...(profile.dropped > 0
              ? [
                  `window ${(profile.spanMs / 1000).toFixed(1)} s (${profile.dropped} samples dropped)`,
                ]
              : []),
            ...Object.entries(profile.stages).map(
              ([name, s]) =>
                `${name.padEnd(16)} ${s.medianMs?.toFixed(2) ?? 'n/a'} / ${s.p95Ms?.toFixed(2) ?? 'n/a'} ms (${s.count})`,
            ),
          ].join('\n')}
        </pre>
      )}
    </div>
  );
}
