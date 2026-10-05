import type { PlaceKind } from '@atlas/shared';
import type { Activity } from './config';

/** Seasonal attendance follows its own clock; ordinary places retain their default share. */
export function gathererShare(
  owner: { place: PlaceKind; seasonal?: 'visitors' | 'congregations' },
  levels?: Activity,
): number {
  return owner.seasonal
    ? (levels?.season?.[owner.seasonal] ?? 0)
    : (levels?.places[owner.place] ?? 1);
}
