import type { Atlas, SpeechInView } from '@atlas/renderer';
import type { DialogueCatalog } from '@atlas/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSpeechStore } from '@/state/speech';
import { useAtlasInstance, useAtlasStore } from '@/state/store';
import { useLifeStore } from '@/state/life';
import { SpeechBubbles } from './SpeechBubbles';
import { SpeechControls } from './SpeechControls';

const catalog: DialogueCatalog = {
  native: { code: 'bcl', label: 'Bikol' },
  translations: [
    { code: 'en', label: 'English' },
    { code: 'fil', label: 'Tagalog' },
  ],
  exchanges: [
    {
      id: 'chat',
      kind: 'talk',
      sources: [{ title: 'Fixture' }],
      lines: [
        { bcl: 'Kumusta ka?', en: 'How are you?', fil: 'Kumusta ka?' },
        { bcl: 'Marhay man, salamat.', en: 'I am fine, thank you.', fil: 'Mabuti naman, salamat.' },
      ],
    },
  ],
};
let container: HTMLDivElement, root: Root, listener: ((cues: SpeechInView[]) => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  useLifeStore.setState({ enabled: true });
  useAtlasStore.setState({ camera: { lng: 0, lat: 0, zoom: 19 } });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(180);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(60);
  useSpeechStore.setState({ enabled: true, translation: null });
  const on: Atlas['on'] = (event, handler) => {
    if (event === 'speechchange') listener = handler as (cues: SpeechInView[]) => void;
    return () => {
      listener = undefined;
    };
  };
  useAtlasInstance.setState({ atlas: { on } as Atlas });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      createElement(
        'div',
        null,
        createElement(SpeechControls, { catalog }),
        createElement(SpeechBubbles, { catalog }),
      ),
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAtlasInstance.setState({ atlas: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('explains when Life, zoom or reduced motion prevents speech', () => {
  act(() => useLifeStore.setState({ enabled: false }));
  expect(container.textContent).toContain('Turn Life on to see speech.');
  act(() => {
    useLifeStore.setState({ enabled: true });
    useAtlasStore.setState({ camera: { lng: 0, lat: 0, zoom: 17 } });
  });
  expect(container.textContent).toContain('Zoom to z18 or closer to see speech.');
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  act(() => useAtlasStore.setState({ camera: { lng: 0, lat: 0, zoom: 19 } }));
  expect(container.textContent).toContain('Speech pauses while reduced motion is on.');
});
const cue = (line = 0): SpeechInView => ({
  id: 'speaker',
  exchangeId: 'chat',
  line,
  point: [400, 300],
});
it('keeps Bikol visible, switches translations immediately, follows replies and toggles speech', () => {
  act(() => {
    listener!([cue()]);
    vi.advanceTimersToNextFrame();
  });
  expect(container.querySelector('[lang="bcl"]')?.textContent).toBe('Kumusta ka?');
  expect(container.querySelector('[lang="en"]')).toBeNull();
  const select = container.querySelector('select')!;
  const translate = (code: string) =>
    act(() => {
      select.value = code;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  translate('en');
  expect(container.querySelector('[lang="en"]')?.textContent).toBe('How are you?');
  expect(container.querySelector('[lang="bcl"]')?.textContent).toBe('Kumusta ka?');
  translate('fil');
  expect(container.querySelector('[lang="en"]')).toBeNull();
  expect(container.querySelector('[lang="fil"]')?.textContent).toBe('Kumusta ka?');
  act(() => {
    listener!([cue(1)]);
    vi.advanceTimersToNextFrame();
  });
  expect(container.querySelector('[lang="bcl"]')?.textContent).toBe('Marhay man, salamat.');
  expect(container.querySelector('[lang="fil"]')?.textContent).toBe('Mabuti naman, salamat.');
  act(() => container.querySelector('button')!.click());
  expect(container.querySelectorAll('[data-speech-bubble]')).toHaveLength(0);
  expect(container.querySelector('button')!.getAttribute('aria-pressed')).toBe('false');
  act(() => container.querySelector('button')!.click());
  expect(container.querySelectorAll('[data-speech-bubble]')).toHaveLength(1);
  act(() => listener!([]));
  expect(container.querySelectorAll('[data-speech-bubble]')).toHaveLength(0);
});
it('uses renderer-selected bubbles and removes old listeners/nodes when the renderer is replaced', () => {
  act(() => {
    listener!([1, 2, 3, 4].map((id) => ({ ...cue(), id: String(id), point: [id * 180, 300] })));
    vi.advanceTimersToNextFrame();
  });
  expect(container.querySelectorAll('[data-speech-bubble]')).toHaveLength(4);
  expect(container.textContent).toContain('Speech (simulated)');
  expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  expect(container.querySelector('[aria-live]')).toBeNull();
  act(() => useAtlasInstance.setState({ atlas: null }));
  expect(listener).toBeUndefined();
  expect(container.querySelectorAll('[data-speech-bubble]')).toHaveLength(0);
});
