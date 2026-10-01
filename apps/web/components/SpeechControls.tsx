'use client';

import type { DialogueCatalog } from '@atlas/shared';
import { useSyncExternalStore } from 'react';
import { prefersReducedMotion, subscribeReducedMotion } from '@/lib/motion';
import { useLifeStore } from '@/state/life';
import { useAtlasStore } from '@/state/store';
import { useSpeechStore } from '@/state/speech';
import styles from './Hud.module.css';

export function SpeechControls({ catalog }: { catalog: DialogueCatalog }) {
  const enabled = useSpeechStore((s) => s.enabled);
  const translation = useSpeechStore((s) => s.translation);
  const life = useLifeStore((s) => s.enabled);
  const zoom = useAtlasStore((s) => s.camera?.zoom ?? 0);
  const reduced = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
  const explanation = reduced
    ? 'Speech pauses while reduced motion is on.'
    : !life
      ? 'Turn Life on to see speech.'
      : zoom < 18
        ? 'Zoom to z18 or closer to see speech.'
        : null;
  return (
    <>
      <div className={styles.row}>
        <button
          type="button"
          className={`${styles.button} ${styles.toggle}`}
          aria-pressed={enabled}
          title="Speech bubbles for simulated greetings and conversations at z18 and closer"
          onClick={() => useSpeechStore.setState({ enabled: !enabled })}
        >
          Speech
        </button>
        <select
          className={styles.button}
          aria-label="Speech translation"
          value={translation ?? ''}
          onChange={(event) => useSpeechStore.setState({ translation: event.target.value || null })}
        >
          <option value="">{catalog.native.label} only</option>
          {catalog.translations.map(({ code, label }) => (
            <option key={code} value={code}>
              {label} translation
            </option>
          ))}
        </select>
      </div>
      {enabled && explanation && <p className={styles.line}>{explanation}</p>}
    </>
  );
}
