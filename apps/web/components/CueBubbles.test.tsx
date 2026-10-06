import type { Atlas, EmojiInView, SpeechInView } from '@atlas/renderer';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAtlasInstance } from '@/state/store';
import { useEmojiStore } from '@/state/emoji';
import { useSpeechStore } from '@/state/speech';
import { CueBubbles } from './CueBubbles';
let frames: Map<number, FrameRequestCallback>, nextFrame: number;
beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(38);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(34);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
});
const flushCues = () =>
  act(async () => {
    await Promise.resolve();
  });
afterEach(() => {
  useAtlasInstance.setState({ atlas: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('renders emoji without a dialogue catalog, reads current label footprints and removes disabled nodes', async () => {
  let listener: ((cues: EmojiInView[]) => void) | undefined;
  let labels = [{ left: 360, top: 210, width: 80, height: 78 }];
  const on: Atlas['on'] = (event, handler) => {
    if (event === 'emojichange') listener = handler as typeof listener;
    return () => {};
  };
  const getLabelObstacles = vi.fn(() => labels);
  useAtlasInstance.setState({ atlas: { on, getLabelObstacles } as unknown as Atlas });
  useEmojiStore.setState({ enabled: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(CueBubbles)));
  const cue: EmojiInView = { id: 'dog', subject: 'dog', mood: 'happy', point: [400, 300] };
  act(() => listener!([cue]));
  await flushCues();
  const node = container.querySelector<HTMLElement>('[data-emoji-bubble]')!;
  expect(node.textContent).toBe('💕');
  expect(node.style.visibility).toBe('visible');
  expect(node.dataset.below).toBe('true');
  labels = [];
  act(() => listener!([{ ...cue, point: [400.1, 300] }]));
  await flushCues();
  expect(node.dataset.below).toBe('false');
  expect(getLabelObstacles).toHaveBeenCalledTimes(2);
  act(() => useEmojiStore.setState({ enabled: false }));
  expect(container.querySelector('[data-emoji-bubble]')).toBeNull();
  act(() => root.unmount());
  container.remove();
});
it('coalesces both cue channels before the next frame, follows moving anchors and cancels queued work', async () => {
  let speech: ((cues: SpeechInView[]) => void) | undefined;
  let emoji: ((cues: EmojiInView[]) => void) | undefined;
  const on: Atlas['on'] = (event, handler) => {
    if (event === 'speechchange') speech = handler as typeof speech;
    if (event === 'emojichange') emoji = handler as typeof emoji;
    return () => {};
  };
  const getLabelObstacles = vi.fn(() => []);
  useAtlasInstance.setState({ atlas: { on, getLabelObstacles } as unknown as Atlas });
  useSpeechStore.setState({ enabled: true, translation: null });
  useEmojiStore.setState({ enabled: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(CueBubbles, {
        catalog: {
          native: { code: 'bcl', label: 'Bikol' },
          translations: [],
          exchanges: [{ id: 'chat', kind: 'talk', lines: [{ bcl: 'Hello', en: 'Hello' }] }],
        },
      }),
    ),
  );
  const cue: EmojiInView = { id: 'pet', subject: 'cat', mood: 'happy', point: [600, 300] };
  act(() => {
    speech!([{ id: 'human', exchangeId: 'chat', line: 0, point: [300, 300] }]);
    emoji!([cue]);
    emoji!([{ ...cue, mood: 'sleeping' }]);
  });
  expect(nextFrame).toBe(0);
  expect(container.querySelectorAll('[data-emoji-bubble]')).toHaveLength(0);
  await flushCues();
  expect(getLabelObstacles).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-emoji-bubble]')?.textContent).toBe('💤');
  expect(container.querySelector('[lang="bcl"]')?.textContent).toBe('Hello');
  act(() => {
    emoji!([cue]);
    emoji!([]);
  });
  expect(container.querySelectorAll('[data-emoji-bubble]')).toHaveLength(0);
  expect(getLabelObstacles).toHaveBeenCalledTimes(1);
  await flushCues();
  expect(container.querySelectorAll('[data-emoji-bubble]')).toHaveLength(0);
  const speechNode = container.querySelector<HTMLElement>('[data-speech-bubble]')!;
  const previousPosition = speechNode.style.transform;
  act(() => speech!([{ id: 'human', exchangeId: 'chat', line: 0, point: [301, 300] }]));
  await flushCues();
  expect(speechNode.style.transform).not.toBe(previousPosition);
  expect(nextFrame).toBe(0);
  act(() => speech!([{ id: 'human', exchangeId: 'chat', line: 0, point: [302, 300] }]));
  act(() => root.unmount());
  expect(frames.size).toBe(0);
  await flushCues();
  expect(container.querySelectorAll('[data-speech-bubble]')).toHaveLength(0);
  container.remove();
});
