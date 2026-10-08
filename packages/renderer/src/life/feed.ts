export type TapPointer = { revision: number; left: boolean };
export type FeedPoint = {
  x: number;
  y: number;
  until: number;
  inhibited: boolean;
  revision: number;
  cellMeters: number;
  seed: number;
};
type Point = { x: number; y: number };
/** Nearest-first fixed samples; ordinary forage and saved return anchors never use this mode. */
export function feedSpot(
  at: Point,
  radius: number,
  valid: (p: Point) => boolean,
  phase = 0,
): Point | undefined {
  for (let i = 0; i < 8; i++) {
    const angle = phase + i * 2.399963229728653,
      distance = radius * Math.sqrt(i / 7);
    const point =
      i === 0
        ? { x: at.x, y: at.y }
        : { x: at.x + Math.cos(angle) * distance, y: at.y + Math.sin(angle) * distance };
    if (valid(point)) return point;
  }
}
export function feedCrumbs(seed: number): Point[] {
  const count = 3 + ((seed >>> 0) % 3),
    phase = (((seed >>> 0) % 1024) * Math.PI) / 512;
  return Array.from({ length: count }, (_, i) => {
    const angle = phase + i * 2.399963229728653,
      radius = 0.5 + i * 0.2;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
}
