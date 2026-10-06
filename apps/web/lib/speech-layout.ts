export type SpeechRect = { left: number; top: number; width: number; height: number };
const PAD = 8;
const CLEARANCE = 6;
const GAPS = [14, 22, 30] as const;
const overlaps = (a: SpeechRect, b: SpeechRect) =>
  a.left < b.left + b.width + CLEARANCE &&
  a.left + a.width + CLEARANCE > b.left &&
  a.top < b.top + b.height + CLEARANCE &&
  a.top + a.height + CLEARANCE > b.top;

/** Bounds every fixed-offset or attached-tail placement, including collision clearance. */
export function speechPlacementEnvelope(
  [x, y]: readonly [number, number],
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): SpeechRect {
  const clamp = (left: number) => Math.max(PAD, Math.min(viewport.width - size.width - PAD, left));
  const left = clamp(x - Math.max(size.width - PAD, size.width * 0.8)) - CLEARANCE;
  const right = clamp(x - Math.min(PAD, size.width * 0.2)) + size.width + CLEARANCE;
  const gap = GAPS[GAPS.length - 1]!;
  return {
    left,
    top: y - size.height - gap - CLEARANCE,
    width: right - left,
    height: 2 * (size.height + gap + CLEARANCE),
  };
}

/** Above/below variants keep the tail attached; suppressed bubbles never cover controls. */
export function placeSpeech(
  point: readonly [number, number],
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  occupied: readonly SpeechRect[],
) {
  const [x, y] = point,
    pad = PAD;
  if (x < pad || y < pad || x > viewport.width - pad || y > viewport.height - pad) return null;
  for (const below of [false, true]) {
    for (const gap of GAPS) {
      const top = below ? y + gap : y - size.height - gap;
      const candidates = [0.5, 0.2, 0.8].map((offset) => x - size.width * offset);
      // Fixed offsets miss narrow gaps between the HUD and attribution. Align with
      // obstacle edges as well, while keeping the tail inside the actual bubble.
      for (const other of occupied) {
        if (
          top >= other.top + other.height + CLEARANCE ||
          top + size.height + CLEARANCE <= other.top
        )
          continue;
        for (const left of [
          other.left + other.width + CLEARANCE,
          other.left - size.width - CLEARANCE,
        ])
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
