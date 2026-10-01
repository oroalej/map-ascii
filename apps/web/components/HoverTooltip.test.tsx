import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useUiStore } from '@/state/ui';
import { HoverTooltip } from './HoverTooltip';
import type { FeatureInfo } from '@atlas/renderer';

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
