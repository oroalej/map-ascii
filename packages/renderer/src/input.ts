/**
 * Pointer, wheel, and keyboard input on the canvas → camera intents. Listens on the canvas only;
 * the renderer never touches the rest of the DOM.
 */

export type InputIntents = {
  /** Move the map content by (dx, dy) CSS pixels. */
  pan: (dx: number, dy: number) => void;
  /** Change zoom by `delta` around `anchor`, the offset from the canvas center in CSS pixels. */
  zoom: (delta: number, anchor: [number, number]) => void;
  /** Rotate by `dBearing` and tilt by `dPitch` degrees (orbit mode, SPEC.md §3). */
  orbit: (dBearing: number, dPitch: number) => void;
};

/** Degrees of bearing and pitch per pixel of orbit drag. */
const ORBIT_PER_PIXEL = 0.35;

/** Zoom change per wheel pixel, and the cap per event (a mouse notch is ~100 px). */
const WHEEL_ZOOM_PER_PIXEL = 1 / 300;
const WHEEL_MAX = 1;
const KEY_PAN = 100;

export function attachInput(canvas: HTMLCanvasElement, intents: InputIntents): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  /** Whether the current single-pointer drag orbits (right button or Ctrl) instead of panning. */
  let orbiting = false;

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
    const angle = a && b ? Math.atan2(b.y - a.y, b.x - a.x) : 0;
    return { mid, spread, angle };
  };

  const onPointerDown = (e: PointerEvent) => {
    const orbitButton =
      e.pointerType === 'mouse' && (e.button === 2 || (e.button === 0 && e.ctrlKey));
    if (e.button !== 0 && !orbitButton && e.pointerType === 'mouse') return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    orbiting = orbitButton && pointers.size === 1;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const before = gesture();
    pointers.set(e.pointerId, local(e));
    const after = gesture();
    const [dx, dy] = [after.mid.x - before.mid.x, after.mid.y - before.mid.y];
    if (orbiting) {
      // Drag right turns the map clockwise; drag up tilts toward the horizon.
      intents.orbit(-dx * ORBIT_PER_PIXEL, -dy * ORBIT_PER_PIXEL);
      return;
    }
    intents.pan(dx, dy);
    if (pointers.size === 2 && before.spread > 0 && after.spread > 0) {
      intents.zoom(Math.log2(after.spread / before.spread), fromCenter(after.mid));
      // Two-finger twist rotates.
      let turn = after.angle - before.angle;
      if (turn > Math.PI) turn -= 2 * Math.PI;
      if (turn < -Math.PI) turn += 2 * Math.PI;
      if (turn !== 0) intents.orbit((-turn * 180) / Math.PI, 0);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) orbiting = false;
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
  // Right-drag orbits, so the canvas has no context menu.
  const onContextMenu = (e: Event) => e.preventDefault();
  canvas.addEventListener('contextmenu', onContextMenu);
  return () => {
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('keydown', onKeyDown);
  };
}
