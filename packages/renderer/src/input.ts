/**
 * Pointer, wheel, and keyboard input on the canvas → camera intents. Listens on the canvas only;
 * the renderer never touches the rest of the DOM.
 */

export type InputIntents = {
  /** Move the map content by (dx, dy) CSS pixels. */
  pan: (dx: number, dy: number) => void;
  /** Change zoom by `delta` around `anchor`, the offset from the canvas center in CSS pixels. */
  zoom: (delta: number, anchor: [number, number]) => void;
};

/** Zoom change per wheel pixel, and the cap per event (a mouse notch is ~100 px). */
const WHEEL_ZOOM_PER_PIXEL = 1 / 300;
const WHEEL_MAX = 1;
const KEY_PAN = 100;

export function attachInput(canvas: HTMLCanvasElement, intents: InputIntents): () => void {
  const pointers = new Map<number, { x: number; y: number }>();

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const fromCenter = (p: { x: number; y: number }): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [p.x - rect.width / 2, p.y - rect.height / 2];
  };
  /** Midpoint and spread of the active pointers. */
  const gesture = () => {
    const ps = [...pointers.values()];
    const mid = {
      x: ps.reduce((s, p) => s + p.x, 0) / ps.length,
      y: ps.reduce((s, p) => s + p.y, 0) / ps.length,
    };
    const [a, b] = ps;
    const spread = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    return { mid, spread };
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const before = gesture();
    pointers.set(e.pointerId, local(e));
    const after = gesture();
    intents.pan(after.mid.x - before.mid.x, after.mid.y - before.mid.y);
    if (pointers.size === 2 && before.spread > 0 && after.spread > 0) {
      intents.zoom(Math.log2(after.spread / before.spread), fromCenter(after.mid));
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const pixels =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? e.deltaY * 40
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? e.deltaY * 800
          : e.deltaY;
    const delta = Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, -pixels * WHEEL_ZOOM_PER_PIXEL));
    intents.zoom(delta, fromCenter(local(e)));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const actions: Record<string, () => void> = {
      '+': () => intents.zoom(1, [0, 0]),
      '=': () => intents.zoom(1, [0, 0]),
      '-': () => intents.zoom(-1, [0, 0]),
      ArrowUp: () => intents.pan(0, KEY_PAN),
      ArrowDown: () => intents.pan(0, -KEY_PAN),
      ArrowLeft: () => intents.pan(KEY_PAN, 0),
      ArrowRight: () => intents.pan(-KEY_PAN, 0),
    };
    const action = actions[e.key];
    if (!action) return;
    e.preventDefault();
    action();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('keydown', onKeyDown);
  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('keydown', onKeyDown);
  };
}
