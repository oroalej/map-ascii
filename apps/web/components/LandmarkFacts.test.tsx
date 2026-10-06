// @vitest-environment jsdom
import type { Atlas } from '@atlas/renderer';
import type { Landmark, SearchEntry } from '@atlas/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initialAtlasState, useAtlasInstance, useAtlasStore } from '@/state/store';
import { selectPlace } from '@/state/selection';
import { useUiStore } from '@/state/ui';
import { useAtlasEvents } from '@/state/useAtlasEvents';
import { loadSearch, type CitySearch } from '@/lib/search';
import MiniSearch from 'minisearch';
import { LandmarkFacts } from './LandmarkFacts';
import { TourPlayer } from './TourPlayer';
import { useTourStore } from '@/state/tour';
vi.mock('@/lib/search', () => ({ loadSearch: vi.fn() }));
const landmark: Landmark = {
  id: 'landmark/a',
  osm_id: 'osm:node/1',
  name: { en: 'A place' },
  type: 'monument',
  certainty: 'unknown',
  sources: [{ title: 'History', url: 'https://example.org/history' }],
  facts: [0, 1, 2].map((i) => ({
    text: { en: `Fact ${i}` },
    source: 0,
    ...(i === 0 ? { year: 1900, certainty: 'circa' as const } : {}),
  })),
};
const other = { ...landmark, id: 'landmark/b', osm_id: 'osm:node/2', name: { en: 'B place' } };
let root: Root, container: HTMLDivElement, canvas: HTMLCanvasElement;
let frames: Map<number, FrameRequestCallback>,
  next: number,
  projected: [number, number],
  cameraChanged: (() => void) | undefined;
let small: boolean,
  mediaListeners: Set<() => void>,
  observers: Set<() => void>,
  shownMeasures: number;
