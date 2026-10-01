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
    pad = 8;
  if (x < pad || y < pad || x > viewport.width - pad || y > viewport.height - pad) return null;
  for (const below of [false, true]) {
    for (const gap of [14, 22, 30]) {
      const top = below ? y + gap : y - size.height - gap;
      const candidates = [0.5, 0.2, 0.8].map((offset) => x - size.width * offset);
      // Fixed offsets miss narrow gaps between the HUD and attribution. Align with
      // obstacle edges as well, while keeping the tail inside the actual bubble.
      for (const other of occupied) {
        if (top >= other.top + other.height + 6 || top + size.height + 6 <= other.top) continue;
        for (const left of [other.left + other.width + 6, other.left - size.width - 6])
          if (x - left >= pad && x - left <= size.width - pad) candidates.push(left);
      }
      for (const candidate of candidates) {
        const left = Math.max(pad, Math.min(viewport.width - size.width - pad, candidate));
        const box = { ...size, left, top };
        if (
          box.top < pad ||
          box.top + box.height > viewport.height - pad ||
          box.left + box.width > viewport.width - pad ||
          occupied.some((other) => overlaps(box, other))
        )
          continue;
        return { ...box, below, tail: x - left };
      }
    }
  }
  return null;
}
