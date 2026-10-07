import type { Mover } from './simulate';

/** Detach mutable member slots so a rejected heading trial can restore them exactly. */
export const snapshotMover = (m: Mover): Mover =>
  m.group ? { ...m, group: m.group.map((w) => ({ ...w })) } : { ...m };

/** Preserve the live array/member identities used by inspection and scene ownership. */
export function restoreMover(m: Mover, before: Mover) {
  const group = m.group;
  for (const key of Object.keys(m)) if (!Object.hasOwn(before, key)) Reflect.deleteProperty(m, key);
  Object.assign(m, before);
  if (group && before.group) {
    before.group.forEach((w, i) => Object.assign(group[i]!, w));
    m.group = group;
  }
}

/** Change a group's frame without swapping the members' world positions. */
export function faceGroup(m: Mover, hx: number, hy: number, previous = m.momentFacing ?? m) {
  for (const w of m.group ?? []) {
    const x = -previous.hy * w.lateral - previous.hx * w.back;
    const y = previous.hx * w.lateral - previous.hy * w.back;
    w.lateral = -hy * x + hx * y;
    w.back = -hx * x - hy * y;
  }
  delete m.momentFacing;
  m.hx = hx;
  m.hy = hy;
}
