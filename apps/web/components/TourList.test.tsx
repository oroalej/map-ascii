// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Tour } from '@atlas/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tourControls, useTourStore } from '@/state/tour';
import { TourList } from './TourList';

vi.mock('@/state/store', () => ({
  useAtlasInstance: (select: (state: { atlas: object }) => boolean) => select({ atlas: {} }),
}));

const tour = (id: string, group?: string): Tour => ({
  id: `tour/${id}`,
  title: { en: id },
  group,
  status: 'draft',
  description: { en: `${id} description` },
  steps: [{ camera: { lat: 0, lng: 0, zoom: 16 }, duration_ms: 4000, narration: { en: id } }],
});
const groups = [
  { id: 'food', label: 'Food' },
  { id: 'heritage', label: 'Heritage' },
  { id: 'infrastructure', label: 'Infrastructure' },
];
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  root = createRoot(container);
  useTourStore.setState({
    dataStatus: 'ready',
    tours: [tour('heritage', 'heritage'), tour('first', 'food'), tour('second', 'food')],
  });
});
afterEach(() => {
  act(() => root.unmount());
  useTourStore.setState({ tours: [], dataStatus: 'unloaded' });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('uses declared group order, preserves tour order and labels each nested list', () => {
  act(() => root.render(<TourList id="menu" tourGroups={groups} />));
  expect(container.querySelector('ul')?.getAttribute('aria-label')).toBe('Tours');
  expect([...container.querySelectorAll('h3')].map((h) => h.textContent)).toEqual([
    'Food',
    'Heritage',
  ]);
  expect(
    [...container.querySelectorAll('ul[aria-labelledby]')].map(
      (list) => container.querySelector(`#${list.getAttribute('aria-labelledby')}`)?.textContent,
    ),
  ).toEqual(['Food', 'Heritage']);
  expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
    'first1 stopdraftfirst description',
    'second1 stopdraftsecond description',
    'heritage1 stopdraftheritage description',
  ]);
  const start = vi.spyOn(tourControls, 'start').mockReturnValue(true);
  act(() => container.querySelector('button')!.click());
  expect(start).toHaveBeenCalledWith('first');
});

it('keeps the flat list and button names when no groups are declared', () => {
  act(() => root.render(<TourList id="menu" />));
  expect(container.querySelectorAll('ul')).toHaveLength(1);
  expect(container.querySelectorAll('h3')).toHaveLength(0);
  expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
    'heritage1 stopdraftheritage description',
    'first1 stopdraftfirst description',
    'second1 stopdraftsecond description',
  ]);
});

it.each(['loading', 'error', 'ready'] as const)(
  'retains the %s state inside the outer Tours list',
  (dataStatus) => {
    useTourStore.setState({ dataStatus, tours: [] });
    act(() => root.render(<TourList id="menu" tourGroups={groups} />));
    expect(container.querySelectorAll('ul')).toHaveLength(1);
    expect(container.querySelectorAll('h3')).toHaveLength(0);
    expect(container.textContent).toBe(
      dataStatus === 'loading'
        ? 'Loading tours…'
        : dataStatus === 'error'
          ? 'Retry loading tours'
          : 'No tours available.',
    );
  },
);
