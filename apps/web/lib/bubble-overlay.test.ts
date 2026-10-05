import { expect, it } from 'vitest';
import { layoutBubbles, type BubbleLayout } from './bubble-overlay';
const cue = (id: string, x = 400, pair?: string): BubbleLayout => ({
  id,
  kind: 'emoji',
  pair,
  point: [x, 300],
  size: { width: 38, height: 34 },
});
const viewport = { width: 800, height: 600 };
it('places speech first and includes thought dots when avoiding map labels', () => {
  const speech: BubbleLayout = {
    id: 'speech',
    kind: 'speech',
    point: [400, 300],
    size: { width: 180, height: 60 },
  };
  const boxes = layoutBubbles([speech, cue('emoji')], viewport, [], []);
  expect(boxes.size).toBe(2);
  expect(boxes.get('speech')!.top).not.toBe(boxes.get('emoji')!.top);
  const labels = [{ left: 360, top: 210, width: 80, height: 78 }];
  const blocked = layoutBubbles([cue('emoji')], viewport, [], labels);
  expect(blocked.get('emoji')!.below).toBe(true);
});
it.each(['panel', 'speech', 'label', 'edge'])(
  'commits neither pair half when one is blocked by %s',
  (kind) => {
    const pair = [cue('a', 300, 'pair'), cue('b', kind === 'edge' ? 2 : 600, 'pair')];
    const block = { left: 560, top: 0, width: 120, height: 600 };
    const records =
      kind === 'speech'
        ? [
            {
              id: 's1',
              kind: 'speech' as const,
              point: [600, 300] as const,
              size: { width: 180, height: 180 },
            },
            {
              id: 's2',
              kind: 'speech' as const,
              point: [600, 500] as const,
              size: { width: 180, height: 180 },
            },
            ...pair,
          ]
        : pair;
    const boxes = layoutBubbles(
      records,
      viewport,
      kind === 'panel' ? [block] : [],
      kind === 'label' ? [block] : [],
    );
    if (kind === 'speech') {
      expect(boxes.has('s1')).toBe(true);
      expect(boxes.has('s2')).toBe(true);
      expect(boxes.has('a')).toBe(false);
      expect(boxes.has('b')).toBe(false);
    } else expect(boxes.size).toBe(0);
  },
);
it('uses canvas offsets and detached fractional label footprints on every placement', () => {
  const origin = { left: 40.5, top: 25.25 },
    label = { left: 370, top: 210, width: 60.5, height: 78.5 };
  const box = layoutBubbles([cue('a')], viewport, [], [label], origin).get('a')!;
  expect(box.below).toBe(true);
  expect(box.left).toBeGreaterThan(400);
});
