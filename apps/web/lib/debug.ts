/** Capture before URL mirroring removes parameters that aren't view state. */
let requested: boolean | undefined;
export const isDebugRequested = () =>
  (requested ??= new URLSearchParams(window.location.search).get('debug') === '1');
