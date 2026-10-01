'use client';

import type { DialogueCatalog } from '@atlas/shared';
import type { SpeechInView } from '@atlas/renderer';
import { useEffect, useRef } from 'react';
import { placeSpeech, type SpeechRect } from '@/lib/speech-layout';
import { useSpeechStore } from '@/state/speech';
import { useAtlasInstance, useAtlasStore } from '@/state/store';
import styles from './SpeechBubbles.module.css';

/** Only this small overlay changes on each renderer event; no app-wide frame state. */
export function SpeechBubbles({ catalog }: { catalog: DialogueCatalog }) {
  const root = useRef<HTMLDivElement>(null);
  const atlas = useAtlasInstance((s) => s.atlas);
  const theme = useAtlasStore((s) => s.theme);
  useEffect(() => {
    const container = root.current;
    if (!container || !atlas) return;
    const exchanges = new Map(catalog.exchanges.map((entry) => [entry.id, entry]));
    const nodes = new Map<
      string,
      { node: HTMLDivElement; text: string; size: { width: number; height: number } }
    >();
    let cues: readonly SpeechInView[] = [],
      obstacles: SpeechRect[] = [],
      lastMeasure = -Infinity;
    const draw = () => {
      const { enabled, translation } = useSpeechStore.getState();
      const selected = enabled ? cues.slice(0, window.innerWidth <= 640 ? 2 : 3) : [];
      const keep = new Set(selected.map((cue) => cue.id));
      for (const [id, entry] of nodes)
        if (!keep.has(id)) {
          entry.node.remove();
          nodes.delete(id);
        }
      if (!selected.length) return;
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
        const key = `${text[catalog.native.code]}\n${translation ? text[translation] : ''}\n${window.innerWidth}`;
        if (entry.text !== key) {
          const native = document.createElement('span');
          native.lang = catalog.native.code;
          native.textContent = text[catalog.native.code]!;
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
      const occupied = [...obstacles];
      const canvas = document.querySelector('main > canvas');
      const origin = canvas?.getBoundingClientRect();
      for (const cue of selected) {
        const entry = nodes.get(cue.id);
        if (!entry) continue;
        const point: [number, number] = [
          cue.point[0] + (origin?.left ?? 0),
          cue.point[1] + (origin?.top ?? 0),
        ];
        const box = placeSpeech(
          point,
          entry.size,
          { width: window.innerWidth, height: window.innerHeight },
          occupied,
        );
        entry.node.style.visibility = box ? 'visible' : 'hidden';
        if (!box) continue;
        occupied.push(box);
        entry.node.style.transform = `translate(${box.left}px, ${box.top}px)`;
        entry.node.style.setProperty('--tail-x', `${box.tail}px`);
        entry.node.dataset.below = String(box.below);
      }
    };
    const off = atlas.on('speechchange', (next) => {
      cues = next;
      draw();
    });
    const offPrefs = useSpeechStore.subscribe(draw);
    // A panel can open while stationary speakers emit no changed anchors.
    const layoutTimer = window.setInterval(draw, 200);
    const resize = () => {
      lastMeasure = -Infinity;
      draw();
    };
    window.addEventListener('resize', resize);
    return () => {
      off();
      offPrefs();
      window.clearInterval(layoutTimer);
      window.removeEventListener('resize', resize);
      container.replaceChildren();
    };
  }, [atlas, catalog]);
  return <div ref={root} className={styles.overlay} data-theme={theme} aria-hidden="true" />;
}
