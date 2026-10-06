'use client';

import { EMOJI_ZOOM } from '@atlas/shared';
import { useSyncExternalStore } from 'react';
import { prefersReducedMotion, subscribeReducedMotion } from '@/lib/motion';
import { useLifeStore } from '@/state/life';
import { useAtlasStore } from '@/state/store';
import { useEmojiStore } from '@/state/emoji';
import styles from './Hud.module.css';

export function EmojiControls() {
  const enabled = useEmojiStore((s) => s.enabled);
  const life = useLifeStore((s) => s.enabled);
  const zoom = useAtlasStore((s) => s.camera?.zoom ?? 0);
  const reduced = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
  const explanation = reduced
    ? 'Emoji pauses while reduced motion is on.'
    : !life
      ? 'Turn Life on to see emoji.'
      : zoom < EMOJI_ZOOM
        ? `Zoom to z${EMOJI_ZOOM} or closer to see emoji.`
        : null;
  return (
    <>
      <div className={styles.row}>
        <button
          type="button"
          className={`${styles.button} ${styles.toggle}`}
          aria-pressed={enabled}
          title={`Emoji bubbles for simulated moods at z${EMOJI_ZOOM} and closer`}
          onClick={() => useEmojiStore.setState({ enabled: !enabled })}
        >
          Emoji (simulated)
        </button>
      </div>
      {enabled && explanation && <p className={styles.line}>{explanation}</p>}
    </>
  );
}
