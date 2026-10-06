'use client';
import { useEffect, useRef } from 'react';
import { popoverPlacement, type Side } from '@/lib/popover';
import { TOOLTIP_INSET } from '@/lib/tooltip';
import { useAtlasInstance } from '@/state/store';
import { LandmarkDetails, type LandmarkDetailsProps } from './LandmarkDetails';
import { focusFacts, publishFactsVisible } from './facts-visibility';
import styles from './LandmarkFacts.module.css';

export function LandmarkPopover({
  anchor,
  sequence,
  ...body
}: LandmarkDetailsProps & { anchor: readonly [number, number] | null; sequence: number }) {
  const atlas = useAtlasInstance((s) => s.atlas);
  const canvas = useAtlasInstance((s) => s.canvas);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let frame: number | null = null,
      side: Side | undefined;
    const hide = () => {
      root.hidden = true;
      publishFactsVisible(sequence, false);
    };
    const place = () => {
      frame = null;
      if (!atlas || !canvas || !anchor) {
        hide();
        return;
      }
      const rect = canvas.getBoundingClientRect(),
        visual = window.visualViewport;
      const left = Math.max(rect.left, visual?.offsetLeft ?? 0),
        top = Math.max(rect.top, visual?.offsetTop ?? 0);
      const right = Math.min(
        rect.right,
        (visual?.offsetLeft ?? 0) + (visual?.width ?? window.innerWidth),
      );
      const bottom = Math.min(
        rect.bottom,
        (visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight),
      );
      const viewport = {
        left,
        top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      };
      const projected = atlas.project(anchor),
        point: [number, number] = [rect.left + projected[0], rect.top + projected[1]];
      if (
        viewport.width <= TOOLTIP_INSET * 2 ||
        viewport.height <= TOOLTIP_INSET * 2 ||
        !popoverPlacement(point, { width: 0, height: 0 }, viewport).visible
      ) {
        hide();
        return;
      }
      root.hidden = false;
      const width = Math.min(320, viewport.width - TOOLTIP_INSET * 2),
        height = Math.min(viewport.height * 0.6, viewport.height - TOOLTIP_INSET * 2);
      root.style.width = `${width}px`;
      root.style.maxHeight = `${height}px`;
      root.style.padding = `${Math.min(14, width / 8, height / 8)}px`;
      const size = root.getBoundingClientRect();
      const placed = popoverPlacement(point, size, viewport, side);
      side = placed.side;
      root.style.transform = `translate(${placed.left}px, ${placed.top}px)`;
      root.dataset.side = side;
      publishFactsVisible(sequence, true);
      focusFacts(root, sequence);
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(place);
    };
    const off = atlas?.on('camerachange', schedule);
    window.addEventListener('resize', schedule);
    const visual = window.visualViewport;
    visual?.addEventListener('resize', schedule);
    visual?.addEventListener('scroll', schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    if (canvas) observer.observe(canvas);
    schedule();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      off?.();
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      visual?.removeEventListener('resize', schedule);
      visual?.removeEventListener('scroll', schedule);
      publishFactsVisible(sequence, false);
    };
  }, [atlas, canvas, anchor, sequence]);
  return (
    <div
      ref={ref}
      hidden
      className={styles.popover}
      role="dialog"
      aria-modal="false"
      aria-labelledby={body.headingId}
      data-speech-obstacle
    >
      <LandmarkDetails {...body} />
    </div>
  );
}
