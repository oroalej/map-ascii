import { classId } from '../classes';
import { CellBit, cellBits } from './config';
import { LIFE_AGENT_MASK } from './turn-signals';

const permissions = cellBits();
const trunk = classId('tree');
export const LIFE_OCCLUDERS = [trunk, classId('tree_crown'), classId('trees')] as const;
const occluders = new Set<number>(LIFE_OCCLUDERS);

/** Same surface/subcell predicate as glyph.ts and the completed Life-hover implementation. */
export function lifeVisibleOnSurface(
  lifeClass: number,
  flags: number,
  coarse: number,
  sampled: number,
  height: number,
): boolean {
  const bits = flags & LIFE_AGENT_MASK;
  if (!bits) return false;
  const nonBird = lifeClass !== classId('life_bird');
  const surface = nonBird && coarse !== trunk ? sampled : coarse;
  if (nonBird && occluders.has(surface)) return false;
  const allowed = permissions[surface] ?? 0;
  return (
    (allowed & bits) !== 0 ||
    (bits === CellBit.person && (allowed & CellBit.grounds) !== 0 && height === 0)
  );
}
