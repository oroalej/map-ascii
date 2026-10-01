'use client';

import { useUiStore } from '@/state/ui';
import styles from './HoverTooltip.module.css';

/** The name of the place under the mouse (SPEC.md §5: "Highlight and tooltip with the name"). */
export function HoverTooltip() {
  const hover = useUiStore((s) => s.hover);
  const lifeHover = useUiStore((s) => s.lifeHover);
  const label = lifeHover?.label ?? hover?.feature.name;
  const point = lifeHover?.point ?? hover?.point;
  if (!label || !point) return null;
  const [x, y] = point;
  return (
    <div className={styles.tooltip} style={{ left: x + 14, top: y + 14 }} role="tooltip">
      {label}
    </div>
  );
}
