import type { FeatureInfo } from '@atlas/renderer';
import { useAtlasStore } from './store';
import { useUiStore, type SelectionOrigin } from './ui';

/** Record every operation, including same-ID selections, before publishing its URL identity. */
export function selectPlace(
  id: string | null,
  options: {
    origin?: SelectionOrigin;
    anchor?: readonly [number, number];
    picked?: FeatureInfo;
  } = {},
) {
  const sequence = useUiStore.getState().selectionSequence + 1;
  const origin = options.origin ?? 'programmatic';
  useUiStore.setState({
    selectionSequence: sequence,
    selection: id ? { id, origin, sequence } : null,
    anchor:
      id && origin === 'pointer' && options.anchor
        ? { id, lngLat: options.anchor, sequence }
        : null,
    picked: id && origin === 'pointer' && options.picked?.id === id ? options.picked : null,
    focusRequest: id && origin === 'keyboard' ? sequence : null,
    factsVisible: false,
  });
  useAtlasStore.getState().setSelected(id);
}
