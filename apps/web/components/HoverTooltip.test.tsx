import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUiStore } from '@/state/ui';
import { HoverTooltip } from './HoverTooltip';
import type { FeatureInfo } from '@atlas/renderer';

let observers: ResizeObserverCallback[];
let rect: { width: number; height: number };
beforeEach(() => {
  observers = [];
  rect = { width: 80, height: 20 };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => rect as DOMRect,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('prioritizes simulated hover and restores the landmark tooltip when it clears', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'),
    root = createRoot(container);
  useUiStore.setState({
    hover: { feature: { name: 'Place' } as FeatureInfo, point: [1, 2] },
    lifeHover: null,
  });
  act(() => root.render(createElement(HoverTooltip)));
  expect(container.textContent).toBe('Place');
  act(() => useUiStore.setState({ lifeHover: { label: 'Car (simulated)', point: [3, 4] } }));
  expect(container.textContent).toBe('Car (simulated)');
  expect(container.querySelector('[role="tooltip"]')?.getAttribute('style')).toContain(
    'left: 17px',
  );
  act(() => useUiStore.setState({ lifeHover: null }));
  expect(container.textContent).toBe('Place');
  act(() => root.unmount());
  useUiStore.setState({ hover: null });
  vi.unstubAllGlobals();
});

it('remeasures long labels and responds to element and visual viewport changes', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const visual = Object.assign(new EventTarget(), {
    offsetLeft: 0,
    offsetTop: 0,
    width: 300,
    height: 200,
  });
  vi.stubGlobal('visualViewport', visual);
  const container = document.createElement('div'),
    root = createRoot(container);
  useUiStore.setState({
    hover: null,
    lifeHover: { label: 'Person (simulated)', point: [290, 190] },
  });
  act(() => root.render(createElement(HoverTooltip)));
  const tooltip = container.querySelector<HTMLElement>('[role="tooltip"]')!;
  expect(tooltip.style.left).toBe('196px');
  expect(tooltip.style.top).toBe('156px');
  rect.width = 180;
  act(() =>
    useUiStore.setState({
      lifeHover: { label: 'Longer activity name (simulated)', point: [290, 190] },
    }),
  );
  expect(tooltip.style.left).toBe('96px');
  rect.width = 100;
  act(() => observers.at(-1)!([], {} as ResizeObserver));
  expect(tooltip.style.left).toBe('176px');
  Object.assign(visual, { width: 130, offsetLeft: 30 });
  act(() => {
    visual.dispatchEvent(new Event('resize'));
  });
  expect(tooltip.style.maxWidth).toBe('114px');
  expect(tooltip.style.left).toBe('52px');
  Object.assign(visual, { offsetTop: 100 });
  act(() => {
    visual.dispatchEvent(new Event('scroll'));
  });
  expect(tooltip.style.top).toBe('204px');
  act(() => root.unmount());
  useUiStore.setState({ lifeHover: null });
});
