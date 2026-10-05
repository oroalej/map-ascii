'use client';
import type { RuntimeDialogueCatalog } from '@atlas/shared';
import { CueBubbles } from './CueBubbles';
/** Speech compatibility entry point delegates to the shared production overlay. */
export function SpeechBubbles({ catalog }: { catalog: RuntimeDialogueCatalog }) {
  return <CueBubbles catalog={catalog} />;
}
