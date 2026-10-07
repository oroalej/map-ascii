'use client';
import { useEffect, useRef } from 'react';
import {
  popoverAnchorVisible,
  popoverArrowOffset,
  popoverPlacement,
  POPOVER_WIDTH,
  POPOVER_MAX_HEIGHT_RATIO,
  POPOVER_PADDING,
  POPOVER_PADDING_RATIO,
  type Side,
} from '@/lib/popover';
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
    let constraints = '';
    const attribution = document.querySelector<HTMLElement>('footer[data-speech-obstacle]');
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
      const footer = attribution?.getBoundingClientRect();
      const placementViewport = {
        ...viewport,
        height: Math.max(
          0,
          (footer && footer.height > 0 && footer.right > left && footer.left < right
            ? Math.min(bottom, footer.top)
            : bottom) - top,
        ),
      };
      if (
        viewport.width <= TOOLTIP_INSET * 2 ||
        placementViewport.height <= TOOLTIP_INSET * 2 ||
        !popoverAnchorVisible(point, viewport)
      ) {
        hide();
        return;
      }
      root.hidden = false;
      const width = Math.min(POPOVER_WIDTH, placementViewport.width - TOOLTIP_INSET * 2),
        height = Math.min(
          placementViewport.height * POPOVER_MAX_HEIGHT_RATIO,
          placementViewport.height - TOOLTIP_INSET * 2,
        ),
        padding = Math.min(
          POPOVER_PADDING,
          width * POPOVER_PADDING_RATIO,
          height * POPOVER_PADDING_RATIO,
        );
      const nextConstraints = `${width}/${height}/${padding}`;
      if (constraints !== nextConstraints) {
        root.style.width = `${width}px`;
        root.style.maxHeight = `${height}px`;
        root.style.padding = `${padding}px`;
        constraints = nextConstraints;
      }
      const size = root.getBoundingClientRect();
      const placed = popoverPlacement(point, size, placementViewport, side);
      side = placed.side;
      root.style.transform = `translate(${placed.left}px, ${placed.top}px)`;
      root.style.setProperty('--arrow-offset', `${popoverArrowOffset(point, size, placed)}px`);
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
    if (attribution) observer.observe(attribution);
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
