'use client';

import type { DialogueCatalog } from '@atlas/shared';
import { useSpeechStore } from '@/state/speech';
import styles from './Hud.module.css';

export function SpeechControls({ catalog }: { catalog: DialogueCatalog }) {
  const enabled = useSpeechStore((s) => s.enabled);
  const translation = useSpeechStore((s) => s.translation);
  return (
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
  );
}
