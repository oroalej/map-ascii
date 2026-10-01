/** CPU reference of shaders/party-walls.ts. Only cardinal raster contacts form party walls. */
import { Dir, wallMask } from './select';
export type WallCell = {
  id: number;
  eligible: boolean;
  height: number;
  style: number;
  landmark?: boolean;
  seeThrough?: boolean;
};
const directions = [
  [0, -1, Dir.N],
  [1, 0, Dir.E],
  [0, 1, Dir.S],
  [-1, 0, Dir.W],
] as const;

export function partySeam(center: WallCell, east: WallCell, south: WallCell): boolean {
  return (
    center.eligible &&
    center.height > 0 &&
    center.style === 0 &&
    [east, south].some(
      (q) =>
        q.eligible &&
        q.height === center.height &&
        q.style === 0 &&
        !!q.landmark === !!center.landmark &&
        q.id !== center.id,
    )
  );
}

/** undefined selects the existing outline algorithm; null is an interior roof cell. */
export function partyWallMask(
  sample: (x: number, y: number) => WallCell,
): number | null | undefined {
  const center = sample(0, 0);
  if (!center.eligible || !center.height || !center.style) return undefined;
  const member = (x: number, y: number) => {
    const q = sample(x, y);
    return q.eligible && q.height === center.height && q.style === center.style;
  };
  if (!directions.some(([x, y]) => member(x, y) && sample(x, y).id !== center.id)) return undefined;
  const outside = (x: number, y: number) => !member(x, y) && !sample(x, y).seeThrough;
  const shared = (x: number, y: number, dx: number, dy: number) =>
    member(x, y) && member(x + dx, y + dy) && sample(x, y).id !== sample(x + dx, y + dy).id;
  const externalMask = (x: number, y: number): number | null => {
    return wallMask((dx, dy) => outside(x + dx, y + dy));
  };
  const active = (x: number, y: number) =>
    member(x, y) && (externalMask(x, y) !== null || shared(x, y, 1, 0) || shared(x, y, 0, 1));
  if (!active(0, 0)) return null;
  const proposes = (x: number, y: number, dx: number, dy: number, bit: number) => {
    if (((externalMask(x, y) ?? 0) & bit) !== 0) return true;
    const qx = x + dx,
      qy = y + dy;
    if (dy && shared(x, y, 1, 0))
      return shared(qx, qy, 1, 0) || (dy < 0 && shared(qx, qy, 0, 1)) || outside(qx + 1, qy);
    if (dx && shared(x, y, 0, 1))
      return shared(qx, qy, 0, 1) || (dx < 0 && shared(qx, qy, 1, 0)) || outside(qx, qy + 1);
    return false;
  };
  let mask = 0;
  for (const [x, y, bit] of directions) {
    const reverse = bit === Dir.N ? Dir.S : bit === Dir.E ? Dir.W : bit === Dir.S ? Dir.N : Dir.E;
    if (active(x, y) && (proposes(0, 0, x, y, bit) || proposes(x, y, -x, -y, reverse))) mask |= bit;
  }
  return mask;
}
