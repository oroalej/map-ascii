import type { LabelArea, LabelCandidate, LabelMode } from './labels';

/** Below, above, right, left, or a whole word rotated along its street. */
export type LabelSlot = 0 | 1 | 2 | 3 | -1;
export type LabelMemory = Map<number, LabelSlot>;
export type PlaceStability = { memory?: LabelMemory; focus?: readonly number[] };

/** Retained text may extend this many label cells beyond the screen. */
export const KEEP_OVERHANG = 3;
/** Street repeat spacing, in horizontal label-cell widths (450 px with the default cells). */
export const STREET_REPEAT = 45;

/** Selected first, then hovered, excluding misses, non-labels and duplicate focus. */
export function labelFocus(
  selected: number,
  hover: number,
  isLabel: (id: number) => boolean,
): number[] {
  return [selected, hover].filter((id, i, ids) => id > 0 && ids.indexOf(id) === i && isLabel(id));
}

export function orderLabels(
  candidates: readonly LabelCandidate[],
  stability: PlaceStability,
): LabelCandidate[] {
  const focus = new Map<number, number>();
  stability.focus?.forEach((id, i) => {
    if (!focus.has(id)) focus.set(id, i);
  });
  const priority = (id: number) => focus.get(id) ?? Infinity;
  return [...candidates].sort(
    (a, b) =>
      priority(a.id) - priority(b.id) ||
      a.rank - b.rank ||
      Number(stability.memory?.has(b.id) ?? false) - Number(stability.memory?.has(a.id) ?? false) ||
      a.id - b.id,
  );
}

export function labelSlots(mode: LabelMode | undefined, remembered?: LabelSlot): LabelSlot[] {
  const defaults: LabelSlot[] = mode === 'rotated' ? [-1, 0, 1, 2, 3] : [0, 1, 2, 3];
  return remembered !== undefined && defaults.includes(remembered)
    ? [remembered, ...defaults.filter((slot) => slot !== remembered)]
    : defaults;
}

export function retentionArea(area: LabelArea, kept: boolean): LabelArea {
  return kept
    ? {
        left: area.left - KEEP_OVERHANG,
        top: area.top - KEEP_OVERHANG,
        right: area.right + KEEP_OVERHANG,
        bottom: area.bottom + KEEP_OVERHANG,
      }
    : area;
}
