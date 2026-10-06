import { expect, it } from 'vitest';
import { layoutBubbles, type BubbleLayout } from './bubble-overlay';
import { placeSpeech } from './speech-layout';
const cue = (id: string, x = 400, pair?: string): BubbleLayout => ({
  id,
  kind: 'emoji',
  pair,
  point: [x, 300],
  size: { width: 38, height: 34 },
});
const viewport = { width: 800, height: 600 };
it('rolls back a blocked pair footprint before placing the next group', () => {
  const block = { left: 560, top: 0, width: 120, height: 600 };
  const later = cue('later', 300);
  const expected = layoutBubbles([later], viewport, [block], []).get('later');
  const actual = layoutBubbles(
    [cue('a', 300, 'pair'), cue('b', 600, 'pair'), later],
    viewport,
    [block],
    [],
  );
  expect(actual.has('a')).toBe(false);
  expect(actual.has('b')).toBe(false);
  expect(actual.get('later')).toEqual(expected);
});
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
it('matches unfiltered placement near viewport edges and label-clearance boundaries', () => {
  const labels = [
    { left: 0, top: 200, width: 19, height: 81 },
    { left: 25, top: 242, width: 20, height: 40 },
    { left: 380, top: 210, width: 80, height: 78 },
    { left: 750, top: 270, width: 50, height: 45 },
  ];
  for (const x of [8, 20, 40, 400, 760, 792]) {
    const record = cue('a', x);
    const expected = placeSpeech(record.point, { width: 38, height: 48 }, viewport, labels);
    const actual = layoutBubbles([record], viewport, [], labels).get('a');
    expect(actual).toEqual(
      expected
        ? {
            ...expected,
            height: 34,
            top: expected.top + (expected.below ? 14 : 0),
          }
        : undefined,
    );
  }
});
it('ignores distant labels while retaining local thought-dot collisions', () => {
  const local = [{ left: 360, top: 210, width: 80, height: 78 }];
  const distant = Array.from({ length: 100 }, (_, i) => ({
    left: 600 + i,
    top: 0,
    width: 30,
    height: 40,
  }));
  expect(layoutBubbles([cue('a')], viewport, [], [...local, ...distant])).toEqual(
    layoutBubbles([cue('a')], viewport, [], local),
  );
});
