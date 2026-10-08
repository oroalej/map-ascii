import type { Atlas } from '@atlas/renderer';
import { useUiStore } from '@/state/ui';
import { cityJson } from './city-json';
import { isCityProcessions } from './guards';

export const loadProcessions = cityJson('processions', isCityProcessions, { processions: [] });
const installed = new WeakMap<Atlas, unknown>();
export async function installProcessions(city: string, atlas: Atlas, current: () => boolean) {
  const { processions } = await loadProcessions(city);
  if (!current()) return null;
  if (installed.get(atlas) !== processions) {
    atlas.setProcessions(processions);
    installed.set(atlas, processions);
  }
  useUiStore.setState({ processions });
  return processions;
}
