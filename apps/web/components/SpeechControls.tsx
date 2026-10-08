'use client';

import { SPEECH_ZOOM, type RuntimeDialogueCatalog } from '@atlas/shared';
import { useSyncExternalStore } from 'react';
import { prefersReducedMotion, subscribeReducedMotion } from '@/lib/motion';
import { useLifeStore } from '@/state/life';
import { useAtlasStore } from '@/state/store';
import { useSpeechStore } from '@/state/speech';
import styles from './Hud.module.css';

export function SpeechControls({ catalog }: { catalog: RuntimeDialogueCatalog }) {
  const enabled = useSpeechStore((s) => s.enabled);
  const translation = useSpeechStore((s) => s.translation);
  const life = useLifeStore((s) => s.enabled);
  const closeEnough = useAtlasStore((s) => (s.camera?.zoom ?? 0) >= SPEECH_ZOOM);
  const reduced = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
  if (!life || reduced || !closeEnough) return null;
  return (
    <>
      <div className={styles.row}>
        <button
          type="button"
          className={`${styles.button} ${styles.toggle}`}
          aria-pressed={enabled}
          title={`Speech bubbles for simulated greetings and conversations at z${SPEECH_ZOOM} and closer`}
          onClick={() => useSpeechStore.setState({ enabled: !enabled })}
        >
          Speech (simulated)
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
    </>
  );
}
