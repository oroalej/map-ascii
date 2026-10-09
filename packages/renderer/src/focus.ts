import { classId, type RenderClass } from './classes';
import type { VisibleAgent } from './life/simulate';

export type LifeFocus = (typeof groups)[number];
export type LegendFocus = {
  classes: readonly RenderClass[];
  life: readonly LifeFocus[];
  folklore?: boolean;
};
export const LIFE_FOCUS_BIT = 32;
export const FOCUS_DIM = 0.5;
/** Matches focusPulse() in the glyph shader, using elapsed renderer seconds. */
export function focusPulse(time: number, shimmer: boolean): number {
  return shimmer ? 0.75 + 0.25 * Math.sin(3 * time) : 1;
}
const groups = ['traffic', 'people', 'vendors', 'pets', 'boats', 'trains', 'birds'] as const;

export function lifeFocusOf(agent: VisibleAgent): LifeFocus {
  if (agent.line || agent.kind === 'boat') return 'boats';
  if (agent.vehicle === 'cart' || agent.peddler) return 'vendors';
  if (agent.kind === 'vehicle' || agent.vehicle === 'carabao') return 'traffic';
  if (agent.kind === 'cat' || agent.kind === 'dog') return 'pets';
  if (agent.kind === 'train') return 'trains';
  if (agent.kind === 'bird') return 'birds';
  return 'people';
}

/** A pair of unsigned 32-bit words, including class ids above 31. Zero is never selectable. */
export function classMask(ids: readonly number[]): Uint32Array {
  const words = new Uint32Array(2);
  for (const id of ids)
    if (Number.isInteger(id) && id > 0 && id < 64) words[id >>> 5]! |= (1 << (id & 31)) >>> 0;
  return words;
}

/**
 * Feature indices lit as legend-focus members, or null with no focus (tour highlights apply).
 * Landmarks share their buildings' classes, so the Landmark and Heritage entries light their
 * footprints by feature: every curated landmark (`notable`, which includes heritage sites), or
 * only the heritage sites.
 */
export function focusHighlights(
  focus: ReturnType<typeof normalizeFocus>,
  features: { readonly heritage: readonly number[]; readonly notable: readonly number[] },
): readonly number[] | null {
  const active =
    focus.mask[0]! !== 0 || focus.mask[1]! !== 0 || focus.life.size > 0 || focus.folklore;
  if (!active) return null;
  const has = (cls: RenderClass) => {
    const id = classId(cls);
    return (focus.mask[id >>> 5]! & ((1 << (id & 31)) >>> 0)) !== 0;
  };
  if (has('marker_landmark')) return features.notable;
  return has('marker_heritage') ? features.heritage : [];
}

export function normalizeFocus(input: LegendFocus | null): {
  mask: Uint32Array;
  life: ReadonlySet<LifeFocus>;
  folklore: boolean;
  key: string;
} {
  const mask = classMask(input?.classes.map(classId) ?? []);
  const life = new Set(groups.filter((group) => input?.life.includes(group)));
  const folklore = input?.folklore === true;
  return { mask, life, folklore, key: `${mask[0]}/${mask[1]}/${[...life].join(',')}/${folklore}` };
}
