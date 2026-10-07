import { expect, it } from 'vitest';
import { selectPlace } from './selection';
import { useAtlasStore } from './store';
import { useUiStore } from './ui';

it('records each selection before its identity, clears same-ID anchors, and requests keyboard focus once', () => {
  const seen: unknown[] = [];
  const off = useAtlasStore.subscribe(() => seen.push(useUiStore.getState().anchor));
  selectPlace('a', { origin: 'pointer', anchor: [1, 2], picked: { id: 'a', class: 'monument' } });
  const first = useUiStore.getState().selectionSequence;
  expect(seen.at(-1)).toMatchObject({ id: 'a', lngLat: [1, 2], sequence: first });
  selectPlace('a', { origin: 'keyboard' });
  expect(useUiStore.getState()).toMatchObject({
    anchor: null,
    picked: null,
    focusRequest: first + 1,
  });
  selectPlace('b');
  selectPlace('a', { origin: 'pointer' });
  expect(useUiStore.getState()).toMatchObject({ anchor: null, picked: null, focusRequest: null });
  selectPlace('a', { origin: 'pointer', anchor: [3, 4] });
  selectPlace('a');
  expect(useUiStore.getState().anchor).toBeNull();
  selectPlace(null);
  expect(useUiStore.getState()).toMatchObject({
    selection: null,
    anchor: null,
    picked: null,
    focusRequest: null,
    factsVisible: false,
  });
  off();
});
