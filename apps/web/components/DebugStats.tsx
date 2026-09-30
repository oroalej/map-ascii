'use client';

import { lazy, Suspense, useSyncExternalStore } from 'react';
import { isDebugRequested } from '@/lib/debug';

const Panel = lazy(() => import('./DebugStatsPanel'));
const subscribeNoop = () => () => {};

/** Keep diagnostics out of the normal startup payload. */
export function DebugStats() {
  const debug = useSyncExternalStore(subscribeNoop, isDebugRequested, () => false);
  return debug ? (
    <Suspense fallback={null}>
      <Panel />
    </Suspense>
  ) : null;
}
