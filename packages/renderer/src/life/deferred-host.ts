import type { EmergencyData, ProcessionRoute } from '@atlas/shared';
import type { LifeHost } from './host';

/** A bounded latest-state facade: observation and frame requests never start the simulation. */
export function deferredHost(
  create: () => LifeHost,
  active: () => boolean,
  initial: {
    processions: readonly ProcessionRoute[];
    emergency?: EmergencyData | undefined;
  },
) {
  let host: LifeHost | undefined,
    disposed = false;
  let tiles: Parameters<LifeHost['sync']> | undefined;
  let routes = initial.processions,
    emergency = initial.emergency;
  let live: Parameters<LifeHost['setLive']> = [undefined];
  const start = () => {
    if (disposed || !active()) return undefined;
    if (!host) {
      host = create();
      host.setProcessions(routes);
      host.setEmergency(emergency);
      if (tiles) host.sync(...tiles);
      host.setLive(...live);
    }
    return host;
  };
  return {
    start,
    get started() {
      return !!host;
    },
    latest: () => (disposed ? undefined : host?.latest()),
    request: (...args: Parameters<LifeHost['request']>) =>
      !disposed && (host?.request(...args) ?? false),
    sync: (...args: Parameters<LifeHost['sync']>) => {
      if (!disposed) {
        tiles = args;
        host?.sync(...args);
      }
    },
    clearTiles: () => {
      tiles = undefined;
      host?.clearTiles();
    },
    invalidateFrame: () => host?.invalidateFrame(),
    invalidateFolklore: () => host?.invalidateFolklore(),
    setEmergency: (data?: EmergencyData) => {
      if (!disposed) {
        emergency = data;
        host?.setEmergency(data);
      }
    },
    setProcessions: (next: readonly ProcessionRoute[]) => {
      if (disposed) return;
      routes = next;
      live = [undefined];
      host?.setProcessions(next);
    },
    setLive: (...args: Parameters<LifeHost['setLive']>) => {
      if (disposed) return;
      live = args;
      if (args[0] && routes.some((route) => route.id === args[0])) start();
      host?.setLive(...args);
    },
    play: (...args: Parameters<LifeHost['play']>) => {
      if (disposed || !routes.some((route) => route.id === args[0])) return false;
      return start()?.play(...args) ?? false;
    },
    stop: () => {
      live = [undefined];
      host?.stop();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      tiles = undefined;
      live = [undefined];
      host?.dispose();
    },
  } satisfies LifeHost & { start(): LifeHost | undefined; readonly started: boolean };
}