let viewport: EventTarget & {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
};
const searchData = (entries: SearchEntry[]): CitySearch => ({
  index: new MiniSearch({ fields: ['name'] }),
  entries: new Map(entries.map((e) => [e.id, e])),
});
const entry = (id: string, lng: number): SearchEntry => ({
  id,
  name: 'Place',
  altNames: [],
  type: 'landmark',
  lat: 2,
  lng,
  zoomHint: 18,
});
function App() {
  useAtlasEvents();
  return (
    <>
      <LandmarkFacts
        city="test"
        subdivisionLabel="district"
        landmarks={[
          landmark,
          other,
          { ...landmark, id: 'landmark/c', osm_id: 'osm:node/3', facts: undefined },
        ]}
        art={[]}
      />
      <TourPlayer />
    </>
  );
}
const render = () => act(() => root.render(createElement(App)));
const flush = () => {
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((cb) => cb(100));
  });
};
const dialog = () => container.querySelector<HTMLDivElement>('[role="dialog"]');
const clickSelection = (id = landmark.osm_id!) =>
  act(() => selectPlace(id, { origin: 'pointer', anchor: [1, 2] }));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = new Map();
  next = 0;
  projected = [200, 200];
  small = false;
  mediaListeners = new Set();
  observers = new Set();
  shownMeasures = 0;
  viewport = Object.assign(new EventTarget(), {
    width: 800,
    height: 700,
    offsetLeft: 0,
    offsetTop: 0,
  });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('matchMedia', () => ({
    matches: small,
    addEventListener: (_: string, cb: () => void) => mediaListeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => mediaListeners.delete(cb),
  }));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++next, cb);
    return next;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
        observers.add(cb);
      }
      observe() {}
      disconnect() {
        observers.delete(this.cb);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.getAttribute('role') !== 'dialog') return new DOMRect();
    if (this.hidden) return new DOMRect(0, 0, 0, 0);
    shownMeasures++;
    return new DOMRect(
      0,
      0,
      Number.parseFloat(this.style.width) || 320,
      Math.min(260, Number.parseFloat(this.style.maxHeight) || 260),
    );
  });
  vi.mocked(loadSearch).mockReturnValue(new Promise(() => {}));
  useAtlasStore.setState(initialAtlasState());
  selectPlace(null);
  useTourStore.setState({ active: null });
  canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    value: () => new DOMRect(20, 30, 700, 600),
  });
  const on: Atlas['on'] = (event, handler) => {
    if (event === 'camerachange') cameraChanged = handler as () => void;
    return () => {
      if (event === 'camerachange') cameraChanged = undefined;
    };
  };
  const atlas = {
    project: vi.fn(() => projected),
    on,
    getFeature: () => undefined,
    getCamera: () => ({ lng: 1, lat: 2, zoom: 18 }),
    setCamera: vi.fn(),
    setSelected: vi.fn(),
    setHighlighted: vi.fn(),
  } as unknown as Atlas;
  useAtlasInstance.setState({ atlas, canvas });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    await Promise.resolve();
    root.unmount();
  });
  container.remove();
  useAtlasInstance.setState({ atlas: null, canvas: null });
  useTourStore.setState({ active: null });
  selectPlace(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('shows sourced facts, follows the camera, hides offscreen and remeasures on return in one frame', () => {
  clickSelection();
  render();
  expect(dialog()!.hidden).toBe(true);
  flush();
  expect(dialog()!.textContent).toContain('Fact 0');
  expect(dialog()!.textContent).toContain('c. 1900');
  expect(dialog()!.querySelector('sup a')?.getAttribute('href')).toBe(
    'https://example.org/history',
  );
  expect(dialog()!.querySelector('a[href="https://www.openstreetmap.org/node/1"]')).not.toBeNull();
  const before = dialog()!.style.transform;
  projected = [210, 220];
  act(() => cameraChanged!());
  flush();
  expect(dialog()!.style.transform).not.toBe(before);
  projected = [-100, 220];
  act(() => cameraChanged!());
  flush();
  expect(dialog()!.hidden).toBe(true);
  expect(useUiStore.getState().factsVisible).toBe(false);
  expect(dialog()!.getBoundingClientRect().width).toBe(0);
  const measured = shownMeasures;
  projected = [100, 100];
  act(() => cameraChanged!());
  flush();
  expect(dialog()!.hidden).toBe(false);
  expect(shownMeasures).toBe(measured + 1);
  expect(useUiStore.getState().factsVisible).toBe(true);
  expect(useAtlasStore.getState().selectedId).toBe(landmark.osm_id);
});
it('constrains the measured box to the canvas/visual viewport and responds to resize without a camera event', () => {
  viewport.width = 240;
  viewport.height = 180;
  viewport.offsetLeft = 100;
  viewport.offsetTop = 70;
  projected = [160, 100];
  clickSelection();
  render();
  flush();
  const verify = () => {
    const box = dialog()!.getBoundingClientRect(),
      numbers = dialog()!
        .style.transform.match(/[\d.]+/g)!
        .map(Number),
      [x, y] = numbers;
    expect(x).toBeGreaterThanOrEqual(viewport.offsetLeft + 8);
    expect(y).toBeGreaterThanOrEqual(viewport.offsetTop + 8);
    expect(x! + box.width).toBeLessThanOrEqual(viewport.offsetLeft + viewport.width - 8);
    expect(y! + box.height).toBeLessThanOrEqual(viewport.offsetTop + viewport.height - 8);
  };
  verify();
  const before = dialog()!.style.width;
  viewport.width = 180;
  viewport.height = 140;
  act(() => {
    viewport.dispatchEvent(new Event('resize'));
  });
  flush();
  verify();
  expect(dialog()!.style.width).not.toBe(before);
  act(() => {
    window.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('scroll'));
    observers.forEach((cb) => cb());
  });
  expect(frames.size).toBe(1);
  flush();
  verify();
});
it('preserves pointer focus, focuses keyboard opening once, and clears through Close and Escape', async () => {
  vi.mocked(loadSearch).mockResolvedValue(searchData([entry(landmark.osm_id!, 1)]));
  const button = document.createElement('button');
  document.body.append(button);
  button.focus();
  clickSelection();
  render();
  flush();
  expect(document.activeElement).toBe(button);
  await act(async () => {
    selectPlace(landmark.osm_id!, { origin: 'keyboard' });
    await Promise.resolve();
  });
  flush();
  expect(document.activeElement).toBe(dialog()!.querySelector('h2'));
  expect(useUiStore.getState().focusRequest).toBeNull();
  button.focus();
  act(() => cameraChanged!());
  flush();
  expect(document.activeElement).toBe(button);
  act(() => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  expect(dialog()).toBeNull();
  clickSelection();
  flush();
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
  expect(dialog()).toBeNull();
  expect(useUiStore.getState().factsVisible).toBe(false);
  button.remove();
});
it('does not show unlisted selections and cancels stale search responses', async () => {
  act(() => selectPlace('osm:node/3'));
  render();
  expect(dialog()).toBeNull();
  let stale!: (data: CitySearch) => void;
  vi.mocked(loadSearch)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        stale = resolve;
      }),
    )
    .mockResolvedValueOnce(searchData([entry(other.osm_id, 20)]));
  act(() => selectPlace(landmark.osm_id!));
  await act(async () => {
    selectPlace(other.osm_id);
    await Promise.resolve();
  });
  flush();
  const project = vi.spyOn(useAtlasInstance.getState().atlas!, 'project');
  expect(project).toHaveBeenLastCalledWith([20, 2]);
  await act(async () => {
    stale(searchData([entry(landmark.osm_id!, 999)]));
    await Promise.resolve();
  });
  flush();
  expect(project).toHaveBeenLastCalledWith([20, 2]);
  expect(dialog()!.textContent).toContain('B place');
});
it('uses the phone sheet, preserves tour-caption precedence, and opens explicit facts even after the tour ends', () => {
  small = true;
  useAtlasStore.setState({ tour: { id: 'test', step: 0, paused: false } });
  useTourStore.setState({
    active: {
      tour: {
        id: 'tour/test',
        title: { en: 'Tour' },
        status: 'draft',
        steps: [
          { camera: { lat: 0, lng: 0, zoom: 18 }, duration_ms: 1000, narration: { en: 'Caption' } },
        ],
      },
      run: {
        step: 0,
        durations: [1000],
        phase: 'ended',
        paused: true,
        grabbed: false,
        elapsed: 1000,
        since: null,
      },
    },
  });
  act(() => selectPlace(landmark.osm_id!));
  render();
  expect(dialog()).toBeNull();
  expect(container.querySelector('[aria-label="Tour"]')).not.toBeNull();
  clickSelection();
  expect(dialog()).not.toBeNull();
  expect(useUiStore.getState().factsVisible).toBe(true);
  expect(container.querySelector('[aria-label="Tour"]')).toBeNull();
  const handle = dialog()!.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  act(() => handle.click());
  expect(handle.getAttribute('aria-expanded')).toBe('true');
  Object.defineProperty(handle, 'setPointerCapture', { value: vi.fn() });
  act(() => {
    handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientY: 10 }));
    handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientY: 80 }));
  });
  expect(dialog()).toBeNull();
  expect(container.querySelector('[aria-label="Tour"]')).not.toBeNull();
  act(() => selectPlace(landmark.osm_id!, { origin: 'keyboard' }));
  expect(document.activeElement).toBe(dialog()!.querySelector('h2'));
});
