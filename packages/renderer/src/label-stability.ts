import type { LabelArea, LabelCandidate, LabelMode } from './labels';

/** Below, above, right, left, or a whole word rotated along its street. */
export type LabelSlot = 0 | 1 | 2 | 3 | -1;
export type LabelMemoryEntry = { slot: LabelSlot; visible: boolean };
export type LabelMemory = Map<number, LabelMemoryEntry>;
export type LabelOrderKey = { label: LabelCandidate; focus: number; retained: number };
export type PlaceStability = {
  memory?: LabelMemory;
  focus?: readonly number[];
  /** Focus-only overlays read the last cell draw's memory without replacing it. */
  commitMemory?: boolean;
  /** Physical viewport, including partial cells; defaults to the admission area. */
  screen?: LabelArea;
  /** Per-target sorting storage; keys are recalculated once per candidate. */
  order?: LabelOrderKey[];
};

/** Retained layouts may extend this many cells beyond the fully visible cell bounds. */
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
  const keys = stability.order ?? [];
  keys.length = candidates.length;
  for (let i = 0; i < candidates.length; i++) {
    const label = candidates[i]!;
    const previous = stability.memory?.get(label.id);
    const key = (keys[i] ??= { label, focus: Infinity, retained: 2 });
    key.label = label;
    key.focus = focus.get(label.id) ?? Infinity;
    key.retained = previous ? (previous.visible ? 0 : 1) : 2;
  }
  keys.sort(
    (a, b) =>
      a.focus - b.focus ||
      a.label.rank - b.label.rank ||
      a.retained - b.retained ||
      a.label.id - b.label.id,
  );
  return keys.map(({ label }) => label);
}

const besideSlots: readonly (readonly LabelSlot[])[] = [
  [0, 1, 2, 3],
  [1, 0, 2, 3],
  [2, 0, 1, 3],
  [3, 0, 1, 2],
];
const rotatedSlots = besideSlots.map((slots): readonly LabelSlot[] => [-1, ...slots]);

/** Reuse the four possible orders: eligibility and placement call this for every candidate. */
export function labelSlots(
  mode: LabelMode | undefined,
  remembered?: LabelSlot,
): readonly LabelSlot[] {
  const beside = remembered === undefined || remembered === -1 ? 0 : remembered;
  return (mode === 'rotated' ? rotatedSlots : besideSlots)[beside]!;
}

export function retentionArea(area: LabelArea): LabelArea {
  return {
    left: area.left - KEEP_OVERHANG,
    top: area.top - KEEP_OVERHANG,
    right: area.right + KEEP_OVERHANG,
    bottom: area.bottom + KEEP_OVERHANG,
  };
}

/** Shared admission policy; eligibility and individual-slot collision checks stay separate. */
export const placementArea = (area: LabelArea, retained: LabelArea, kept: boolean): LabelArea =>
  kept ? retained : area;
