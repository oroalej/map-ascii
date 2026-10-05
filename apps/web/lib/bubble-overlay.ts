import { placeSpeech, type SpeechRect } from './speech-layout';
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
  let labelsAdded = false;
  for (const group of groups.values()) {
    const emoji = group[0]!.kind === 'emoji';
    if (emoji && !labelsAdded) {
      occupied.push(
        ...labels.map((b) => ({ ...b, left: b.left + origin.left, top: b.top + origin.top })),
      );
      labelsAdded = true;
    }
    if (emoji && group[0]!.pair && group.length !== 2) continue;
    const trial = [...occupied],
      placed: [string, NonNullable<ReturnType<typeof placeSpeech>>][] = [];
    for (const cue of group) {
      const point: [number, number] = [cue.point[0] + origin.left, cue.point[1] + origin.top];
      const size = { ...cue.size, height: cue.size.height + (emoji ? 14 : 0) };
      const footprint = placeSpeech(point, size, viewport, trial);
      if (!footprint) break;
      trial.push(footprint);
      placed.push([
        cue.id,
        {
          ...footprint,
          height: cue.size.height,
          top: footprint.top + (emoji && footprint.below ? 14 : 0),
        },
      ]);
    }
    if (placed.length !== group.length) continue;
    for (const [id, box] of placed) result.set(id, box);
    occupied.push(...trial.slice(occupied.length));
  }
  return result;
}
