'use client';

import { useUiStore } from '@/state/ui';
import styles from './HoverTooltip.module.css';

/** The name of the place under the mouse (SPEC.md §5: "Highlight and tooltip with the name"). */
export function HoverTooltip() {
  const hover = useUiStore((s) => s.hover);
  if (!hover?.feature.name) return null;
  const [x, y] = hover.point;
  return (
    <div className={styles.tooltip} style={{ left: x + 14, top: y + 14 }} role="tooltip">
      {hover.feature.name}
    </div>
  );
}
