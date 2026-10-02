'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { tooltipPosition, TOOLTIP_INSET, type TooltipViewport } from '@/lib/tooltip';
import { useUiStore } from '@/state/ui';
import styles from './HoverTooltip.module.css';

const viewportNow = (): TooltipViewport => {
  const viewport = window.visualViewport;
  return viewport
    ? {
        left: viewport.offsetLeft,
        top: viewport.offsetTop,
        width: viewport.width,
        height: viewport.height,
      }
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
};

/** The name under the mouse, positioned within the visible viewport. */
export function HoverTooltip() {
  const hover = useUiStore((s) => s.hover);
  const lifeHover = useUiStore((s) => s.lifeHover);
  const label = lifeHover?.label ?? hover?.feature.name;
  const point = lifeHover?.point ?? hover?.point;
  return label && point ? <PositionedTooltip label={label} point={point} /> : null;
}

function PositionedTooltip({ label, point }: { label: string; point: [number, number] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<TooltipViewport>(viewportNow);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const resize = () => setViewport(viewportNow());
    resize();
    window.addEventListener('resize', resize);
    const visual = window.visualViewport;
    visual?.addEventListener('resize', resize);
    visual?.addEventListener('scroll', resize);
    return () => {
      window.removeEventListener('resize', resize);
      visual?.removeEventListener('resize', resize);
      visual?.removeEventListener('scroll', resize);
    };
  }, []);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize((old) => (old.width === width && old.height === height ? old : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [label, viewport.width]);
  return (
    <div
      ref={ref}
      className={styles.tooltip}
      style={{
        ...tooltipPosition(point, size, viewport),
        maxWidth: Math.max(0, Math.min(260, viewport.width - 2 * TOOLTIP_INSET)),
      }}
      role="tooltip"
    >
      {label}
    </div>
  );
}
