/** CPU reference of shaders/party-walls.ts. Only cardinal raster contacts form party walls. */
export type WallCell = {
  id: number;
  eligible: boolean;
  height: number;
  style: number;
  seeThrough?: boolean;
};
const directions = [
  [0, -1, 1],
  [1, 0, 2],
  [0, 1, 4],
  [-1, 0, 8],
] as const;

export function partySeam(center: WallCell, east: WallCell, south: WallCell): boolean {
  return (
    center.eligible &&
    center.height > 0 &&
    [east, south].some(
      (q) =>
        q.eligible && q.height === center.height && q.style === center.style && q.id !== center.id,
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
    const o = (dx: number, dy: number) => outside(x + dx, y + dy);
    if (![-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => (dx || dy) && o(dx, dy)))) return null;
    return (
      (!o(0, -1) && (o(-1, 0) || o(-1, -1) || o(1, 0) || o(1, -1)) ? 1 : 0) |
      (!o(1, 0) && (o(0, -1) || o(1, -1) || o(0, 1) || o(1, 1)) ? 2 : 0) |
      (!o(0, 1) && (o(-1, 0) || o(-1, 1) || o(1, 0) || o(1, 1)) ? 4 : 0) |
      (!o(-1, 0) && (o(0, -1) || o(-1, -1) || o(0, 1) || o(-1, 1)) ? 8 : 0)
    );
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
    const reverse = bit === 1 ? 4 : bit === 2 ? 8 : bit === 4 ? 1 : 2;
    if (active(x, y) && (proposes(0, 0, x, y, bit) || proposes(x, y, -x, -y, reverse))) mask |= bit;
  }
  return mask;
}
