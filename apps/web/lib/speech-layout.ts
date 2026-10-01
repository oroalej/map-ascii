export type SpeechRect = { left: number; top: number; width: number; height: number };
const overlaps = (a: SpeechRect, b: SpeechRect) =>
  a.left < b.left + b.width + 6 &&
  a.left + a.width + 6 > b.left &&
  a.top < b.top + b.height + 6 &&
  a.top + a.height + 6 > b.top;

/** Above/below variants keep the tail attached; suppressed bubbles never cover controls. */
export function placeSpeech(
  point: readonly [number, number],
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  occupied: readonly SpeechRect[],
) {
  const [x, y] = point,
    gap = 14,
    pad = 8;
  if (x < pad || y < pad || x > viewport.width - pad || y > viewport.height - pad) return null;
  for (const below of [false, true])
    for (const offset of [0.5, 0.2, 0.8]) {
      const left = Math.max(
        pad,
        Math.min(viewport.width - size.width - pad, x - size.width * offset),
      );
      const box = { ...size, left, top: below ? y + gap : y - size.height - gap };
      if (
        box.top < pad ||
        box.top + box.height > viewport.height - pad ||
        box.left + box.width > viewport.width - pad ||
        occupied.some((other) => overlaps(box, other))
      )
        continue;
      return { ...box, below, tail: x - left };
    }
  return null;
}
