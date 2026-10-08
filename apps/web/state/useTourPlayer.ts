'use client';

import { useEffect } from 'react';
import { typingInField } from '@/lib/dom';
import { useAtlasInstance, useAtlasStore } from './store';
import { setTourRunner, tourControls, useTourStore } from './tour';
import { selectPlace } from './selection';

/**
 * Run the city's tours (SPEC.md §6) against the live atlas:
 * - a step selects and highlights its features, sets its year, flies to its camera, and holds;
 * - moving the camera, or selecting something else, pauses the tour ("Resume tour");
 * - a hidden tab pauses the tour, and showing it again resumes;
 * - `T` opens the tours menu, Space pauses or resumes, Esc exits;
 * - a URL with `tour` and `step` reopens that tour there, paused.
 */
export function useTourPlayer(city: string, hasTours: boolean) {
  const atlas = useAtlasInstance((s) => s.atlas);

  useEffect(() => {
    tourControls.configure(city, hasTours);
    return () => tourControls.configure(null, false);
  }, [city, hasTours]);

  useEffect(() => {
    if (!atlas) return;
    let timer: number | undefined;
    /** Set while a step applies its selection, so that isn't taken for the visitor's. */
    let applying = false;

    setTourRunner({
      show(step) {
        const store = useAtlasStore.getState();
        applying = true;
        try {
          selectPlace(step.select ?? null);
        } finally {
          applying = false;
        }
        // After the selection, which clears highlights (useAtlasEvents).
        atlas.setHighlighted(step.highlight ?? []);
        if (step.year !== undefined) store.setYear(step.year);
        atlas.flyTo(step.camera, { duration: step.fly_ms });
      },
      hold(ms) {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => tourControls.dwellDone(), ms);
      },
      cancelHold() {
        window.clearTimeout(timer);
      },
      stop() {
        // A non-animated camera update ends any flight where it is.
        atlas.setCamera(atlas.getCamera());
        atlas.setHighlighted([]);
      },
    });

    const offFlyEnd = atlas.on('flyend', () => tourControls.flyEnd());
    const offInput = atlas.on('input', () => tourControls.grab());
    const offSelection = useAtlasStore.subscribe((s, prev) => {
      if (applying || s.selectedId === prev.selectedId || s.selectedId === null) return;
      if (useTourStore.getState().active) tourControls.grab();
    });

    return () => {
      window.clearTimeout(timer);
      setTourRunner(null);
      offFlyEnd();
      offInput();
      offSelection();
    };
  }, [atlas]);

  useEffect(() => {
    let pausedWhileHidden = false;
    const onVisibility = () => {
      const run = useTourStore.getState().active?.run;
      if (document.hidden) {
        if (run && !run.paused && run.phase !== 'ended') {
          tourControls.pause();
          pausedWhileHidden = true;
        }
      } else if (pausedWhileHidden) {
        pausedWhileHidden = false;
        tourControls.resume();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typingInField()) return;
      const { active, menuOpen } = useTourStore.getState();
      if (e.key === 't' || e.key === 'T') {
        if (!useTourStore.getState().hasTours) return;
        e.preventDefault();
        tourControls.setMenuOpen(!menuOpen);
      } else if (e.key === ' ' && active) {
        // Space on a focused button presses it instead.
        if (document.activeElement instanceof HTMLButtonElement) return;
        e.preventDefault();
        tourControls.toggle();
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        if (menuOpen) tourControls.setMenuOpen(false);
        else tourControls.exit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
