import { placeSpeech, speechPlacementEnvelope, type SpeechRect } from './speech-layout';
// Matches the 14px extension of .emoji::after and its below variant in SpeechBubbles.module.css.
const THOUGHT_DOT_EXTENT = 14;
export type BubbleLayout = {
  id: string;
  kind: 'speech' | 'emoji';
  pair?: string;
  point: readonly [number, number];
  size: { width: number; height: number };
};
/** Shared production layout. Each pair either commits every body and thought dot, or none. */
export function layoutBubbles(
  cues: readonly BubbleLayout[],
  viewport: { width: number; height: number },
  obstacles: readonly SpeechRect[],
  labels: readonly SpeechRect[],
  origin: { left: number; top: number } = { left: 0, top: 0 },
) {
  const result = new Map<string, NonNullable<ReturnType<typeof placeSpeech>>>();
  const occupied = [...obstacles];
  const groups = new Map<string, BubbleLayout[]>();
  for (const cue of cues) {
    const id = cue.kind === 'emoji' && cue.pair ? `pair:${cue.pair}` : cue.id;
    const group = groups.get(id) ?? [];
    group.push(cue);
    groups.set(id, group);
  }
  const mapLabels =
    origin.left === 0 && origin.top === 0
      ? labels
      : labels.map((b) => ({ ...b, left: b.left + origin.left, top: b.top + origin.top }));
  for (const group of groups.values()) {
    const emoji = group[0]!.kind === 'emoji';
    if (emoji && group[0]!.pair && group.length !== 2) continue;
    const start = occupied.length;
    const placed: [string, NonNullable<ReturnType<typeof placeSpeech>>][] = [];
    for (const cue of group) {
      const point: [number, number] = [cue.point[0] + origin.left, cue.point[1] + origin.top];
      const size = { ...cue.size, height: cue.size.height + (emoji ? THOUGHT_DOT_EXTENT : 0) };
      const envelope = speechPlacementEnvelope(point, size, viewport);
      const nearby = emoji
        ? mapLabels.filter(
            (label) =>
              label.left < envelope.left + envelope.width &&
              label.left + label.width > envelope.left &&
              label.top < envelope.top + envelope.height &&
              label.top + label.height > envelope.top,
          )
        : [];
      const footprint = placeSpeech(
        point,
        size,
        viewport,
        nearby.length ? [...occupied, ...nearby] : occupied,
      );
      if (!footprint) break;
      occupied.push(footprint);
      placed.push([
        cue.id,
        {
          ...footprint,
          height: cue.size.height,
          top: footprint.top + (emoji && footprint.below ? THOUGHT_DOT_EXTENT : 0),
        },
      ]);
    }
    if (placed.length !== group.length) {
      occupied.length = start;
      continue;
    }
    for (const [id, box] of placed) result.set(id, box);
  }
  return result;
}
