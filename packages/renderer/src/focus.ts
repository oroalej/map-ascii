import { classId, type RenderClass } from './classes';
import type { VisibleAgent } from './life/simulate';

export type LifeFocus = 'traffic' | 'people' | 'vendors' | 'pets' | 'boats' | 'trains' | 'birds';
export type LegendFocus = { classes: readonly RenderClass[]; life: readonly LifeFocus[] };
export const LIFE_FOCUS_BIT = 32;
export const FOCUS_DIM = 0.5;
const groups: readonly LifeFocus[] = [
  'traffic',
  'people',
  'vendors',
  'pets',
  'boats',
  'trains',
  'birds',
];

export function lifeFocusOf(agent: VisibleAgent): LifeFocus {
  if (agent.line || agent.kind === 'boat') return 'boats';
  if (agent.vehicle === 'cart') return 'vendors';
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

export function normalizeFocus(input: LegendFocus | null): {
  mask: Uint32Array;
  life: ReadonlySet<LifeFocus>;
  key: string;
} {
  const mask = classMask(input?.classes.map(classId) ?? []);
  const life = new Set(groups.filter((group) => input?.life.includes(group)));
  return { mask, life, key: `${mask[0]}/${mask[1]}/${[...life].join(',')}` };
}
