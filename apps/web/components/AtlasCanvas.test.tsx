import type * as Renderer from '@atlas/renderer';
import { createAtlas, type Atlas, type AtlasEventMap } from '@atlas/renderer';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initialAtlasState, useAtlasInstance, useAtlasStore } from '@/state/store';
import { AtlasCanvas } from './AtlasCanvas';

vi.mock('@atlas/renderer', async (original) => ({
  ...(await original<typeof Renderer>()),
  createAtlas: vi.fn(),
}));
const meta = {
  slug: 'fixture',
  name: { en: 'Fixture' },
  subdivisionLabel: { en: 'district' },
  languages: [],
  bounds: [1, 2, 3, 4],
  regionBounds: [0, 1, 4, 5],
  defaultCamera: { lat: 3, lng: 2, zoom: 14 },
  yearRange: [1900, 2026],
  attribution: [],
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve({ ok: url.endsWith('.meta.json'), json: () => Promise.resolve(meta) }),
    ),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useAtlasStore.setState(initialAtlasState());
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAtlasInstance.setState({ atlas: null });
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it('catches startup failure and retries on a fresh canvas, then restores and cleans up normally', async () => {
  const listeners = new Map<keyof AtlasEventMap, () => void>();
  const off = vi.fn(),
    destroy = vi.fn();
  const atlas = {
    getCamera: () => meta.defaultCamera,
    destroy,
    on: (event: keyof AtlasEventMap, handler: () => void) => {
      listeners.set(event, handler);
      return off;
    },
  } as unknown as Atlas;
  vi.mocked(createAtlas)
    .mockImplementationOnce(() => {
      throw new Error('selection shader failed');
    })
    .mockReturnValue(atlas);
  const probe = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
  await act(async () => {
    root.render(
      createElement(AtlasCanvas, {
        slug: 'fixture',
        name: 'Fixture',
        subdivisionLabel: 'district',
      }),
    );
    await Promise.resolve();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Map graphics could not start',
  );
  expect(console.error).toHaveBeenCalledWith(
    'ASCII Atlas graphics initialization failed',
    expect.any(Error),
  );
  expect(probe).not.toHaveBeenCalled();
  expect(useAtlasInstance.getState().atlas).toBeNull();
  const previous = container.querySelector('canvas');
  act(() => container.querySelector('button')!.click());
  expect(createAtlas).toHaveBeenCalledTimes(2);
  expect(container.querySelector('canvas')).not.toBe(previous);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(useAtlasInstance.getState().atlas).toBe(atlas);
  act(() => listeners.get('contextlost')!());
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Restoring');
  act(() => listeners.get('contextrestored')!());
  expect(container.querySelector('[role="status"]')).toBeNull();
  act(() => root.render(null));
  expect(destroy).toHaveBeenCalledOnce();
  expect(off).toHaveBeenCalledTimes(4);
  expect(useAtlasInstance.getState().atlas).toBeNull();
});
