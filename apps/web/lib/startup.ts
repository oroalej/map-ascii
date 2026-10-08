import { useUiStore } from '@/state/ui';
import { useAtlasInstance } from '@/state/store';

/** All automatic sidecars share this signal, including subscribers mounted after readiness. */
export function afterFirstTileFrame(city: string, callback: () => void): () => void {
  let done = false;
  const check = () => {
    const startup = useUiStore.getState().startup;
    if (
      !done &&
      startup?.city === city &&
      startup.status === 'ready' &&
      startup.atlas === useAtlasInstance.getState().atlas &&
      startup.atlas
    ) {
      done = true;
      callback();
    }
  };
  const unsubscribe = useUiStore.subscribe(check);
  check();
  return unsubscribe;
}
