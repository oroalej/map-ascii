'use client';

import { emojiGlyph, type RuntimeDialogueCatalog } from '@atlas/shared';
import type { SpeechInView, EmojiInView } from '@atlas/renderer';
import { useEffect, useRef } from 'react';
import type { SpeechRect } from '@/lib/speech-layout';
import { layoutBubbles, type BubbleLayout } from '@/lib/bubble-overlay';
import { useEmojiStore } from '@/state/emoji';
import { useSpeechStore } from '@/state/speech';
import { useAtlasInstance, useAtlasStore } from '@/state/store';
import styles from './SpeechBubbles.module.css';

/** Only this small overlay changes on each renderer event; no app-wide frame state. */
export function CueBubbles({ catalog }: { catalog?: RuntimeDialogueCatalog }) {
  const root = useRef<HTMLDivElement>(null);
  const atlas = useAtlasInstance((s) => s.atlas);
  const theme = useAtlasStore((s) => s.theme);
  useEffect(() => {
    const container = root.current;
    if (!container || !atlas) return;
    const exchanges = new Map((catalog?.exchanges ?? []).map((entry) => [entry.id, entry]));
    const nodes = new Map<
      string,
      { node: HTMLDivElement; text: string; size: { width: number; height: number } }
    >();
    let cues: readonly SpeechInView[] = [],
      emojiCues: readonly EmojiInView[] = [],
      obstacles: SpeechRect[] = [],
      lastMeasure = -Infinity;
    const draw = () => {
      const { enabled, translation } = useSpeechStore.getState();
      const selected = enabled && catalog ? cues : [];
      const moods = useEmojiStore.getState().enabled ? emojiCues : [];
      const keep = new Set([...selected, ...moods].map((cue) => cue.id));
      for (const [id, entry] of nodes)
        if (!keep.has(id)) {
          entry.node.remove();
          nodes.delete(id);
        }
      if (!selected.length && !moods.length) return;
      for (const cue of selected) {
        const text = exchanges.get(cue.exchangeId)?.lines[cue.line];
        if (!text) continue;
        let entry = nodes.get(cue.id);
        if (!entry) {
          const node = document.createElement('div');
          node.className = styles.bubble!;
          node.dataset.speechBubble = '';
          container.append(node);
          nodes.set(cue.id, (entry = { node, text: '', size: { width: 0, height: 0 } }));
        }
        const key = `${text[catalog!.native.code]}\n${translation ? text[translation] : ''}\n${window.innerWidth}`;
        entry.node.dataset.speechExchange = cue.exchangeId;
        entry.node.dataset.speechLine = String(cue.line);
        entry.node.dataset.speechMember = String(cue.member ?? 0);
        if (entry.text !== key) {
          const native = document.createElement('span');
          native.lang = catalog!.native.code;
          native.textContent = text[catalog!.native.code]!;
          entry.node.replaceChildren(native);
          if (translation && text[translation]) {
            const translated = document.createElement('span');
            translated.className = styles.translation!;
            translated.lang = translation;
            translated.textContent = text[translation]!;
            entry.node.append(translated);
          }
          entry.text = key;
          entry.size = { width: entry.node.offsetWidth, height: entry.node.offsetHeight };
        }
      }
      for (const cue of moods) {
        let entry = nodes.get(cue.id);
        if (!entry) {
          const node = document.createElement('div');
          node.className = `${styles.bubble} ${styles.emoji}`;
          node.dataset.emojiBubble = '';
          container.append(node);
          nodes.set(cue.id, (entry = { node, text: '', size: { width: 0, height: 0 } }));
        }
        const glyph = emojiGlyph(cue.subject, cue.mood);
        entry.node.dataset.emojiMood = cue.mood;
        if (entry.text !== glyph) {
          entry.node.textContent = glyph;
          entry.text = glyph;
          entry.size = { width: entry.node.offsetWidth, height: entry.node.offsetHeight };
        }
      }
      const now = performance.now();
      if (now - lastMeasure >= 200) {
        lastMeasure = now;
        obstacles = [
          ...document.querySelectorAll<HTMLElement>(
            '[data-speech-obstacle], main input, main [role="dialog"]',
          ),
        ]
          .filter((element) => !element.hidden && element.getClientRects().length > 0)
          .map((element) => {
            const r = element.getBoundingClientRect();
            return { left: r.left, top: r.top, width: r.width, height: r.height };
          });
      }
      const canvas = document.querySelector('main > canvas');
      const origin = canvas?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const records: BubbleLayout[] = [
        ...selected
          .filter((c) => nodes.has(c.id))
          .map((c) => ({
            id: c.id,
            kind: 'speech' as const,
            point: c.point,
            size: nodes.get(c.id)!.size,
          })),
        ...moods.map((c) => ({
          id: c.id,
          kind: 'emoji' as const,
          pair: c.pair,
          point: c.point,
          size: nodes.get(c.id)!.size,
        })),
      ];
      const boxes = layoutBubbles(
        records,
        { width: window.innerWidth, height: window.innerHeight },
        obstacles,
        moods.length ? atlas.getLabelObstacles() : [],
        origin,
      );
      for (const cue of records) {
        const entry = nodes.get(cue.id)!,
          box = boxes.get(cue.id);
        entry.node.style.visibility = box ? 'visible' : 'hidden';
        if (!box) continue;
        entry.node.style.transform = `translate(${box.left}px, ${box.top}px)`;
        entry.node.style.setProperty('--tail-x', `${box.tail}px`);
        entry.node.dataset.below = String(box.below);
      }
    };
    let drawFrame: number | undefined;
    const scheduleDraw = () => {
      if (drawFrame !== undefined) return;
      drawFrame = window.requestAnimationFrame(() => {
        drawFrame = undefined;
        draw();
      });
    };
    const drawNow = () => {
      if (drawFrame !== undefined) window.cancelAnimationFrame(drawFrame);
      drawFrame = undefined;
      draw();
    };
    const off = atlas.on('speechchange', (next) => {
      cues = next;
      // Empty channels clear immediately on camera/lifecycle invalidation.
      if (next.length) scheduleDraw();
      else drawNow();
    });
    const offEmoji = atlas.on('emojichange', (next) => {
      emojiCues = next;
      if (next.length) scheduleDraw();
      else drawNow();
    });
    const offEmojiPrefs = useEmojiStore.subscribe(drawNow);
    const offPrefs = useSpeechStore.subscribe(drawNow);
    // A panel can open while stationary speakers emit no changed anchors.
    const layoutTimer = window.setInterval(scheduleDraw, 200);
    const resize = () => {
      lastMeasure = -Infinity;
      scheduleDraw();
    };
    window.addEventListener('resize', resize);
    return () => {
      if (drawFrame !== undefined) window.cancelAnimationFrame(drawFrame);
      off();
      offPrefs();
      offEmoji();
      offEmojiPrefs();
      window.clearInterval(layoutTimer);
      window.removeEventListener('resize', resize);
      container.replaceChildren();
    };
  }, [atlas, catalog]);
  return <div ref={root} className={styles.overlay} data-theme={theme} aria-hidden="true" />;
}
