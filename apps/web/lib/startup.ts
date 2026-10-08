import { useUiStore } from '@/state/ui';
import { useAtlasInstance } from '@/state/store';
import { AUTOMATIC_JSON, type AutomaticJson, type AutomaticJsonPolicy } from './automatic-json';

/** Every automatic sidecar uses the policy that the export budget measures. */
export function scheduleAutomaticJson(
  city: string,
  resource: AutomaticJson,
  callback: () => void,
  policy: AutomaticJsonPolicy = AUTOMATIC_JSON,
): () => void {
  if (policy[resource] === 'startup') {
    callback();
    return () => {};
  }
  return afterFirstTileFrame(city, callback);
}

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
